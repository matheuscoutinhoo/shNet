import type { SimulationEngine } from '../core/engine';
import type { Device, FirewallZonePolicy, NetworkInterface, Packet } from '../model';
import { isIcmpError } from './icmp';
import { firewallZone, zoneRule } from './firewall-policy';

type ZoneRule = FirewallZonePolicy['rules'][number];
const destinationPort = (p: Packet) =>
  p.protocol === 'TCP' || p.protocol === 'UDP' ? p.destinationPort : undefined;

/** "%FW-6-DROP_PKT" for a packet dropped by a zone-pair class configured with "drop log". */
export function logZbfDrop(e: SimulationEngine, d: Device, rule: ZoneRule, packet: Packet) {
  if (!rule.zonePair) return;
  const ports =
    packet.protocol === 'TCP' || packet.protocol === 'UDP'
      ? [packet.sourcePort, packet.destinationPort]
      : [0, 0];
  e.emit(
    'FIREWALL_DENY',
    d.id,
    `%FW-6-DROP_PKT: Dropping ${packet.protocol.toLowerCase()} session ${packet.src}:${ports[0]} ${packet.dst}:${ports[1]} on zone-pair ${rule.zonePair} class ${rule.className ?? 'class-default'} with ip ident 0`
  );
}
/** The packet a reply answers, to recognise return traffic of a session inspected the other way. */
function answered(packet: Packet): Packet | undefined {
  if (isIcmpError(packet)) return packet.error?.quote as Packet | undefined;
  const back = { src: packet.dst, dst: packet.src };
  if (packet.protocol === 'TCP')
    return packet.flags.includes('ACK') || packet.flags.includes('RST')
      ? {
          ...packet,
          ...back,
          sourcePort: packet.destinationPort,
          destinationPort: packet.sourcePort,
          flags: ['SYN'],
        }
      : undefined;
  if (packet.protocol === 'UDP')
    return { ...packet, ...back, sourcePort: packet.destinationPort, destinationPort: packet.sourcePort };
  if (packet.protocol === 'ICMP' && packet.kind === 'echo-reply')
    return { ...packet, ...back, kind: 'echo-request' };
}
/**
 * IOS self zone: traffic to or from the router itself passes unless a zone-pair with the self
 * zone has a policy. That policy then decides, routing protocols included; "inspect" also lets
 * the replies come back, recognised by matching the packet they answer against the opposite pair.
 */
export function permitSelfZone(
  e: SimulationEngine,
  d: Device,
  port: NetworkInterface,
  packet: Packet,
  toSelf: boolean
) {
  const policy = d.firewall?.enabled ? d.firewall.zonePolicy : undefined;
  if (!policy || packet.src.includes(':') || (!toSelf && isIcmpError(packet))) return true;
  const zone = firewallZone(d, port.id);
  if (!zone) return true;
  const from = toSelf ? zone : 'self',
    to = toSelf ? 'self' : zone;
  if (!policy.rules.some((rule) => rule.from === from && rule.to === to)) return true;
  const rule = zoneRule(d, from, to, packet.protocol, destinationPort(packet), packet);
  if (rule && rule.action !== 'deny') return true;
  const original = answered(packet);
  if (
    original &&
    zoneRule(d, to, from, original.protocol, destinationPort(original), original)?.action === 'inspect'
  )
    return true;
  if (rule?.log) logZbfDrop(e, d, rule, packet);
  d.firewall!.dropped++;
  const message =
    'Firewall ' +
    packet.protocol +
    (toSelf ? ' para o roteador em ' : ' gerado pelo roteador em ') +
    port.name +
    ': zone-pair ' +
    from +
    ' → ' +
    to +
    ' descarta; ' +
    packet.src +
    ' → ' +
    packet.dst +
    '.';
  e.emit('FIREWALL_DENY', d.id, message, { port: port.id, packet });
  e.drop(d, message, port.id);
  return false;
}
