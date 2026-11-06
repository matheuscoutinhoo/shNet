import type { Device, Snapshot } from '../model';
import { ipNumber, sameSubnet, subnet, resolveRoute, staticRouteInstalled } from './ipv4';
import {
  BGP,
  bgpNeighborActive,
  bgpPrefixKey,
  type BgpNeighbor,
  type BgpPath,
  type BgpRedistribution,
  type BgpState,
} from './bgp-model';
import { applyRouteMap, prefixListPermits } from './routing-policy';
import { interfaceUp } from './layer3';
import { ripRoutes } from './rip';

export function validBgpPrefix(path: { network: string; prefix: number }) {
  return subnet(path.network, path.prefix).network === path.network && ipNumber(path.network) < 0xe0000000;
}
export function bgpPermits(filter: BgpNeighbor['importFilter'], path: BgpPath) {
  if (!filter.length) return true;
  return (
    [...filter]
      .sort((a, b) => a.sequence - b.sequence)
      .find(
        (rule) =>
          sameSubnet(rule.network, path.network, rule.prefix) &&
          path.prefix >= (rule.minPrefix ?? rule.prefix) &&
          path.prefix <= (rule.maxPrefix ?? rule.minPrefix ?? rule.prefix)
      )?.action === 'permit'
  );
}
// NEXT_HOP must resolve through the IGP/static underlay, never through its own BGP route.
export function bgpNextHop(device: Device, nextHop: string, snapshot?: Snapshot) {
  if (device.interfaces.some((port) => !port.vrf && port.ip === nextHop)) return;
  return resolveRoute({ ...device, bgp: undefined }, nextHop, undefined, snapshot);
}
function isOriginated(device: Device, prefix: { network: string; prefix: number }) {
  return (
    device.interfaces.some(
      (port) =>
        port.adminUp &&
        !port.vrf &&
        port.ip &&
        port.prefix === prefix.prefix &&
        sameSubnet(port.ip, prefix.network, prefix.prefix)
    ) ||
    device.routes.some(
      (route) =>
        !route.vrf &&
        route.network === prefix.network &&
        route.prefix === prefix.prefix &&
        // Null0 and interface statics count as soon as IOS installs them; recursive ones need their next hop.
        staticRouteInstalled({ ...device, bgp: undefined }, route)
    ) ||
    [
      ...(device.ospf?.enabled ? device.ospf.routes : []),
      ...(device.rip?.enabled ? device.rip.table.filter((route) => route.metric < 16) : []),
    ].some(
      (route) =>
        route.network === prefix.network &&
        route.prefix === prefix.prefix &&
        bgpNextHop(device, route.nextHop)
    )
  );
}
export type BgpCandidate = BgpPath & {
  peer?: string;
  port?: string;
  gateway?: string;
  external: boolean;
  remoteId: string;
};
/** Prefixes "redistribute SOURCE" brings into BGP, with the source metric (IOS copies it to the MED). */
function redistributedRoutes(device: Device, r: BgpRedistribution) {
  const plain = { ...device, bgp: undefined };
  const routes =
    r.source === 'connected'
      ? device.interfaces
          .filter((p) => !p.vrf && p.ip && p.prefix !== undefined && interfaceUp(device, p))
          .map((p) => ({ network: subnet(p.ip!, p.prefix!).network, prefix: p.prefix!, metric: 0 }))
      : r.source === 'static'
        ? device.routes
            .filter((route) => !route.vrf && staticRouteInstalled(plain, route))
            .map((route) => ({ network: route.network, prefix: route.prefix, metric: 0 }))
        : r.source === 'ospf'
          ? // Without "match external", IOS redistributes only intra- and inter-area OSPF routes.
            device.ospf?.enabled && (r.process === undefined || (device.ospf.processId ?? 1) === r.process)
            ? device.ospf.routes.filter(
                (route) => !route.pathType || ['intra', 'inter'].includes(route.pathType)
              )
            : []
          : ripRoutes(device);
  const unique = new Map(routes.map((route) => [bgpPrefixKey(route), route]));
  return [...unique.values()].map((route) => ({
    network: route.network,
    prefix: route.prefix,
    metric: r.metric ?? route.metric,
  }));
}
/** Locally originated and accepted (policy-permitted, resolvable) paths: the "valid" BGP paths. */
export function bgpCandidates(device: Device): BgpCandidate[] {
  const state = device.bgp;
  if (!state?.enabled || !device.power) return [];
  const local = (prefix: { network: string; prefix: number }, origin: BgpPath['origin'], med = 0) => ({
    network: prefix.network,
    prefix: prefix.prefix,
    nextHop: state.routerId,
    asPath: [] as number[],
    origin,
    localPref: 100,
    med,
    external: false,
    remoteId: state.routerId,
  });
  const paths: BgpCandidate[] = state.networks
    .filter((prefix) => isOriginated(device, prefix))
    .map((prefix) => local(prefix, 'IGP'));
  for (const r of state.redistribute ?? [])
    for (const route of redistributedRoutes(device, r)) {
      if (!validBgpPrefix(route) || paths.some((path) => bgpPrefixKey(path) === bgpPrefixKey(route)))
        continue;
      const path = local(route, 'INCOMPLETE', route.metric);
      const mapped = r.routeMap ? applyRouteMap(device, r.routeMap, path) : path;
      if (mapped) paths.push({ ...path, ...mapped });
    }
  // Many paths share a next hop; resolve each one once per selection.
  const nextHops = new Map<string, ReturnType<typeof bgpNextHop>>();
  for (const path of state.rib) {
    const config = state.neighbors.find((peer) => peer.ip === path.peer),
      peer = state.peers.find((peer) => peer.ip === path.peer);
    if (!nextHops.has(path.nextHop)) nextHops.set(path.nextHop, bgpNextHop(device, path.nextHop));
    const resolved = nextHops.get(path.nextHop);
    if (
      !config ||
      peer?.state !== 'Established' ||
      !resolved ||
      !bgpPermits(config.importFilter, path) ||
      !prefixListPermits(device, config.importPrefixList, path)
    )
      continue;
    const mapped = applyRouteMap(device, config.importRouteMap, path);
    if (!mapped) continue;
    paths.push({
      ...path,
      ...mapped,
      port: resolved.port.id,
      gateway: resolved.nextHop,
      external: config.remoteAs !== state.asn,
      remoteId: peer.remoteId!,
    });
  }
  // "aggregate-address": originated while at least one more specific path is in the BGP table.
  for (const aggregate of state.aggregates ?? []) {
    const contributors = paths.filter(
      (path) =>
        path.prefix > aggregate.prefix && sameSubnet(path.network, aggregate.network, aggregate.prefix)
    );
    if (!contributors.length) continue;
    paths.push({
      ...local(aggregate, 'IGP'),
      asPath: aggregate.asSet ? [...new Set(contributors.flatMap((path) => path.asPath))].slice(0, 32) : [],
    });
  }
  return paths;
}
export function bestBgpPaths(device: Device): BgpCandidate[] {
  const state = device.bgp;
  if (!state?.enabled || !device.power) return [];
  const paths = bgpCandidates(device);
  const origin = { IGP: 0, EGP: 1, INCOMPLETE: 2 };
  const compare = (a: BgpCandidate, b: BgpCandidate, med = false) =>
    Number(!!a.peer) - Number(!!b.peer) ||
    b.localPref - a.localPref ||
    a.asPath.length - b.asPath.length ||
    origin[a.origin] - origin[b.origin] ||
    (med ? a.med - b.med : 0) ||
    Number(b.external) - Number(a.external) ||
    ipNumber(a.remoteId) - ipNumber(b.remoteId) ||
    ipNumber(a.peer ?? state.routerId) - ipNumber(b.peer ?? state.routerId);
  const result: BgpCandidate[] = [];
  const byPrefix = new Map<string, BgpCandidate[]>();
  for (const path of paths) {
    const key = bgpPrefixKey(path),
      group = byPrefix.get(key);
    if (group) group.push(path);
    else byPrefix.set(key, [path]);
  }
  for (const key of [...byPrefix.keys()].sort()) {
    const candidates = byPrefix.get(key)!;
    // Deterministic MED: compare MED within an origin AS before comparing across ASes.
    const winners = [...new Set(candidates.map((path) => path.asPath[0] ?? state.asn))].map(
      (asn) =>
        candidates
          .filter((path) => (path.asPath[0] ?? state.asn) === asn)
          .sort((a, b) => compare(a, b, true))[0]
    );
    result.push(winners.sort((a, b) => compare(a, b))[0]);
  }
  return result.slice(0, BGP.maxRoutes);
}
export function installedBgpRoutes(device: Device): BgpState['routes'] {
  return bestBgpPaths(device)
    .filter((path) => path.peer && path.port && path.gateway)
    .map((path) => ({
      network: path.network,
      prefix: path.prefix,
      port: path.port!,
      nextHop: path.gateway!,
      peer: path.peer!,
      distance: path.external ? 20 : 200,
      metric: path.med,
    }));
}
export function exportedBgpPaths(device: Device, neighbor: BgpNeighbor): BgpPath[] {
  const state = device.bgp!,
    external = state.asn !== neighbor.remoteAs;
  if (!bgpNeighborActive(state, neighbor)) return [];
  const source = bgpNextHop(device, neighbor.ip)?.port.ip;
  if (!source) return [];
  const best = bestBgpPaths(device);
  // "summary-only" aggregates suppress their more specific paths toward every neighbor.
  const summaries = (state.aggregates ?? []).filter(
    (aggregate) =>
      aggregate.summaryOnly && best.some((path) => bgpPrefixKey(path) === bgpPrefixKey(aggregate))
  );
  const exported = best.flatMap((original) => {
    if (
      summaries.some(
        (aggregate) =>
          original.prefix > aggregate.prefix &&
          sameSubnet(original.network, aggregate.network, aggregate.prefix)
      ) ||
      (neighbor.defaultOriginate && original.prefix === 0)
    )
      return [];
    const mapped = applyRouteMap(device, neighbor.exportRouteMap, original);
    if (!mapped) return [];
    const path = { ...original, ...mapped };
    if (
      path.peer === neighbor.ip ||
      !bgpPermits(neighbor.exportFilter, path) ||
      !prefixListPermits(device, neighbor.exportPrefixList, path)
    )
      return [];
    const learned = state.neighbors.find((peer) => peer.ip === path.peer);
    const reflection = !external && learned?.remoteAs === state.asn;
    if (reflection && !learned?.reflectorClient && !neighbor.reflectorClient) return [];
    const asPath = external ? [...Array(1 + neighbor.prepend).fill(state.asn), ...path.asPath] : path.asPath;
    // Like IOS, a path is sent even if it contains the neighbor's AS: the receiver drops it unless
    // it uses "allowas-in" (or the provider "as-override").
    if (asPath.length > 32) return [];
    const clusterList = reflection ? [...(path.clusterList ?? []), state.routerId] : path.clusterList;
    if ((clusterList?.length ?? 0) > 16) return [];
    return [
      {
        network: path.network,
        prefix: path.prefix,
        nextHop: external || neighbor.nextHopSelf || !path.peer ? source : path.nextHop,
        asPath,
        origin: path.origin,
        localPref: external ? 100 : path.localPref,
        med: external ? (neighbor.exportRouteMap ? path.med : neighbor.med) : path.med,
        ...(!external && (reflection || path.originatorId)
          ? { originatorId: path.originatorId ?? path.remoteId }
          : {}),
        ...(!external && clusterList ? { clusterList } : {}),
      },
    ];
  });
  // "neighbor X default-originate [route-map M]": a default route regardless of the local table,
  // or only while the route-map matches a path in it.
  const condition = neighbor.defaultOriginate;
  const originate =
    condition === true ||
    (!!condition && best.some((path) => applyRouteMap(device, condition.routeMap, path) !== undefined));
  if (!originate) return exported;
  return [
    {
      network: '0.0.0.0',
      prefix: 0,
      nextHop: source,
      asPath: external ? Array(1 + neighbor.prepend).fill(state.asn) : [],
      origin: 'IGP',
      localPref: 100,
      med: 0,
    },
    ...exported,
  ];
}
