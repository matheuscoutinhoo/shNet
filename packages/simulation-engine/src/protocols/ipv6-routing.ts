import type { Device, NetworkInterface } from '../model';
import { interfaceUp } from './layer3';
import { linkLocal6, sameSubnet6 } from './ipv6-address';
export const usable6 = (p: NetworkInterface) =>
  p.ipv6?.addresses.filter((a) => ['preferred', 'deprecated'].includes(a.state)) ?? [];
export function source6(port: NetworkInterface, target: string) {
  const candidates = usable6(port).filter((a) => linkLocal6(a.ip) === linkLocal6(target));
  return candidates.find((a) => a.state === 'preferred')?.ip ?? candidates[0]?.ip;
}
export function resolveRoute6(device: Device, target: string, now: number, vrf?: string, scope?: string) {
  const choices: {
    port: NetworkInterface;
    nextHop: string;
    prefix: number;
    distance: number;
    metric: number;
    origin: string;
  }[] = [];
  for (const port of device.interfaces) {
    if (!interfaceUp(device, port) || !port.ipv6 || port.vrf !== vrf || (scope && scope !== port.id))
      continue;
    for (const address of usable6(port))
      if (address.onLink && sameSubnet6(target, address.ip, address.prefix))
        choices.push({
          port,
          nextHop: target,
          prefix: address.prefix,
          distance: 0,
          metric: 0,
          origin: 'connected',
        });
    for (const prefix of port.ipv6.onLinkPrefixes ?? [])
      if (prefix.expiresAt > now && sameSubnet6(target, prefix.network, prefix.prefix))
        choices.push({
          port,
          nextHop: target,
          prefix: prefix.prefix,
          distance: 0,
          metric: 0,
          origin: 'RA on-link',
        });
    if (!linkLocal6(target))
      for (const router of port.ipv6.routers)
        if (router.expiresAt > now)
          choices.push({ port, nextHop: router.ip, prefix: 0, distance: 2, metric: 0, origin: 'RA' });
  }
  if (!linkLocal6(target))
    for (const route of device.routes6 ?? []) {
      const port = device.interfaces.find(
        (p) => p.id === route.port && p.vrf === vrf && p.ipv6 && interfaceUp(device, p)
      );
      if (
        port &&
        route.vrf === vrf &&
        (!scope || scope === port.id) &&
        sameSubnet6(target, route.network, route.prefix)
      )
        choices.push({
          port,
          nextHop: route.nextHop === '::' ? target : route.nextHop,
          prefix: route.prefix,
          distance: 1,
          metric: route.metric,
          origin: 'static',
        });
    }
  choices.sort(
    (a, b) =>
      b.prefix - a.prefix ||
      a.distance - b.distance ||
      a.metric - b.metric ||
      a.port.id.localeCompare(b.port.id)
  );
  return choices[0];
}
