import { md5 } from '@noble/hashes/legacy.js';
import { hmac } from '@noble/hashes/hmac.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
export type EapPacket = {
  code: 1 | 2 | 3 | 4;
  identifier: number;
  method?: 1 | 13 | 25;
  data: string;
  flags?: number;
  length?: number;
};
const u16 = (n: number) => [(n >>> 8) & 255, n & 255],
  u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const text = (s: string) => new TextEncoder().encode(s),
  hex = (s: string) => hexToBytes(s);
export function encodeEap(p: EapPacket) {
  if (
    !Number.isInteger(p.identifier) ||
    p.identifier < 0 ||
    p.identifier > 255 ||
    ![1, 2, 3, 4].includes(p.code)
  )
    throw new Error('EAP cabeçalho inválido.');
  let data: number[] = [];
  if (p.code === 1 || p.code === 2) {
    if (!p.method) throw new Error('EAP Request/Response exige método.');
    data = [
      p.method,
      ...(p.method === 1
        ? text(p.data)
        : [p.flags ?? 0, ...((p.flags ?? 0) & 128 ? u32(p.length ?? 0) : []), ...hex(p.data)]),
    ];
  } else if (p.data || p.method) throw new Error('EAP Success/Failure não possui payload.');
  if (data.length > 16000) throw new Error('EAP excede limite.');
  return bytesToHex(new Uint8Array([p.code, p.identifier, ...u16(data.length + 4), ...data]));
}
export function decodeEap(wire: string): EapPacket {
  const b = hex(wire),
    length = b[2] * 256 + b[3];
  if (b.length < 4 || length !== b.length || ![1, 2, 3, 4].includes(b[0]))
    throw new Error('EAP tamanho/código inválido.');
  const p: EapPacket = { code: b[0] as EapPacket['code'], identifier: b[1], data: '' };
  if (p.code === 3 || p.code === 4) {
    if (b.length !== 4) throw new Error('EAP resultado com payload.');
    return p;
  }
  if (![1, 13, 25].includes(b[4])) throw new Error('EAP método não suportado.');
  p.method = b[4] as EapPacket['method'];
  if (p.method === 1) p.data = new TextDecoder('utf-8', { fatal: true }).decode(b.slice(5));
  else {
    if (b.length < 6) throw new Error('EAP-TLS sem flags.');
    p.flags = b[5];
    let at = 6;
    if (p.flags & 128) {
      if (b.length < 10) throw new Error('EAP-TLS sem comprimento.');
      p.length = b[6] * 16777216 + b[7] * 65536 + b[8] * 256 + b[9];
      at = 10;
    }
    p.data = bytesToHex(b.slice(at));
  }
  return p;
}
export type RadiusWire = {
  code: 1 | 2 | 3 | 11;
  identifier: number;
  authenticator: string;
  eap: EapPacket;
  state?: string;
  username?: string;
  nas?: string;
  callingStation?: string;
  recvKey?: string;
  sendKey?: string;
};
function attr(type: number, data: Uint8Array | number[]) {
  if (data.length > 253) throw new Error('Atributo RADIUS excede limite.');
  return [type, data.length + 2, ...data];
}
export function wrapMppe(key: string, secret: string, requestAuthenticator: string, salt: number) {
  const bytes = hex(key),
    data = [bytes.length, ...bytes],
    saltBytes = u16(salt | 32768);
  while (data.length % 16) data.push(0);
  const result: number[] = [...saltBytes];
  let prev: number[] = [...hex(requestAuthenticator), ...saltBytes];
  for (let i = 0; i < data.length; i += 16) {
    const mask = md5(new Uint8Array([...text(secret), ...prev])),
      block = data.slice(i, i + 16).map((v, j) => v ^ mask[j]);
    result.push(...block);
    prev = block;
  }
  return new Uint8Array(result);
}
function unwrapMppe(data: Uint8Array, secret: string, requestAuthenticator: string) {
  if (data.length < 18 || (data.length - 2) % 16 || !(data[0] & 128))
    throw new Error('MS-MPPE key inválida.');
  const decoded: number[] = [];
  let prev: number[] = [...hex(requestAuthenticator), ...data.slice(0, 2)];
  for (let i = 2; i < data.length; i += 16) {
    const mask = md5(new Uint8Array([...text(secret), ...prev])),
      block = [...data.slice(i, i + 16)];
    decoded.push(...block.map((v, j) => v ^ mask[j]));
    prev = block;
  }
  const length = decoded[0];
  if (
    length < 16 ||
    length > 64 ||
    length >= decoded.length ||
    decoded.slice(length + 1).some((v) => v !== 0)
  )
    throw new Error('MS-MPPE comprimento/padding inválido.');
  return bytesToHex(new Uint8Array(decoded.slice(1, length + 1)));
}
export function encodeRadius(m: RadiusWire, secret: string, requestAuthenticator?: string) {
  const auth = hex(m.code === 1 ? m.authenticator : (requestAuthenticator ?? ''));
  if (auth.length !== 16) throw new Error('RADIUS exige Request Authenticator de 16 octetos.');
  if (
    !Number.isInteger(m.identifier) ||
    m.identifier < 0 ||
    m.identifier > 255 ||
    ![1, 2, 3, 11].includes(m.code)
  )
    throw new Error('RADIUS cabeçalho inválido.');
  const attrs: number[] = [];
  if (m.username) attrs.push(...attr(1, text(m.username)));
  if (m.state) attrs.push(...attr(24, text(m.state)));
  if (m.nas) attrs.push(...attr(32, text(m.nas)));
  if (m.callingStation) attrs.push(...attr(31, text(m.callingStation)));
  const eap = hex(encodeEap(m.eap));
  for (let i = 0; i < eap.length; i += 253) attrs.push(...attr(79, eap.slice(i, i + 253)));
  if (m.recvKey || m.sendKey) {
    if (m.code !== 2 || !requestAuthenticator) throw new Error('MPPE só em Access-Accept.');
    for (const [type, key] of [
      [17, m.recvKey],
      [16, m.sendKey],
    ] as const)
      if (key) {
        const wrapped = wrapMppe(key, secret, requestAuthenticator, type);
        attrs.push(...attr(26, [0, 0, 1, 55, type, wrapped.length + 2, ...wrapped]));
      }
  }
  const macAt = 20 + attrs.length + 2;
  attrs.push(...attr(80, Array(16).fill(0)));
  if (attrs.length + 20 > 4096) throw new Error('RADIUS excede 4096 octetos; fragmente EAP-TLS.');
  const packet = new Uint8Array([m.code, m.identifier, ...u16(20 + attrs.length), ...auth, ...attrs]);
  packet.set(hmac(md5, text(secret), packet), macAt);
  if (m.code !== 1) packet.set(md5(new Uint8Array([...packet, ...text(secret)])), 4);
  return bytesToHex(packet);
}
export function decodeRadius(wire: string, secret: string, requestAuthenticator?: string): RadiusWire {
  const packet = hex(wire),
    length = packet[2] * 256 + packet[3];
  if (
    packet.length < 20 ||
    packet.length > 4096 ||
    length !== packet.length ||
    ![1, 2, 3, 11].includes(packet[0])
  )
    throw new Error('RADIUS tamanho/código inválido.');
  const m: RadiusWire = {
    code: packet[0] as RadiusWire['code'],
    identifier: packet[1],
    authenticator: bytesToHex(packet.slice(4, 20)),
    eap: { code: 4, identifier: 0, data: '' },
  };
  const attrs: { type: number; data: Uint8Array; offset: number }[] = [];
  let at = 20;
  while (at < packet.length) {
    const n = packet[at + 1];
    if (n < 2 || at + n > packet.length) throw new Error('Atributo RADIUS truncado.');
    attrs.push({ type: packet[at], data: packet.slice(at + 2, at + n), offset: at + 2 });
    at += n;
  }
  const authenticator = attrs.filter((a) => a.type === 80);
  if (authenticator.length !== 1 || authenticator[0].data.length !== 16)
    throw new Error('RADIUS exige Message-Authenticator único.');
  const copy = packet.slice();
  if (m.code !== 1) {
    const auth = hex(requestAuthenticator ?? '');
    if (auth.length !== 16) throw new Error('RADIUS resposta sem request correlacionado.');
    copy.set(auth, 4);
    if (m.authenticator !== bytesToHex(md5(new Uint8Array([...copy, ...text(secret)]))))
      throw new Error('RADIUS Response Authenticator inválido.');
  }
  copy.fill(0, authenticator[0].offset, authenticator[0].offset + 16);
  if (bytesToHex(authenticator[0].data) !== bytesToHex(hmac(md5, text(secret), copy)))
    throw new Error('RADIUS Message-Authenticator inválido.');
  const eap = attrs.filter((a) => a.type === 79).flatMap((a) => [...a.data]);
  if (!eap.length) throw new Error('RADIUS EAP-Message ausente.');
  m.eap = decodeEap(bytesToHex(new Uint8Array(eap)));
  for (const [type, name] of [
    [1, 'username'],
    [24, 'state'],
    [32, 'nas'],
    [31, 'callingStation'],
  ] as const) {
    const values = attrs.filter((a) => a.type === type);
    if (values.length > 1) throw new Error('RADIUS atributo duplicado.');
    if (values[0]) m[name] = new TextDecoder('utf-8', { fatal: true }).decode(values[0].data);
  }
  for (const a of attrs.filter((a) => a.type === 26)) {
    if (
      a.data.length < 8 ||
      a.data[0] !== 0 ||
      a.data[1] !== 0 ||
      a.data[2] !== 1 ||
      a.data[3] !== 55 ||
      ![16, 17].includes(a.data[4]) ||
      a.data[5] !== a.data.length - 4 ||
      !requestAuthenticator
    )
      throw new Error('RADIUS vendor/MPPE inválido.');
    const field = a.data[4] === 17 ? 'recvKey' : 'sendKey';
    if (m[field]) throw new Error('RADIUS MPPE duplicada.');
    m[field] = unwrapMppe(a.data.slice(6), secret, requestAuthenticator);
  }
  return m;
}
