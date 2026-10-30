import { md5 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Device } from '../model';
import { tcpOptionBytes, tcpOctets, type TcpPacket } from './tcp-model';
import { concat, pseudo, u16, u32 } from '../wire/binary';
const flags = { FIN: 1, SYN: 2, RST: 4, PSH: 8, ACK: 16, ECE: 64, CWR: 128 };
export function tcpMd5Digest(p: TcpPacket, key: string) {
  const payload = tcpOctets(p.data, p.encoding),
    size = 20 + tcpOptionBytes(p.options) + payload.length;
  const header = concat(
    u16(p.sourcePort),
    u16(p.destinationPort),
    u32(p.sequence),
    u32(p.acknowledgment),
    new Uint8Array([((20 + tcpOptionBytes(p.options)) / 4) << 4, p.flags.reduce((v, f) => v | flags[f], 0)]),
    u16(p.window),
    new Uint8Array(4)
  );
  return bytesToHex(
    md5(concat(pseudo(p.src, p.dst, 6, size), header, payload, new TextEncoder().encode(key)))
  );
}
function key(d: Device, p: TcpPacket, inbound: boolean) {
  return p.sourcePort === 179 || p.destinationPort === 179
    ? d.bgp?.neighbors.find((n) => n.ip === (inbound ? p.src : p.dst))?.password
    : undefined;
}
export function signTcp(d: Device, p: TcpPacket) {
  const secret = key(d, p, false);
  if (!secret) return;
  const old = tcpOptionBytes(p.options);
  p.options = { ...p.options, md5: '00'.repeat(16) };
  while (tcpOptionBytes(p.options) > 40 && p.options.sack?.length) {
    p.options.sack.pop();
    if (!p.options.sack.length) delete p.options.sack;
  }
  p.bytes += tcpOptionBytes(p.options) - old;
  p.options.md5 = tcpMd5Digest(p, secret);
}
export function authenticTcp(d: Device, p: TcpPacket) {
  const secret = key(d, p, true);
  if (!secret) return !p.options?.md5;
  if (!p.options?.md5) return false;
  const expected = tcpMd5Digest(p, secret);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ p.options.md5.charCodeAt(i);
  return diff === 0;
}
