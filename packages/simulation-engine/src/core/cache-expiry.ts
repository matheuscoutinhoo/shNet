import type { Snapshot } from '../model';
type Entry = { expires?: number; expiresAt?: number };
const indices = new WeakMap<Snapshot, WeakMap<object, { length: number; next: number }>>();
const deadlines = new WeakMap<Snapshot, number>();
export function invalidateCacheExpiry(snapshot: Snapshot) {
  indices.delete(snapshot);
  deadlines.delete(snapshot);
}
export function noteCacheExpiry(snapshot: Snapshot, at: number) {
  const current = deadlines.get(snapshot);
  if (current !== undefined && at < current) deadlines.set(snapshot, at);
}
function prune<T extends Entry>(snapshot: Snapshot, entries: T[], key: 'expires' | 'expiresAt') {
  let index = indices.get(snapshot);
  if (!index) {
    index = new WeakMap();
    indices.set(snapshot, index);
  }
  let bound = index.get(entries);
  if (!bound || bound.length !== entries.length) {
    bound = {
      length: entries.length,
      next: entries.reduce((at, entry) => Math.min(at, entry[key] ?? Infinity), Infinity),
    };
    index.set(entries, bound);
  }
  return bound.next > snapshot.clock
    ? entries
    : entries.filter((entry) => (entry[key] ?? Infinity) > snapshot.clock);
}
export function expireDeviceCaches(snapshot: Snapshot) {
  if ((deadlines.get(snapshot) ?? -Infinity) > snapshot.clock) return;
  // Learners replace these arrays when refreshing entries. Public execution
  // boundaries invalidate the index to include direct configuration edits.
  let next = Infinity;
  for (const device of snapshot.devices) {
    device.macTable = prune(snapshot, device.macTable, 'expires');
    device.arpTable = prune(snapshot, device.arpTable, 'expires');
    if (device.dnsCache) device.dnsCache = prune(snapshot, device.dnsCache, 'expiresAt');
    for (const entry of device.macTable) next = Math.min(next, entry.expires);
    for (const entry of device.arpTable) next = Math.min(next, entry.expires);
    for (const entry of device.dnsCache ?? []) next = Math.min(next, entry.expiresAt);
  }
  deadlines.set(snapshot, next);
}
