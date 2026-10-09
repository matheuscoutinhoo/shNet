import { ripRoutes } from './rip';
import type { Device, NetworkInterface } from '../model';
import { sameSubnet } from './ipv4';

// Bind the transport to one WAN interface. Overlay routes cannot resolve their own carrier.
export function resolveUnderlay(device: Device, port: NetworkInterface, destination: string) {
  if (!port.ip || port.prefix === undefined || port.vrf || port.tunnel) return;
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
