import type { SimulationEngine } from '../core/engine';
import type { Device, IcmpPacket, NetworkInterface, Packet6 } from '../model';
import { permitFirewall } from './firewall';

// Zones and their ip/TCP/UDP/ICMP rules apply to both address families.
// NDP terminates locally before this transit policy; it is never tracked as echo.
export function permitFirewall6(
  e: SimulationEngine,
  d: Device,
  input: NetworkInterface,
  output: NetworkInterface,
  p: Packet6
) {
  if (p.protocol === 'TCP') return permitFirewall(e, d, input, output, p.segment, p);
  if (p.protocol === 'UDP')
    return permitFirewall(
      e,
      d,
      input,
      output,
      {
        protocol: 'UDP',
        src: p.src,
        dst: p.dst,
        ttl: p.hopLimit,
        bytes: p.bytes,
        sourcePort: p.datagram.sourcePort,
        destinationPort: p.datagram.destinationPort,
      },
      p
    );
  const error = ['unreachable', 'time-exceeded', 'packet-too-big'].includes(p.kind);
  if (!error && p.kind !== 'echo-request' && p.kind !== 'echo-reply') return false;
  const quote = p.quote;
  const packet: IcmpPacket = {
    protocol: 'ICMP',
    src: p.src,
    dst: p.dst,
    ttl: p.hopLimit,
    bytes: p.bytes,
    kind: p.kind === 'packet-too-big' ? 'unreachable' : (p.kind as IcmpPacket['kind']),
    probeId:
      p.probeId ?? ('probeId' in (quote ?? {}) ? (quote as { probeId: string }).probeId : 'icmp6-error'),
    ...(error && quote
      ? {
          error: {
            code: p.kind === 'packet-too-big' ? (4 as const) : (0 as const),
            ...(p.mtu ? { mtu: p.mtu } : {}),
            quote:
              'protocol' in quote
                ? { ...quote, ttl: 64 }
                : { ...quote, ttl: 64, protocol: 'ICMP' as const, kind: 'echo-request' as const },
          },
        }
      : {}),
  };
  return permitFirewall(e, d, input, output, packet, p);
}
