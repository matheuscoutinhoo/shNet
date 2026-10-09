import type { SimulationEngine } from '../core/engine';
import {
  frameSchema,
  type Action,
  type Device,
  type Frame,
  type NetworkInterface,
  type Snapshot,
} from '../model';
import { qosConfigSchema } from './qos-model';
export function qosConfig(p: NetworkInterface) {
  const q = p.qos;
  return q
    ? {
        enabled: q.enabled,
        rateMbps: q.rateMbps,
        queueLimit: q.queueLimit,
        ...(q.ecnThreshold ? { ecnThreshold: q.ecnThreshold } : {}),
        scheduler: q.scheduler,
        classes: q.classes,
      }
    : { enabled: true, rateMbps: p.speed, queueLimit: 64, scheduler: 'priority' as const, classes: [] };
}
export function configureQos(e: SimulationEngine, d: Device, p: NetworkInterface, input: unknown) {
  const c = qosConfigSchema.parse(input);
  if (
    p.logical ||
    p.aggregate ||
    p.tunnel ||
    p.vxlan ||
    p.media === 'wifi' ||
    c.rateMbps > p.speed ||
    (c.ecnThreshold !== undefined && c.ecnThreshold > c.queueLimit) ||
    c.classes.some((c) => c.name === 'default') ||
    new Set(c.classes.map((p) => p.name)).size !== c.classes.length
  )
    throw new Error('QoS exige porta física cabeada, taxa até a velocidade e classes únicas.');
  for (const queued of p.qos?.queues ?? [])
    e.drop(
      d,
      'QoS: reconfiguração removeu frame pendente.',
      p.id,
      frameSchema.parse(JSON.parse(queued.frame))
    );
  p.qos = {
    ...c,
    token: e.id('qos'),
    cursor: 0,
    remaining: 0,
    queues: [],
    stats: [...c.classes.map((c) => ({ name: c.name, burst: c.burst })), { name: 'default', burst: 0 }].map(
      (c) => ({
        name: c.name,
        enqueued: 0,
        dequeued: 0,
        dropped: 0,
        bytes: 0,
        tokens: c.burst,
        updatedAt: e.state.clock,
      })
    ),
  };
  e.state.queue = e.state.queue.filter(
    ({ action: a }) => a.kind !== 'qos-tick' || a.device !== d.id || a.port !== p.id
  );
  e.emit('CONFIG_CHANGED', d.id, 'QoS ' + c.scheduler + ' ' + c.rateMbps + ' Mbps em ' + p.name + '.', {
    port: p.id,
  });
}
export function enqueueQos(e: SimulationEngine, d: Device, p: NetworkInterface, frame: Frame, link: string) {
  const q = p.qos;
  if (!q?.enabled) return false;
  const packet = frame.packet ?? frame.ipv6 ?? frame.fragment,
    rule = q.classes.find(
      (c) =>
        (c.protocol === 'any' ||
          c.protocol.toUpperCase() ===
            (frame.mpls ? 'MPLS' : packet?.protocol === 'ICMPv6' ? 'ICMP' : packet?.protocol)) &&
        (c.tc === undefined || frame.mpls?.labels[0].tc === c.tc) &&
        (c.destinationPort === undefined ||
          (packet && 'destinationPort' in packet && packet.destinationPort === c.destinationPort)) &&
        (c.dscp === undefined || (packet?.dscp ?? 0) === c.dscp)
    ),
    name = rule?.name ?? 'default',
    stats = q.stats.find((s) => s.name === name)!,
    bytes = (packet?.bytes ?? frame.mpls?.bytes ?? 28) + 18;
  if (rule?.policeMbps !== undefined) {
    stats.tokens = Math.min(
      rule.burst,
      stats.tokens + (e.state.clock - stats.updatedAt) * rule.policeMbps * 125
    );
    stats.updatedAt = e.state.clock;
    if (stats.tokens < bytes) {
      stats.dropped++;
      e.emit('QOS_DROP', d.id, 'Policer ' + name + ': orçamento de tokens insuficiente.', {
        port: p.id,
        frame,
      });
      e.drop(d, 'QoS policer ' + name + '.', p.id, frame);
      return true;
    }
    stats.tokens -= bytes;
  }
  if (q.queues.length >= q.queueLimit) {
    stats.dropped++;
    e.emit('QOS_DROP', d.id, 'QoS tail drop: fila cheia (' + q.queueLimit + ').', { port: p.id, frame });
    e.drop(d, 'QoS congestionamento.', p.id, frame);
    return true;
  }
  const tcp =
    frame.packet?.protocol === 'TCP'
      ? frame.packet
      : frame.ipv6?.protocol === 'TCP'
        ? frame.ipv6.segment
        : undefined;
  if (tcp?.data && tcp.ecn && q.ecnThreshold !== undefined && q.queues.length >= q.ecnThreshold) {
    tcp.ecn = 3;
    e.emit('QOS_MARK', d.id, 'ECN: congestionamento sinalizado por CE.', { port: p.id, frame });
  }
  if (rule?.mark !== undefined && packet) {
    packet.dscp = rule.mark;
    e.emit('QOS_MARK', d.id, name + ': DSCP ' + rule.mark + '.', { port: p.id, frame });
  }
  if (rule?.markTc !== undefined && frame.mpls) {
    frame.mpls.labels[0].tc = rule.markTc;
    e.emit('QOS_MARK', d.id, name + ': MPLS TC ' + rule.markTc + '.', { port: p.id, frame });
  }
  q.queues.push({
    class: name,
    frame: JSON.stringify(frameSchema.parse(frame)),
    bytes,
    at: e.state.clock,
    link,
  });
  stats.enqueued++;
  e.emit('QOS_ENQUEUE', d.id, name + ': ' + q.queues.length + ' frame(s) na fila.', { port: p.id, frame });
  if (q.timerAt === undefined) {
    q.timerAt = e.state.clock + 0.001;
    e.schedule(0.001, { kind: 'qos-tick', device: d.id, port: p.id, token: q.token });
  }
  return true;
}
export function handleQosTick(e: SimulationEngine, a: Extract<Action, { kind: 'qos-tick' }>) {
  const d = e.device(a.device),
    p = d.interfaces.find((p) => p.id === a.port)!,
    q = p.qos;
  if (!q || q.token !== a.token || q.timerAt !== e.state.clock) return;
  delete q.timerAt;
  if (!q.queues.length) return;
  const classes = [...q.classes, { name: 'default', priority: 0, weight: 1 }];
  let name: string;
  if (q.scheduler === 'priority') {
    const nonempty = classes
      .filter((c) => q.queues.some((f) => f.class === c.name))
      .sort((a, b) => b.priority - a.priority);
    name = nonempty[0].name;
  } else {
    let selected = classes[q.cursor];
    for (let n = 0; n < classes.length; n++) {
      if (q.queues.some((f) => f.class === selected.name)) break;
      q.cursor = (q.cursor + 1) % classes.length;
      q.remaining = 0;
      selected = classes[q.cursor];
    }
    name = selected.name;
    if (q.remaining === 0) q.remaining = selected.weight;
    q.remaining--;
    if (q.remaining === 0) q.cursor = (q.cursor + 1) % classes.length;
  }
  const at = q.queues.findIndex((f) => f.class === name),
    [item] = q.queues.splice(at, 1),
    frame = frameSchema.parse(JSON.parse(item.frame)),
    stats = q.stats.find((s) => s.name === name)!;
  stats.dequeued++;
  stats.bytes += item.bytes;
  e.emit('QOS_DEQUEUE', d.id, name + ': espera ' + (e.state.clock - item.at).toFixed(3) + ' ms.', {
    port: p.id,
    frame,
  });
  e.transmitQueued(d.id, p.id, frame, item.link);
  const delay = Math.max(0.001, (item.bytes * 8) / (Math.min(q.rateMbps, p.speed) * 1000));
  q.timerAt = e.state.clock + delay;
  e.schedule(delay, { kind: 'qos-tick', device: d.id, port: p.id, token: q.token });
}
export function validateQos(s: Snapshot) {
  const used = new Set<Action>();
  for (const d of s.devices)
    for (const p of d.interfaces) {
      const q = p.qos;
      if (!q) continue;
      const names = [...q.classes.map((c) => c.name), 'default'];
      if (
        p.logical ||
        p.aggregate ||
        p.tunnel ||
        p.vxlan ||
        p.media === 'wifi' ||
        q.rateMbps > p.speed ||
        new Set(names).size !== names.length ||
        q.cursor >= names.length ||
        q.stats.length !== names.length ||
        new Set(q.stats.map((n) => n.name)).size !== names.length ||
        q.stats.some((n) => !names.includes(n.name) || n.updatedAt > s.clock) ||
        q.queues.length > q.queueLimit
      )
        throw new Error('Estado/configuração QoS inválido.');
      for (const f of q.queues) {
        const frame = frameSchema.parse(JSON.parse(f.frame));
        if (
          f.bytes !==
            (frame.packet?.bytes ?? frame.fragment?.bytes ?? frame.ipv6?.bytes ?? frame.mpls?.bytes ?? 28) +
              18 ||
          !names.includes(f.class) ||
          f.at > s.clock ||
          !s.links.some(
            (l) => l.id === f.link && [l.a, l.b].some((end) => end.device === d.id && end.port === p.id)
          )
        )
          throw new Error('Frame na fila QoS inválido.');
      }
      const ticks = s.queue.filter(
        (v) => v.action.kind === 'qos-tick' && v.action.device === d.id && v.action.port === p.id
      );
      if (
        q.timerAt === undefined
          ? ticks.length > 0 || q.queues.length > 0
          : ticks.length !== 1 ||
            ticks[0].at !== q.timerAt ||
            (ticks[0].action as Extract<Action, { kind: 'qos-tick' }>).token !== q.token
      )
        throw new Error('Timer QoS inconsistente.');
      ticks.forEach((v) => used.add(v.action));
    }
  for (const v of s.queue)
    if (v.action.kind === 'qos-tick' && !used.has(v.action)) throw new Error('Timer QoS órfão.');
}
