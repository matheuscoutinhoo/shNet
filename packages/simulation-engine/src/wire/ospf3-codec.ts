import type { Ospf3Lsa, Ospf3Message, Ospf3Packet } from '../protocols/ospf3-model';
import { checksum, concat, ip4, ip6, need, pseudo, u16, u32, view } from './binary';

/** OSPFv3 (RFC 5340) header, Hello and Link State Update encoding, IPv6 next header 89. */
const prefixBytes = (prefix: number) => Math.ceil(prefix / 32) * 4;
function lsaBodyBytes(l: Ospf3Lsa) {
  if (l.type === 'router') return 4 + 16 * l.links.length;
  if (l.type === 'prefix') return 12 + l.prefixes.reduce((n, x) => n + 4 + prefixBytes(x.prefix), 0);
  return l.prefixes.reduce((n, x) => n + 8 + prefixBytes(x.prefix), 0);
}
/** Bytes of the OSPFv3 packet (the IPv6 header excluded). */
export function ospf3PayloadBytes(m: Ospf3Message) {
  return (
    16 +
    (m.type === 'hello'
      ? 20 + 4 * m.neighbors.length
      : 4 + m.lsas.reduce((n, l) => n + 20 + lsaBodyBytes(l), 0))
  );
}
const LS_TYPES = { router: 0x2001, prefix: 0x2009, 'inter-prefix': 0x2003 } as const;
function prefix(network: string, length: number) {
  return ip6(network).subarray(0, prefixBytes(length));
}
function lsa(l: Ospf3Lsa) {
  const body =
    l.type === 'router'
      ? concat(
          new Uint8Array([0, 0, 0, 0x13]),
          ...l.links.map((x) => concat(new Uint8Array([1, 0]), u16(x.cost), u32(0), u32(0), ip4(x.neighbor)))
        )
      : l.type === 'prefix'
        ? concat(
            u16(l.prefixes.length),
            u16(LS_TYPES.router),
            u32(0),
            ip4(l.advertisingRouter),
            ...l.prefixes.map((x) =>
              concat(new Uint8Array([x.prefix, 0]), u16(x.metric), prefix(x.network, x.prefix))
            )
          )
        : concat(
            ...l.prefixes.map((x) =>
              concat(
                u32(x.metric & 0xffffff),
                new Uint8Array([x.prefix, 0, 0, 0]),
                prefix(x.network, x.prefix)
              )
            )
          );
  const age = l.flushed ? 3600 : 1;
  return concat(
    u16(age),
    u16(LS_TYPES[l.type]),
    u32(l.id),
    ip4(l.advertisingRouter),
    u32((0x80000000 + l.sequence) >>> 0),
    u16(0),
    u16(20 + body.length),
    body
  );
}
export function encodeOspf3(p: Ospf3Packet) {
  const m = p.message;
  const body =
    m.type === 'hello'
      ? concat(
          u32(m.interfaceId),
          new Uint8Array([m.priority, 0, 0, 0x13]),
          u16(Math.min(65535, m.helloMs / 1000)),
          u16(Math.min(65535, m.deadMs / 1000)),
          ip4(m.dr),
          ip4(m.bdr),
          ...m.neighbors.map(ip4)
        )
      : concat(u32(m.lsas.length), ...m.lsas.map(lsa));
  const packet = concat(
    new Uint8Array([3, m.type === 'hello' ? 1 : 4]),
    u16(16 + body.length),
    ip4(p.routerId),
    u32(p.area),
    u16(0),
    new Uint8Array([0, 0]),
    body
  );
  view(packet).setUint16(12, checksum(concat(pseudo(p.src, p.dst, 89, packet.length), packet)));
  if (packet.length + 40 !== p.bytes) throw new Error('OSPFv3 modeled and wire sizes differ.');
  return packet;
}
/** Header fields of an OSPFv3 packet from a capture. */
export function decodeOspf3(b: Uint8Array, src: string, dst: string) {
  need(b, 0, 16);
  const v = view(b);
  if (b[0] !== 3) throw new Error('Unsupported OSPF version.');
  if (v.getUint16(2) !== b.length) throw new Error('Invalid OSPFv3 length.');
  if (checksum(concat(pseudo(src, dst, 89, b.length), b))) throw new Error('Invalid OSPFv3 checksum.');
  return {
    type: b[1],
    routerId: [...b.subarray(4, 8)].join('.'),
    area: v.getUint32(8),
    ...(b[1] === 1
      ? { neighbors: (b.length - 36) / 4, helloInterval: v.getUint16(24) }
      : { lsas: v.getUint32(16) }),
  };
}
