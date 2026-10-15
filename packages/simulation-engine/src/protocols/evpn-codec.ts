import type { BgpMessage, BgpPeer } from './bgp-model';
import { bgpAttribute, bgpPathAttributes, bgpUpdate, readBgpIp } from './bgp-codec';
import { concat, hex, ip4, need, u16, u32, view } from '../wire/binary';

type Update = Extract<BgpMessage, { type: 'UPDATE' }>;
type Mac = NonNullable<Update['evpnAnnouncements']>[number];
type Imet = NonNullable<Update['evpnImet']>[number];
export type EvpnCodecContext = { withdrawnEvpn?: BgpPeer['evpnAdvertised'] };
const bytes = (...values: number[]) => Uint8Array.from(values);
const vniBytes = (vni: number) => bytes(vni >>> 16, vni >>> 8, vni);
const readVni = (v: Uint8Array) => (v[0] << 16) | (v[1] << 8) | v[2];
// Global VNIs use the VLAN-aware bundle encoding (RFC 8365 5.1.3):
// Ethernet Tag = VNI, RD type 1 = VTEP:0, ESI = 0 (single-homed).
function routeNlri(route: Mac | Pick<Imet, 'vni' | 'nextHop'>) {
  const rd = concat(u16(1), ip4(route.nextHop), u16(0));
  const body =
    'mac' in route
      ? concat(
          rd,
          new Uint8Array(10),
          u32(route.vni),
          bytes(48),
          hex(route.mac.replaceAll(':', '')),
          bytes(route.ip ? 32 : 0),
          ...(route.ip ? [ip4(route.ip)] : []),
          vniBytes(route.vni)
        )
      : concat(rd, u32(route.vni), bytes(32), ip4(route.nextHop));
  return concat(bytes('mac' in route ? 2 : 3, body.length), body);
}
function routeTarget(rt: string) {
  const [global, local] = rt.split(':').map(Number);
  if (
    !Number.isInteger(global) ||
    !Number.isInteger(local) ||
    global < 0 ||
    local < 0 ||
    global > 0xffffffff ||
    local > 0xffffffff ||
    (global > 65535 && local > 65535)
  )
    throw new Error('RT exige ASN de 16 bits/local de 32 bits ou ASN de 32 bits/local de 16 bits.');
  return global <= 65535
    ? concat(bytes(0, 2), u16(global), u32(local))
    : concat(bytes(2, 2), u32(global), u16(local));
}
export function encodeEvpnUpdates(message: Update, context: EvpnCodecContext) {
  const result: Uint8Array[] = [];
  const withdrawn: Uint8Array[] = [];
  for (const route of message.evpnWithdrawn ?? []) {
    const previous = context.withdrawnEvpn?.find(
      (entry) => entry.vni === route.vni && entry.mac === route.mac
    );
    if (!previous) throw new Error('Retirada EVPN precisa do NLRI anteriormente anunciado.');
    withdrawn.push(routeNlri(previous));
  }
  for (const route of message.evpnAnnouncements ?? []) {
    const previous = context.withdrawnEvpn?.find(
      (entry) => entry.vni === route.vni && entry.mac === route.mac
    );
    if (previous && (previous.ip !== route.ip || previous.nextHop !== route.nextHop))
      withdrawn.push(routeNlri(previous));
  }
  for (const route of message.evpnImetWithdrawn ?? []) withdrawn.push(routeNlri(route));
  if (withdrawn.length) result.push(bgpUpdate(bgpAttribute(128, 15, concat(bytes(0, 25, 70), ...withdrawn))));
  const routes: (Mac | Imet)[] = [...(message.evpnAnnouncements ?? []), ...(message.evpnImet ?? [])];
  for (const route of routes) {
    const mac = 'mac' in route;
    const communities = concat(
      routeTarget(route.routeTarget),
      bytes(3, 12, 0, 0, 0, 0, 0, 8),
      ...(mac ? [concat(bytes(6, 0, 0, 0), u32(route.sequence))] : [])
    );
    const attributes = concat(
      bgpPathAttributes({ asPath: route.asPath }),
      bgpAttribute(192, 16, communities),
      ...(mac ? [] : [bgpAttribute(192, 22, concat(bytes(0, 6), vniBytes(route.vni), ip4(route.nextHop)))]),
      bgpAttribute(128, 14, concat(bytes(0, 25, 70, 4), ip4(route.nextHop), bytes(0), routeNlri(route)))
    );
    result.push(bgpUpdate(attributes));
  }
  return result;
}

