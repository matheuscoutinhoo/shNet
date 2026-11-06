import { SimulationEngine } from './engine';
import { LIMITS, type Device, type NetworkInterface, type Snapshot } from '../model';
import { updateSystem } from '../devices/infrastructure';
import { invalidateCacheExpiry } from './cache-expiry';
import { invalidateSpanningRefresh } from '../protocols/stp';
import { invalidateBgpRefresh } from '../protocols/bgp';
// Above this size a UI delta compares only what events touched, with a full comparison every
// FULL_SWEEP_EVERY deltas; smaller labs are always compared in full (it costs little).
const INCREMENTAL_DEVICES = 40;
const FULL_SWEEP_EVERY = 10;
export interface SimulationDelta {
  metadata: Partial<Omit<Snapshot, 'devices' | 'queue' | 'events' | 'diagnostics' | 'capture'>>;
  deletedKeys: (keyof Snapshot)[];
  devices: Device[];
  devicePatches?: {
    id: string;
    values: Partial<Device>;
    deleted: (keyof Device)[];
    ports?: { id: string; values: Partial<NetworkInterface>; deleted: (keyof NetworkInterface)[] }[];
  }[];
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
  // Per device: JSON of each field (and of each port), as last sent to the UI.
  private devices = new Map<string, DeviceSignature>();
  private queue = new Map<number, string>();
  // Owning device of each known queue entry: its timers or in-flight frames changed when it goes.
  private queueDevices = new Map<number, string>();
  private metadata = new Map<keyof Snapshot, string>();
  private lastEvent?: string;
  private lastDiagnostic?: string;
  private lastFrame?: string;
  private advanceTarget?: number;
  private sinceFullSweep = 0;
  constructor(snapshot: unknown) {
    this.engine = new SimulationEngine(snapshot);
    this.engine.trackTouched();
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
    invalidateCacheExpiry(this.engine.state);
    invalidateSpanningRefresh(this.engine.state);
    invalidateBgpRefresh(this.engine.state);
    let processed = 0;
    while (processed < maxSteps && performance.now() - start < wallMs) {
      if (!this.engine.step(false, processed === 0)) break;
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
  /** A delta that compares the whole state, so the receiver ends with an exact copy. */
  sync() {
    this.sinceFullSweep = FULL_SWEEP_EVERY;
    return this.delta(0);
  }
  private delta(processed: number): SimulationDelta {
    const s = this.engine.state,
      devices: Device[] = [],
      ids = new Set(s.devices.map((d) => d.id));
    // Devices are compared only when an event, record or timer touched them. A periodic full sweep
    // also picks up bookkeeping refreshed without any of those (resource metrics, aging lists).
    const touched = this.engine.takeTouched();
    const full =
      !touched || s.devices.length <= INCREMENTAL_DEVICES || ++this.sinceFullSweep >= FULL_SWEEP_EVERY;
    if (full) this.sinceFullSweep = 0;
    const pending = new Set(s.queue.map((q) => q.order)),
      removedQueue = [...this.queue.keys()].filter((id) => !pending.has(id));
    removedQueue.forEach((id) => {
      const owner = this.queueDevices.get(id);
      if (owner) touched?.add(owner);
      this.queue.delete(id);
      this.queueDevices.delete(id);
    });
    const queue: Snapshot['queue'] = [];
    for (const q of s.queue) {
      const known = this.queue.has(q.order);
      if (known && !full) continue;
      const signature = JSON.stringify(q);
      if (signature !== this.queue.get(q.order)) {
        queue.push(q);
        this.queue.set(q.order, signature);
        const owner = 'device' in q.action ? (q.action.device as string) : undefined;
        if (owner) {
          this.queueDevices.set(q.order, owner);
          touched?.add(owner);
        }
      }
    }
    const devicePatches: NonNullable<SimulationDelta['devicePatches']> = [];
    const removedDevices = [...this.devices.keys()].filter((id) => !ids.has(id));
    removedDevices.forEach((id) => this.devices.delete(id));
    for (const d of s.devices) {
      const known = this.devices.get(d.id);
      if (!full && known && !touched!.has(d.id)) continue;
      if (!known) {
        devices.push(d);
        this.devices.set(d.id, deviceSignature(d));
        continue;
      }
      const patch = devicePatch(known, d);
      if (patch) devicePatches.push(patch);
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
      devicePatches,
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
function fieldPatch<T extends object>(before: T, after: T) {
  const values: Partial<T> = {};
  const deleted = (Object.keys(before) as (keyof T)[]).filter((key) => !(key in after));
  for (const key of Object.keys(after) as (keyof T)[])
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) values[key] = after[key];
  return { values, deleted };
}
interface DeviceSignature {
  fields: Map<keyof Device, string>;
  ports: Map<string, string>;
  order: string;
}
const portOrder = (d: Device) => d.interfaces.map((p) => p.id).join('\u0000');
function deviceSignature(d: Device): DeviceSignature {
  const fields = new Map<keyof Device, string>();
  for (const key of Object.keys(d) as (keyof Device)[])
    if (key !== 'interfaces') fields.set(key, JSON.stringify(d[key]));
  return {
    fields,
    ports: new Map(d.interfaces.map((p) => [p.id, JSON.stringify(p)])),
    order: portOrder(d),
  };
}
/** Changed fields and ports of a device since its signature, serializing each part once. */
function devicePatch(known: DeviceSignature, d: Device) {
  const values: Partial<Device> = {},
    deleted: (keyof Device)[] = [];
  for (const key of [...known.fields.keys()])
    if (!(key in d)) {
      deleted.push(key);
      known.fields.delete(key);
    }
  for (const key of Object.keys(d) as (keyof Device)[]) {
    if (key === 'interfaces') continue;
    const signature = JSON.stringify(d[key]);
    if (signature !== known.fields.get(key)) {
      Object.assign(values, { [key]: d[key] });
      known.fields.set(key, signature);
    }
  }
  let ports: NonNullable<SimulationDelta['devicePatches']>[number]['ports'];
  const order = portOrder(d);
  if (order !== known.order) {
    // Ports were added, removed or reordered: send the interface list whole.
    values.interfaces = d.interfaces;
    known.order = order;
    known.ports = new Map(d.interfaces.map((p) => [p.id, JSON.stringify(p)]));
  } else
    for (const p of d.interfaces) {
      const signature = JSON.stringify(p),
        before = known.ports.get(p.id)!;
      if (signature === before) continue;
      known.ports.set(p.id, signature);
      const changed = fieldPatch(JSON.parse(before) as NetworkInterface, p);
      if (Object.keys(changed.values).length || changed.deleted.length)
        (ports ??= []).push({ id: p.id, ...changed });
    }
  if (!Object.keys(values).length && !deleted.length && !ports) return undefined;
  return { id: d.id, values, deleted, ...(ports ? { ports } : {}) };
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
  const patches = new Map(delta.devicePatches?.map((p) => [p.id, p]) ?? []);
  if (patches.size)
    s.devices = s.devices.map((d) => {
      const patch = patches.get(d.id);
      if (!patch) return d;
      const next = { ...d, ...patch.values };
      for (const key of patch.deleted) delete next[key];
      if (patch.ports) {
        const ports = new Map(patch.ports.map((p) => [p.id, p]));
        next.interfaces = next.interfaces.map((p) => {
          const update = ports.get(p.id);
          if (!update) return p;
          const port = { ...p, ...update.values };
          for (const key of update.deleted) delete port[key];
          return port;
        });
      }
      return next;
    });
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
