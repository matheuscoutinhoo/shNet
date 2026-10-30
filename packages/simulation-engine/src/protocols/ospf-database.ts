import { lsaChecksum, ospfAreaType } from './ospf-security';
import { ripRoutes } from './rip';
import type { SimulationEngine } from '../core/engine';
import type { Device } from '../model';
import { subnet, sameSubnet, resolveRoute } from './ipv4';
import { OSPF, lsaKey, type DynamicRoute, type OspfLsa } from './ospf-model';
import { bestOspfRoutes, ospfSpf, ospfRouterPaths } from './ospf-spf';
import { floodOspf } from './ospf-wire';

function signature(lsa: OspfLsa) {
  return JSON.stringify([
    lsaKey(lsa),
    lsa.withdrawn,
    lsa.type === 'router'
      ? [
          lsa.links.map((link) => [link.kind, link.id, link.cost]),
          lsa.prefixes.map((entry) => [entry.network, entry.prefix, entry.cost]),
        ]
      : lsa.type === 'asbr-summary'
        ? [lsa.routerId, lsa.cost]
        : [
            lsa.network,
            lsa.prefix,
            lsa.type === 'network' ? lsa.routers : lsa.cost,
            ...(lsa.type === 'external' || lsa.type === 'nssa'
              ? [lsa.metricType, lsa.forwardingAddress, lsa.tag]
              : []),
          ],
  ]);
}
function publish(engine: SimulationEngine, device: Device, candidate: OspfLsa) {
  const state = device.ospf!,
    key = lsaKey(candidate),
    existing = state.lsdb.find((entry) => lsaKey(entry) === key);
  if (
    existing &&
    signature(existing) === signature(candidate) &&
    engine.state.clock - existing.originatedAt < OSPF.refreshMs
  )
    return false;
  candidate.sequence = Math.max(++engine.state.sequence, (existing?.sequence ?? 0) + 1);
  engine.state.sequence = Math.max(engine.state.sequence, candidate.sequence);
  candidate.originatedAt = engine.state.clock;
  candidate.checksum = lsaChecksum(candidate);
  if (!existing && state.lsdb.length >= 1024) {
    engine.drop(device, 'LSDB OSPF cheia.');
    return false;
  }
  state.lsdb = state.lsdb.filter((entry) => lsaKey(entry) !== key);
  state.lsdb.push(candidate);
  floodOspf(engine, device, candidate);
  engine.emit(
    'OSPF_LSA',
    device.id,
    `${candidate.withdrawn ? 'Retirada' : 'Originação'} LSA ${key}, sequência ${candidate.sequence}.`
  );
  return true;
}
export function synchronizeOspf(engine: SimulationEngine, device: Device) {
  const state = device.ospf!;
  if (!state.enabled) return;
  const areas = [...new Set(state.interfaces.map((entry) => entry.area))].sort((a, b) => a - b);
  const originated = new Set<string>();
  const base = (area: number) => ({
    area,
    advertisingRouter: state.routerId,
    sequence: 1,
    originatedAt: engine.state.clock,
    withdrawn: false,
  });
  for (const area of areas) {
    const routerLsa: Extract<OspfLsa, { type: 'router' }> = {
      ...base(area),
      type: 'router',
      flags:
        (areas.includes(0) && areas.length > 1 ? 1 : 0) |
        (state.externalRoutes.length || state.defaultOriginate ? 2 : 0),
      id: state.routerId,
      links: [],
      prefixes: [],
    };
    for (const config of state.interfaces.filter((entry) => entry.area === area)) {
      const port = device.interfaces.find((entry) => entry.id === config.port)!;
      const runtime = state.ports.find((entry) => entry.port === config.port)!;
      if (!runtime.operational || !port.ip || port.prefix === undefined) continue;
      const network = subnet(port.ip, port.prefix).network;
      const neighbors = state.neighbors.filter((entry) => entry.port === port.id && entry.state === 'Full');
      const dr =
        runtime.dr === state.routerId
          ? port.ip
          : state.neighbors.find((entry) => entry.port === port.id && entry.routerId === runtime.dr)?.ip;
      if (!config.passive && config.networkType === 'broadcast' && neighbors.length && dr) {
        routerLsa.links.push({ kind: 'network', id: dr, data: port.ip, cost: config.cost });
        if (runtime.dr === state.routerId) {
          const networkLsa: OspfLsa = {
            ...base(area),
            type: 'network',
            id: port.ip,
            network,
            prefix: port.prefix,
            routers: [state.routerId, ...neighbors.map((entry) => entry.routerId)].sort(),
          };
          originated.add(lsaKey(networkLsa));
          publish(engine, device, networkLsa);
        }
      } else {
        // IOS advertises a loopback as a /32 host route unless "ip ospf network point-to-point" is set.
        const host = port.loopback && port.ospfSettings?.networkType !== 'point-to-point';
        routerLsa.prefixes.push({
          network: host ? port.ip : network,
          prefix: host ? 32 : port.prefix,
          cost: config.cost,
        });
        if (!config.passive)
          for (const neighbor of neighbors)
            routerLsa.links.push({ kind: 'router', id: neighbor.routerId, data: port.ip, cost: config.cost });
      }
    }
    routerLsa.links = [
      ...new Map(
        routerLsa.links.sort((a, b) => b.cost - a.cost).map((link) => [`${link.kind}:${link.id}`, link])
      ).values(),
    ].sort((a, b) => a.id.localeCompare(b.id));
    routerLsa.prefixes = [
      ...new Map(
        routerLsa.prefixes
          .sort((a, b) => b.cost - a.cost)
          .map((entry) => [`${entry.network}/${entry.prefix}`, entry])
      ).values(),
    ].sort((a, b) => a.network.localeCompare(b.network));
    originated.add(lsaKey(routerLsa));
    publish(engine, device, routerLsa);
  }
  const abr = areas.includes(0) && areas.length > 1;
  const eligible = state.externalRoutes.filter(
    (r) =>
      device.routes.some((n) => !n.vrf && n.network === r.network && n.prefix === r.prefix) ||
      ripRoutes(device).some((n) => n.network === r.network && n.prefix === r.prefix) ||
      device.interfaces.some(
        (p) =>
          p.ip &&
          p.prefix === r.prefix &&
          subnet(p.ip, p.prefix).network === r.network &&
          state.ports.some((t) => t.port === p.id && t.operational)
      )
  );
  if (state.defaultOriginate) {
    const route = resolveRoute({ ...device, ospf: undefined }, '0.0.0.0', undefined, engine.state);
    if (state.defaultOriginate.always || route?.prefix === 0) {
      const prior = eligible.findIndex((r) => r.prefix === 0);
      if (prior >= 0) eligible.splice(prior, 1);
      eligible.push({
        network: '0.0.0.0',
        prefix: 0,
        cost: state.defaultOriginate.cost,
        metricType: state.defaultOriginate.metricType,
        tag: 0,
        forwardingAddress: '0.0.0.0',
      });
    }
  }
  for (const area of areas)
    if (ospfAreaType(device, area) !== 'stub')
      for (const r of eligible) {
        const lsa: OspfLsa = {
          ...base(area),
          ...r,
          type: ospfAreaType(device, area) === 'nssa' ? 'nssa' : 'external',
          id: r.network + '/' + r.prefix,
        };
        originated.add(lsaKey(lsa));
        publish(engine, device, lsa);
      }
  if (abr) {
    const paths = new Map(areas.map((area) => [area, ospfRouterPaths(device, area)]));
    for (const source of [...state.lsdb].filter(
      (l) => l.type === 'nssa' && !l.withdrawn && l.advertisingRouter !== state.routerId
    )) {
      if (source.type !== 'nssa') continue;
      const path = paths.get(source.area)?.get('router:' + source.advertisingRouter);
      if (!path?.port) continue;
      for (const area of areas.filter((a) => ospfAreaType(device, a) === 'normal')) {
        const lsa: OspfLsa = {
          ...source,
          ...base(area),
          type: 'external',
          cost: source.metricType === 'E1' ? Math.min(16777215, source.cost + path.cost) : source.cost,
          forwardingAddress: '0.0.0.0',
        };
        originated.add(lsaKey(lsa));
        publish(engine, device, lsa);
      }
    }
    const externals = new Map<string, Extract<OspfLsa, { type: 'external' }>>();
    for (const lsa of state.lsdb)
      if (lsa.type === 'external' && lsa.advertisingRouter !== state.routerId) {
        const key = lsa.id + '|' + lsa.advertisingRouter,
          old = externals.get(key);
        if (!old || lsa.sequence > old.sequence) externals.set(key, lsa);
      }
    for (const original of externals.values())
      for (const area of areas.filter((a) => ospfAreaType(device, a) === 'normal' && a !== original.area)) {
        const path = paths.get(original.area)?.get('router:' + original.advertisingRouter);
        if (!path?.port) continue;
        const copy: OspfLsa = { ...original, area };
        copy.checksum = lsaChecksum(copy);
        const local = state.lsdb.find((l) => lsaKey(l) === lsaKey(copy));
        if (!local || local.sequence < copy.sequence) {
          state.lsdb = state.lsdb.filter((l) => lsaKey(l) !== lsaKey(copy));
          state.lsdb.push(copy);
          floodOspf(engine, device, copy);
        }
        if (!copy.withdrawn) {
          const summary: OspfLsa = {
            ...base(area),
            type: 'asbr-summary',
            id: copy.advertisingRouter,
            routerId: copy.advertisingRouter,
            cost: Math.max(1, path.cost),
          };
          originated.add(lsaKey(summary));
          publish(engine, device, summary);
        }
      }
    for (const area of areas.filter((a) => ospfAreaType(device, a) === 'stub')) {
      const lsa: OspfLsa = {
        ...base(area),
        type: 'summary',
        id: '0.0.0.0/0',
        network: '0.0.0.0',
        prefix: 0,
        cost: state.areas.find((a) => a.id === area)?.defaultCost ?? 1,
      };
      originated.add(lsaKey(lsa));
      publish(engine, device, lsa);
    }
  }
  // Network LSAs of a former DR must disappear before running SPF.
  for (const lsa of [...state.lsdb])
    if (
      lsa.advertisingRouter === state.routerId &&
      lsa.type !== 'summary' &&
      !originated.has(lsaKey(lsa)) &&
      !lsa.withdrawn
    )
      publish(engine, device, { ...lsa, withdrawn: true });
  const calculated = areas
    .flatMap((area) => ospfSpf(device, area))
    .filter((route) => !abr || route.area === 0 || route.pathType !== 'inter');
  const routes = bestOspfRoutes(calculated, state.maximumPaths);
  if (abr) {
    const local: DynamicRoute[] = state.interfaces.flatMap((config) => {
      const port = device.interfaces.find((entry) => entry.id === config.port)!;
      return state.ports.find((entry) => entry.port === port.id)?.operational &&
        port.ip &&
        port.prefix !== undefined
        ? [
            {
              network: subnet(port.ip, port.prefix).network,
              prefix: port.prefix,
              metric: config.cost,
              nextHop: port.ip,
              port: port.id,
              protocol: 'OSPF' as const,
              distance: 110,
              area: config.area,
              pathType: 'intra' as const,
            },
          ]
        : [];
    });
    for (const area of areas) {
      const candidates = bestOspfRoutes(
        [...local, ...routes].filter(
          (route) =>
            route.area !== area &&
            ['intra', 'inter'].includes(route.pathType ?? 'intra') &&
            (area !== 0 || route.pathType === 'intra')
        )
      );
      const summarized = new Map<string, DynamicRoute>();
      for (const route of candidates) {
        const range = state.summaryRanges
          .filter(
            (r) =>
              r.area === route.area &&
              r.area !== area &&
              r.prefix <= route.prefix &&
              sameSubnet(route.network, r.network, r.prefix)
          )
          .sort((a, b) => b.prefix - a.prefix)[0];
        const candidate = range
          ? { ...route, network: range.network, prefix: range.prefix, metric: range.cost ?? route.metric }
          : route;
        const key = candidate.network + '/' + candidate.prefix,
          old = summarized.get(key);
        if (!old || old.metric < candidate.metric) summarized.set(key, candidate);
      }
      for (const route of summarized.values()) {
        // Never summarize a prefix that is present inside the destination area.
        if (
          local.some(
            (entry) => entry.area === area && entry.network === route.network && entry.prefix === route.prefix
          )
        )
          continue;
        const lsa: OspfLsa = {
          ...base(area),
          type: 'summary',
          id: `${route.network}/${route.prefix}`,
          network: route.network,
          prefix: route.prefix,
          cost: Math.max(1, route.metric),
        };
        originated.add(lsaKey(lsa));
        publish(engine, device, lsa);
      }
    }
  }
  for (const lsa of [...state.lsdb])
    if (
      lsa.advertisingRouter === state.routerId &&
      lsa.type === 'summary' &&
      !originated.has(lsaKey(lsa)) &&
      !lsa.withdrawn
    )
      publish(engine, device, { ...lsa, withdrawn: true });
  const previous = JSON.stringify(state.routes),
    next = JSON.stringify(routes);
  if (previous !== next) {
    for (const route of state.routes)
      if (!routes.some((entry) => JSON.stringify(entry) === JSON.stringify(route)))
        engine.emit(
          'ROUTE_REMOVED',
          device.id,
          `OSPF retirou ${route.network}/${route.prefix} via ${route.nextHop}.`
        );
    for (const route of routes)
      if (!state.routes.some((entry) => JSON.stringify(entry) === JSON.stringify(route)))
        engine.emit(
          'ROUTE_ADDED',
          device.id,
          `OSPF ${route.pathType === 'inter' ? 'IA ' : ''}${route.network}/${route.prefix} via ${route.nextHop}, custo ${route.metric}.`
        );
    state.routes = routes;
    state.spfRuns++;
    engine.emit('OSPF_SPF', device.id, `SPF a partir da LSDB local: ${routes.length} rotas selecionadas.`);
  }
}
