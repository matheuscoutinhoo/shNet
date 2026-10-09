import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkInterface, Packet, Packet6, Snapshot } from '../model';
import { idsConfigSchema } from './ids-model';
import { sameSubnet } from './ipv4';
import { tcpAdd, tcpBytes, tcpDistance, type TcpPacket } from './tcp-model';
function payloadText(p: Packet | Packet6) {
  if (p.protocol === 'TCP') return 'segment' in p ? p.segment.data : p.data;
  if (p.protocol === 'UDP') return JSON.stringify('datagram' in p ? p.datagram.payload : p.payload);
  return '';
}
export function configureIds(e: SimulationEngine, d: Device, input: unknown) {
  const c = idsConfigSchema.parse(input);
  if (new Set(c.rules.map((r) => r.id)).size !== c.rules.length) throw new Error('Regra IDS duplicada.');
  d.ids = { ...c, dropped: 0, alerts: [], counters: [], flows: [] };
  e.emit('CONFIG_CHANGED', d.id, 'IDS/IPS configurado.');
}
function assemble(d: Device, p: TcpPacket, clock: number) {
  const state = d.ids!,
    id = JSON.stringify([p.src, p.dst, p.sourcePort, p.destinationPort, p.family]);
  state.flows = state.flows.filter((f) => clock - f.lastAt < 60000);
  let f = state.flows.find((f) => f.id === id);
  if (p.flags.includes('SYN')) {
    state.flows = state.flows.filter((f) => f.id !== id);
    f = undefined;
  }
  if (!f) {
    if (state.flows.length >= 256) state.flows.shift();
    f = {
      id,
      next: tcpAdd(p.sequence, Number(p.flags.includes('SYN'))),
      text: '',
      chunks: [],
      lastAt: clock,
    };
    state.flows.push(f);
  }
  f.lastAt = clock;
  if (!p.data) return f.text;
  const delta = tcpDistance(f.next, p.sequence);
  if (delta > 0 && delta < 65536) {
    if (f.chunks.length < 64 && !f.chunks.some((q) => q.sequence === p.sequence))
      f.chunks.push(structuredClone(p));
    return f.text;
  }
  if (delta !== 0) return f.text;
  f.text = (f.text + p.data).slice(-4096);
  f.next = tcpAdd(f.next, tcpBytes(p.data));
  for (let i = 0; i < 64; i++) {
    const at = f.chunks.findIndex((q) => q.sequence === f!.next);
    if (at < 0) break;
    const [q] = f.chunks.splice(at, 1);
    f.text = (f.text + q.data).slice(-4096);
    f.next = tcpAdd(f.next, tcpBytes(q.data));
  }
  return f.text;
}
export function permitIds(e: SimulationEngine, d: Device, port: NetworkInterface, p: Packet | Packet6) {
  const c = d.ids;
  if (!c?.enabled) return true;
  if (p.protocol === 'OSPF' || p.protocol === 'VRRP') return true;
  const tcp = p.protocol === 'TCP' ? ('segment' in p ? p.segment : p) : undefined;
  const text = tcp ? assemble(d, tcp, e.state.clock) : payloadText(p);
  const destinationPort =
    p.protocol === 'TCP'
      ? tcp!.destinationPort
      : p.protocol === 'UDP'
        ? 'datagram' in p
          ? p.datagram.destinationPort
          : p.destinationPort
        : undefined;
  let permit = true;
  for (const r of c.rules) {
    if (
      (r.protocol !== 'any' && r.protocol !== p.protocol) ||
      (r.destinationPort !== undefined && r.destinationPort !== destinationPort) ||
      (r.source && (p.src.includes(':') || !sameSubnet(p.src, r.source.network, r.source.prefix))) ||
      (r.synOnly && !tcp?.flags.includes('SYN'))
    )
      continue;
    c.counters = c.counters.filter(
      (v) => e.state.clock - v.startedAt < (c.rules.find((r) => r.id === v.rule)?.windowMs ?? 0)
    );
    let counter = c.counters.find((v) => v.rule === r.id && v.source === p.src);
    if (!counter) {
      if (c.counters.length >= 1024) c.counters.shift();
      counter = { rule: r.id, source: p.src, startedAt: e.state.clock, count: 0, alerted: false };
      c.counters.push(counter);
    }
    counter.count++;
    const matched =
      (r.pattern === undefined || text.toLowerCase().includes(r.pattern.toLowerCase())) &&
      (r.threshold === undefined || counter.count >= r.threshold);
    if (!matched) continue;
    const blocked = c.mode === 'ips' && r.action === 'drop';
    if (blocked) {
      permit = false;
      c.dropped++;
    }
    if (!counter.alerted) {
      counter.alerted = true;
      const reason =
        r.name + (r.pattern ? ': assinatura detectada' : ': limiar ' + counter.count + ' pacotes');
      c.alerts.push({
        at: e.state.clock,
        rule: r.id,
        source: p.src,
        destination: p.dst,
        protocol: p.protocol,
        port: port.id,
        blocked,
        reason,
      });
      if (c.alerts.length > 256) c.alerts.shift();
      e.emit(blocked ? 'FIREWALL_DENY' : 'FIREWALL_APPLICATION', d.id, 'IDS/IPS: ' + reason, {
        port: port.id,
      });
    }
  }
  if (!permit) e.drop(d, 'IPS: tráfego bloqueado por assinatura/limiar.', port.id);
  return permit;
}
export function validateIds(s: Snapshot) {
  for (const d of s.devices)
    if (d.ids) {
      const c = d.ids;
      if (
        new Set(c.rules.map((r) => r.id)).size !== c.rules.length ||
        new Set(c.flows.map((f) => f.id)).size !== c.flows.length ||
        new Set(c.counters.map((v) => v.rule + ':' + v.source)).size !== c.counters.length
      )
        throw new Error('Estado IDS duplicado.');
      if (
        c.counters.some((v) => !c.rules.some((r) => r.id === v.rule) || v.startedAt > s.clock) ||
        c.alerts.some(
          (a) =>
            !c.rules.some((r) => r.id === a.rule) ||
            a.at > s.clock ||
            !d.interfaces.some((p) => p.id === a.port)
        ) ||
        c.flows.some((f) => f.lastAt > s.clock)
      )
        throw new Error('Referência/relógio IDS inválido.');
    }
}
