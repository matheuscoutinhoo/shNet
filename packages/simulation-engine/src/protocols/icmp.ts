import type { SimulationEngine } from '../core/engine';
import type { Device, IcmpPacket, IcmpQuote, NetworkInterface, Packet } from '../model';
import { isUnicast } from './dhcp-config';
import { resolveRoute, subnet } from './ipv4';

export function isIcmpError(
  packet: Packet
): packet is IcmpPacket & { kind: 'time-exceeded' | 'unreachable' } {
  return packet.protocol === 'ICMP' && (packet.kind === 'time-exceeded' || packet.kind === 'unreachable');
}
export function quotePacket(packet: Packet): IcmpQuote | undefined {
  const header = { src: packet.src, dst: packet.dst, ttl: packet.ttl };
  if (packet.protocol === 'OSPF' || packet.protocol === 'VRRP' || isIcmpError(packet)) return;
  if (packet.protocol === 'ICMP') {
    if (packet.kind !== 'echo-request' && packet.kind !== 'echo-reply') return;
    return { ...header, protocol: 'ICMP', kind: packet.kind, probeId: packet.probeId };
  }
  const ports = { sourcePort: packet.sourcePort, destinationPort: packet.destinationPort };
  return packet.protocol === 'TCP'
    ? { ...header, ...ports, protocol: 'TCP', sequence: packet.sequence }
    : { ...header, ...ports, protocol: 'UDP' };
}
export function sendIcmpError(
  engine: SimulationEngine,
  device: Device,
  ingress: NetworkInterface,
  packet: Packet,
  kind: 'time-exceeded' | 'unreachable',
  code: 0 | 1 | 3 | 4,
  mtu?: number
) {
  const quote = quotePacket(packet);
  if (!quote) return;
  sendIcmpQuoteError(
    engine,
    device,
    ingress,
    quote,
    kind,
    code,
    mtu,
    packet.protocol === 'ICMP' ? packet.traceId : undefined
  );
}

export function sendIcmpQuoteError(
  engine: SimulationEngine,
  device: Device,
  ingress: NetworkInterface,
  quote: IcmpQuote,
  kind: 'time-exceeded' | 'unreachable',
  code: 0 | 1 | 3 | 4,
  mtu?: number,
  traceId?: string
) {
  const broadcast = (ip: string) =>
    device.interfaces.some(
      (port) =>
        port.vrf === ingress.vrf &&
        port.ip &&
        port.prefix !== undefined &&
        port.prefix < 31 &&
        [subnet(port.ip, port.prefix).network, subnet(port.ip, port.prefix).broadcast].includes(ip)
    );
  if (!isUnicast(quote.src) || !isUnicast(quote.dst) || broadcast(quote.src) || broadcast(quote.dst)) return;
  const source = resolveRoute(device, quote.src, ingress.vrf)?.port.ip ?? ingress.ip;
  if (!source) return;
  engine.emit(
    'PACKET_SENT',
    device.id,
    'ICMP ' + kind + ' / ' + code + '; cita ' + quote.protocol + ' ' + quote.src + ' → ' + quote.dst + '.'
  );
  engine.sendIp(
    device.id,
    {
      src: source,
      dst: quote.src,
      ttl: 64,
      protocol: 'ICMP',
      kind,
      probeId: quote.protocol === 'ICMP' ? quote.probeId : engine.id('icmp'),
      ...(traceId ? { traceId } : {}),
      bytes: 56,
      error: { code, quote, ...(code === 4 ? { mtu } : {}) },
    },
    undefined,
    ingress.vrf
  );
}
