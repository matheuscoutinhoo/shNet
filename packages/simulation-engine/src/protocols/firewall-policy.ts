import type { Device, FirewallSession, Packet } from '../model';
import { isIcmpError } from './icmp';
import { isUnicast } from './dhcp-config';

export function firewallZone(device: Device, port: string) {
  return device.firewall?.zonePolicy?.zones.find((zone) => zone.ports.includes(port))?.name;
}
export function firewallRule(
  device: Device,
  input: string,
  output: string,
  protocol: Packet['protocol'],
  destinationPort?: number
) {
  const from = firewallZone(device, input),
    to = firewallZone(device, output);
  if (!from || !to) return;
  return device.firewall?.zonePolicy?.rules
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .find(
      (rule) =>
        rule.from === from &&
        rule.to === to &&
        (rule.protocol === 'ip' || rule.protocol === protocol) &&
        (rule.destinationPort === undefined || rule.destinationPort === destinationPort)
    );
}
export function sessionDirection(
  session: FirewallSession,
  input: string,
  output: string,
  packet: Packet
): boolean | undefined {
  if (
    packet.protocol === 'OSPF' ||
    packet.protocol === 'VRRP' ||
    isIcmpError(packet) ||
    session.protocol !== packet.protocol
  )
    return;
  for (const outbound of [true, false]) {
    if (
      session.inside === (outbound ? input : output) &&
      session.outside === (outbound ? output : input) &&
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
    !isUnicast(packet.src) ||
    packet.dst !== packet.error.quote.src
  )
    return;
  const quote = packet.error.quote;
  return device.firewall?.sessions.find((session) => {
    if (session.expiresAt <= now || session.protocol !== quote.protocol) return false;
    // The quoted flow travels in the opposite direction to the error.
    for (const outbound of [true, false]) {
      if (
        session.inside !== (outbound ? output : input) ||
        session.outside !== (outbound ? input : output) ||
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
