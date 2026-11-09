import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkInterface, Packet } from '../model';
import { bestRoute, sameSubnet } from './ipv4';
import { routingEnabled } from './layer3';
import { ripRoutes } from './rip';
import { eigrpRoutes } from './eigrp';

/** Whether a route of this length towards the source leaves through the port (any equal-cost path). */
function reachableVia(d: Device, port: NetworkInterface, source: string, prefix: number) {
  if (port.ip && port.prefix === prefix && sameSubnet(port.ip, source, port.prefix)) return true;
  const onPort = (nextHop: string) =>
    !!port.ip && port.prefix !== undefined && sameSubnet(port.ip, nextHop, port.prefix);
  const dynamic = port.vrf
    ? []
    : [
        ...(d.ospf?.enabled ? d.ospf.routes : []),
        ...ripRoutes(d),
        ...eigrpRoutes(d),
        ...(d.bgp?.enabled ? d.bgp.routes : []),
      ];
  if (
    dynamic.some((r) => r.port === port.id && r.prefix === prefix && sameSubnet(r.network, source, r.prefix))
  )
    return true;
  return d.routes.some(
    (r) =>
      r.vrf === port.vrf &&
      !r.discard &&
      r.prefix === prefix &&
      sameSubnet(r.network, source, r.prefix) &&
      (r.port === port.id || (!r.port && onPort(r.nextHop)))
  );
}
/**
 * Unicast Reverse Path Forwarding (RFC 3704): strict mode ("rx") accepts a packet only when the
 * route back to its source leaves through the interface it arrived on; loose mode ("any") when any
 * route exists. A default route counts only with "allow-default"; a Null0 route never does. DHCP
 * discovery (0.0.0.0 to 255.255.255.255) is exempt, like IOS.
 */
export function permitUrpf(e: SimulationEngine, d: Device, port: NetworkInterface, packet: Packet) {
  const u = port.urpf;
  if (!u || !routingEnabled(d)) return true;
  if (packet.src === '0.0.0.0' && packet.dst === '255.255.255.255') return true;
  const route = bestRoute(d, packet.src, port.vrf);
  const ok =
    !!route &&
    !('discard' in route) &&
    (route.prefix > 0 || !!u.allowDefault) &&
    (u.mode === 'any' || route.port.id === port.id || reachableVia(d, port, packet.src, route.prefix));
  if (ok) return true;
  port.urpfDrops = (port.urpfDrops ?? 0) + 1;
  e.drop(
    d,
    `uRPF (${u.mode === 'rx' ? 'strict' : 'loose'}) on ${port.name}: source ${packet.src} is not reachable via ${u.mode === 'rx' ? 'this interface' : 'any interface'}.`,
    port.id
  );
  return false;
}
