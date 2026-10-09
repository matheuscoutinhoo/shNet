import { aclSchema, type Device, type NetworkInterface, type Packet } from '../model';
import type { SimulationEngine } from '../core/engine';
import { sameSubnet, subnet } from './ipv4';

export function configureAcl(device: Device, input: unknown) {
  if (device.type === 'switch' && !device.interfaces.some((p) => p.mode === 'routed' && p.ip))
    throw new Error('ACL IPv4 requer um equipamento com stack IP.');
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
  const rule = acl?.rules.find(
    (entry) =>
      (entry.protocol === 'ip' || entry.protocol.toUpperCase() === packet.protocol) &&
      sameSubnet(entry.source.network, packet.src, entry.source.prefix) &&
      sameSubnet(entry.destination.network, packet.dst, entry.destination.prefix) &&
      (entry.sourcePort === undefined ||
        ((packet.protocol === 'TCP' || packet.protocol === 'UDP') &&
          packet.sourcePort === entry.sourcePort)) &&
      (entry.destinationPort === undefined ||
        ((packet.protocol === 'TCP' || packet.protocol === 'UDP') &&
          packet.destinationPort === entry.destinationPort))
  );
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
  engine.emit(permitted ? 'ACL_PERMIT' : 'ACL_DENY', device.id, reason, { port: port.id });
  if (!permitted) engine.drop(device, reason, port.id);
  return permitted;
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
      if (name && (port.mode !== 'routed' || !lists.some((acl) => acl.name === name)))
        throw new Error('Interface referencia ACL inválida.');
}
