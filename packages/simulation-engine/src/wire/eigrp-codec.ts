import type { EigrpMessage, EigrpPacket, EigrpRouteTlv } from '../protocols/eigrp-model';
import { checksum, concat, hex, ip4, need, u16, u32, view } from './binary';

/** EIGRP (RFC 7868) classic TLV encoding, IP protocol 88. */
const OPCODES = { update: 1, query: 3, reply: 4, hello: 5, ack: 5 } as const;
const PROTOCOLS = { eigrp: 2, static: 3, rip: 4, ospf: 6, bgp: 9, connected: 11 } as const;
const STUB = { connected: 1, static: 2, summary: 4, receiveOnly: 8, redistributed: 16 } as const;
const destinationBytes = (prefix: number) => Math.max(1, Math.ceil(prefix / 8));
const routeBytes = (r: EigrpRouteTlv) => (r.external ? 45 : 25) + destinationBytes(r.prefix);
/** Bytes of the EIGRP header and TLVs (the IP header excluded). */
export function eigrpPayloadBytes(m: EigrpMessage, authenticated: boolean) {
  const tlvs =
    m.opcode === 'hello'
      ? 12 + 8 + (m.stub ? 6 : 0)
      : m.opcode === 'ack'
        ? 0
        : m.routes.reduce((n, r) => n + routeBytes(r), 0);
  return 20 + (authenticated ? 40 : 0) + tlvs;
}
const tlv = (type: number, body: Uint8Array) => concat(u16(type), u16(body.length + 4), body);
const u24 = (n: number) => new Uint8Array([(n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
function vectorBytes(r: EigrpRouteTlv) {
  const v = r.vector;
  return concat(
    u32(v.delay >= 0xffffffff ? 0xffffffff : Math.min(0xfffffffe, v.delay * 256)),
    u32(Math.min(0xffffffff, Math.floor(2_560_000_000 / v.bandwidth))),
    u24(v.mtu),
    new Uint8Array([v.hops, v.reliability, v.load])
  );
}
function destination(r: EigrpRouteTlv) {
  return concat(new Uint8Array([r.prefix]), ip4(r.network).subarray(0, destinationBytes(r.prefix)));
}
function routeTlv(r: EigrpRouteTlv) {
  if (!r.external)
    return tlv(
      0x0102,
      concat(
        ip4(r.nextHop),
        vectorBytes(r).subarray(0, 8),
        vectorBytes(r).subarray(8),
        new Uint8Array([0, 0]),
        destination(r)
      )
    );
  const x = r.external;
  return tlv(
    0x0103,
    concat(
      ip4(r.nextHop),
      ip4(x.routerId),
      u32(x.asn),
      u32(x.tag),
      u32(x.metric),
      u16(0),
      new Uint8Array([PROTOCOLS[x.protocol], 0]),
      vectorBytes(r),
      u16(0),
      destination(r)
    )
  );
}
export function encodeEigrp(p: EigrpPacket) {
  const m = p.message;
  const body =
    m.opcode === 'hello'
      ? concat(
          tlv(0x0001, concat(new Uint8Array([...m.k, 0]), u16(m.holdTime))),
          tlv(0x0004, new Uint8Array([23, 0, 2, 0])),
          ...(m.stub
            ? [
                tlv(
                  0x0006,
                  u16(
                    (Object.keys(STUB) as (keyof typeof STUB)[])
                      .filter((k) => m.stub![k])
                      .reduce((n, k) => n | STUB[k], 0)
                  )
                ),
              ]
            : [])
        )
      : m.opcode === 'ack'
        ? new Uint8Array(0)
        : concat(...m.routes.map(routeTlv));
  const auth = p.authentication
    ? tlv(
        0x0002,
        concat(
          u16(2),
          u16(16),
          u32(p.authentication.keyId),
          u32(0),
          new Uint8Array(8),
          hex(p.authentication.digest)
        )
      )
    : new Uint8Array(0);
  const flags = 'init' in m && m.init ? 1 : 0;
  const packet = concat(
    new Uint8Array([2, OPCODES[m.opcode]]),
    u16(0),
    u32(flags),
    u32(p.sequence),
    u32(p.ack),
    u16(0),
    u16(p.asn),
    auth,
    body
  );
  view(packet).setUint16(2, checksum(packet));
  if (packet.length + 20 !== p.bytes) throw new Error('EIGRP modeled and wire sizes differ.');
  return packet;
}
const PROTOCOL_NAMES = Object.fromEntries(Object.entries(PROTOCOLS).map(([k, v]) => [v, k]));
/** Header fields and TLV summary of an EIGRP packet read from a capture. */
export function decodeEigrp(b: Uint8Array) {
  need(b, 0, 20);
  const v = view(b);
  if (b[0] !== 2) throw new Error('Unsupported EIGRP version.');
  if (checksum(b)) throw new Error('Invalid EIGRP checksum.');
  const opcode = b[1],
    flags = v.getUint32(4),
    sequence = v.getUint32(8),
    ack = v.getUint32(12),
    asn = v.getUint16(18);
  const routes: { network: string; prefix: number; external: boolean; delay: number; bandwidth: number }[] =
    [];
  let k: number[] | undefined,
    holdTime: number | undefined,
    authenticated = false;
  for (let at = 20; at < b.length;) {
    need(b, at, 4);
    const type = v.getUint16(at),
      length = v.getUint16(at + 2);
    if (length < 4) throw new Error('Invalid EIGRP TLV length.');
    need(b, at, length);
    if (type === 0x0001) {
      k = [...b.subarray(at + 4, at + 9)];
      holdTime = v.getUint16(at + 10);
    } else if (type === 0x0002) authenticated = true;
    else if (type === 0x0102 || type === 0x0103) {
      const external = type === 0x0103,
        metric = at + (external ? 28 : 8),
        prefixAt = at + (external ? 44 : 24);
      const prefix = b[prefixAt],
        bytes = [...b.subarray(prefixAt + 1, at + length), 0, 0, 0, 0].slice(0, 4);
      const delay = v.getUint32(metric),
        bw = v.getUint32(metric + 4);
      routes.push({
        network: bytes.join('.'),
        prefix,
        external,
        delay: delay === 0xffffffff ? delay : delay / 256,
        bandwidth: bw ? Math.floor(2_560_000_000 / bw) : 0,
      });
      if (external && !PROTOCOL_NAMES[b[at + 26]]) throw new Error('Unknown EIGRP external protocol.');
    }
    at += length;
  }
  return { opcode, flags, sequence, ack, asn, k, holdTime, authenticated, routes };
}
