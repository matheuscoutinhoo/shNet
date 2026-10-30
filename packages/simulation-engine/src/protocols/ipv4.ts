import { ipv4Schema, type Device, type NetworkInterface, type Packet, type Snapshot } from '../model';
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
import { receiveVrrp, acceptsVrrpAddress } from './vrrp';
import { receiveHsrp, acceptsHsrpAddress } from './hsrp';
import { interfaceUp, interfaceOperational, routingEnabled } from './layer3';
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
  vrf?: string,
  snapshot?: Snapshot,
  visited: ReadonlySet<string> = new Set(),
  flowKey?: string
): { port: NetworkInterface; nextHop: string; prefix: number } | undefined {
  type Resolution = { port: NetworkInterface; nextHop: string; prefix: number };
  const work = { remaining: 1024 },
    direct = new Map<string, Resolution | undefined>();
  function lookup(dst: string, visited: ReadonlySet<string>, directOnly = false): Resolution | undefined {
    const usable = (p: NetworkInterface) =>
      interfaceUp(device, p) && (!snapshot || interfaceOperational(snapshot, device, p));
    const connected = device.interfaces
      .filter(
        (i) =>
          usable(i) &&
          i.vrf === vrf &&
          i.ip !== undefined &&
          i.prefix !== undefined &&
          sameSubnet(i.ip, dst, i.prefix)
      )
      .sort((a, b) => b.prefix! - a.prefix!);
    const candidates: {
      port?: NetworkInterface;
      nextHop: string;
      prefix: number;
      metric: number;
      distance: number;
      key?: string;
    }[] = [
      ...connected.map((port) => ({ port, nextHop: dst, prefix: port.prefix!, metric: -1, distance: 0 })),
      ...(visited.size ? [] : resolveDefaultRoutes(device, vrf).map((route) => ({ ...route, distance: 1 }))),
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
        if(r.track&&!device.monitoring?.tracks.find(t=>t.id===r.track)?.state)continue;
        const key = JSON.stringify([vrf, r.network, r.prefix, r.nextHop, r.port]);
        if (r.distance === 255 || visited.has(key) || visited.size >= 16 || (visited.size && !r.prefix))
          continue;
        const port = r.port
          ? device.interfaces.find(
              (p) =>
                p.id === r.port &&
                p.vrf === vrf &&
                p.ip &&
                p.prefix !== undefined &&
                usable(p) &&
                (r.nextHop === '0.0.0.0' || sameSubnet(p.ip, r.nextHop, p.prefix))
            )
          : undefined;
        if (r.port && !port) continue;
        candidates.push({
          port,
          nextHop: r.nextHop === '0.0.0.0' && port ? dst : r.nextHop,
          prefix: r.prefix,
          metric: r.metric,
          distance: r.distance ?? 1,
          key,
        });
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
            usable(entry) &&
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
    // Resolve candidates only when they can win the RIB selection. Eagerly
    // resolving less-specific routes can expand a cyclic graph exponentially,
    // even when the next hop already has a directly connected path.
    candidates.sort((a, b) => b.prefix - a.prefix || a.distance - b.distance || a.metric - b.metric);
    if(flowKey && !visited.size && candidates[0]?.distance>0) {
      const best=candidates[0], count=candidates.findIndex(c=>c.prefix!==best.prefix||c.distance!==best.distance||c.metric!==best.metric);
      const equal=candidates.splice(0,count<0?candidates.length:count);
      let hash=2166136261;
      for(const char of flowKey)hash=Math.imul(hash^char.charCodeAt(0),16777619)>>>0;
      const offset=hash%equal.length;
      candidates.unshift(...equal.slice(offset),...equal.slice(0,offset));
    }
    for (const candidate of candidates) {
      if (candidate.port) {
        if (usable(candidate.port))
          return { port: candidate.port, nextHop: candidate.nextHop, prefix: candidate.prefix };
        continue;
      }
      if (!candidate.key || directOnly) continue;
      const path = new Set([...visited, candidate.key]);
      let resolved: Resolution | undefined;
      if (work.remaining > 0) {
        work.remaining--;
        resolved = lookup(candidate.nextHop, path);
      } else {
        if (!direct.has(candidate.nextHop))
          direct.set(candidate.nextHop, lookup(candidate.nextHop, path, true));
        resolved = direct.get(candidate.nextHop);
      }
      if (resolved) return { ...resolved, prefix: candidate.prefix };
    }
  }
  return lookup(dst, visited);
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
  if (packet.protocol === 'UDP' && packet.payload.protocol === 'HSRP') {
    receiveHsrp(e, d, port, packet);
    return;
  }
  if (packet.protocol === 'VRRP') {
    receiveVrrp(e, d, port, packet, sourceMac);
    return;
  }
  const virtual = d.vrrp?.groups.find(
    (group) => group.vip === packet.dst && d.interfaces.find((p) => p.id === group.port)?.vrf === port.vrf
  );
  if (
    d.hsrp?.groups.some(
      (g) => g.vip === packet.dst && d.interfaces.find((p) => p.id === g.port)?.vrf === port.vrf
    ) &&
    !acceptsHsrpAddress(e.state, d, packet.dst, port.vrf)
  ) {
    e.drop(d, 'HSRP virtual IP is not active on this device.', port.id);
    return;
  }
  const localVirtual = virtual && acceptsVrrpAddress(e.state, d, packet.dst, port.vrf);
  if (virtual && !localVirtual) {
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
    acceptsHsrpAddress(e.state, d, packet.dst, port.vrf) ||
    (packet.dst === virtual?.vip ? localVirtual : acceptsVrrpAddress(e.state, d, packet.dst, port.vrf)) ||
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
