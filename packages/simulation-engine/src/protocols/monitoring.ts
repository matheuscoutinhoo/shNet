import type { SimulationEngine } from '../core/engine';
import type { Device, Snapshot } from '../model';
import { interfaceOperational } from './layer3';
import { refreshHsrp } from './hsrp';
import { refreshVrrp } from './vrrp';
export function monitoring(e: SimulationEngine, d: Device) {
  return (d.monitoring ??= { token: e.id('monitor'), operations: [], tracks: [] });
}
/** Ping records an IP SLA operation still has to read; ping history trimming must keep them. */
export function slaProbeIds(s: Snapshot) {
  return new Set(
    s.devices.flatMap((d) => d.monitoring?.operations.flatMap((o) => (o.probe ? [o.probe] : [])) ?? [])
  );
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
      if (!p) {
        // The record was cleared from the ping history (e.g. by a scenario run), not lost on the
        // network: like IOS, the operation keeps its last result and probes at the next interval.
        delete op.probe;
        delete op.sentAt;
      } else if (p.status !== 'pending' || e.state.clock - (op.sentAt ?? 0) >= op.timeoutMs) {
        op.status = p.status === 'success' && (p.rtt ?? Infinity) <= op.timeoutMs ? 'up' : 'down';
        op.rtt = p.rtt;
        op.lastRun = op.sentAt;
        if (op.status === 'up') op.successes = (op.successes ?? 0) + 1;
        else op.failures = (op.failures ?? 0) + 1;
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
        op.lastRun = e.state.clock;
        op.failures = (op.failures ?? 0) + 1;
        e.emit('PACKET_DROPPED', d.id, `IP SLA ${op.id}: source address or probe capacity unavailable.`);
      }
    }
  }
  let changed = false;
  for (const t of s.tracks) {
    const p = t.port ? d.interfaces.find((p) => p.id === t.port) : undefined;
    const up =
      d.power &&
      (t.kind === 'sla'
        ? s.operations.find((o) => o.id === t.operation)?.status === 'up'
        : !!p && interfaceOperational(e.state, d, p));
    if (up !== t.state) {
      changed = true;
      t.state = up;
      t.changedAt = e.state.clock;
      t.changes = (t.changes ?? 0) + 1;
      const object =
        t.kind === 'sla' ? `ip sla ${t.operation} reachability` : `interface ${p?.name ?? ''} line-protocol`;
      e.emit('CONFIG_CHANGED', d.id, `%TRACK-6-STATE: ${t.id} ${object} ${up ? 'Down -> Up' : 'Up -> Down'}`);
    }
  }
  s.tickAt = e.state.clock + 1000;
  e.scheduleAt(s.tickAt, { kind: 'monitoring-tick', device: d.id, token: s.token });
  // VRRP and HSRP groups tracking these objects re-evaluate their priority.
  if (changed) refreshVrrp(e);
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
