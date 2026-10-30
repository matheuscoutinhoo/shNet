import type { Device } from '../model';
import { type DynamicRoute, type OspfLsa } from './ospf-model';
import { sameSubnet } from './ipv4';

type NextHop = { port: string; nextHop: string };
type Hop = { cost: number; port?: string; nextHop?: string; alternatives?: NextHop[] };
const hops = (path: Hop): NextHop[] =>
  path.alternatives ?? (path.port && path.nextHop ? [{ port: path.port, nextHop: path.nextHop }] : []);
function mergeHops(values: NextHop[], maximum = 32) {
  return [...new Map(values.map((h) => [h.nextHop + ':' + h.port, h])).values()]
    .sort((a, b) => a.nextHop.localeCompare(b.nextHop) || a.port.localeCompare(b.port))
    .slice(0, maximum);
}
const nodeKey = (kind: string, id: string) => kind + ':' + id;
export function ospfRouterPaths(device: Device, area: number) {
  const state = device.ospf!;
  const database = state.lsdb.filter((lsa) => lsa.area === area && !lsa.withdrawn);
  const graph = new Map<string, { lsa: OspfLsa; edges: { key: string; cost: number }[] }>();
  for (const lsa of database) {
    if (lsa.type !== 'router' && lsa.type !== 'network') continue;
    const key = nodeKey(lsa.type, lsa.id);
    const edges =
      lsa.type === 'router'
        ? lsa.links.map((link) => ({ key: nodeKey(link.kind, link.id), cost: link.cost }))
        : lsa.routers.map((router) => ({ key: nodeKey('router', router), cost: 0 }));
    graph.set(key, { lsa, edges });
  }
  const root = nodeKey('router', state.routerId);
  const best = new Map<string, Hop>([[root, { cost: 0 }]]),
    visited = new Set<string>();
  while (true) {
    const current = [...best]
      .filter(([key]) => !visited.has(key))
      .sort((a, b) => a[1].cost - b[1].cost || a[0].localeCompare(b[0]))[0];
    if (!current) break;
    const [key, path] = current;
    visited.add(key);
    for (const edge of graph.get(key)?.edges ?? []) {
      // A link is usable only when both LSAs describe it.
      if (!graph.get(edge.key)?.edges.some((back) => back.key === key)) continue;
      let hop: Hop = { ...path, cost: path.cost + edge.cost };
      if (!hop.port && edge.key.startsWith('router:')) {
        const routerId = edge.key.slice(7);
        const neighbors = state.neighbors
          .filter(
            (entry) =>
              entry.area === area &&
              entry.routerId === routerId &&
              (entry.state === 'Full' || (key.startsWith('network:') && entry.state === '2-Way')) &&
              (!key.startsWith('network:') ||
                device.interfaces.some(
                  (port) =>
                    port.id === entry.port &&
                    port.ip &&
                    port.prefix !== undefined &&
                    sameSubnet(port.ip, key.slice(8), port.prefix)
                ))
          )
          .sort(
            (a, b) =>
              (state.interfaces.find((entry) => entry.port === a.port)?.cost ?? 1) -
                (state.interfaces.find((entry) => entry.port === b.port)?.cost ?? 1) ||
              a.port.localeCompare(b.port)
          );
        const cost = neighbors.length
          ? state.interfaces.find((p) => p.port === neighbors[0].port)?.cost
          : undefined;
        const alternatives = mergeHops(
          neighbors
            .filter((n) => state.interfaces.find((p) => p.port === n.port)?.cost === cost)
            .map((n) => ({ port: n.port, nextHop: n.ip }))
        );
        if (!alternatives.length) continue;
        hop = { ...hop, ...alternatives[0], alternatives };
      }
      const previous = best.get(edge.key);
      if (hop.cost > 16777215) continue;
      if (!previous || hop.cost < previous.cost) {
        best.set(edge.key, hop);
        visited.delete(edge.key);
      } else if (hop.cost === previous.cost) {
        const alternatives = mergeHops([...hops(previous), ...hops(hop)]);
        if (JSON.stringify(alternatives) !== JSON.stringify(hops(previous))) {
          best.set(edge.key, { ...previous, ...alternatives[0], alternatives });
          visited.delete(edge.key);
        }
      }
    }
  }
  const summaries = database.filter((l) => l.type === 'asbr-summary');
  const basePaths = new Map(best);
  for (const lsa of summaries) {
    const path = basePaths.get(nodeKey('router', lsa.advertisingRouter));
    if (!path?.port || !path.nextHop) continue;
    const key = nodeKey('router', lsa.routerId),
      candidate = { ...path, cost: path.cost + lsa.cost },
      old = best.get(key);
    if (!old || candidate.cost < old.cost) best.set(key, candidate);
  }
  return best;
}
export function ospfSpf(device: Device, area: number): DynamicRoute[] {
  const state = device.ospf!,
    database = state.lsdb.filter((l) => l.area === area && !l.withdrawn),
    best = ospfRouterPaths(device, area);
  const routes: DynamicRoute[] = [];
  for (const lsa of database) {
    if (lsa.type === 'external' || lsa.type === 'nssa' || lsa.type === 'asbr-summary') continue;
    const owner =
      lsa.type === 'network' ? nodeKey('network', lsa.id) : nodeKey('router', lsa.advertisingRouter);
    const path = best.get(owner);
    if (!path) continue;
    const prefixes =
      lsa.type === 'router'
        ? lsa.prefixes
        : [{ network: lsa.network, prefix: lsa.prefix, cost: lsa.type === 'summary' ? lsa.cost : 0 }];
    for (const prefix of prefixes) {
      const metric = path.cost + prefix.cost;
      if (metric > 16777215) continue;
      for (const hop of hops(path))
        routes.push({
          ...prefix,
          metric,
          port: hop.port,
          nextHop: hop.nextHop,
          protocol: 'OSPF',
          distance: 110,
          area,
          pathType: lsa.type === 'summary' ? 'inter' : 'intra',
        });
    }
  }
  for (const lsa of database) {
    if ((lsa.type !== 'external' && lsa.type !== 'nssa') || lsa.advertisingRouter === state.routerId)
      continue;
    let path = best.get(nodeKey('router', lsa.advertisingRouter));
    if (lsa.forwardingAddress !== '0.0.0.0') {
      const p = device.interfaces.find(
        (p) =>
          p.ip &&
          p.prefix !== undefined &&
          sameSubnet(p.ip, lsa.forwardingAddress, p.prefix) &&
          state.ports.some((r) => r.port === p.id && r.operational)
      );
      const route = routes
        .filter((r) => sameSubnet(r.network, lsa.forwardingAddress, r.prefix))
        .sort((a, b) => b.prefix - a.prefix || a.metric - b.metric)[0];
      path = p
        ? { cost: 0, port: p.id, nextHop: lsa.forwardingAddress }
        : route
          ? { cost: route.metric, port: route.port, nextHop: route.nextHop }
          : undefined;
    }
    if (!path?.port || !path.nextHop) continue;
    const metric = lsa.metricType === 'E1' ? lsa.cost + path.cost : lsa.cost;
    if (metric > 16777215) continue;
    for (const hop of hops(path))
      routes.push({
        network: lsa.network,
        prefix: lsa.prefix,
        nextHop: hop.nextHop,
        port: hop.port,
        metric,
        internalCost: path.cost,
        tag: lsa.tag,
        protocol: 'OSPF',
        distance: 110,
        area,
        pathType: lsa.type === 'nssa' ? (lsa.metricType === 'E1' ? 'N1' : 'N2') : lsa.metricType,
      });
  }
  // Do not leak the LSA-only cost property into persisted route contracts.
  const attached = state.lsdb.flatMap<{ network: string; prefix: number }>((lsa) =>
    lsa.withdrawn
      ? []
      : lsa.type === 'router' && lsa.advertisingRouter === state.routerId
        ? lsa.prefixes
        : lsa.type === 'network' && lsa.routers.includes(state.routerId)
          ? [lsa]
          : []
  );
  return routes
    .filter(
      (route) => !attached.some((entry) => entry.network === route.network && entry.prefix === route.prefix)
    )
    .map(
      ({
        network,
        prefix,
        nextHop,
        port,
        metric,
        protocol,
        distance,
        area,
        pathType,
        internalCost,
        tag,
      }) => ({
        network,
        prefix,
        nextHop,
        port,
        metric,
        protocol,
        distance,
        area,
        pathType,
        ...(internalCost !== undefined ? { internalCost } : {}),
        ...(tag !== undefined ? { tag } : {}),
      })
    );
}
const rank = (p: DynamicRoute['pathType']) =>
  p === 'intra' ? 0 : p === 'inter' ? 1 : p === 'E1' || p === 'N1' ? 2 : 3;
export function bestOspfRoutes(routes: DynamicRoute[], maximumPaths = 4) {
  const sorted = [...routes].sort(
    (a, b) =>
      rank(a.pathType) - rank(b.pathType) ||
      a.metric - b.metric ||
      (a.internalCost ?? 0) - (b.internalCost ?? 0) ||
      a.nextHop.localeCompare(b.nextHop) ||
      a.port.localeCompare(b.port)
  );
  const chosen = new Map<string, DynamicRoute[]>();
  for (const route of sorted) {
    const key = `${route.network}/${route.prefix}`;
    const existing = chosen.get(key);
    if (!existing) chosen.set(key, [route]);
    else if (
      existing.length < maximumPaths &&
      rank(route.pathType) === rank(existing[0].pathType) &&
      route.metric === existing[0].metric &&
      (route.internalCost ?? 0) === (existing[0].internalCost ?? 0) &&
      !existing.some((r) => r.port === route.port && r.nextHop === route.nextHop)
    )
      existing.push(route);
  }
  return [...chosen.values()]
    .flat()
    .sort((a, b) => a.network.localeCompare(b.network) || a.prefix - b.prefix)
    .slice(0, 1024);
}
