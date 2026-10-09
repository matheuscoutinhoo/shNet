import type { Device } from '../model';
import type { OspfLsa, OspfPacket } from './ospf-model';
import { hmacHex } from './security-crypto';
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
      .join(',') +
    '}'
  );
}
export function lsaChecksum(lsa: OspfLsa) {
  const { checksum: _c, originatedAt: _age, ...body } = lsa;
  let a = 0,
    b = 0;
  for (const octet of new TextEncoder().encode(canonical(body))) {
    a = (a + octet) % 255;
    b = (b + a) % 255;
  }
  return b * 256 + a;
}
export function ospfAuthenticator(p: OspfPacket, key: string) {
  const { authentication: _a, ...body } = p;
  return hmacHex(key, canonical(body) + '|' + p.authentication!.sequence);
}
export const ospfAreaType = (d: Device, area: number) =>
  d.ospf?.areas.find((a) => a.id === area)?.type ?? 'normal';
