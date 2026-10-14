import { SimulationEngine } from './engine';
import { LIMITS, type Device, type Snapshot } from '../model';
import { updateSystem } from '../devices/infrastructure';
export interface SimulationDelta {
  metadata: Partial<Omit<Snapshot, 'devices' | 'queue' | 'events' | 'diagnostics' | 'capture'>>;
  deletedKeys: (keyof Snapshot)[];
  devices: Device[];
  removedDevices: string[];
  queue: Snapshot['queue'];
  removedQueue: number[];
  events: Snapshot['events'];
  replaceEvents: boolean;
  diagnostics: Snapshot['events'];
  replaceDiagnostics: boolean;
  capture?: NonNullable<Snapshot['capture']>;
  captureRetained: number;
  replaceCapture: boolean;
  processed: number;
  pending: number;
}
export class SimulationRunner {
  readonly engine: SimulationEngine;
  private devices = new Map<string, string>();
  private queue = new Map<number, string>();
  private metadata = new Map<keyof Snapshot, string>();
  private lastEvent?: string;
  private lastDiagnostic?: string;
  private lastFrame?: string;
  private advanceTarget?: number;
  constructor(snapshot: unknown) {
    this.engine = new SimulationEngine(snapshot);
    this.delta(0);
  }
  step(maxSteps = 1, wallMs = 20) {
    if (
      !Number.isInteger(maxSteps) ||
      maxSteps < 1 ||
      maxSteps > 500 ||
      !Number.isFinite(wallMs) ||
      wallMs < 1 ||
      wallMs > 100
    )
      throw new Error('Orçamento do Worker inválido.');
    const start = performance.now();
    let processed = 0;
    while (processed < maxSteps && performance.now() - start < wallMs) {
      if (!this.engine.step()) break;
      processed++;
    }
    for (const d of this.engine.state.devices)
      if (d.system && this.engine.state.clock - d.system.lastAt >= 1000) updateSystem(this.engine.state, d);
    return this.delta(processed);
  }
  advanceUntil(time: number, wallMs = 20) {
    if (!Number.isFinite(time) || time < this.engine.state.clock)
      throw new Error('Instante virtual inválido.');
    const fresh = this.advanceTarget === undefined,
      target = this.advanceTarget ?? time;
    this.advanceTarget = target;
    const processed = this.engine.advanceTo(target, 20000, wallMs, fresh);
    if (this.engine.state.clock >= target && (this.engine.state.queue[0]?.at ?? Infinity) > target)
      this.advanceTarget = undefined;
    return this.delta(processed);
  }
  private delta(processed: number): SimulationDelta {
    const s = this.engine.state,
      devices: Device[] = [],
      ids = new Set(s.devices.map((d) => d.id));
    const removedDevices = [...this.devices.keys()].filter((id) => !ids.has(id));
    removedDevices.forEach((id) => this.devices.delete(id));
    for (const d of s.devices) {
      const signature = JSON.stringify(d);
      if (signature !== this.devices.get(d.id)) {
        devices.push(d);
        this.devices.set(d.id, signature);
      }
    }
    const pending = new Set(s.queue.map((q) => q.order)),
      removedQueue = [...this.queue.keys()].filter((id) => !pending.has(id));
    removedQueue.forEach((id) => this.queue.delete(id));
    const queue: Snapshot['queue'] = [];
    for (const q of s.queue) {
      const signature = JSON.stringify(q);
      if (signature !== this.queue.get(q.order)) {
        queue.push(q);
        this.queue.set(q.order, signature);
      }
    }
    const metadata: SimulationDelta['metadata'] = {},
      deletedKeys: (keyof Snapshot)[] = [];
    for (const key of this.metadata.keys())
      if (!(key in s)) {
        deletedKeys.push(key);
        this.metadata.delete(key);
      }
    for (const [key, value] of Object.entries(s)) {
      if (['devices', 'queue', 'events', 'diagnostics', 'capture'].includes(key)) continue;
      const signature = JSON.stringify(value),
        k = key as keyof Snapshot;
      if (signature !== this.metadata.get(k)) {
        Object.assign(metadata, { [key]: value });
        this.metadata.set(k, signature);
      }
    }
    const at = this.lastEvent ? s.events.findIndex((e) => e.id === this.lastEvent) : -1,
      replaceEvents = Boolean(this.lastEvent && at < 0),
      events = at >= 0 ? s.events.slice(at + 1) : s.events;
    this.lastEvent = s.events.at(-1)?.id;
    const diagnosticAt = this.lastDiagnostic
      ? (s.diagnostics ?? []).findIndex((e) => e.id === this.lastDiagnostic)
      : -1;
    const diagnostics = diagnosticAt >= 0 ? s.diagnostics!.slice(diagnosticAt + 1) : (s.diagnostics ?? []);
    const replaceDiagnostics = diagnosticAt < 0;
    this.lastDiagnostic = s.diagnostics?.at(-1)?.id;
    const frameAt = this.lastFrame ? (s.capture?.frames ?? []).findIndex((e) => e.id === this.lastFrame) : -1;
    const capture = s.capture
      ? { ...s.capture, frames: frameAt >= 0 ? s.capture.frames.slice(frameAt + 1) : s.capture.frames }
      : undefined;
    const replaceCapture = frameAt < 0;
    this.lastFrame = s.capture?.frames.at(-1)?.id;
    return {
      metadata,
      deletedKeys,
      devices,
      removedDevices,
      queue,
      removedQueue,
      events,
      replaceEvents,
      diagnostics,
      replaceDiagnostics,
      capture,
      captureRetained: s.capture?.frames.length ?? 0,
      replaceCapture,
      processed,
      pending: s.queue.length,
    };
  }
}
export function applySimulationDelta(s: Snapshot, delta: SimulationDelta) {
  const changed = new Map(delta.devices.map((d) => [d.id, d])),
    removed = new Set(delta.removedDevices);
  s.devices = s.devices
    .filter((d) => !removed.has(d.id))
    .map((d) => {
      const next = changed.get(d.id);
      changed.delete(d.id);
      return next ?? d;
    });
  s.devices.push(...changed.values());
  const queue = new Map(s.queue.map((q) => [q.order, q]));
  delta.removedQueue.forEach((id) => queue.delete(id));
  delta.queue.forEach((q) => queue.set(q.order, q));
  s.queue = [...queue.values()].sort((a, b) => a.at - b.at || a.order - b.order);
  s.events = (delta.replaceEvents ? delta.events : [...s.events, ...delta.events]).slice(-LIMITS.events);
  if (delta.diagnostics.length || s.diagnostics)
    s.diagnostics = (
      delta.replaceDiagnostics ? delta.diagnostics : [...(s.diagnostics ?? []), ...delta.diagnostics]
    ).slice(-LIMITS.diagnostics);
  if (delta.capture)
    s.capture = {
      ...delta.capture,
      frames:
        delta.captureRetained === 0
          ? []
          : (delta.replaceCapture
              ? delta.capture.frames
              : [...(s.capture?.frames ?? []), ...delta.capture.frames]
            ).slice(-delta.captureRetained),
    };
  else delete s.capture;
  for (const key of delta.deletedKeys) delete (s as Partial<Snapshot>)[key];
  Object.assign(s, delta.metadata);
}
