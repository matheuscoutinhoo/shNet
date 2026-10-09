import { md5 } from '@noble/hashes/legacy.js';
import { hmac } from '@noble/hashes/hmac.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { hashHex } from './security-crypto';
import type { RadiusRequest, RadiusResponse } from './aaa-model';
const text = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(b);
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const read32 = (b: Uint8Array, at = 0) => new DataView(b.buffer, b.byteOffset).getUint32(at);
const attr = (type: number, data: Uint8Array | number[]) => {
  if (data.length > 253) throw new Error('Atributo AAA excede 253 octetos.');
  return [type, data.length + 2, ...data];
};
export const chapChallenge = (challenge: string) =>
  /^[a-f0-9]{32}$/.test(challenge) ? challenge : hashHex(challenge).slice(0, 32);
export const chapProof = (password: string, challenge: string) => {
  const bytes = hexToBytes(chapChallenge(challenge));
  return bytesToHex(md5(new Uint8Array([bytes[0], ...text(password), ...bytes])));
};
/** RFC 2865 CHAP-Password/Challenge, RFC 2869 Message-Authenticator. */
export function encodeAaaRadius(m: Omit<RadiusRequest, 'wire'> | Omit<RadiusResponse, 'wire'>, key: string) {
  const request = m.type === 'Access-Request',
    auth = hexToBytes(request ? m.authenticator : m.requestAuthenticator);
  const attributes: number[] = [...attr(24, text(m.id))];
  if (request) {
    const challenge = hexToBytes(chapChallenge(m.challenge));
    attributes.push(
      ...attr(1, text(m.username)),
      ...attr(3, [challenge[0], ...hexToBytes(m.proof)]),
      ...attr(60, challenge),
      ...attr(32, text(m.challenge))
    );
  } else {
    attributes.push(
      ...attr(27, u32(Math.ceil(m.sessionMs / 1000))),
      ...attr(26, [
        0,
        0,
        0,
        9,
        1,
        text('shell:priv-lvl=' + m.privilege).length + 2,
        ...text('shell:priv-lvl=' + m.privilege),
      ])
    );
    if (m.vlan) attributes.push(...attr(81, [0, ...text(String(m.vlan))]));
    for (const command of m.commands ?? []) attributes.push(...attr(11, text(command)));
  }
  const macAt = 20 + attributes.length + 2;
  attributes.push(...attr(80, Array(16).fill(0)));
  const length = 20 + attributes.length,
    code = request ? 1 : m.type === 'Access-Accept' ? 2 : 3;
  if (length > 4096 || auth.length !== 16) throw new Error('Cabeçalho RADIUS inválido.');
  const packet = new Uint8Array([
    code,
    Number.parseInt(hashHex(m.id).slice(0, 2), 16),
    length >>> 8,
    length & 255,
    ...auth,
    ...attributes,
  ]);
  packet.set(hmac(md5, text(key), packet), macAt);
  if (!request) packet.set(md5(new Uint8Array([...packet, ...text(key)])), 4);
  return bytesToHex(packet);
}
export function verifyAaaRadius(m: RadiusRequest | RadiusResponse, key: string) {
  try {
    const wire = hexToBytes(m.wire),
      request = m.type === 'Access-Request';
    if (wire.length < 20 || wire.length > 4096 || wire[2] * 256 + wire[3] !== wire.length) return false;
    const { wire: _wire, ...body } = m;
    if (request) return encodeAaaRadius(body, key) === m.wire;
    const regenerated = encodeAaaRadius(body, key);
    return regenerated === m.wire && bytesToHex(wire.slice(4, 20)) === m.authenticator;
  } catch {
    return false;
  }
}
export interface TacacsPacket {
  type: 1 | 2 | 3;
  sequence: number;
  session: number;
  body: Uint8Array;
}
/** RFC 8907 twelve-octet header and chained MD5 pad; this is obfuscation. */
export function encodeTacacs(m: TacacsPacket, key: string) {
  if (m.body.length > 4096 || m.sequence < 1 || m.sequence > 255)
    throw new Error('TACACS+ tamanho/sequência inválidos.');
  const version = m.type === 1 ? 0xc1 : 0xc0,
    session = u32(m.session),
    body = m.body.slice();
  let previous: Uint8Array = new Uint8Array();
  for (let at = 0; at < body.length; at += 16) {
    previous = md5(new Uint8Array([...session, ...text(key), version, m.sequence, ...previous]));
    for (let i = 0; i < 16 && at + i < body.length; i++) body[at + i] ^= previous[i];
  }
  return bytesToHex(
    new Uint8Array([version, m.type, m.sequence, 0, ...session, ...u32(body.length), ...body])
  );
}
export function decodeTacacs(wire: string, key: string): TacacsPacket {
  const bytes = hexToBytes(wire);
  if (
    bytes.length < 12 ||
    ![1, 2, 3].includes(bytes[1]) ||
    bytes[0] !== (bytes[1] === 1 ? 0xc1 : 0xc0) ||
    bytes[3] !== 0 ||
    !bytes[2] ||
    read32(bytes, 8) !== bytes.length - 12 ||
    bytes.length > 4108
  )
    throw new Error('Cabeçalho TACACS+ inválido.');
  const packet = {
    type: bytes[1] as 1 | 2 | 3,
    sequence: bytes[2],
    session: read32(bytes, 4),
    body: bytes.slice(12),
  };
  // XOR is its own inverse, using the same header and key.
  packet.body = hexToBytes(encodeTacacs(packet, key)).slice(12);
  return packet;
}
export const tacacsSession = (id: string, type: number) =>
  Number.parseInt(hashHex(id + '|' + type).slice(0, 8), 16);
