import type { OspfLsa, OspfPacket } from '../protocols/ospf-model';
import { md5 } from '@noble/hashes/legacy.js';
import { concat, checksum, hex, ip4, need, u16, u32, view } from './binary';
const mask = (prefix: number) => u32(prefix ? (0xffffffff << (32 - prefix)) >>> 0 : 0);
const type = (lsa: OspfLsa) =>
  ({ router: 1, network: 2, summary: 3, 'asbr-summary': 4, external: 5, nssa: 7 })[lsa.type];
const id = (lsa: OspfLsa) =>
  lsa.type === 'router' || lsa.type === 'network'
    ? lsa.id
    : lsa.type === 'asbr-summary'
      ? lsa.routerId
      : lsa.network;
// RFC 2328 A.4: Fletcher checksum excludes LS age; checksum octets are at 16/17.
function lsaChecksum(b: Uint8Array) {
  let c0 = 0,
    c1 = 0;
  for (let i = 2; i < b.length; i++) {
    c0 = (c0 + b[i]) % 255;
    c1 = (c1 + c0) % 255;
  }
  let x = ((b.length - 17) * c0 - c1) % 255;
  if (x <= 0) x += 255;
  let y = 510 - c0 - x;
  if (y > 255) y -= 255;
  b[16] = x;
  b[17] = y;
}
export function encodeOspfLsa(lsa: OspfLsa, atMs = lsa.originatedAt) {
  let body: Uint8Array;
  if (lsa.type === 'router')
    body = concat(
      new Uint8Array([lsa.flags ?? 0, 0]),
      u16(lsa.links.length + lsa.prefixes.length),
      ...lsa.links.map((l) =>
        concat(
          ip4(l.id),
          l.data ? ip4(l.data) : new Uint8Array(4),
          new Uint8Array([l.kind === 'router' ? 1 : 2, 0]),
          u16(l.cost)
        )
      ),
      ...lsa.prefixes.map((p) => concat(ip4(p.network), mask(p.prefix), new Uint8Array([3, 0]), u16(p.cost)))
    );
  else if (lsa.type === 'network') body = concat(mask(lsa.prefix), ...lsa.routers.map(ip4));
  else if (lsa.type === 'asbr-summary') body = concat(new Uint8Array(4), u32(lsa.cost & 0xffffff));
  else if (lsa.type === 'summary') body = concat(mask(lsa.prefix), u32(lsa.cost & 0xffffff));
  else
    body = concat(
      mask(lsa.prefix),
      u32((lsa.metricType === 'E2' ? 0x80000000 : 0) | (lsa.cost & 0xffffff)),
      ip4(lsa.forwardingAddress),
      u32(lsa.tag)
    );
  const header = concat(
    u16(lsa.withdrawn ? 3600 : Math.min(3599, Math.max(0, Math.floor((atMs - lsa.originatedAt) / 1000)))),
    new Uint8Array([lsa.type === 'nssa' ? 8 : 2, type(lsa)]),
    ip4(id(lsa)),
    ip4(lsa.advertisingRouter),
    u32((0x80000000 + (lsa.sequence % 0x7fffffff)) >>> 0),
    new Uint8Array(2),
    u16(20 + body.length)
  );
  const b = concat(header, body);
  lsaChecksum(b);
  return b;
}
export const ospfHeaderWire = (lsa: OspfLsa, atMs = lsa.originatedAt) =>
  [...encodeOspfLsa(lsa, atMs).subarray(0, 20)].map((b) => b.toString(16).padStart(2, '0')).join('');
