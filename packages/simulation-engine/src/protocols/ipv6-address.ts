import { z } from 'zod';

export function ipv6Number(ip: string): bigint {
  z.ipv6().parse(ip);
  let value = ip.toLowerCase();
  if (value.includes('.')) {
    const at = value.lastIndexOf(':');
    const bytes = value
      .slice(at + 1)
      .split('.')
      .map(Number);
    value =
      value.slice(0, at + 1) +
      ((bytes[0] << 8) | bytes[1]).toString(16) +
      ':' +
      ((bytes[2] << 8) | bytes[3]).toString(16);
  }
  const [left, right] = value.split('::');
  const a = left ? left.split(':') : [],
    b = right ? right.split(':') : [];
  const words = right !== undefined ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
  return words.reduce((n, word) => (n << 16n) | BigInt('0x' + word), 0n);
}
export function ipv6String(n: bigint): string {
  const words = Array.from({ length: 8 }, (_, i) => ((n >> BigInt((7 - i) * 16)) & 65535n).toString(16));
  let start = -1,
    length = 1;
  for (let i = 0; i < 8;) {
    if (words[i] !== '0') {
      i++;
      continue;
    }
    let end = i;
    while (end < 8 && words[end] === '0') end++;
    if (end - i > length) {
      start = i;
      length = end - i;
    }
    i = end;
  }
  return start < 0
    ? words.join(':')
    : words.slice(0, start).join(':') + '::' + words.slice(start + length).join(':');
}
export const ipv6Schema = z.ipv6().transform((ip) => ipv6String(ipv6Number(ip)));
export const normalize6 = (ip: string) => ipv6Schema.parse(ip);
export const network6 = (ip: string, prefix: number) =>
  ipv6String((ipv6Number(ip) >> BigInt(128 - prefix)) << BigInt(128 - prefix));
export const sameSubnet6 = (a: string, b: string, prefix: number) =>
  network6(a, prefix) === network6(b, prefix);
export const multicast6 = (ip: string) => ipv6Number(ip) >> 120n === 255n;
export const linkLocal6 = (ip: string) => sameSubnet6(ip, 'fe80::', 10);
export const unicast6 = (ip: string) => !multicast6(ip) && ipv6Number(ip) !== 0n;
export function interfaceId6(mac: string) {
  const b = mac.split(':').map((v) => parseInt(v, 16));
  b[0] ^= 2;
  return BigInt(
    '0x' + [...b.slice(0, 3), 255, 254, ...b.slice(3)].map((v) => v.toString(16).padStart(2, '0')).join('')
  );
}
export const slaacAddress6 = (network: string, mac: string) =>
  ipv6String(ipv6Number(network6(network, 64)) | interfaceId6(mac));
export const solicitedNode6 = (ip: string) =>
  ipv6String(ipv6Number('ff02::1:ff00:0') | (ipv6Number(ip) & 0xffffffn));
export const multicastMac6 = (ip: string) =>
  '33:33:' + (ipv6Number(ip) & 0xffffffffn).toString(16).padStart(8, '0').match(/../g)!.join(':');