export function tacacsStart(username: string, challenge: string, proof: string) {
  const user = text(username),
    c = hexToBytes(chapChallenge(challenge));
  return new Uint8Array([1, 1, 3, 1, user.length, 0, 0, 33, ...user, c[0], ...c, ...hexToBytes(proof)]);
}
export function readTacacsStart(body: Uint8Array) {
  if (
    body.length < 8 ||
    body[0] !== 1 ||
    body[2] !== 3 ||
    body[3] !== 1 ||
    body[5] ||
    body[6] ||
    body[7] !== 33 ||
    body.length !== 8 + body[4] + 33
  )
    throw new Error('START CHAP inválido.');
  const at = 8 + body[4],
    challenge = bytesToHex(body.slice(at + 1, at + 17));
  if (body[at] !== body[at + 1]) throw new Error('Identificador CHAP inválido.');
  return { username: decode(body.slice(8, at)), challenge, proof: bytesToHex(body.slice(at + 17)) };
}
export function tacacsArguments(username: string, args: string[], accountingFlag?: number) {
  const user = text(username),
    values = args.map(text);
  if (user.length > 64 || values.length > 32 || values.some((v) => v.length > 253))
    throw new Error('Argumentos TACACS+ inválidos.');
  return new Uint8Array([
    ...(accountingFlag === undefined ? [] : [accountingFlag]),
    6,
    1,
    3,
    1,
    user.length,
    0,
    0,
    values.length,
    ...values.map((v) => v.length),
    ...user,
    ...values.flatMap((v) => [...v]),
  ]);
}
export function readTacacsArguments(body: Uint8Array, accounting: boolean) {
  const shift = accounting ? 1 : 0,
    b = body.slice(shift);
  if (
    b.length < 8 ||
    b[0] !== 6 ||
    b[2] !== 3 ||
    b[3] !== 1 ||
    b[5] ||
    b[6] ||
    b[7] > 32 ||
    (accounting && ![2, 4, 8].includes(body[0]))
  )
    throw new Error('REQUEST TACACS+ inválido.');
  let at = 8 + b[7];
  const userEnd = at + b[4],
    username = decode(b.slice(at, userEnd));
  at = userEnd;
  const args: string[] = [];
  for (let i = 0; i < b[7]; i++) {
    const length = b[8 + i];
    if (at + length > b.length) throw new Error('Argumento TACACS+ truncado.');
    args.push(decode(b.slice(at, at + length)));
    at += length;
  }
  if (at !== b.length) throw new Error('REQUEST TACACS+ com bytes excedentes.');
  return { username, args, flag: accounting ? body[0] : undefined };
}
export function tacacsAuthorizationReply(accepted: boolean, args: string[]) {
  const values = args.map(text);
  return new Uint8Array([
    accepted ? 1 : 16,
    values.length,
    0,
    0,
    0,
    0,
    ...values.map((v) => v.length),
    ...values.flatMap((v) => [...v]),
  ]);
}
export function readTacacsAuthorization(body: Uint8Array) {
  if (body.length < 6 || ![1, 16].includes(body[0]) || body[1] > 32 || body.slice(2, 6).some(Boolean))
    throw new Error('REPLY de autorização inválido.');
  let at = 6 + body[1];
  const args: string[] = [];
  for (let i = 0; i < body[1]; i++) {
    const length = body[6 + i];
    if (at + length > body.length) throw new Error('REPLY truncado.');
    args.push(decode(body.slice(at, at + length)));
    at += length;
  }
  if (at !== body.length) throw new Error('REPLY com bytes excedentes.');
  return { accepted: body[0] === 1, args };
}
