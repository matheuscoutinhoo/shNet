import type { SimulationEngine } from '../core/engine';
import type { Device, Snapshot } from '../model';
import { interfaceOperational } from './layer3';
import { refreshHsrp } from './hsrp';
export function monitoring(e: SimulationEngine, d: Device) {
  return (d.monitoring ??= { token: e.id('monitor'), operations: [], tracks: [] });
}
export function scheduleMonitoring(e: SimulationEngine, d: Device) {
  const s = monitoring(e, d);
  if (s.tickAt !== undefined) return;
  s.tickAt = e.state.clock + 0.001;
  e.scheduleAt(s.tickAt, { kind: 'monitoring-tick', device: d.id, token: s.token });
}
export function monitorTick(e: SimulationEngine, d: Device, token: string) {
  const s = d.monitoring;
  if (!s || s.token !== token) return;
  delete s.tickAt;
  for (const op of s.operations) {
    if (!op.scheduled) continue;
    if (op.probe) {
      const p = e.state.probes.find((p) => p.id === op.probe);
      if (
        p?.status === 'success' ||
        p?.status !== 'pending' ||
        e.state.clock - (op.sentAt ?? 0) >= op.timeoutMs
      ) {
        op.status = p?.status === 'success' && (p.rtt ?? Infinity) <= op.timeoutMs ? 'up' : 'down';
        op.rtt = p?.rtt;
        delete op.probe;
        delete op.sentAt;
      }
    }
    if (!d.power) {
      op.status = 'down';
      continue;
    }
    if (op.target && !op.probe && (op.nextAt ?? 0) <= e.state.clock) {
      op.nextAt = e.state.clock + op.frequencyMs;
      try {
        op.probe = e.ping(d.id, op.target, 64, undefined, 84, false, op.sourcePort);
        op.sentAt = e.state.clock;
      } catch {
        op.status = 'down';
        e.emit('PACKET_DROPPED', d.id, `IP SLA ${op.id}: source address or probe capacity unavailable.`);
      }
    }
  }
  for (const t of s.tracks) {
    const p = t.port ? d.interfaces.find((p) => p.id === t.port) : undefined;
    const up =
      d.power &&
      (t.kind === 'sla'
        ? s.operations.find((o) => o.id === t.operation)?.status === 'up'
        : !!p && interfaceOperational(e.state, d, p));
    if (up !== t.state) {
      t.state = up;
      t.changedAt = e.state.clock;
      e.emit('CONFIG_CHANGED', d.id, `Object track ${t.id}: ${up ? 'Up' : 'Down'}.`);
    }
  }
  s.tickAt = e.state.clock + 1000;
  e.scheduleAt(s.tickAt, { kind: 'monitoring-tick', device: d.id, token: s.token });
  refreshHsrp(e);
}
export function validateMonitoring(s: Snapshot) {
  for (const d of s.devices) {
    const m = d.monitoring;
    if (!m) continue;
    if (
      new Set(m.operations.map((o) => o.id)).size !== m.operations.length ||
      new Set(m.tracks.map((t) => t.id)).size !== m.tracks.length ||
      m.operations.some((o) => o.sourcePort && !d.interfaces.some((p) => p.id === o.sourcePort)) ||
      m.tracks.some((t) => t.kind === 'interface' && !d.interfaces.some((p) => p.id === t.port))
    )
      throw new Error('Invalid IP SLA or tracking configuration.');
    const timers = s.queue.filter((q) => q.action.kind === 'monitoring-tick' && q.action.device === d.id);
    if (m.tickAt !== undefined && (timers.length !== 1 || timers[0].at !== m.tickAt))
      throw new Error('Invalid monitoring timer.');
  }
}
