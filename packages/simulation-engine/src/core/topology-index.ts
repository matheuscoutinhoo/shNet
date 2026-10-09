import type { Device, Link, NetworkInterface, Snapshot } from '../model';
type Entry<T> = { value: T; index: number };
const devices = new WeakMap<Snapshot, { array: Device[]; length: number; map: Map<string, Entry<Device>> }>();
const ports = new WeakMap<
  Device,
  { array: NetworkInterface[]; length: number; map: Map<string, Entry<NetworkInterface>> }
>();
const links = new WeakMap<
  Snapshot,
  { array: Link[]; length: number; ids: Map<string, Entry<Link>>; ends: Map<string, Entry<Link>[]> }
>();
export function findDevice(s: Snapshot, id: string): Device | undefined {
  let cache = devices.get(s),
    item = cache?.map.get(id);
  if (
    !cache ||
    cache.array !== s.devices ||
    cache.length !== s.devices.length ||
    !item ||
    s.devices[item.index] !== item.value ||
    item.value.id !== id
  ) {
    cache = {
      array: s.devices,
      length: s.devices.length,
      map: new Map(s.devices.map((value, index) => [value.id, { value, index }])),
    };
    devices.set(s, cache);
    item = cache.map.get(id);
  }
  return item?.value;
}
export function findPort(d: Device, id: string): NetworkInterface | undefined {
  let cache = ports.get(d),
    item = cache?.map.get(id);
  if (
    !cache ||
    cache.array !== d.interfaces ||
    cache.length !== d.interfaces.length ||
    !item ||
    d.interfaces[item.index] !== item.value ||
    item.value.id !== id
  ) {
    cache = {
      array: d.interfaces,
      length: d.interfaces.length,
      map: new Map(d.interfaces.map((value, index) => [value.id, { value, index }])),
    };
    ports.set(d, cache);
    item = cache.map.get(id);
  }
  return item?.value;
}
const endKey = (device: string, port: string) => JSON.stringify([device, port]);
function build(s: Snapshot) {
  const ids = new Map<string, Entry<Link>>(),
    ends = new Map<string, Entry<Link>[]>();
  s.links.forEach((value, index) => {
    const entry = { value, index };
    ids.set(value.id, entry);
    for (const end of [value.a, value.b]) {
      const key = endKey(end.device, end.port);
      ends.set(key, [...(ends.get(key) ?? []), entry]);
    }
  });
  const cache = { array: s.links, length: s.links.length, ids, ends };
  links.set(s, cache);
  return cache;
}
export function findLink(s: Snapshot, id: string): Link | undefined {
  let cache = links.get(s),
    entry = cache?.ids.get(id);
  if (
    !cache ||
    cache.array !== s.links ||
    cache.length !== s.links.length ||
    !entry ||
    s.links[entry.index] !== entry.value ||
    entry.value.id !== id
  ) {
    cache = build(s);
    entry = cache.ids.get(id);
  }
  return entry?.value;
}
export function linksAt(s: Snapshot, device: string, port: string): Link[] {
  let cache = links.get(s),
    entries = cache?.ends.get(endKey(device, port));
  if (
    !cache ||
    cache.array !== s.links ||
    cache.length !== s.links.length ||
    !entries ||
    entries.some(
      (entry) =>
        s.links[entry.index] !== entry.value ||
        ![entry.value.a, entry.value.b].some((end) => end.device === device && end.port === port)
    )
  ) {
    cache = build(s);
    entries = cache.ends.get(endKey(device, port));
  }
  return entries?.map((entry) => entry.value) ?? [];
}
