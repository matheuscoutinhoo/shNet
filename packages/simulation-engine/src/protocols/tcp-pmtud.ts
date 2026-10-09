import type { SimulationEngine } from '../core/engine';
import type { Device } from '../model';
import { tcpBytes, tcpAdd, tcpOptionBytes, type TcpPacket } from './tcp-model';
import { tcpFlow } from './tcp-flow';
import { armTcpRetry, takeTcpText, transmitTcp } from './tcp-wire';
type Quote = Pick<TcpPacket, 'src' | 'dst' | 'sourcePort' | 'destinationPort' | 'sequence'>;
export function receiveTcpMtu(
  e: SimulationEngine,
  d: Device,
  quote: Quote,
  mtu: number,
  vrf?: string,
  scope?: string
) {
  const c = d.tcpConnections?.find(
      (c) =>
        c.vrf === vrf &&
        c.scope === scope &&
        c.localIp === quote.src &&
        c.remoteIp === quote.dst &&
        c.localPort === quote.sourcePort &&
        c.remotePort === quote.destinationPort
    ),
    x = c?.extensions;
  if (
    !c ||
    !x?.local.pmtud ||
    !Number.isInteger(mtu) ||
    mtu < (c.localIp.includes(':') ? 1280 : 576) ||
    mtu >= (x.pathMtu ?? 9216)
  )
    return false;
  const f = tcpFlow(c),
    flight = [...(c.pending ? [c.pending] : []), ...f.flight],
    quoted = flight.find((p) => p.packet.sequence === quote.sequence);
  if (!quoted || quoted.packet.bytes <= mtu || !quoted.packet.data) return false;
  const mss = Math.min(f.mss, mtu - (c.localIp.includes(':') ? 60 : 40) - (x.timestamps ? 12 : 0));
  const next: typeof flight = [];
  for (const item of flight) {
    if (!item.packet.data) {
      next.push(item);
      continue;
    }
    let remaining = item.packet.data,
      sequence = item.packet.sequence;
    const payloadLimit = Math.min(
      mss,
      mtu - (item.packet.family ? 60 : 40) - tcpOptionBytes(item.packet.options)
    );
    while (remaining) {
      const data = takeTcpText(remaining, payloadLimit);
      if (!data) return false;
      remaining = remaining.slice(data.length);
      const packet = { ...structuredClone(item.packet), sequence, data };
      packet.bytes = (packet.family ? 60 : 40) + tcpOptionBytes(packet.options) + tcpBytes(data);
      if (packet.options?.timestamp) packet.options.timestamp.value = Math.floor(e.state.clock) >>> 0;
      next.push({ ...item, packet, sentAt: e.state.clock, retransmitted: true });
      sequence = tcpAdd(sequence, tcpBytes(data));
    }
  }
  if (next.length > 64) return false;
  x.pathMtu = mtu;
  f.mss = mss;
  c.pending = next.shift();
  f.flight = next;
  d.pending = d.pending.filter(
    (p) => p.packet.protocol !== 'TCP' || p.packet.traceId !== c.id || p.packet.bytes <= mtu
  );
  if (d.pending6)
    d.pending6 = d.pending6.filter(
      (p) => p.packet.protocol !== 'TCP' || p.packet.segment.traceId !== c.id || p.packet.bytes <= mtu
    );
  e.emit(
    'TCP_STATE_CHANGED',
    d.id,
    `${c.id}: PMTUD MTU=${mtu}; MSS=${mss}; segmentos refeitos sem perder sequência.`
  );
  armTcpRetry(e, d, c);
  for (const item of [c.pending!, ...f.flight])
    if (!item.sacked) {
      c.retransmissions++;
      transmitTcp(e, d, item.packet, c.vrf, c.scope);
    }
  return true;
}