export function decodeEvpnNlri(attrs: Map<number, Uint8Array>, asPath: number[]): Partial<Update> {
  const result: Partial<Update> = {};
  const reach = attrs.get(14),
    unreach = attrs.get(15);
  let nextHop = '',
    rt = '',
    sequence = 0;
  if (reach) {
    need(reach, 0, 9);
    if (view(reach).getUint16(0) !== 25 || reach[2] !== 70 || reach[3] !== 4 || reach[8] !== 0)
      throw new Error('MP_REACH exige EVPN IPv4 no modelo.');
    nextHop = readBgpIp(reach.subarray(4, 8));
    const ec = attrs.get(16);
    if (!ec || ec.length % 8) throw new Error('Comunidades EVPN ausentes ou truncadas.');
    let vxlan = false,
      mobility = false;
    for (let at = 0; at < ec.length; at += 8) {
      const value = ec.subarray(at, at + 8),
        v = view(value);
      if (value[1] === 2 && (value[0] === 0 || value[0] === 2)) {
        if (rt) throw new Error('O modelo suporta um RT por anúncio.');
        rt = value[0] === 0 ? `${v.getUint16(2)}:${v.getUint32(4)}` : `${v.getUint32(2)}:${v.getUint16(6)}`;
      } else if (value[0] === 3 && value[1] === 12) {
        if (value.subarray(2, 6).some(Boolean) || v.getUint16(6) !== 8)
          throw new Error('Encapsulamento EVPN não suportado.');
        vxlan = true;
      } else if (value[0] === 6 && value[1] === 0) {
        if (mobility || value[2] !== 0 || value[3] !== 0)
          throw new Error('MAC Mobility inválida ou sticky não suportado.');
        mobility = true;
        sequence = v.getUint32(4);
      }
    }
    if (!rt || !vxlan) throw new Error('EVPN exige RT e encapsulamento VXLAN.');
  }
  for (const [payload, withdrawn] of [
    [reach?.subarray(9), false],
    [unreach?.subarray(3), true],
  ] as const) {
    if (!payload) continue;
    if (withdrawn && (unreach!.length < 3 || view(unreach!).getUint16(0) !== 25 || unreach![2] !== 70))
      throw new Error('MP_UNREACH exige EVPN.');
    for (let at = 0; at < payload.length;) {
      need(payload, at, 2);
      const type = payload[at++],
        size = payload[at++];
      need(payload, at, size);
      const route = payload.subarray(at, at + size),
        v = view(route);
      at += size;
      need(route, 0, type === 2 ? 33 : 17);
      if (v.getUint16(0) !== 1 || v.getUint16(6) !== 0) throw new Error('RD fora do modelo VTEP:0.');
      const origin = readBgpIp(route.subarray(2, 6));
      if (type === 2) {
        const vni = v.getUint32(18),
          ipLength = route[29],
          end = ipLength === 32 ? 34 : 30;
        if (
          route.subarray(8, 18).some(Boolean) ||
          route[22] !== 48 ||
          ![0, 32].includes(ipLength) ||
          route.length !== end + 3 ||
          readVni(route.subarray(end)) !== vni
        )
          throw new Error('NLRI MAC/IP fora do modelo global VNI / ESI zero.');
        const mac = Array.from(route.subarray(23, 29), (b) => b.toString(16).padStart(2, '0')).join(':');
        if (withdrawn) (result.evpnWithdrawn ??= []).push({ vni, mac });
        else {
          if (origin !== nextHop) throw new Error('RD e next-hop EVPN divergentes.');
          (result.evpnAnnouncements ??= []).push({
            vni,
            mac,
            ...(ipLength ? { ip: readBgpIp(route.subarray(30, 34)) } : {}),
            sequence,
            routeTarget: rt,
            nextHop,
            asPath,
          });
        }
      } else if (type === 3) {
        const vni = v.getUint32(8),
          source = readBgpIp(route.subarray(13, 17));
        if (size !== 17 || route[12] !== 32 || source !== origin) throw new Error('NLRI IMET inválido.');
        if (!withdrawn) {
          const pmsi = attrs.get(22);
          if (
            source !== nextHop ||
            !pmsi ||
            pmsi.length !== 9 ||
            pmsi[0] !== 0 ||
            pmsi[1] !== 6 ||
            readVni(pmsi.subarray(2, 5)) !== vni ||
            readBgpIp(pmsi.subarray(5)) !== source
          )
            throw new Error('PMSI IMET exige ingress replication com VNI/VTEP consistentes.');
        }
        // RT/AS_PATH are attributes, absent in a withdrawal. The engine matches
        // an IMET withdrawal by peer/VNI/VTEP, not these omitted attributes.
        if (withdrawn) (result.evpnImetWithdrawn ??= []).push({ vni, nextHop: source });
        else (result.evpnImet ??= []).push({ vni, routeTarget: rt, nextHop, asPath });
      } else throw new Error('Tipo EVPN não suportado pelo modelo.');
    }
  }
  return result;
}
