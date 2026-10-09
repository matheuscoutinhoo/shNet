import type { SimulationEngine } from '../core/engine';
import type { Action, Device, UdpPacket, Snapshot } from '../model';
import { telemetryConfigSchema, collectorConfigSchema } from './telemetry-model';
import { modelDigest } from './model-cipher';
import { resolveRoute } from './ipv4';
import { isUnicast } from './dhcp-config';
export function telemetryConfig(d: Device) {
  const s = d.telemetry;
  if (!s) throw new Error('Telemetria ausente.');
  const { enabled, collector, key, intervalMs, sensors } = s;
  return { enabled, collector, key, intervalMs, sensors };
}
export function configureTelemetry(e: SimulationEngine, d: Device, input: unknown) {
  const c = telemetryConfigSchema.parse(input);
  if (!isUnicast(c.collector) || new Set(c.sensors).size !== c.sensors.length)
    throw new Error('Coletor/sensores de telemetria inválidos.');
  e.state.queue = e.state.queue.filter((q) => q.action.kind !== 'telemetry-tick' || q.action.device !== d.id);
  d.telemetry = {
    ...c,
    stream: e.id('telemetry'),
    sequence: 0,
    token: e.id('telemetry-token'),
    tickAt: e.state.clock + 0.001,
    sent: 0,
  };
  e.schedule(0.001, { kind: 'telemetry-tick', device: d.id, token: d.telemetry.token });
  e.emit('CONFIG_CHANGED', d.id, 'Publicação periódica de telemetria configurada.');
}
export function configureCollector(e: SimulationEngine, d: Device, input: unknown) {
  if (d.type === 'pc') throw new Error('Coletor exige servidor/roteador/switch L3.');
  d.telemetryCollector = {
    ...collectorConfigSchema.parse(input),
    records: [],
    streams: [],
    received: 0,
    rejected: 0,
  };
  e.emit('CONFIG_CHANGED', d.id, 'Coletor UDP57500 configurado.');
}
export function telemetryMetrics(d: Device) {
  const metrics: { path: string; value: number }[] = [],
    s = d.telemetry?.sensors ?? [];
  const add = (path: string, value: number) => metrics.push({ path, value });
  if (s.includes('interfaces'))
    for (const p of d.interfaces) {
      add('/interfaces/' + p.id + '/rx', p.rx);
      add('/interfaces/' + p.id + '/tx', p.tx);
      add('/interfaces/' + p.id + '/admin-up', Number(p.adminUp));
      add('/interfaces/' + p.id + '/errors', p.errors);
    }
  if (s.includes('routes')) {
    add('/routing/static/count', d.routes.length);
    add('/routing/bgp/count', d.bgp?.routes.length ?? 0);
    add('/routing/ospf/count', d.ospf?.routes.length ?? 0);
    add('/routing/rip/count', d.rip?.table.length ?? 0);
  }
  if (s.includes('tcp')) {
    add('/tcp/connections', d.tcpConnections?.length ?? 0);
    add('/firewall/drops', d.firewall?.dropped ?? 0);
  }
  if (s.includes('qos'))
    for (const p of d.interfaces)
      if (p.qos) {
        add('/qos/' + p.id + '/depth', p.qos.queues.length);
        add(
          '/qos/' + p.id + '/drops',
          p.qos.stats.reduce((n, c) => n + c.dropped, 0)
        );
      }
  if (s.includes('aaa')) {
    add('/aaa/accepted', d.aaaServer?.accepted ?? 0);
    add('/aaa/rejected', d.aaaServer?.rejected ?? 0);
    add('/dot1x/authorized', d.interfaces.filter((p) => p.dot1x?.phase === 'authorized').length);
  }
  return metrics.slice(0, 256);
}
function tag(message: Record<string, unknown>, key: string) {
  const { tag: _tag, ...data } = message;
  return modelDigest(key + '|' + JSON.stringify(data));
}
export function handleTelemetry(e: SimulationEngine, a: Extract<Action, { kind: 'telemetry-tick' }>) {
  const d = e.device(a.device),
    s = d.telemetry;
  if (!s || s.token !== a.token || s.tickAt !== e.state.clock) return;
  const route = resolveRoute(d, s.collector);
  if (s.enabled && d.power && route?.port.ip) {
    const metrics = telemetryMetrics(d),
      pending = [...metrics],
      limit = Math.min(1200, route.port.mtu - 28);
    while (pending.length) {
      const body = {
        stream: s.stream,
        sequence: s.sequence + 1,
        hostname: d.hostname,
        timestamp: e.state.clock + (d.networkClock?.offsetMs ?? 0),
        metrics: [] as typeof metrics,
      };
      while (
        pending.length &&
        new TextEncoder().encode(
          JSON.stringify({ ...body, metrics: [...body.metrics, pending[0]], tag: '00000000' })
        ).length <= limit
      )
        body.metrics.push(pending.shift()!);
      if (!body.metrics.length) {
        e.drop(d, 'Telemetria: sensor excede MTU.');
        break;
      }
      const message = { ...body, tag: tag(body, s.key) },
        bytes = 28 + new TextEncoder().encode(JSON.stringify(message)).length;
      s.sequence++;
      s.sent++;
      e.sendIp(d.id, {
        protocol: 'UDP',
        src: route.port.ip,
        dst: s.collector,
        sourcePort: 57501,
        destinationPort: 57500,
        ttl: 64,
        bytes,
        payload: { protocol: 'TELEMETRY', message },
      });
      e.emit(
        'TELEMETRY_SENT',
        d.id,
        'Amostra ' + s.sequence + ' com ' + message.metrics.length + ' sensores enviada ao coletor.'
      );
    }
  } else if (s.enabled) e.drop(d, 'Telemetria: sem IPv4/rota ou equipamento desligado.');
  s.tickAt = e.state.clock + s.intervalMs;
  e.schedule(s.intervalMs, { kind: 'telemetry-tick', device: d.id, token: s.token });
}
export function receiveTelemetry(e: SimulationEngine, d: Device, p: UdpPacket) {
  if (p.payload.protocol !== 'TELEMETRY') return;
  const c = d.telemetryCollector,
    m = p.payload.message;
  if (
    !c?.enabled ||
    p.destinationPort !== 57500 ||
    !isUnicast(p.src) ||
    tag(m, c.key) !== m.tag ||
    p.bytes !== 28 + new TextEncoder().encode(JSON.stringify(m)).length
  ) {
    if (c) c.rejected++;
    e.drop(d, 'Telemetria: coletor, origem, comprimento ou integridade inválidos.');
    return;
  }
  let stream = c.streams.find((s) => s.source === p.src && s.id === m.stream);
  if (stream && (stream.receivedSequences.includes(m.sequence) || m.sequence <= stream.lastSequence - 64)) {
    c.rejected++;
    e.drop(d, 'Telemetria: replay/ordem antiga.');
    return;
  }
  if (!stream) {
    if (c.streams.length >= 128) c.streams.shift();
    stream = { source: p.src, id: m.stream, lastSequence: m.sequence, receivedSequences: [m.sequence] };
    c.streams.push(stream);
  }
  stream.lastSequence = Math.max(stream.lastSequence, m.sequence);
  stream.receivedSequences = [...new Set([...stream.receivedSequences, m.sequence])]
    .sort((a, b) => a - b)
    .slice(-64);
  c.received++;
  c.records.push({ source: p.src, receivedAt: e.state.clock, message: m });
  c.records = c.records.slice(-256);
  e.emit('TELEMETRY_RECEIVED', d.id, 'Amostra ' + m.sequence + ' de ' + p.src + ' recebida.');
}
export function validateTelemetry(s: Snapshot) {
  for (const d of s.devices) {
    const t = d.telemetry;
    if (t) {
      const timers = s.queue.filter((q) => q.action.kind === 'telemetry-tick' && q.action.device === d.id);
      if (
        !isUnicast(t.collector) ||
        new Set(t.sensors).size !== t.sensors.length ||
        t.sent !== t.sequence ||
        timers.length !== 1 ||
        timers[0].at !== t.tickAt ||
        timers[0].action.kind !== 'telemetry-tick' ||
        timers[0].action.token !== t.token
      )
        throw new Error('Estado/timer de telemetria inválido.');
    }
    const c = d.telemetryCollector;
    if (
      c &&
      (d.type === 'pc' ||
        new Set(c.streams.map((n) => n.source + '/' + n.id)).size !== c.streams.length ||
        c.streams.some(
          (n) =>
            new Set(n.receivedSequences).size !== n.receivedSequences.length ||
            Math.max(...n.receivedSequences) !== n.lastSequence
        ) ||
        c.records.some(
          (r) => r.receivedAt > s.clock || !isUnicast(r.source) || tag(r.message, c.key) !== r.message.tag
        ))
    )
      throw new Error('Coletor de telemetria inválido.');
  }
  for (const q of s.queue) {
    const a = q.action;
    if (a.kind === 'telemetry-tick' && !s.devices.some((d) => d.id === a.device && d.telemetry))
      throw new Error('Timer de telemetria órfão.');
  }
}
