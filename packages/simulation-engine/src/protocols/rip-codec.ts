import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { RipMessage } from './rip-model';
const u16 = (n: number) => [(n >>> 8) & 255, n & 255],
  u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ip = (s: string) => s.split('.').map(Number);
// RFC 2453 RTEs and RFC 4822 keyed SHA-256 header/trailer, represented as octets.
export function encodeRip(m: RipMessage, authenticationData?: string) {
  const entries =
    m.type === 'request'
      ? [{ network: '0.0.0.0', prefix: 0, metric: 16, tag: 0, nextHop: '0.0.0.0' }]
      : m.entries;
  const a = m.authentication,
    offset = 4 + (a ? 20 : 0) + entries.length * 20,
    bytes = [m.type === 'request' ? 1 : 2, 2, 0, 0];
  if (a) bytes.push(255, 255, 0, 3, ...u16(offset), a.keyId, 32, ...u32(a.sequence), ...Array(8).fill(0));
  for (const entry of entries)
    bytes.push(
      ...u16(m.type === 'request' ? 0 : 2),
      ...u16(entry.tag),
      ...ip(entry.network),
      ...u32(entry.prefix === 0 ? 0 : (0xffffffff << (32 - entry.prefix)) >>> 0),
      ...ip(entry.nextHop ?? '0.0.0.0'),
      ...u32(entry.metric)
    );
  if (a) bytes.push(255, 255, 0, 1, ...hexToBytes(authenticationData ?? a.digest));
  return new Uint8Array(bytes);
}
export function ripAuthentication(m: RipMessage, key: string) {
  const input = new TextEncoder().encode(key),
    normalized = new Uint8Array(32);
  normalized.set(input.length > 32 ? sha256(input) : input);
  return bytesToHex(hmac(sha256, normalized, encodeRip(m, '878fe1f3'.repeat(8))));
}
