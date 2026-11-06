import { aclSchema, type AclRule, type Device, type NetworkInterface, type Packet } from '../model';
import type { SimulationEngine } from '../core/engine';
import { ipNumber, sameSubnet, subnet } from './ipv4';
import { longInterfaceName } from './interface-name';

/** IOS ICMP message type and code of an ICMP packet. */
export function icmpTypeCode(packet: Extract<Packet, { protocol: 'ICMP' }>): [number, number] {
  return packet.kind === 'echo-request'
    ? [8, 0]
    : packet.kind === 'echo-reply'
      ? [0, 0]
      : packet.kind === 'time-exceeded'
        ? [11, 0]
        : [3, packet.error?.code ?? 0];
}
function portMatches(value: number, port: number, op: AclRule['sourcePortOp'], end?: number) {
  return op === undefined
    ? value === port
    : op === 'neq'
      ? value !== port
      : op === 'gt'
        ? value > port
        : op === 'lt'
          ? value < port
          : value >= port && value <= end!;
}
const PROTOCOL_NUMBERS: Partial<Record<Packet['protocol'], number>> = {
  OSPF: 89,
  VRRP: 112,
  GRE: 47,
  ESP: 50,
};
// IOS reports the first packet that matches a "log" entry at once and a count every 5 minutes.
const ACL_LOG_INTERVAL_MS = 300_000;
function logAclMatch(
  engine: SimulationEngine,
  device: Device,
  name: string,
  standard: boolean,
  rule: AclRule,
  port: NetworkInterface,
  packet: Packet
) {
  const now = engine.state.clock;
  if (rule.loggedAt !== undefined && now - rule.loggedAt < ACL_LOG_INTERVAL_MS) {
    rule.logPending = (rule.logPending ?? 0) + 1;
    return;
  }
  const count = (rule.logPending ?? 0) + 1;
  rule.loggedAt = now;
  delete rule.logPending;
  const verb = rule.action === 'permit' ? 'permitted' : 'denied',
    packets = count + (count === 1 ? ' packet' : ' packets'),
    input = rule.log === 'log-input' ? ' (' + longInterfaceName(port.name) + ')' : '';
  const text = standard
    ? `%SEC-6-IPACCESSLOGS: list ${name} ${verb} ${packet.src}${input} ${packets}`
    : packet.protocol === 'TCP' || packet.protocol === 'UDP'
      ? `%SEC-6-IPACCESSLOGP: list ${name} ${verb} ${packet.protocol.toLowerCase()} ${packet.src}(${packet.sourcePort})${input} -> ${packet.dst}(${packet.destinationPort}), ${packets}`
      : packet.protocol === 'ICMP'
        ? `%SEC-6-IPACCESSLOGDP: list ${name} ${verb} icmp ${packet.src}${input} -> ${packet.dst} (${icmpTypeCode(packet).join('/')}), ${packets}`
        : `%SEC-6-IPACCESSLOGNP: list ${name} ${verb} ${PROTOCOL_NUMBERS[packet.protocol] ?? 0} ${packet.src}${input} -> ${packet.dst}, ${packets}`;
  engine.emit(rule.action === 'permit' ? 'ACL_PERMIT' : 'ACL_DENY', device.id, text, { port: port.id });
}

export function configureAcl(device: Device, input: unknown) {
  const acl = aclSchema.parse(input);
  if (new Set(acl.rules.map((rule) => rule.sequence)).size !== acl.rules.length)
    throw new Error('Sequência ACL duplicada.');
  for (const rule of acl.rules)
    for (const range of [rule.source, rule.destination])
      if (subnet(range.network, range.prefix).network !== range.network)
        throw new Error('Rede ACL desalinhada ao prefixo.');
  acl.rules.sort((left, right) => left.sequence - right.sequence);
  const others = device.accessLists?.filter((entry) => entry.name !== acl.name) ?? [];
  if (others.length >= 32) throw new Error('Limite de 32 ACLs por equipamento.');
  device.accessLists = [...others, acl];
  return acl;
}

