import type { Device, Snapshot } from '../model';

/**
 * Incremental validation context. After a local edit only the devices whose state or timers changed
 * need their per-device invariants rechecked; cross-device and orphan-timer checks always run.
 */
let changed: ReadonlySet<string> | undefined;
let current: Snapshot | undefined;
let timers: Map<string, Snapshot['queue']> | undefined;
let devices: Map<string, Device> | undefined;

export function withValidationScope<T>(s: Snapshot, scope: ReadonlySet<string> | undefined, run: () => T): T {
  const previous = { changed, current, timers, devices };
  changed = scope;
  current = s;
  timers = undefined;
  devices = undefined;
  try {
    return run();
  } finally {
    ({ changed, current, timers, devices } = previous);
  }
}

/** Whether per-device invariants of this device must be checked in the running validation. */
export const checkDevice = (id: string) => !changed || changed.has(id);

/** Queue entries of one device and action kind, indexed once per validation. */
export function deviceTimers(s: Snapshot, device: string, kind: string): Snapshot['queue'] {
  if (s !== current || !timers) {
    const index = new Map<string, Snapshot['queue']>();
    for (const item of s.queue) {
      const owner = 'device' in item.action ? (item.action.device as string) : undefined;
      if (owner === undefined) continue;
      const list = index.get(owner);
      if (list) list.push(item);
      else index.set(owner, [item]);
    }
    if (s !== current) return (index.get(device) ?? []).filter((q) => q.action.kind === kind);
    timers = index;
  }
  return (timers.get(device) ?? []).filter((q) => q.action.kind === kind);
}

/** Device lookup by ID, indexed once per validation. */
export function validatedDevice(s: Snapshot, id: string): Device | undefined {
  if (s !== current || !devices) {
    const index = new Map(s.devices.map((d) => [d.id, d]));
    if (s !== current) return index.get(id);
    devices = index;
  }
  return devices.get(id);
}
