import type { Device } from '../model';
import type { BgpPath } from './bgp-model';
import { sameSubnet, subnet } from './ipv4';
export function validateRoutingPolicy(d: Device) {
  const p = d.routingPolicy;
  if (!p) return;
  if (
    new Set(p.prefixLists.map((l) => l.name)).size !== p.prefixLists.length ||
    new Set(p.routeMaps.map((r) => r.name + ':' + r.sequence)).size !== p.routeMaps.length
  )
    throw new Error('Duplicate routing policy.');
  for (const l of p.prefixLists) {
    if (
      new Set(l.entries.map((e) => e.sequence)).size !== l.entries.length ||
      l.entries.some(
        (e) =>
          subnet(e.network, e.prefix).network !== e.network ||
          (e.minPrefix ?? e.prefix) < e.prefix ||
          (e.maxPrefix ?? e.minPrefix ?? e.prefix) < (e.minPrefix ?? e.prefix)
      )
    )
      throw new Error('Invalid prefix-list entry.');
  }
}
export function prefixListPermits(
  d: Device,
  name: string | undefined,
  path: { network: string; prefix: number }
) {
  if (!name) return true;
  return (
    d.routingPolicy?.prefixLists
      .find((p) => p.name === name)
      ?.entries.slice()
      .sort((a, b) => a.sequence - b.sequence)
      .find(
        (r) =>
          sameSubnet(r.network, path.network, r.prefix) &&
          path.prefix >= (r.minPrefix ?? r.prefix) &&
          path.prefix <= (r.maxPrefix ?? r.minPrefix ?? r.prefix)
      )?.action === 'permit'
  );
}
export function applyRouteMap(d: Device, name: string | undefined, path: BgpPath): BgpPath | undefined {
  if (!name) return path;
  const entry = d.routingPolicy?.routeMaps
    .filter((r) => r.name === name)
    .sort((a, b) => a.sequence - b.sequence)
    .find((r) => !r.prefixLists.length || r.prefixLists.some((name) => prefixListPermits(d, name, path)));
  if (!entry || entry.action === 'deny') return;
  const asPath = [...entry.prepend, ...path.asPath];
  if (asPath.length > 32) return;
  return {
    ...path,
    asPath,
    ...(entry.localPref !== undefined ? { localPref: entry.localPref } : {}),
    ...(entry.metric !== undefined ? { med: entry.metric } : {}),
  };
}
