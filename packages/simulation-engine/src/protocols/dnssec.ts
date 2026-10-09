import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { z } from 'zod';
import type { Device, DnsMessage, DnsRecord } from '../model';
import { dnsResolverSchema, dnssecZoneSchema, type nsecSchema, type dnssecProofSchema } from './dns-model';
import { ipv6Number } from './ipv6-address';
import { resolveDnsRecords } from './dns-records';

type Nsec = z.infer<typeof nsecSchema>;
type Proof = z.infer<typeof dnssecProofSchema>;
type Record = DnsRecord | Nsec;
type Response = Extract<DnsMessage, { type: 'response' }>;
const types = { A: 1, CNAME: 5, AAAA: 28, RRSIG: 46, NSEC: 47, DNSKEY: 48 };
const within = (name: string, zone: string) => name === zone || name.endsWith('.' + zone);
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const nameBytes = (name: string) => [
  ...name
    .toLowerCase()
    .split('.')
    .flatMap((label) => [label.length, ...new TextEncoder().encode(label)]),
  0,
];
const compare = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
// RFC 4034: compare labels from the root, then unsigned octets within each label.
function nameOrder(a: string, b: string) {
  const left = a.split('.').reverse(),
    right = b.split('.').reverse();
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const n = compare([...new TextEncoder().encode(left[i])], [...new TextEncoder().encode(right[i])]);
    if (n) return n;
  }
  return left.length - right.length;
}
function rdata(record: Record) {
  if (record.type === 'A') return record.value.split('.').map(Number);
  if (record.type === 'AAAA') {
    const n = ipv6Number(record.value);
    return Array.from({ length: 16 }, (_, i) => Number((n >> BigInt((15 - i) * 8)) & 255n));
  }
  if (record.type === 'CNAME') return nameBytes(record.value);
  const bitmap = Array(7).fill(0) as number[];
  for (const type of record.types) bitmap[Math.floor(types[type] / 8)] |= 128 >> (types[type] % 8);
  while (bitmap.at(-1) === 0) bitmap.pop();
  return [...nameBytes(record.next), 0, bitmap.length, ...bitmap];
}
function signedBytes(
  proof: Pick<Proof, 'zone' | 'keyTag'>,
  sig: Proof['signatures'][number],
  records: Record[]
) {
  return new Uint8Array([
    ...u16(types[sig.type]),
    15,
    sig.name.split('.').length,
    ...u32(sig.ttl),
    ...u32(sig.expiration),
    ...u32(sig.inception),
    ...u16(proof.keyTag),
    ...nameBytes(proof.zone),
    ...records
      .map(rdata)
      .sort(compare)
      .flatMap((data) => [
        ...nameBytes(sig.name),
        ...u16(types[sig.type]),
        0,
        1,
        ...u32(sig.ttl),
        ...u16(data.length),
        ...data,
      ]),
  ]);
}
function keyData(publicKey: string) {
  return new Uint8Array([1, 1, 3, 15, ...hexToBytes(publicKey)]);
}
function keyTag(publicKey: string) {
  const data = keyData(publicKey);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += i & 1 ? data[i] : data[i] << 8;
  return (sum + (sum >>> 16)) & 65535;
}
export function dnssecAnchor(zone: z.infer<typeof dnssecZoneSchema>) {
  const publicKey = bytesToHex(ed25519.getPublicKey(hexToBytes(zone.seed)));
  return {
    zone: zone.name,
    digest: bytesToHex(sha256(new Uint8Array([...nameBytes(zone.name), ...keyData(publicKey)]))),
  };
}
function covers(nsec: Nsec, name: string) {
  const left = nameOrder(nsec.name, name),
    right = nameOrder(name, nsec.next);
  return nameOrder(nsec.name, nsec.next) < 0 ? left < 0 && right < 0 : left < 0 || right < 0;
}
function nsecRing(records: DnsRecord[], zone: string): Nsec[] {
  const names = new Set([zone]);
  for (const record of records.filter((r) => within(r.name, zone))) {
    let name = record.name;
    while (within(name, zone)) {
      names.add(name);
      if (name === zone) break;
      name = name.slice(name.indexOf('.') + 1);
    }
  }
  const sorted = [...names].sort(nameOrder);
  return sorted.map((name, i) => ({
    name,
    type: 'NSEC',
    ttl: 60,
    next: sorted[(i + 1) % sorted.length],
    types: [
      ...new Set([
        ...records.filter((r) => r.name === name).map((r) => r.type),
        'RRSIG' as const,
        'NSEC' as const,
        ...(name === zone ? ['DNSKEY' as const] : []),
      ]),
    ],
  }));
}
function finalName(response: Response) {
  let name = response.question.name;
  for (const record of response.answers)
    if (record.type === 'CNAME' && record.name === name) name = record.value;
  return name;
}
export function buildDnsResponse(
  device: Device,
  query: Extract<DnsMessage, { type: 'query' }>,
  clock: number
): Response {
  const result = device.dnsServer?.enabled
    ? resolveDnsRecords(device.dnsServer.records, query.question)
    : { code: 'REFUSED' as const, answers: [] };
  const response: Response = {
    type: 'response',
    transactionId: query.transactionId,
    question: query.question,
    recursionDesired: query.recursionDesired,
    recursionAvailable: false,
    authoritative: true,
    truncated: false,
    code: result.answers.length > 64 ? 'SERVFAIL' : result.code,
    answers: result.answers.slice(0, 64).map((record) => ({
      ...record,
      ttl: Math.min(
        ...result.answers.filter((r) => r.name === record.name && r.type === record.type).map((r) => r.ttl)
      ),
    })),
  };
  if (query.edns) response.edns = { ...query.edns, version: 0 };
  if (query.edns?.version) {
    response.code = 'BADVERS';
    response.answers = [];
    return response;
  }
  if (!query.edns?.dnssecOk) return response;
  const name = finalName(response);
  const zone = device.dnsServer?.zones
    ?.filter((z) => within(name, z.name) && response.answers.every((r) => within(r.name, z.name)))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!zone || !['NOERROR', 'NXDOMAIN'].includes(response.code)) return response;
  const publicKey = bytesToHex(ed25519.getPublicKey(hexToBytes(zone.seed)));
  const proof: Proof = { zone: zone.name, publicKey, keyTag: keyTag(publicKey), signatures: [], denial: [] };
  if (response.code === 'NXDOMAIN' || !response.answers.some((r) => r.type === query.question.type)) {
    const ring = nsecRing(device.dnsServer!.records, zone.name);
    const exact = ring.find((r) => r.name === name);
    if (exact) {
      response.code = 'NOERROR';
      proof.denial = [exact];
    } else {
      let closest = name;
      while (!ring.some((r) => r.name === closest) && closest.includes('.'))
        closest = closest.slice(closest.indexOf('.') + 1);
      const nextCloser = name
        .split('.')
        .slice(-(closest.split('.').length + 1))
        .join('.');
      proof.denial = [
        ...new Set([
          ring.find((r) => r.name === closest)!,
          ring.find((r) => covers(r, nextCloser))!,
          ring.find((r) => covers(r, '*.' + closest))!,
        ]),
      ];
    }
  }
  const records: Record[] = [...response.answers, ...proof.denial];
  for (const record of records) {
    if (proof.signatures.some((s) => s.name === record.name && s.type === record.type)) continue;
    const set = records.filter((r) => r.name === record.name && r.type === record.type);
    const signature = {
      name: record.name,
      type: record.type,
      ttl: Math.min(...set.map((r) => r.ttl)),
      inception: Math.floor(clock / 1000),
      expiration: Math.floor(clock / 1000) + zone.validity,
      signature: '',
    };
    signature.signature = bytesToHex(ed25519.sign(signedBytes(proof, signature, set), hexToBytes(zone.seed)));
    proof.signatures.push(signature);
  }
  response.dnssec = proof;
  return response;
}
export function verifyDnsResponse(
  device: Device,
  response: Response,
  clock: number
): 'secure' | 'insecure' | 'bogus' {
  const policy = device.dnsResolver;
  if (!policy || policy.validation === 'off') return 'insecure';
  const proof = response.dnssec;
  const anchor = policy.anchors
    .filter((a) => within(finalName(response), a.zone))
    .sort((a, b) => b.zone.length - a.zone.length)[0];
  if (!proof) return policy.validation === 'require' || anchor ? 'bogus' : 'insecure';
  if (!anchor || anchor.zone !== proof.zone) return policy.validation === 'require' ? 'bogus' : 'insecure';
  if (
    anchor.digest !==
      bytesToHex(sha256(new Uint8Array([...nameBytes(proof.zone), ...keyData(proof.publicKey)]))) ||
    keyTag(proof.publicKey) !== proof.keyTag
  )
    return 'bogus';
  const now = Math.floor(clock / 1000),
    records: Record[] = [...response.answers, ...proof.denial];
  try {
    for (const record of records) {
      const signature = proof.signatures.find((s) => s.name === record.name && s.type === record.type);
      if (
        !within(record.name, proof.zone) ||
        !signature ||
        signature.inception > now ||
        signature.expiration <= now ||
        record.ttl > signature.ttl ||
        signature.expiration <= signature.inception
      )
        return 'bogus';
      if (
        !ed25519.verify(
          hexToBytes(signature.signature),
          signedBytes(
            proof,
            signature,
            records.filter((r) => r.name === record.name && r.type === record.type)
          ),
          hexToBytes(proof.publicKey)
        )
      )
        return 'bogus';
    }
  } catch {
    return 'bogus';
  }
  if (!records.length) return 'bogus';
  const name = finalName(response);
  if (response.code === 'NXDOMAIN') {
    const ancestors = proof.denial
      .filter((r) => within(name, r.name))
      .sort((a, b) => b.name.length - a.name.length);
    const closest = ancestors[0];
    if (!closest || closest.name === name) return 'bogus';
    const nextCloser = name
      .split('.')
      .slice(-(closest.name.split('.').length + 1))
      .join('.');
    if (
      !proof.denial.some((r) => covers(r, nextCloser)) ||
      !proof.denial.some((r) => covers(r, '*.' + closest.name))
    )
      return 'bogus';
  } else if (
    response.code === 'NOERROR' &&
    !response.answers.some((r) => r.type === response.question.type)
  ) {
    const exact = proof.denial.find((r) => r.name === name);
    if (!exact || exact.types.includes(response.question.type) || exact.types.includes('CNAME'))
      return 'bogus';
  } else if (response.code !== 'NOERROR') return 'bogus';
  return 'secure';
}
export function dnsCacheExpiry(clock: number, answers: DnsRecord[], proof?: Proof) {
  return Math.min(
    clock + Math.min(...answers.map((r) => r.ttl)) * 1000,
    ...(proof?.signatures.map((s) => s.expiration * 1000) ?? [])
  );
}
export function configureDnsSecurity(device: Device, input: unknown, zones?: unknown) {
  const resolver = dnsResolverSchema.parse(input);
  const parsed = zones === undefined ? undefined : dnssecZoneSchema.array().max(16).parse(zones);
  if (parsed && device.type !== 'server' && device.type !== 'router')
    throw new Error('Zonas DNSSEC requerem servidor ou roteador.');
  if (
    new Set(resolver.anchors.map((a) => a.zone)).size !== resolver.anchors.length ||
    (parsed && new Set(parsed.map((z) => z.name)).size !== parsed.length)
  )
    throw new Error('Zona ou âncora DNSSEC duplicada.');
  if (resolver.validation !== 'off' && !resolver.edns?.dnssecOk)
    throw new Error('Validação DNSSEC requer EDNS com DO=1.');
  device.dnsResolver = resolver;
  device.dnsCache = [];
  if (parsed)
    device.dnsServer = {
      ...device.dnsServer,
      enabled: device.dnsServer?.enabled ?? true,
      records: device.dnsServer?.records ?? [],
      zones: parsed,
    };
}
