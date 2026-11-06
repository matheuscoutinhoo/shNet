import type { Device } from '../model';
import { staticRouteInstalled, subnet } from './ipv4';
import { interfaceUp } from './layer3';
import { ripRoutes } from './rip';
import { applyRouteMap } from './routing-policy';

type External = NonNullable<Device['ospf']>['externalRoutes'][number];
/**
 * External routes that "redistribute SOURCE" originates, as IOS does: classless, metric 20 (1 for
 * BGP) and metric-type 2 by default. Connected networks already running OSPF, iBGP routes and a
 * static default (which needs "default-information originate") are not redistributed.
 */
export function ospfRedistributedRoutes(device: Device): External[] {
  const state = device.ospf;
  if (!state?.redistribute?.length) return [];
  const result = new Map<string, External>();
  for (const r of state.redistribute) {
    const routes: { network: string; prefix: number }[] =
      r.source === 'connected'
        ? device.interfaces
            .filter(
              (p) =>
                !p.vrf &&
                p.ip &&
                p.prefix !== undefined &&
                interfaceUp(device, p) &&
                !state.interfaces.some((entry) => entry.port === p.id)
            )
            .map((p) => ({ network: subnet(p.ip!, p.prefix!).network, prefix: p.prefix! }))
        : r.source === 'static'
          ? device.routes.filter(
              (route) =>
                !route.vrf && route.prefix > 0 && staticRouteInstalled({ ...device, ospf: undefined }, route)
            )
          : r.source === 'bgp'
            ? device.bgp?.enabled && (r.process === undefined || device.bgp.asn === r.process)
              ? device.bgp.routes.filter((route) => route.distance === 20)
              : []
            : ripRoutes(device);
    for (const route of routes) {
      const key = route.network + '/' + route.prefix;
      if (result.has(key)) continue;
      const metric = r.metric ?? (r.source === 'bgp' ? 1 : 20);
      const path = {
        network: route.network,
        prefix: route.prefix,
        nextHop: '0.0.0.0',
        asPath: [],
        origin: 'INCOMPLETE' as const,
        localPref: 100,
        med: metric,
      };
      const mapped = r.routeMap ? applyRouteMap(device, r.routeMap, path) : path;
      if (!mapped) continue;
      result.set(key, {
        network: route.network,
        prefix: route.prefix,
        cost: Math.max(1, Math.min(16777214, mapped.med)),
        metricType: r.metricType ?? 'E2',
        tag: r.tag ?? 0,
        forwardingAddress: '0.0.0.0',
      });
    }
  }
  return [...result.values()];
}
