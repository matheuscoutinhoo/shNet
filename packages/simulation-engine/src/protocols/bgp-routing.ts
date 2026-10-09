import type { Device } from '../model';
import { ipNumber, sameSubnet, subnet, resolveRoute } from './ipv4';
import { BGP, bgpPrefixKey, type BgpNeighbor, type BgpPath, type BgpState } from './bgp-model';

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
export function bgpNextHop(device: Device, nextHop: string) {
  if (device.interfaces.some((port) => !port.vrf && port.ip === nextHop)) return;
  return resolveRoute({ ...device, bgp: undefined }, nextHop);
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
        bgpNextHop(device, route.nextHop)
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
export function bestBgpPaths(device: Device): BgpCandidate[] {
  const state = device.bgp;
  if (!state?.enabled || !device.power) return [];
  const paths: BgpCandidate[] = state.networks
    .filter((prefix) => isOriginated(device, prefix))
    .map((prefix) => ({
      ...prefix,
      nextHop: state.routerId,
      asPath: [],
      origin: 'IGP',
      localPref: 100,
      med: 0,
      external: false,
      remoteId: state.routerId,
    }));
  for (const path of state.rib) {
    const config = state.neighbors.find((peer) => peer.ip === path.peer),
      peer = state.peers.find((peer) => peer.ip === path.peer);
    const resolved = bgpNextHop(device, path.nextHop);
    if (!config || peer?.state !== 'Established' || !resolved || !bgpPermits(config.importFilter, path))
      continue;
    paths.push({
      ...path,
      port: resolved.port.id,
      gateway: resolved.nextHop,
      external: config.remoteAs !== state.asn,
      remoteId: peer.remoteId!,
    });
  }
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
  for (const key of [...new Set(paths.map(bgpPrefixKey))].sort()) {
    const candidates = paths.filter((path) => bgpPrefixKey(path) === key);
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
  const source = bgpNextHop(device, neighbor.ip)?.port.ip;
  if (!source) return [];
  return bestBgpPaths(device).flatMap((path) => {
    if (path.peer === neighbor.ip || !bgpPermits(neighbor.exportFilter, path)) return [];
    const learned = state.neighbors.find((peer) => peer.ip === path.peer);
    const reflection = !external && learned?.remoteAs === state.asn;
    if (reflection && !learned?.reflectorClient && !neighbor.reflectorClient) return [];
    const asPath = external ? [...Array(1 + neighbor.prepend).fill(state.asn), ...path.asPath] : path.asPath;
    if (asPath.length > 32 || (external && asPath.includes(neighbor.remoteAs))) return [];
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
        med: external ? neighbor.med : path.med,
        ...(!external && (reflection || path.originatorId)
          ? { originatorId: path.originatorId ?? path.remoteId }
          : {}),
        ...(!external && clusterList ? { clusterList } : {}),
      },
    ];
  });
}
