import { ipv6Number, ipv6String } from '../protocols/ipv6-address';
export const text = (value: string) => new TextEncoder().encode(value);
export const concat = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
};
export const u16 = (value: number) => new Uint8Array([(value >>> 8) & 255, value & 255]);
export const u32 = (value: number) =>
  new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
export function hex(value: string) {
  if (value.length > 131070 || !/^(?:[a-f0-9]{2})*$/i.test(value))
    throw new Error('Octetos hexadecimais inválidos.');
  return Uint8Array.from(value.match(/../g) ?? [], (b) => parseInt(b, 16));
}
export const ip4 = (value: string) => Uint8Array.from(value.split('.').map(Number));
export const ip6 = (value: string) => {
  const value6 = ipv6Number(value);
  return Uint8Array.from({ length: 16 }, (_, i) => Number((value6 >> BigInt((15 - i) * 8)) & 255n));
};
export const readIp6 = (bytes: Uint8Array) => ipv6String(bytes.reduce((n, b) => (n << 8n) | BigInt(b), 0n));
export function checksum(bytes: Uint8Array) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) sum += (bytes[i] << 8) | (bytes[i + 1] ?? 0);
  while (sum > 65535) sum = (sum & 65535) + (sum >>> 16);
  return ~sum & 65535;
}
export const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
export function need(bytes: Uint8Array, at: number, length: number) {
  if (
    !Number.isInteger(at) ||
    !Number.isInteger(length) ||
    at < 0 ||
    length < 0 ||
    at + length > bytes.length
  )
    throw new Error('Pacote binário truncado.');
}
export function pseudo(src: string, dst: string, protocol: number, length: number) {
  return src.includes(':')
    ? concat(ip6(src), ip6(dst), u32(length), new Uint8Array([0, 0, 0, protocol]))
    : concat(ip4(src), ip4(dst), new Uint8Array([0, protocol]), u16(length));
}
