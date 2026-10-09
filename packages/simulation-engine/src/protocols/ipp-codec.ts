import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
export type IppMessage = {
  code: number;
  requestId: number;
  attributes: Record<string, string | number>;
  document: string;
};
const u16 = (n: number) => [(n >>> 8) & 255, n & 255],
  u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
export function encodeIpp(m: IppMessage) {
  const bytes = [1, 1, ...u16(m.code), ...u32(m.requestId), 1];
  for (const [name, value] of Object.entries(m.attributes)) {
    const key = new TextEncoder().encode(name),
      data = typeof value === 'number' ? u32(value) : [...new TextEncoder().encode(value)];
    bytes.push(
      typeof value === 'number'
        ? 0x21
        : name === 'attributes-charset'
          ? 0x47
          : name === 'attributes-natural-language'
            ? 0x48
            : name.endsWith('-uri')
              ? 0x45
              : 0x42,
      ...u16(key.length),
      ...key,
      ...u16(data.length),
      ...data
    );
  }
  bytes.push(3, ...new TextEncoder().encode(m.document));
  return bytesToHex(new Uint8Array(bytes));
}
export function decodeIpp(hex: string): IppMessage {
  if (hex.length > 16000 || !/^([a-f0-9]{2})+$/.test(hex)) throw new Error('IPP: octetos inválidos.');
  const b = hexToBytes(hex);
  let i = 0;
  const octet = () => {
    if (i >= b.length) throw new Error('IPP truncado.');
    return b[i++];
  };
  const u16 = () => octet() * 256 + octet(),
    u32 = () => octet() * 16777216 + octet() * 65536 + octet() * 256 + octet();
  if (octet() !== 1 || octet() !== 1) throw new Error('IPP versão não suportada.');
  const code = u16(),
    requestId = u32(),
    attributes: Record<string, string | number> = {};
  if (!requestId || octet() !== 1) throw new Error('IPP ID/grupo inválido.');
  for (let count = 0; ; count++) {
    const tag = octet();
    if (tag === 3) break;
    if (count >= 32 || ![0x21, 0x42, 0x45, 0x47, 0x48].includes(tag))
      throw new Error('IPP atributo/tag inválido.');
    const nameLen = u16();
    if (!nameLen || nameLen > 128 || i + nameLen > b.length) throw new Error('IPP nome inválido.');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(b.slice(i, i + nameLen));
    i += nameLen;
    const len = u16();
    if (len > 4096 || i + len > b.length || Object.hasOwn(attributes, name) || name === '__proto__')
      throw new Error('IPP valor inválido.');
    if (tag === 0x21) {
      if (len !== 4) throw new Error('IPP inteiro inválido.');
      attributes[name] = u32();
    } else {
      attributes[name] = new TextDecoder('utf-8', { fatal: true }).decode(b.slice(i, i + len));
      i += len;
    }
  }
  const document = new TextDecoder('utf-8', { fatal: true }).decode(b.slice(i));
  return { code, requestId, attributes, document };
}
