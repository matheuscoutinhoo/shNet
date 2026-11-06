import type { Device, FirewallSession, Packet, UdpPacket } from '../model';
import { isIcmpError } from './icmp';
import { isUnicast } from './dhcp-config';
import { unicast6 } from './ipv6-address';
import { matchingAclRule } from './acl';
export type FirewallPacket = Packet | Omit<UdpPacket, 'payload'>;
export const firewallUnicast = (ip: string) => (ip.includes(':') ? unicast6(ip) : isUnicast(ip));

export function firewallZone(device: Device, port: string) {
  return device.firewall?.zonePolicy?.zones.find((zone) => zone.ports.includes(port))?.name;
}
/**
 * Zone-based firewall sessions belong to a zone pair, so return traffic may use any interface of
 * the same zones (dual uplinks, ECMP). Without zones, sessions stay bound to their interfaces.
 */
function sameSide(device: Device, a: string, b: string) {
  if (a === b) return true;
  const zone = firewallZone(device, a);
  return !!zone && zone === firewallZone(device, b);
}
export function firewallRule(
  device: Device,
  input: string,
  output: string,
  protocol: Packet['protocol'],
  destinationPort?: number,
  packet?: Packet
) {
  const from = firewallZone(device, input),
    to = firewallZone(device, output);
  if (!from || !to) return;
  return zoneRule(device, from, to, protocol, destinationPort, packet);
}
/** The first zone-pair rule from one zone to another (also the IOS "self" zone) matching a packet. */
export function zoneRule(
  device: Device,
  from: string,
  to: string,
  protocol: Packet['protocol'],
  destinationPort?: number,
  packet?: Packet
) {
  return device.firewall?.zonePolicy?.rules
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .find(
      (rule) =>
        rule.from === from &&
        rule.to === to &&
        (rule.protocol === 'ip' || rule.protocol === protocol) &&
        (rule.destinationPort === undefined || rule.destinationPort === destinationPort) &&
        (!rule.acls ||
          (!!packet &&
            !packet.src.includes(':') &&
            rule.acls.every((acl) => matchingAclRule(device, acl, packet)?.action === 'permit')))
    );
}
/** A probe shaped like the first packet of a session, used only to re-match ACL-based zone rules. */
export function sessionPacket(session: FirewallSession): Packet {
  const base = { src: session.clientIp, dst: session.serverIp, ttl: 64, bytes: 60 };
  return session.protocol === 'ICMP'
    ? { ...base, protocol: 'ICMP', kind: 'echo-request', probeId: session.probeId }
    : session.protocol === 'UDP'
      ? ({
          ...base,
          protocol: 'UDP',
          sourcePort: session.clientPort,
          destinationPort: session.serverPort,
          payload: { protocol: 'RAW', data: '' },
        } as unknown as Packet)
      : ({
          ...base,
          protocol: 'TCP',
          sourcePort: session.clientPort,
          destinationPort: session.serverPort,
          flags: ['SYN'],
          sequence: session.clientInitial,
          acknowledgment: 0,
          window: 4096,
          data: '',
        } as unknown as Packet);
}
export function sessionDirection(
  device: Device,
  session: FirewallSession,
  input: string,
  output: string,
  packet: FirewallPacket
): boolean | undefined {
  if (
    packet.protocol === 'OSPF' ||
    packet.protocol === 'VRRP' ||
    isIcmpError(packet as Packet) ||
    session.protocol !== packet.protocol
  )
    return;
  for (const outbound of [true, false]) {
    if (
      sameSide(device, session.inside, outbound ? input : output) &&
      sameSide(device, session.outside, outbound ? output : input) &&
      session.clientIp === (outbound ? packet.src : packet.dst) &&
      session.serverIp === (outbound ? packet.dst : packet.src) &&
      (session.protocol === 'ICMP' && packet.protocol === 'ICMP'
        ? session.probeId === packet.probeId
        : session.protocol !== 'ICMP' &&
          packet.protocol !== 'ICMP' &&
          session.clientPort === (outbound ? packet.sourcePort : packet.destinationPort) &&
          session.serverPort === (outbound ? packet.destinationPort : packet.sourcePort))
    )
      return outbound;
  }
}
export function relatedSession(device: Device, input: string, output: string, packet: Packet, now: number) {
  if (
    !isIcmpError(packet) ||
    !packet.error ||
    !firewallUnicast(packet.src) ||
    packet.dst !== packet.error.quote.src
  )
    return;
  const quote = packet.error.quote;
  return device.firewall?.sessions.find((session) => {
    if (session.expiresAt <= now || session.protocol !== quote.protocol) return false;
    // The quoted flow travels in the opposite direction to the error.
    for (const outbound of [true, false]) {
      if (
        !sameSide(device, session.inside, outbound ? output : input) ||
        !sameSide(device, session.outside, outbound ? input : output) ||
        session.clientIp !== (outbound ? quote.src : quote.dst) ||
        session.serverIp !== (outbound ? quote.dst : quote.src)
      )
        continue;
      if (session.protocol === 'ICMP' && quote.protocol === 'ICMP') {
        if (session.probeId === quote.probeId && quote.kind === (outbound ? 'echo-request' : 'echo-reply'))
          return true;
      } else if (
        session.protocol !== 'ICMP' &&
        quote.protocol !== 'ICMP' &&
        session.clientPort === (outbound ? quote.sourcePort : quote.destinationPort) &&
        session.serverPort === (outbound ? quote.destinationPort : quote.sourcePort)
      ) {
        // This engine has one outstanding TCP segment per direction. A quotation
        // is valid only within the sequence space already accepted by the firewall.
        if (session.protocol !== 'TCP' || quote.protocol !== 'TCP') return true;
        const first = outbound ? session.clientInitial : session.serverInitial;
        const next = outbound ? session.clientNext : session.serverNext;
        if (
          first !== undefined &&
          next !== undefined &&
          (quote.sequence - first) >>> 0 <= (next - first) >>> 0
        )
          return true;
      }
    }
    return false;
  });
}
