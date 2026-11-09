import { md5 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { HsrpMessage } from '../protocols/hsrp-model';
import { hsrpMessageSchema } from '../protocols/hsrp-model';
import { concat, hex, ip4, need, text, view } from './binary';
const opcode = { hello: 0, coup: 1, resign: 2 };
// Cisco HSRP authentication TLVs: text (type 3) and MD5 (type 4, after the HSRPv1 header too).
const TEXT_TLV = 3,
  MD5_TLV = 4;
function md5Tlv(digest: string) {
  const b = new Uint8Array(30);
  b.set([MD5_TLV, 28, 1, 0]);
  b.set(hex(digest), 14);
  return b;
}
export function encodeHsrp(input: HsrpMessage, sourceMac: string) {
  const m = hsrpMessageSchema.parse(input);
  if (m.version === 1) {
    const b = new Uint8Array(20);
    b.set([
      0,
      opcode[m.opcode],
      { SPEAK: 4, STANDBY: 8, ACTIVE: 16 }[m.state],
      Math.ceil(m.helloMs / 1000),
      Math.ceil(m.holdMs / 1000),
      m.priority,
      m.group,
      0,
    ]);
    if (!m.md5) b.set(text(m.authText ?? 'cisco'), 8);
    b.set(ip4(m.vip), 16);
    return m.md5 ? concat(b, md5Tlv(m.md5)) : b;
  }
  const b = new Uint8Array(42),
    v = view(b);
  b.set([1, 40, 2, opcode[m.opcode], { SPEAK: 4, STANDBY: 5, ACTIVE: 6 }[m.state], 4]);
  v.setUint16(6, m.group);
  b.set(hex(sourceMac.replaceAll(':', '')), 8);
  v.setUint32(14, m.priority);
  v.setUint32(18, m.helloMs);
  v.setUint32(22, m.holdMs);
  b.set(ip4(m.vip), 26);
  if (m.md5) return concat(b, md5Tlv(m.md5));
  if (!m.authText) return b;
  const auth = new Uint8Array(10);
  auth.set([TEXT_TLV, 8]);
  auth.set(text(m.authText), 2);
  return concat(b, auth);
}
/** Keyed MD5 over the packet with a zero digest, followed by the key string. */
export function hsrpDigest(m: HsrpMessage, key: string) {
  const unsigned = encodeHsrp({ ...m, md5: '0'.repeat(32) }, '00:00:00:00:00:00');
  return bytesToHex(md5(concat(unsigned, new TextEncoder().encode(key))));
}
const ascii = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\0+$/, '');
export function decodeHsrp(b: Uint8Array) {
  const base = b[0] === 0 ? 20 : 42;
  if (![base, base + 30, ...(base === 42 ? [52] : [])].includes(b.length))
    throw new Error('Unsupported HSRP length or authentication TLV.');
  const v = view(b);
  let version: 1 | 2,
    group: number,
    state: number,
    priority: number,
    helloMs: number,
    holdMs: number,
    vipAt: number,
    op: number,
    authText: string | undefined;
  if (b[0] === 0) {
    need(b, 0, 20);
    version = 1;
    op = b[1];
    state = b[2];
    helloMs = b[3] * 1000;
    holdMs = b[4] * 1000;
    priority = b[5];
    group = b[6];
    vipAt = 16;
    authText = ascii(b.subarray(8, 16));
  } else {
    need(b, 0, 42);
    if (b[0] !== 1 || b[1] !== 40 || b[2] !== 2 || b[5] !== 4)
      throw new Error('Invalid HSRPv2 group-state TLV.');
    version = 2;
    op = b[3];
    state = b[4];
    group = v.getUint16(6);
    priority = v.getUint32(14);
    helloMs = v.getUint32(18);
    holdMs = v.getUint32(22);
    vipAt = 26;
    if (b.length === 52) {
      if (b[42] !== TEXT_TLV || b[43] !== 8) throw new Error('Invalid HSRP text authentication TLV.');
      authText = ascii(b.subarray(44, 52));
    }
  }
  let digest: string | undefined;
  if (b.length === base + 30) {
    if (b[base] !== MD5_TLV || b[base + 1] !== 28) throw new Error('Invalid HSRP MD5 authentication TLV.');
    digest = bytesToHex(b.subarray(base + 14, base + 30));
  }
  const states: Record<number, HsrpMessage['state']> =
    version === 1 ? { 4: 'SPEAK', 8: 'STANDBY', 16: 'ACTIVE' } : { 4: 'SPEAK', 5: 'STANDBY', 6: 'ACTIVE' };
  return hsrpMessageSchema.parse({
    version,
    group,
    opcode: ['hello', 'coup', 'resign'][op],
    state: states[state],
    priority,
    helloMs,
    holdMs,
    vip: [...b.subarray(vipAt, vipAt + 4)].join('.'),
    ...(digest ? { md5: digest } : authText && authText !== 'cisco' ? { authText } : {}),
  });
}
