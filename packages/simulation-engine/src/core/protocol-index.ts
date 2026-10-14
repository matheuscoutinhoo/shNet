import type { Device, Snapshot } from '../model';
type Feature = 'bgp' | 'vrrp' | 'wireless' | 'lacp' | 'dot1x' | 'stp' | 'ups' | 'rack';
const caches = new WeakMap<
  Snapshot,
  { array: Device[]; length: number; features: Map<Feature, { device: Device; index: number }[]> }
>();
const participates = (d: Device, key: Feature) =>
  key === 'lacp'
    ? d.interfaces.some((p) => p.aggregate)
    : key === 'dot1x'
      ? d.interfaces.some((p) => p.dot1x || p.supplicant)
      : key === 'stp'
        ? Boolean(d.spanningTree || d.multiSpanningTree)
        : key === 'ups'
          ? d.infrastructure?.kind === 'ups'
          : key === 'rack'
            ? d.infrastructure?.kind === 'rack'
            : Boolean(d[key]);
/** Engine configuration APIs invalidate membership; state fields remain live references. */
export function invalidateProtocolIndex(s: Snapshot) {
  caches.delete(s);
}
export function protocolDevices(s: Snapshot, key: Feature): Device[] {
  let cache = caches.get(s);
  if (!cache || cache.array !== s.devices || cache.length !== s.devices.length) {
    cache = { array: s.devices, length: s.devices.length, features: new Map() };
    caches.set(s, cache);
  }
  let entries = cache.features.get(key);
  if (!entries || entries.some((e) => s.devices[e.index] !== e.device || !participates(e.device, key))) {
    entries = s.devices.flatMap((device, index) => (participates(device, key) ? [{ device, index }] : []));
    cache.features.set(key, entries);
  }
  return entries.map((e) => e.device);
}
