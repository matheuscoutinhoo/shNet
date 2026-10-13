import { ripRoutes } from './rip';
import type { Device, NetworkInterface, Snapshot } from '../model';
import { sameSubnet, resolveRoute } from './ipv4';
import { interfaceOperational } from './layer3';

// Bind the transport to one WAN interface. Overlay routes cannot resolve their own carrier.
export function resolveUnderlay(
  device: Device,
  port: NetworkInterface,
  destination: string,
  snapshot?: Snapshot
) {
  if (!port.ip || port.prefix === undefined || port.vrf || port.tunnel) return;
  if (port.loopback) {
    const route = resolveRoute(device, destination, undefined, snapshot);
    return route && !route.port.tunnel && !route.port.vxlan && !route.port.loopback ? route : undefined;
  }
  if (snapshot && !interfaceOperational(snapshot, device, port)) return;
  if (sameSubnet(port.ip, destination, port.prefix)) return { port, nextHop: destination };
  const routes = [
    ...device.routes.filter((r) => !r.vrf),
    ...(device.ospf?.routes ?? []),
    ...ripRoutes(device),
    ...(device.bgp?.routes ?? []),
  ]
    .filter(
      (r) => sameSubnet(r.network, destination, r.prefix) && sameSubnet(port.ip!, r.nextHop, port.prefix!)
    )
    .sort((a, b) => b.prefix - a.prefix || a.metric - b.metric);
  if (routes[0]) return { port, nextHop: routes[0].nextHop };
  if (port.gateway && sameSubnet(port.ip, port.gateway, port.prefix)) return { port, nextHop: port.gateway };
}