export function permitPacket(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  direction: 'in' | 'out',
  packet: Packet
) {
  const name = direction === 'in' ? port.aclIn : port.aclOut;
  if (!name) return true;
  const acl = device.accessLists?.find((entry) => entry.name === name);
  // IOS permits all traffic through an interface that references an undefined ACL.
  if (!acl) return true;
  const rule = matchingAclRule(device, name, packet);
  if (rule) rule.hits++;
  else if (acl) acl.implicitDrops++;
  const permitted = rule?.action === 'permit';
  const reason =
    'ACL ' +
    name +
    ' ' +
    direction +
    ' em ' +
    port.name +
    ': ' +
    (rule ? 'regra ' + rule.sequence + ' ' + rule.action : 'deny implícito') +
    '; ' +
    packet.protocol +
    ' ' +
    packet.src +
    ' -> ' +
    packet.dst +
    '.';
  engine.emit(permitted ? 'ACL_PERMIT' : 'ACL_DENY', device.id, reason, { port: port.id, packet });
  if (rule?.log) logAclMatch(engine, device, name, acl.kind === 'standard', rule, port, packet);
  if (!permitted) engine.drop(device, reason, port.id);
  return permitted;
}
export function matchingAclRule(device: Device, name: string, packet: Packet) {
  const transport = packet.protocol === 'TCP' || packet.protocol === 'UDP' ? packet : undefined;
  return device.accessLists
    ?.find((acl) => acl.name === name)
    ?.rules.find(
      (entry) =>
        (entry.protocol === 'ip' || entry.protocol.toUpperCase() === packet.protocol) &&
        (entry.sourceWildcard
          ? ((ipNumber(entry.source.network) ^ ipNumber(packet.src)) & ~ipNumber(entry.sourceWildcard)) === 0
          : sameSubnet(entry.source.network, packet.src, entry.source.prefix)) &&
        (entry.destinationWildcard
          ? ((ipNumber(entry.destination.network) ^ ipNumber(packet.dst)) &
              ~ipNumber(entry.destinationWildcard)) ===
            0
          : sameSubnet(entry.destination.network, packet.dst, entry.destination.prefix)) &&
        (entry.sourcePort === undefined ||
          (!!transport &&
            portMatches(transport.sourcePort, entry.sourcePort, entry.sourcePortOp, entry.sourcePortEnd))) &&
        (entry.destinationPort === undefined ||
          (!!transport &&
            portMatches(
              transport.destinationPort,
              entry.destinationPort,
              entry.destinationPortOp,
              entry.destinationPortEnd
            ))) &&
        (entry.icmpType === undefined ||
          (packet.protocol === 'ICMP' &&
            icmpTypeCode(packet)[0] === entry.icmpType &&
            (entry.icmpCode === undefined || icmpTypeCode(packet)[1] === entry.icmpCode))) &&
        (!entry.established ||
          (packet.protocol === 'TCP' && packet.flags.some((f) => f === 'ACK' || f === 'RST')))
    );
}

export function validateAcls(device: Device) {
  const lists = device.accessLists ?? [];
  if (new Set(lists.map((acl) => acl.name)).size !== lists.length) throw new Error('Nome de ACL duplicado.');
  for (const acl of lists) {
    configureAcl({ ...device, accessLists: [] }, acl);
    if (acl.rules.some((rule, index) => index > 0 && rule.sequence <= acl.rules[index - 1].sequence))
      throw new Error('Regras ACL fora de ordem.');
  }
  for (const port of device.interfaces)
    for (const name of [port.aclIn, port.aclOut])
      // A reference to an ACL that is not defined yet is valid IOS configuration.
      if (name && port.mode !== 'routed') throw new Error('Interface referencia ACL inválida.');
}
