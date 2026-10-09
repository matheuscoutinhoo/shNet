import type { SimulationEngine } from '../core/engine';
import type { Device, Frame, NetworkInterface, Snapshot } from '../model';
import type { BgpMessage, BgpPeer } from './bgp-model';
import type { z } from 'zod';
import type { evpnMacSchema } from './vxlan-model';
import { ipNumber } from './ipv4';
import { isUnicast } from './dhcp-config';
type Route = z.infer<typeof evpnMacSchema>;
const key = (r: { vni: number; mac: string }) => r.vni + '/' + r.mac;
export function observeEvpnFrame(d: Device, input: NetworkInterface, frame: Frame, vlan: number) {
  if (input.vxlan || parseInt(frame.src.slice(0, 2), 16) & 1) return;
  const ip = frame.arp?.senderMac === frame.src ? frame.arp.senderIp : frame.packet?.src;
  for (const p of d.interfaces) {
    const v = p.vxlan;
    if (!v?.evpn || !v.enabled || v.vlan !== vlan) continue;
    let local = v.local.find((l) => l.mac === frame.src);
    if (!local) {
      if (v.local.length >= 512) continue;
      local = {
        mac: frame.src,
        sequence: Math.max(0, ...v.routes.filter((r) => r.mac === frame.src).map((r) => r.sequence)) + 1,
        port: input.id,
      };
      v.local.push(local);
    } else if (local.port !== input.id) {
      local.sequence =
        Math.max(local.sequence, ...v.routes.filter((r) => r.mac === frame.src).map((r) => r.sequence)) + 1;
      local.port = input.id;
    }
    if (ip && isUnicast(ip)) local.ip = ip;
  }
}
export function evpnEnabled(d: Device) {
  return d.interfaces.some((p) => p.vxlan?.enabled && p.vxlan.evpn);
}
export function evpnMac(d: Device, p: NetworkInterface, mac: string) {
  const v = p.vxlan;
  if (!v?.enabled || !v.evpn) return;
  return v.routes
    .filter(
      (r) =>
        r.mac === mac &&
        r.routeTarget === v.routeTarget &&
        d.bgp?.peers.some((n) => n.ip === r.peer && n.state === 'Established')
    )
    .sort(
      (a, b) =>
        b.sequence - a.sequence ||
        a.asPath.length - b.asPath.length ||
        ipNumber(a.nextHop) - ipNumber(b.nextHop)
    )[0];
}
export function evpnPort(d: Device, vlan: number, mac: string) {
  return d.interfaces.find((p) => p.vxlan?.vlan === vlan && evpnMac(d, p, mac));
}
export function withdrawEvpnPeer(e: SimulationEngine, d: Device, ip: string) {
  for (const p of d.interfaces) {
    const v = p.vxlan;
    if (!v) continue;
    const removed = v.routes.filter((r) => r.peer === ip);
    v.routes = v.routes.filter((r) => r.peer !== ip);
    for (const r of removed)
      e.emit('EVPN_WITHDRAW', d.id, 'MAC ' + r.mac + ' / VNI ' + r.vni + ': sessão BGP indisponível.', {
        port: p.id,
      });
  }
}
function localRoutes(d: Device) {
  const routes: Route[] = [];
  for (const p of d.interfaces) {
    const v = p.vxlan;
    if (!v?.enabled || !v.evpn) continue;
    const underlay = d.interfaces.find((p) => p.id === v.underlay);
    if (!underlay?.ip) continue;
    const macs = d.macTable.filter(
      (m) =>
        m.vlan === v.vlan &&
        !d.interfaces.find((p) => p.id === m.port)?.vxlan &&
        !(parseInt(m.mac.slice(0, 2), 16) & 1)
    );
    for (const m of macs) {
      let local = v.local.find((l) => l.mac === m.mac);
      if (!local) {
        if (v.local.length >= 512) continue;
        const remote = Math.max(0, ...v.routes.filter((r) => r.mac === m.mac).map((r) => r.sequence));
        local = { mac: m.mac, sequence: remote + 1, port: m.port };
        v.local.push(local);
      } else if (local.port !== m.port) {
        local.sequence =
          Math.max(local.sequence, ...v.routes.filter((r) => r.mac === m.mac).map((r) => r.sequence)) + 1;
        local.port = m.port;
      }
      routes.push({
        vni: v.vni,
        mac: local.mac,
        ip: local.ip,
        sequence: local.sequence,
        routeTarget: v.routeTarget,
        nextHop: underlay.ip,
        asPath: [],
      });
    }
  }
  return routes.sort((a, b) => key(a).localeCompare(key(b)));
}
export function advertiseEvpn(
  e: SimulationEngine,
  d: Device,
  peer: BgpPeer,
  send: (m: BgpMessage) => boolean
) {
  const c = d.bgp!.neighbors.find((n) => n.ip === peer.ip)!,
    external = c.remoteAs !== d.bgp!.asn;
  const exported = localRoutes(d).map((r) => ({ ...r, asPath: external ? [d.bgp!.asn] : [] }));
  const old = peer.evpnAdvertised ?? [],
    withdrawn = old.filter((r) => !exported.some((n) => key(n) === key(r))),
    changed = exported.filter((r) => !old.some((n) => JSON.stringify(n) === JSON.stringify(r)));
  for (let n = 0; n < withdrawn.length; n += 16) {
    const part = withdrawn.slice(n, n + 16);
    if (
      !send({
        type: 'UPDATE',
        announcements: [],
        withdrawn: [],
        evpnWithdrawn: part.map(({ vni, mac }) => ({ vni, mac })),
      })
    )
      return;
    peer.evpnAdvertised = (peer.evpnAdvertised ?? []).filter((r) => !part.some((p) => key(p) === key(r)));
  }
  for (let n = 0; n < changed.length; n += 16) {
    const part = changed.slice(n, n + 16);
    if (!send({ type: 'UPDATE', announcements: [], withdrawn: [], evpnAnnouncements: part })) return;
    peer.evpnAdvertised = [
      ...(peer.evpnAdvertised ?? []).filter((r) => !part.some((p) => key(p) === key(r))),
      ...part,
    ].sort((a, b) => key(a).localeCompare(key(b)));
    e.emit('EVPN_ADVERTISE', d.id, part.length + ' MAC(s) anunciados por BGP para ' + peer.ip + '.');
  }
}
export function receiveEvpn(
  e: SimulationEngine,
  d: Device,
  peer: BgpPeer,
  message: Extract<BgpMessage, { type: 'UPDATE' }>
) {
  const config = d.bgp!.neighbors.find((n) => n.ip === peer.ip)!;
  for (const prefix of message.evpnWithdrawn ?? [])
    for (const p of d.interfaces) {
      const v = p.vxlan;
      if (!v) continue;
      v.routes = v.routes.filter((r) => !(r.peer === peer.ip && key(r) === key(prefix)));
      e.emit(
        'EVPN_WITHDRAW',
        d.id,
        'MAC ' + prefix.mac + ' / VNI ' + prefix.vni + ' retirado por ' + peer.ip + '.',
        { port: p.id }
      );
    }
  for (const route of message.evpnAnnouncements ?? []) {
    if (
      !isUnicast(route.nextHop) ||
      route.asPath.includes(d.bgp!.asn) ||
      (config.remoteAs !== d.bgp!.asn && route.asPath[0] !== config.remoteAs) ||
      d.interfaces.some((p) => p.ip === route.nextHop) ||
      parseInt(route.mac.slice(0, 2), 16) & 1
    ) {
      e.emit('BGP_ROUTE_REJECTED', d.id, 'EVPN: NEXT_HOP/AS_PATH/MAC inválido.');
      continue;
    }
    for (const p of d.interfaces) {
      const v = p.vxlan;
      if (!v?.enabled || !v.evpn || v.vni !== route.vni || v.routeTarget !== route.routeTarget) continue;
      v.routes = v.routes.filter((r) => !(r.peer === peer.ip && key(r) === key(route)));
      if (v.routes.length >= 512) {
        e.drop(d, 'EVPN: limite de MAC routes.', p.id);
        continue;
      }
      v.routes.push({ ...route, peer: peer.ip, learnedAt: e.state.clock });
      v.routes.sort((a, b) => key(a).localeCompare(key(b)) || a.peer.localeCompare(b.peer));
      e.emit(
        'EVPN_INSTALL',
        d.id,
        'MAC ' + route.mac + ' / VNI ' + route.vni + ' → ' + route.nextHop + ' seq ' + route.sequence + '.',
        { port: p.id }
      );
    }
  }
}
export function validateEvpn(s: Snapshot) {
  for (const d of s.devices)
    for (const p of d.interfaces) {
      const v = p.vxlan;
      if (!v) continue;
      if (
        new Set(v.routes.map((r) => r.peer + '/' + key(r))).size !== v.routes.length ||
        new Set(v.local.map((r) => r.mac)).size !== v.local.length ||
        v.local.some((r) => !d.interfaces.some((p) => p.id === r.port && !p.vxlan)) ||
        v.routes.some(
          (r) =>
            r.vni !== v.vni ||
            r.routeTarget !== v.routeTarget ||
            r.learnedAt > s.clock ||
            !isUnicast(r.nextHop) ||
            !d.bgp?.peers.some((n) => n.ip === r.peer && n.state === 'Established')
        )
      )
        throw new Error('RIB/local MAC EVPN inválidos.');
    }
}
