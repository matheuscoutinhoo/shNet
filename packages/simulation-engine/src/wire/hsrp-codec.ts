import type { HsrpMessage } from '../protocols/hsrp-model';
import { hsrpMessageSchema } from '../protocols/hsrp-model';
import { hex, ip4, need, text, view } from './binary';
const opcode = { hello: 0, coup: 1, resign: 2 };
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
    b.set(text('cisco'), 8);
    b.set(ip4(m.vip), 16);
    return b;
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
  return b;
}
export function decodeHsrp(b: Uint8Array) {
  if (b.length !== (b[0] === 0 ? 20 : 42)) throw new Error('Unsupported HSRP length or authentication TLV.');
  const v = view(b);
  let version: 1 | 2,
    group: number,
    state: number,
    priority: number,
    helloMs: number,
    holdMs: number,
    vipAt: number,
    op: number;
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
  });
}