type Header = { key: string; sequence: number; wire?: string };
function header(h: Header) {
  if (!h.wire) throw new Error('Legacy OSPF header lacks LSA wire metadata.');
  const b = hex(h.wire);
  if (b.length !== 20) throw new Error('Invalid OSPF LSA header.');
  return b;
}
function unsignedOspf(p: OspfPacket, atMs = p.sentAt ?? 0) {
  if (p.authentication && p.authentication.algorithm !== 'md5')
    throw new Error('Legacy OSPF model authentication has no RFC wire representation.');
  const m = p.message;
  let body: Uint8Array, t: number;
  if (m.type === 'hello') {
    t = 1;
    body = concat(
      mask(m.prefix),
      u16(m.helloMs / 1000),
      new Uint8Array([m.areaType === 'stub' ? 0 : m.areaType === 'nssa' ? 8 : 2, m.priority]),
      u32(m.deadMs / 1000),
      ip4(m.dr),
      ip4(m.bdr),
      ...m.neighbors.map(ip4)
    );
  } else if (m.type === 'database') {
    t = 2;
    body = concat(
      u16(m.mtu),
      new Uint8Array([2, (m.page === 0 ? 4 : 0) | (m.page < m.pages - 1 ? 2 : 0) | (m.reply ? 0 : 1)]),
      u32(m.page + 1),
      ...m.headers.map(header)
    );
  } else if (m.type === 'request') {
    t = 3;
    body = concat(
      ...m.headers.map((h) => {
        const b = header(h);
        return concat(u32(b[3]), b.subarray(4, 12));
      })
    );
  } else if (m.type === 'update') {
    t = 4;
    body = concat(u32(1), encodeOspfLsa(m.lsa, atMs));
  } else {
    t = 5;
    body = header(m.header);
  }
  const b = concat(
    new Uint8Array([2, t]),
    u16(24 + body.length),
    ip4(p.routerId),
    u32(p.area),
    new Uint8Array(12),
    body
  );
  if (p.authentication) {
    view(b).setUint16(14, 2);
    b[18] = p.authentication.keyId ?? 1;
    b[19] = 16;
    view(b).setUint32(20, p.authentication.sequence);
  } else view(b).setUint16(12, checksum(b));
  return b;
}
/** RFC 2328 D.4.3: keyed MD5, not HMAC; the digest is outside OSPF Packet Length. */
export function ospfMd5Digest(p: OspfPacket, key: string) {
  const secret = new Uint8Array(16);
  secret.set(new TextEncoder().encode(key).subarray(0, 16));
  return [...md5(concat(unsignedOspf(p), secret))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function encodeOspf(p: OspfPacket, atMs = p.sentAt ?? 0) {
  const b = unsignedOspf(p, atMs);
  return p.authentication ? concat(b, hex(p.authentication.digest)) : b;
}
export function verifyOspfMd5(b: Uint8Array, key: string) {
  need(b, 0, 24);
  const v = view(b),
    length = v.getUint16(2);
  if (v.getUint16(14) !== 2 || b[19] !== 16 || b.length !== length + 16) return false;
  const secret = new Uint8Array(16);
  secret.set(new TextEncoder().encode(key).subarray(0, 16));
  const expected = md5(concat(b.subarray(0, length), secret));
  let difference = 0;
  for (let i = 0; i < 16; i++) difference |= expected[i] ^ b[length + i];
  return difference === 0;
}
export function decodeOspf(b: Uint8Array) {
  need(b, 0, 24);
  const v = view(b),
    length = v.getUint16(2),
    auth = v.getUint16(14);
  if (
    b[0] !== 2 ||
    length < 24 ||
    (auth === 0
      ? length !== b.length || !!checksum(b)
      : auth !== 2 || b[19] !== 16 || b.length !== length + 16 || v.getUint16(12) !== 0)
  )
    throw new Error('Invalid OSPFv2 header or checksum.');
  const result: {
    version: number;
    type: number;
    routerId: string;
    area: number;
    lsaTypes: number[];
    lsaCount?: number;
    authentication?: { type: 2; keyId: number; sequence: number };
  } = {
    version: 2,
    type: b[1],
    routerId: [...b.subarray(4, 8)].join('.'),
    area: v.getUint32(8),
    lsaTypes: [],
    ...(auth === 2 ? { authentication: { type: 2 as const, keyId: b[18], sequence: v.getUint32(20) } } : {}),
  };
  const checkLsa = (at: number, full: boolean) => {
    need(b, at, 20);
    const size = v.getUint16(at + 18);
    if (size < 20) throw new Error('Invalid OSPF LSA length.');
    if (full) {
      need(b, at, size);
      let c0 = 0,
        c1 = 0;
      for (let i = at + 2; i < at + size; i++) {
        c0 = (c0 + b[i]) % 255;
        c1 = (c1 + c0) % 255;
      }
      if (c0 || c1) throw new Error('Invalid OSPF LSA checksum.');
    }
    result.lsaTypes.push(b[at + 3]);
    return size;
  };
  if (b[1] === 1) {
    need(b, 24, 20);
    if (length < 44 || (length - 44) % 4) throw new Error('Invalid OSPF Hello length.');
  } else if (b[1] === 2) {
    need(b, 24, 8);
    if (length < 32 || (length - 32) % 20) throw new Error('Invalid OSPF DD length.');
    for (let at = 32; at < length; at += 20) checkLsa(at, false);
  } else if (b[1] === 3) {
    if ((length - 24) % 12) throw new Error('Invalid OSPF request length.');
  } else if (b[1] === 4) {
    need(b, 24, 4);
    result.lsaCount = v.getUint32(24);
    let at = 28;
    for (let i = 0; i < result.lsaCount; i++) at += checkLsa(at, true);
    if (at !== length) throw new Error('Invalid OSPF update length.');
  } else if (b[1] === 5) {
    if ((length - 24) % 20) throw new Error('Invalid OSPF acknowledgment length.');
    for (let at = 24; at < length; at += 20) checkLsa(at, false);
  } else throw new Error('Unsupported OSPF packet type.');
  return result;
}
