import { ipv4Schema, type Device, type NetworkInterface, type Packet } from '../model';
import type { SimulationEngine } from '../core/engine';
import { permitIds } from './ids';
import { receiveUdp } from './udp';
import { permitPacket } from './acl';
import { natInbound } from './nat';
import { receiveTcp } from './tcp';
import { receiveTcpMtu } from './tcp-pmtud';
import { receiveOspf } from './ospf';
import { ripRoutes } from './rip';
import { sendIcmpError } from './icmp';
import { receiveVrrp } from './vrrp';
import { interfaceUp, routingEnabled } from './layer3';
export function ipNumber(ip: string): number {
  const cached = parsedAddresses.get(ip);
  if (cached !== undefined) return cached;
  ipv4Schema.parse(ip);
  const value = ip.split('.').reduce((a, b) => (a * 256 + Number(b)) >>> 0, 0);
  if (parsedAddresses.size >= 4096) parsedAddresses.delete(parsedAddresses.keys().next().value!);
  parsedAddresses.set(ip, value);
  return value;
}
// Pure, bounded memoization: every address is validated before entering the
// cache. This has no effect on protocol state, event order or restore.
const parsedAddresses = new Map<string, number>();
export function ipString(n: number) {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}
export function mask(prefix: number) {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32)
    throw new Error('Prefixo deve estar entre 0 e 32');
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}
export function sameSubnet(a: string, b: string, prefix: number) {
  const m = mask(prefix);
  return (ipNumber(a) & m) === (ipNumber(b) & m);
}
export function subnet(ip: string, prefix: number) {
  const network = (ipNumber(ip) & mask(prefix)) >>> 0;
  const broadcast = (network | ~mask(prefix)) >>> 0;
  return {
    network: ipString(network),
    broadcast: ipString(broadcast),
    first: ipString(prefix >= 31 ? network : network + 1),
    last: ipString(prefix >= 31 ? broadcast : broadcast - 1),
  };
}
export function parsePrefix(value: string) {
  if (value.includes('.')) {
    const n = ipNumber(value);
    const p = n.toString(2).replace(/0/g, '').length;
    if (mask(p) !== n) throw new Error('Máscara não contígua');
    return p;
  }
  const p = Number(value);
  mask(p);
  return p;
}
export function resolveDefaultRoutes(device: Device, vrf?: string) {
  const routes = device.interfaces
    .filter(
      (port) =>
        interfaceUp(device, port) &&
        port.vrf === vrf &&
        port.ip &&
        port.prefix !== undefined &&
        port.gateway &&
        sameSubnet(port.ip, port.gateway, port.prefix)
    )
    .map((port) => ({
      port,
      nextHop: port.gateway!,
      prefix: 0,
      metric: 100,
    }));
  if (!routingEnabled(device) && !vrf && device.gateway) {
    const port = device.interfaces.find(
      (entry) =>
        interfaceUp(device, entry) &&
        entry.vrf === vrf &&
        entry.ip &&
        entry.prefix !== undefined &&
        entry.ipv4Mode !== 'dhcp' &&
        sameSubnet(entry.ip, device.gateway!, entry.prefix)
    );
    if (port) routes.push({ port, nextHop: device.gateway, prefix: 0, metric: 1 });
  }
  return routes;
}
export function resolveRoute(
  device: Device,
  dst: string,
  vrf?: string
): { port: NetworkInterface; nextHop: string; prefix: number } | undefined {
  const connected = device.interfaces
    .filter(
      (i) =>
        interfaceUp(device, i) &&
        i.vrf === vrf &&
        i.ip !== undefined &&
        i.prefix !== undefined &&
        sameSubnet(i.ip, dst, i.prefix)
    )
    .sort((a, b) => b.prefix! - a.prefix!);
  const candidates = [
    ...connected.map((port) => ({ port, nextHop: dst, prefix: port.prefix!, metric: -1, distance: 0 })),
    ...resolveDefaultRoutes(device, vrf).map((route) => ({ ...route, distance: 1 })),
  ];
  if (routingEnabled(device)) {
    for (const port of device.interfaces.filter((p) => p.tunnel && interfaceUp(device, p) && p.vrf === vrf))
      for (const prefix of port.tunnel!.remotePrefixes)
        if (sameSubnet(prefix.network, dst, prefix.prefix))
          candidates.push({
            port,
            nextHop: port.tunnel!.peerIp,
            prefix: prefix.prefix,
            metric: 1,
            distance: 200,
          });
    for (const r of device.routes.filter((r) => r.vrf === vrf && sameSubnet(r.network, dst, r.prefix))) {
      const port = device.interfaces.find(
        (i) =>
          interfaceUp(device, i) &&
          i.vrf === vrf &&
          i.ip &&
          i.prefix !== undefined &&
          sameSubnet(i.ip, r.nextHop, i.prefix)
      );
      if (port)
        candidates.push({ port, nextHop: r.nextHop, prefix: r.prefix, metric: r.metric, distance: 1 });
    }
    for (const route of vrf
      ? []
      : [
          ...(device.ospf?.enabled ? device.ospf.routes : []),
          ...ripRoutes(device),
          ...(device.bgp?.enabled ? device.bgp.routes : []),
        ]) {
      const port = device.interfaces.find(
        (entry) =>
          entry.id === route.port &&
          interfaceUp(device, entry) &&
          entry.vrf === vrf &&
          entry.ip &&
          entry.prefix !== undefined &&
          sameSubnet(entry.ip, route.nextHop, entry.prefix)
      );
      if (port && sameSubnet(route.network, dst, route.prefix))
        candidates.push({
          port,
          nextHop: route.nextHop,
          prefix: route.prefix,
          metric: route.metric,
          distance: route.distance,
        });
    }
  }
  return candidates.sort((a, b) => b.prefix - a.prefix || a.distance - b.distance || a.metric - b.metric)[0];
}
export function receiveIp(
  e: SimulationEngine,
  d: Device,
  port: NetworkInterface,
  packet: Packet,
  sourceMac: string,
  fromWire = true
) {
  if (fromWire && !permitPacket(e, d, port, 'in', packet)) return;
  if (packet.protocol === 'VRRP') {
    receiveVrrp(e, d, port, packet, sourceMac);
    return;
  }
  const virtual = d.vrrp?.groups.find(
    (group) => group.vip === packet.dst && d.interfaces.find((p) => p.id === group.port)?.vrf === port.vrf
  );
  if (virtual && (!d.vrrp?.enabled || virtual.state !== 'ACTIVE' || virtual.priority !== 255)) {
    e.drop(d, 'IP virtual VRRP não aceita tráfego local neste estado; use-o como gateway.', port.id);
    return;
  }
  if (!permitIds(e, d, port, packet)) return;
  if (packet.protocol === 'OSPF') {
    receiveOspf(e, d, port, packet, sourceMac);
    return;
  }
  if (packet.protocol === 'UDP' && packet.payload.protocol === 'RIP') {
    receiveUdp(e, d, port, packet, sourceMac);
    return;
  }
  if (fromWire) {
    const translated = natInbound(e, d, port, packet);
    if (!translated) return;
    packet = translated;
  }
  if (packet.protocol === 'OSPF' || packet.protocol === 'VRRP') return;
  if (
    d.interfaces.some((i) => interfaceUp(d, i) && i.vrf === port.vrf && i.ip === packet.dst) ||
    (packet.protocol === 'UDP' && packet.dst === '255.255.255.255')
  ) {
    e.emit('PACKET_RECEIVED', d.id, 'Pacote destinado a este equipamento.', { port: port.id });
    if (packet.protocol === 'TCP') {
      receiveTcp(e, d, packet, port.vrf);
      return;
    }
    if (packet.protocol === 'UDP') {
      if (port.vrf) {
        e.drop(d, 'Serviços UDP locais exigem tabela padrão nesta versão.', port.id);
        return;
      }
      receiveUdp(e, d, port, packet, sourceMac);
      return;
    }
    if (packet.kind === 'echo-request')
      e.sendIp(
        d.id,
        { ...packet, src: packet.dst, dst: packet.src, ttl: 64, kind: 'echo-reply' },
        undefined,
        port.vrf
      );
    else {
      if (
        packet.kind === 'unreachable' &&
        packet.error?.code === 4 &&
        packet.error.quote.protocol === 'TCP' &&
        packet.error.mtu
      )
        receiveTcpMtu(e, d, packet.error.quote, packet.error.mtu, port.vrf);
      const probe = e.state.probes.find(
        (p) =>
          p.id === packet.probeId &&
          p.device === d.id &&
          p.vrf === port.vrf &&
          p.status === 'pending' &&
          (!packet.error ||
            (packet.error.quote.protocol === 'ICMP' &&
              packet.error.quote.kind === 'echo-request' &&
              packet.error.quote.probeId === p.id &&
              packet.error.quote.dst === p.target))
      );
      if (probe) {
        probe.status = packet.kind === 'echo-reply' ? 'success' : packet.kind;
        probe.rtt = e.state.clock - probe.start;
        probe.responder = packet.src;
        e.emit(
          packet.kind === 'echo-reply' ? 'PING_SUCCESS' : 'PACKET_DROPPED',
          d.id,
          packet.kind === 'echo-reply'
            ? 'Echo Reply recebido: caminho de ida e volta válido.'
            : 'ICMP ' + packet.kind + ' recebido de ' + packet.src
        );
      }
    }
    return;
  }
  if (!routingEnabled(d)) return;
  if (packet.ttl <= 1) {
    e.drop(d, 'TTL expirou no roteador.', port.id);
    sendIcmpError(e, d, port, packet, 'time-exceeded', 0);
    return;
  }
  e.sendIp(d.id, { ...packet, ttl: packet.ttl - 1 }, port);
}
