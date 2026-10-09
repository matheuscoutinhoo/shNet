import type { SimulationEngine } from '../core/engine';
import type { Device } from '../model';
import {
  TCP,
  tcpAdd,
  tcpBytes,
  tcpDistance,
  tcpOptionBytes,
  tcpSettingsSchema,
  type TcpConnection,
  type TcpPacket,
} from './tcp-model';
import { sampleTcpRtt, tcpFlow } from './tcp-flow';
import { resolveRoute } from './ipv4';
import { resolveRoute6 } from './ipv6-routing';
export function configureTcpSettings(e: SimulationEngine, d: Device, input: unknown) {
  d.tcpSettings = tcpSettingsSchema.parse(input);
  e.emit('CONFIG_CHANGED', d.id, 'Opções TCP aplicadas às próximas conexões.');
}
export function initializeTcpExtensions(e: SimulationEngine, d: Device, c: TcpConnection) {
  if (!d.tcpSettings) return;
  c.extensions = {
    local: structuredClone(d.tcpSettings),
    sack: false,
    ecn: false,
    timestamps: false,
    ecnEcho: false,
    cwr: false,
  };
  const f = tcpFlow(c);
  f.mss = d.tcpSettings.mss;
  f.cwnd = Math.min(TCP.buffer, 2 * f.mss);
  const ipv6 = c.localIp.includes(':'),
    mtu = ipv6
      ? resolveRoute6(d, c.remoteIp, e.state.clock, c.vrf, c.scope)?.port.mtu
      : resolveRoute(d, c.remoteIp, c.vrf)?.port.mtu;
  if (mtu) {
    c.extensions.pathMtu = mtu;
    f.mss = Math.min(f.mss, mtu - (ipv6 ? 60 : 40) - (d.tcpSettings.timestamps ? 12 : 0));
  }
}
export function negotiateTcpExtensions(c: TcpConnection, p: TcpPacket, now: number) {
  const x = c.extensions;
  if (!x) return;
  x.sack = x.local.sack && !!p.options?.sackPermitted;
  x.timestamps = x.local.timestamps && !!p.options?.timestamp;
  x.ecn =
    x.local.ecn &&
    p.flags.includes('ECE') &&
    (c.role === 'server' ? p.flags.includes('CWR') : !p.flags.includes('CWR'));
  if (x.timestamps) {
    x.timestampRecent = p.options!.timestamp!.value;
    x.timestampAt = now;
  }
  const f = tcpFlow(c);
  f.mss = Math.min(f.mss, p.options?.mss ?? (p.family ? 1220 : 536));
  // Data options reduce the usable payload inside the discovered IP MTU.
  if (x.pathMtu) f.mss = Math.min(f.mss, x.pathMtu - (p.family ? 60 : 40) - (x.timestamps ? 12 : 0));
  f.cwnd = Math.min(f.cwnd, Math.max(f.mss, 2 * f.mss));
}
export function extendTcpPacket(c: TcpConnection, p: TcpPacket, now: number) {
  const x = c.extensions;
  if (!x) return p;
  const syn = p.flags.includes('SYN'),
    reset = p.flags.includes('RST');
  const options: NonNullable<TcpPacket['options']> = {};
  if (syn) {
    options.mss = x.local.mss;
    if (x.local.sack && (c.role === 'client' || x.sack)) options.sackPermitted = true;
    if (x.local.ecn && (c.role === 'client' || x.ecn)) {
      p.flags.push('ECE');
      if (c.role === 'client') p.flags.push('CWR');
    }
  }
  if (
    !reset &&
    ((syn && x.local.timestamps && (c.role === 'client' || x.timestamps)) || (!syn && x.timestamps))
  )
    options.timestamp = { value: Math.floor(now) >>> 0, echo: x.timestampRecent ?? 0 };
  if (!syn && !reset && x.ecn) {
    if (x.ecnEcho) p.flags.push('ECE');
    if (p.data) {
      p.ecn = 2;
      if (x.cwr) {
        p.flags.push('CWR');
        x.cwr = false;
      }
    }
  }
  if (!syn && !reset && x.sack && p.flags.includes('ACK')) {
    const queued = tcpFlow(c)
        .receiveQueue.map((q) => ({ left: q.sequence, right: tcpAdd(q.sequence, tcpBytes(q.data)) }))
        .filter((b) => b.left !== b.right)
        .sort((a, b) => tcpDistance(c.receiveNext, a.left) - tcpDistance(c.receiveNext, b.left)),
      blocks: typeof queued = [];
    for (const b of queued) {
      const last = blocks.at(-1);
      if (last && last.right === b.left) last.right = b.right;
      else blocks.push(b);
    }
    const at = blocks.findIndex(
      (b) =>
        x.lastOutOfOrder !== undefined && tcpDistance(b.left, x.lastOutOfOrder) < tcpDistance(b.left, b.right)
    );
    if (at > 0) blocks.unshift(...blocks.splice(at, 1));
    if (blocks.length) options.sack = blocks.slice(0, x.timestamps ? 3 : 4);
  }
  if (Object.keys(options).length) p.options = options;
  if (x.local.pmtud && !p.family) p.df = true;
  p.bytes = (p.family ? 60 : 40) + tcpOptionBytes(p.options) + tcpBytes(p.data);
  return p;
}
export function receiveTcpExtensions(e: SimulationEngine, d: Device, c: TcpConnection, p: TcpPacket) {
  const x = c.extensions;
  if (!x) return true;
  if (x.timestamps && !p.flags.includes('RST')) {
    const timestamp = p.options?.timestamp;
    if (!timestamp) {
      e.drop(d, 'TCP: timestamp negociado ausente.');
      return false;
    }
    const old =
      x.timestampRecent !== undefined &&
      tcpDistance(timestamp.value, x.timestampRecent) > 0 &&
      tcpDistance(timestamp.value, x.timestampRecent) < 0x80000000;
    if (old && e.state.clock - (x.timestampAt ?? 0) < 24 * 86400000) {
      e.drop(d, 'TCP PAWS: timestamp antigo.');
      return false;
    }
    if (p.sequence === c.receiveNext) {
      x.timestampRecent = timestamp.value;
      x.timestampAt = e.state.clock;
    }
    const pending = c.pending;
    if (
      pending?.retransmitted &&
      pending.packet.options?.timestamp?.value === timestamp.echo &&
      tcpDistance(c.sendUna, p.acknowledgment) > 0 &&
      tcpDistance(c.sendUna, p.acknowledgment) <= tcpDistance(c.sendUna, c.sendNext) &&
      pending.sentAt !== undefined
    )
      sampleTcpRtt(c, e.state.clock - pending.sentAt);
  }
  if (x.sack && p.options?.sack) {
    const flight = [...(c.pending ? [c.pending] : []), ...tcpFlow(c).flight],
      span = tcpDistance(c.sendUna, c.sendNext),
      ack = tcpDistance(c.sendUna, p.acknowledgment);
    if (
      ack <= span &&
      p.options.sack.every((b) => {
        const left = tcpDistance(c.sendUna, b.left),
          right = tcpDistance(c.sendUna, b.right);
        return left > ack && left < right && right <= span;
      })
    )
      for (const segment of flight) {
        const start = tcpDistance(c.sendUna, segment.packet.sequence),
          end = start + tcpBytes(segment.packet.data);
        if (
          segment.packet.data &&
          p.options.sack.some(
            (b) => tcpDistance(c.sendUna, b.left) <= start && tcpDistance(c.sendUna, b.right) >= end
          )
        )
          segment.sacked = true;
      }
  }
  if (x.ecn) {
    if (p.flags.includes('CWR')) x.ecnEcho = false;
    if (p.ecn === 3 && p.data) x.ecnEcho = true;
    const outstanding = tcpDistance(c.sendUna, c.sendNext);
    if (
      p.flags.includes('ECE') &&
      outstanding &&
      (x.ecnUntil === undefined || tcpDistance(x.ecnUntil, c.sendUna) < 0x80000000)
    ) {
      const f = tcpFlow(c);
      f.ssthresh = Math.min(TCP.buffer, Math.max(2 * f.mss, Math.floor(f.cwnd / 2)));
      f.cwnd = f.ssthresh;
      x.ecnUntil = c.sendNext;
      x.cwr = true;
      e.emit('TCP_STATE_CHANGED', d.id, `${c.id}: ECN/ECE, cwnd=${f.cwnd}; próximo dado confirma CWR.`);
    }
  }
  return true;
}
