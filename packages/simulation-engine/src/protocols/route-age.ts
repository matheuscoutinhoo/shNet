import type { Device } from '../model';

type Path = { network: string; prefix: number; nextHop: string };
// When each dynamic route was installed, for the ages "show ip route" prints. Runtime-only data:
// routes first seen after a lab is loaded start counting at that moment.
const installed = new WeakMap<Device, Map<string, number>>();
const key = (kind: string, r: Path) => `${kind}|${r.network}/${r.prefix}|${r.nextHop}`;

/** Records the routes a protocol just installed; unchanged routes keep their age. */
export function noteInstalledRoutes(device: Device, kind: string, routes: Path[], now: number) {
  let table = installed.get(device);
  if (!table) installed.set(device, (table = new Map()));
  const current = new Set(routes.map((r) => key(kind, r)));
  for (const entry of current) if (!table.has(entry)) table.set(entry, now);
  for (const entry of [...table.keys()])
    if (entry.startsWith(kind + '|') && !current.has(entry)) table.delete(entry);
}
/** When the route was installed (the first time it is seen if its install was not observed). */
export function routeInstalledAt(device: Device, kind: string, route: Path, now: number) {
  let table = installed.get(device);
  if (!table) installed.set(device, (table = new Map()));
  const entry = key(kind, route);
  if (!table.has(entry)) table.set(entry, now);
  return table.get(entry)!;
}
