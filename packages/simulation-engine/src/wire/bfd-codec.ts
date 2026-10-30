import { bfdMessageSchema, type BfdMessage } from '../protocols/bfd-model';
import { concat, hex, u32, view, need } from './binary';
const typeCode = { md5: 2, 'meticulous-md5': 3, 'sha-1': 4, 'meticulous-sha-1': 5 } as const;
export function encodeBfd(input: BfdMessage) {
  const m = bfdMessageSchema.parse(input),
    auth = m.authentication;
  if (!m.my || (m.poll && m.final) || (!m.your && !['AdminDown', 'Down'].includes(m.state)))
    throw new Error('Invalid BFD discriminator or Poll/Final flags.');
  let trailer = new Uint8Array(0);
  if (auth) {
    const size = auth.type.includes('md5') ? 16 : 20,
      digest = hex(auth.digest);
    if (digest.length !== size) throw new Error('Invalid BFD authentication digest length.');
    trailer = concat(
      new Uint8Array([typeCode[auth.type], size + 8, auth.keyId, 0]),
      u32(auth.sequence),
      digest
    );
  }
  return concat(
    new Uint8Array([
      0x20 | (m.diagnostic ?? 0),
      ({ AdminDown: 0, Down: 1, Init: 2, Up: 3 }[m.state] << 6) |
        (m.poll ? 0x20 : 0) |
        (m.final ? 0x10 : 0) |
        (m.controlPlaneIndependent ? 8 : 0) |
        (auth ? 4 : 0),
      m.multiplier,
      24 + trailer.length,
    ]),
    u32(m.my),
    u32(m.your),
    u32(m.desiredTx),
    u32(m.requiredRx),
    u32(0),
    trailer
  );
}
export function decodeBfd(b: Uint8Array) {
  need(b, 0, 24);
  const v = view(b),
    length = b[3],
    flags = b[1],
    authenticated = !!(flags & 4);
  if (
    length < 24 ||
    length !== b.length ||
    b[0] >>> 5 !== 1 ||
    flags & 3 ||
    (flags & 0x30) === 0x30 ||
    !b[2] ||
    !v.getUint32(4) ||
    !v.getUint32(12) ||
    (!v.getUint32(8) && flags >>> 6 > 1)
  )
    throw new Error('Unsupported or invalid BFD control packet.');
  let authentication: BfdMessage['authentication'];
  if (authenticated) {
    need(b, 24, 8);
    const type = Object.entries(typeCode).find(([, code]) => code === b[24])?.[0] as
      keyof typeof typeCode | undefined;
    if (!type) throw new Error('Unsupported BFD authentication type.');
    const size = type.includes('md5') ? 16 : 20;
    if (b[25] !== size + 8 || length !== 32 + size || b[27] !== 0)
      throw new Error('Invalid BFD authentication length or reserved field.');
    authentication = {
      type,
      keyId: b[26],
      sequence: v.getUint32(28),
      digest: [...b.subarray(32)].map((x) => x.toString(16).padStart(2, '0')).join(''),
    };
  } else if (length !== 24) throw new Error('Unauthenticated BFD control packet has trailing data.');
  return bfdMessageSchema.parse({
    state: ['AdminDown', 'Down', 'Init', 'Up'][flags >>> 6],
    multiplier: b[2],
    my: v.getUint32(4),
    your: v.getUint32(8),
    desiredTx: v.getUint32(12),
    requiredRx: v.getUint32(16),
    ...(b[0] & 31 ? { diagnostic: b[0] & 31 } : {}),
    ...(flags & 0x20 ? { poll: true } : {}),
    ...(flags & 0x10 ? { final: true } : {}),
    ...(flags & 8 ? { controlPlaneIndependent: true } : {}),
    ...(authentication ? { authentication } : {}),
  });
}
