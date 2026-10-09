import type { SimulationEngine } from '../core/engine';
import {
  interfaceSchema,
  frameSchema,
  LIMITS,
  type Device,
  type Frame,
  type NetworkInterface,
  type Snapshot,
  type UdpPacket,
} from '../model';
import { vxlanConfigSchema } from './vxlan-model';
import { resolveUnderlay } from './underlay';
import { sendWithArp } from './arp';
import { interfaceOperational } from './layer3';
import { switchFrame } from './ethernet';
import { evpnMac, validateEvpn } from './evpn';
import { isUnicast } from './dhcp-config';
import { configureBgp, bgpConfig } from './bgp';
export function vxlanConfig(p: NetworkInterface) {
  if (!p.vxlan) throw new Error('Interface sem VNI.');
  const v = p.vxlan;
  return {
    vni: v.vni,
    vlan: v.vlan,
    enabled: v.enabled,
    underlay: v.underlay,
    peers: v.peers,
    evpn: v.evpn,
    routeTarget: v.routeTarget,
    mtu: v.mtu,
  };
}
export function configureVxlan(e: SimulationEngine, d: Device, input: unknown) {
  const c = vxlanConfigSchema.parse(input),
    underlay = d.interfaces.find((p) => p.id === c.underlay);
  if (
    d.type !== 'switch' ||
    !underlay?.ip ||
    underlay.mode !== 'routed' ||
    underlay.channel ||
    underlay.tunnel ||
    underlay.vxlan ||
    underlay.vrf ||
    new Set(c.peers).size !== c.peers.length ||
    c.peers.some((ip) => !isUnicast(ip) || d.interfaces.some((p) => p.ip === ip)) ||
    d.interfaces.some((p) => p.vxlan?.vlan === c.vlan && p.vxlan.vni !== c.vni)
  )
    throw new Error('VXLAN exige switch/VTEP, underlay IPv4 routed e um VNI por VLAN.');
  let p = d.interfaces.find((p) => p.vxlan?.vni === c.vni);
  if (!p) {
    if (d.interfaces.length >= 48) throw new Error('Limite de interfaces.');
    const base = d.interfaces[0],
      used = new Set(d.interfaces.map((p) => p.mac));
    let suffix = 1;
    let mac: string;
    do {
      mac = base.mac.split(':').slice(0, 4).join(':') + ':05:' + (suffix++).toString(16).padStart(2, '0');
    } while (used.has(mac));
    p = interfaceSchema.parse({
      ...base,
      id: 'vx' + c.vni,
      name: 'Vxlan' + c.vni,
      mac,
      mode: 'access',
      ip: undefined,
      prefix: undefined,
      ipv6: undefined,
      ipv4Mode: undefined,
      dhcp: undefined,
      dhcpRelay: undefined,
      gateway: undefined,
      dns: undefined,
      channel: undefined,
      aggregate: undefined,
      dot1x: undefined,
      supplicant: undefined,
      logical: undefined,
      tunnel: undefined,
      qos: undefined,
      vrf: undefined,
      natRole: undefined,
      aclIn: undefined,
      aclOut: undefined,
      spanningTree: undefined,
      stpEdge: undefined,
      stpCost: undefined,
      adminUp: true,
      media: 'rj45',
      transceiver: undefined,
      description: 'VTEP / UDP4789',
      rx: 0,
      tx: 0,
      errors: 0,
    });
    d.interfaces.push(p);
  }
  if (!d.vlans.some((v) => v.id === c.vlan)) {
    if (d.vlans.length >= 256) throw new Error('Limite de VLANs.');
    d.vlans.push({ id: c.vlan, name: 'VLAN' + c.vlan });
  }
  p.mtu = c.mtu;
  p.accessVlan = c.vlan;
  p.vxlan = { ...c, learned: [], local: [], routes: [], sent: 0, received: 0 };
  d.macTable = d.macTable.filter((m) => m.port !== p!.id);
  if (d.bgp) configureBgp(e, d, bgpConfig(d));
  e.emit('CONFIG_CHANGED', d.id, 'VNI ' + c.vni + ' ↔ VLAN ' + c.vlan + ' configurado.', { port: p.id });
  return p;
}
export function sendVxlanFrame(e: SimulationEngine, d: Device, p: NetworkInterface, frame: Frame) {
  const v = p.vxlan!,
    underlay = d.interfaces.find((p) => p.id === v.underlay)!;
  if (
    !v.enabled ||
    !p.adminUp ||
    !interfaceOperational(e.state, d, underlay) ||
    frame.eapol ||
    frame.bpdu ||
    frame.lacp ||
    frame.wifi ||
    frame.secure
  ) {
    e.drop(d, 'VXLAN: underlay indisponível ou PDU link-local não transportada.', p.id, frame);
    return;
  }
  const bytes = frame.packet?.bytes ?? frame.fragment?.bytes ?? frame.ipv6?.bytes ?? frame.mpls?.bytes ?? 28;
  if (bytes > p.mtu || frame.vlan !== undefined) {
    e.drop(d, 'VXLAN: MTU/tag interna inválida.', p.id, frame);
    return;
  }
  const route = evpnMac(d, p, frame.dst),
    learned = v.learned.find((m) => m.mac === frame.dst && e.state.clock - m.at < LIMITS.macAge),
    peers = route ? [route.nextHop] : learned ? [learned.vtep] : v.peers;
  if (!peers.length) {
    e.drop(d, 'VXLAN sem VTEPs para replicação.', p.id, frame);
    return;
  }
  const body = JSON.stringify(frameSchema.parse(frame));
  p.tx++;
  v.sent++;
  for (const remote of peers) {
    const carrier = resolveUnderlay(d, underlay, remote);
    if (!carrier) {
      e.drop(d, 'VXLAN: sem rota underlay para ' + remote + '.', p.id);
      continue;
    }
    const packet: UdpPacket = {
      protocol: 'UDP',
      src: underlay.ip!,
      dst: remote,
      ttl: 64,
      sourcePort: 49152 + (parseInt(frame.src.replaceAll(':', '').slice(-4), 16) % 16384),
      destinationPort: 4789,
      bytes: bytes + 50,
      payload: { protocol: 'VXLAN', message: { vni: v.vni, iFlag: true, frame: body, innerBytes: bytes } },
    };
    e.emit('VXLAN_ENCAP', d.id, 'VNI ' + v.vni + ' → VTEP ' + remote + '.', { port: p.id, frame });
    sendWithArp(e, d, underlay, carrier.nextHop, packet);
  }
}
export function receiveVxlan(e: SimulationEngine, d: Device, ingress: NetworkInterface, packet: UdpPacket) {
  if (packet.payload.protocol !== 'VXLAN') return;
  const m = packet.payload.message,
    p = d.interfaces.find((p) => p.vxlan?.enabled && p.adminUp && p.vxlan.vni === m.vni),
    v = p?.vxlan;
  if (
    !p ||
    !v ||
    packet.destinationPort !== 4789 ||
    ingress.id !== v.underlay ||
    (!v.peers.includes(packet.src) && !v.routes.some((r) => r.nextHop === packet.src))
  ) {
    e.drop(d, 'VXLAN: VNI/peer/underlay não autorizado.', ingress.id);
    return;
  }
  try {
    const frame = frameSchema.parse(JSON.parse(m.frame));
    const bytes =
      frame.packet?.bytes ?? frame.fragment?.bytes ?? frame.ipv6?.bytes ?? frame.mpls?.bytes ?? 28;
    if (
      frame.eapol ||
      frame.bpdu ||
      frame.lacp ||
      frame.wifi ||
      frame.secure ||
      frame.vlan !== undefined ||
      bytes !== m.innerBytes ||
      packet.bytes !== bytes + 50 ||
      bytes > p.mtu ||
      frame.hops < 1
    )
      throw Error('Payload VXLAN/MTU/tag inválido.');
    v.learned = v.learned.filter((l) => l.mac !== frame.src && e.state.clock - l.at < LIMITS.macAge);
    v.learned.push({ mac: frame.src, vtep: packet.src, at: e.state.clock });
    v.learned = v.learned.slice(-1024);
    p.rx++;
    v.received++;
    e.emit(
      'VXLAN_DECAP',
      d.id,
      'VNI ' + v.vni + ' recebido de ' + packet.src + '; VLAN local ' + v.vlan + '.',
      { port: p.id, frame }
    );
    switchFrame(e, d, p, { ...frame, hops: frame.hops - 1 });
  } catch (error) {
    e.drop(d, (error as Error).message, p.id);
  }
}
export function validateVxlan(s: Snapshot) {
  validateEvpn(s);
  const check = (packet?: UdpPacket) => {
    if (packet?.payload.protocol !== 'VXLAN') return;
    const m = packet.payload.message,
      frame = frameSchema.parse(JSON.parse(m.frame)),
      bytes = frame.packet?.bytes ?? frame.fragment?.bytes ?? frame.ipv6?.bytes ?? frame.mpls?.bytes ?? 28;
    if (
      bytes !== m.innerBytes ||
      packet.bytes !== bytes + 50 ||
      frame.wifi ||
      frame.secure ||
      frame.lacp ||
      frame.eapol ||
      frame.bpdu ||
      frame.vlan !== undefined
    )
      throw new Error('Payload VXLAN pendente inválido.');
  };
  for (const q of s.queue)
    if (q.action.kind === 'deliver' && q.action.frame.packet?.protocol === 'UDP')
      check(q.action.frame.packet);
  for (const ev of s.events) if (ev.frame?.packet?.protocol === 'UDP') check(ev.frame.packet);
  for (const d of s.devices) {
    for (const pending of d.pending) if (pending.packet.protocol === 'UDP') check(pending.packet);
    const keys = new Set<number>();
    for (const p of d.interfaces) {
      const v = p.vxlan;
      if (!v) continue;
      const underlay = d.interfaces.find((p) => p.id === v.underlay);
      if (
        d.type !== 'switch' ||
        !underlay ||
        !underlay.ip ||
        underlay.mode !== 'routed' ||
        underlay.tunnel ||
        underlay.vxlan ||
        underlay.channel ||
        underlay.vrf ||
        p.mode !== 'access' ||
        p.accessVlan !== v.vlan ||
        p.mtu !== v.mtu ||
        p.ip ||
        p.ipv6 ||
        p.aggregate ||
        p.logical ||
        p.tunnel ||
        keys.has(v.vlan) ||
        !d.vlans.some((l) => l.id === v.vlan) ||
        d.interfaces.some((other) => other !== p && other.vxlan?.vni === v.vni) ||
        new Set(v.peers).size !== v.peers.length ||
        v.peers.some((ip) => !isUnicast(ip) || d.interfaces.some((p) => p.ip === ip)) ||
        new Set(v.learned.map((l) => l.mac)).size !== v.learned.length ||
        v.learned.some((l) => l.at > s.clock || !isUnicast(l.vtep)) ||
        s.links.some((l) => [l.a, l.b].some((end) => end.device === d.id && end.port === p.id))
      )
        throw new Error('Estado/interface VXLAN inválido.');
      keys.add(v.vlan);
    }
  }
}
