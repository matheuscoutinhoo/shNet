import type { Device, Link, NetworkInterface, Snapshot } from '../model';
type Entry<T> = { value: T; index: number };
const devices = new WeakMap<Snapshot, { array: Device[]; length: number; map: Map<string, Entry<Device>> }>();
const ports = new WeakMap<
  Device,
  { array: NetworkInterface[]; length: number; map: Map<string, Entry<NetworkInterface>> }
>();
type Ends = { entries: Entry<Link>[]; values: Link[] };
const links = new WeakMap<
  Snapshot,
  {
    array: Link[];
    length: number;
    ids: Map<string, Entry<Link>>;
    // device id → port id → cables at that port; nested maps avoid building a key per lookup.
    ends: Map<string, Map<string, Ends>>;
  }
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
function build(s: Snapshot) {
  const ids = new Map<string, Entry<Link>>(),
    ends = new Map<string, Map<string, Ends>>();
  const at = (device: string, port: string) => {
    let byPort = ends.get(device);
    if (!byPort) ends.set(device, (byPort = new Map()));
    let found = byPort.get(port);
    if (!found) byPort.set(port, (found = { entries: [], values: [] }));
    return found;
  };
  // An unconnected, known port is a valid cached result. Otherwise every carrier
  // check on a spare port rebuilds the entire graph.
  for (const d of s.devices) for (const p of d.interfaces) at(d.id, p.id);
  s.links.forEach((value, index) => {
    const entry = { value, index };
    ids.set(value.id, entry);
    for (const end of [value.a, value.b]) {
      const found = at(end.device, end.port);
      found.entries.push(entry);
      found.values.push(value);
    }
  });
  const cache = { array: s.links, length: s.links.length, ids, ends };
  links.set(s, cache);
  return cache;
}
/** Call after changing link endpoints in place; normal connect/remove replaces or grows the array. */
export function invalidateTopologyIndex(s: Snapshot) {
  links.delete(s);
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
    found = cache?.ends.get(device)?.get(port);
  if (
    !cache ||
    cache.array !== s.links ||
    cache.length !== s.links.length ||
    !found ||
    found.entries.some(
      (entry) =>
        s.links[entry.index] !== entry.value ||
        !(
          (entry.value.a.device === device && entry.value.a.port === port) ||
          (entry.value.b.device === device && entry.value.b.port === port)
        )
    )
  ) {
    cache = build(s);
    found = cache.ends.get(device)?.get(port);
  }
  // Callers only read the result; a shared array avoids an allocation per carrier check.
  return found?.values ?? [];
}
