import { z } from 'zod';
import { ipv6Schema } from './ipv6-address';
import { tcpPacketSchema } from './tcp-model';
import { udp6DatagramSchema, udp6PayloadBytes } from './udp6-model';
const id = z.string().min(1).max(80),
  time = z.number().finite().nonnegative();
const mac = z.string().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i);
const vrf = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,32}$/)
  .optional();
export const prefix6Schema = z
  .object({
    network: ipv6Schema,
    prefix: z.number().int().min(0).max(128),
    onLink: z.boolean(),
    autonomous: z.boolean(),
    validMs: time.max(86400000),
    preferredMs: time.max(86400000),
  })
  .strict()
  .refine(
    (p) => p.preferredMs <= p.validMs && (!p.autonomous || p.prefix === 64),
    'SLAAC exige /64 e preferred <= valid.'
  );
export const ra6Schema = z
  .object({
    intervalMs: z.number().int().min(1000).max(60000),
    lifetimeMs: time.max(180000),
    prefixes: z.array(prefix6Schema).max(8),
  })
  .strict();
export const acl6RuleSchema = z
  .object({
    action: z.enum(['permit', 'deny']),
    source: ipv6Schema,
    sourcePrefix: z.number().int().min(0).max(128),
    destination: ipv6Schema,
    destinationPrefix: z.number().int().min(0).max(128),
    kind: z.enum(['any', 'echo-request', 'echo-reply', 'ndp', 'error', 'tcp', 'udp']),
    hits: z.number().int().nonnegative().default(0),
  })
  .strict();
export const ipv6ConfigSchema = z
  .object({
    auto: z.boolean(),
    addresses: z
      .array(z.object({ ip: ipv6Schema, prefix: z.number().int().min(0).max(128) }).strict())
      .max(8),
    ra: ra6Schema.optional(),
    aclIn: z.array(acl6RuleSchema).max(64).optional(),
    aclOut: z.array(acl6RuleSchema).max(64).optional(),
  })
  .strict();
export const address6Schema = z
  .object({
    ip: ipv6Schema,
    prefix: z.number().int().min(0).max(128),
    origin: z.enum(['link-local', 'static', 'slaac', 'dhcp6', 'delegated']),
    state: z.enum(['tentative', 'preferred', 'deprecated', 'duplicate']),
    onLink: z.boolean(),
    dadAt: time.optional(),
    validUntil: time.optional(),
    preferredUntil: time.optional(),
  })
  .strict();
export const ipv6InterfaceSchema = z
  .object({
    auto: z.boolean(),
    addresses: z.array(address6Schema).max(32),
    ra: ra6Schema.optional(),
    aclIn: z.array(acl6RuleSchema).max(64).optional(),
    aclOut: z.array(acl6RuleSchema).max(64).optional(),
    routers: z.array(z.object({ ip: ipv6Schema, expiresAt: time }).strict()).max(8),
    onLinkPrefixes: z
      .array(
        z.object({ network: ipv6Schema, prefix: z.number().int().min(0).max(128), expiresAt: time }).strict()
      )
      .max(32)
      .optional(),
    token: id,
    tickAt: time,
    raAt: time,
    rsAt: time,
    rsAttempts: z.number().int().min(0).max(3),
  })
  .strict();
const icmp6Schema = z
  .object({
    src: ipv6Schema,
    dst: ipv6Schema,
    hopLimit: z.number().int().min(0).max(255),
    dscp: z.number().int().min(0).max(63).optional(),
    protocol: z.literal('ICMPv6'),
    kind: z.enum([
      'echo-request',
      'echo-reply',
      'unreachable',
      'time-exceeded',
      'packet-too-big',
      'ns',
      'na',
      'rs',
      'ra',
    ]),
    bytes: z.number().int().min(48).max(65535),
    probeId: id.optional(),
    target: ipv6Schema.optional(),
    mac: mac.optional(),
    solicited: z.boolean().optional(),
    override: z.boolean().optional(),
    router: z.boolean().optional(),
    lifetimeMs: time.max(180000).optional(),
    prefixes: z.array(prefix6Schema).max(8).optional(),
    mtu: z.number().int().min(1280).max(9216).optional(),
    quote: z
      .union([
        z.object({ src: ipv6Schema, dst: ipv6Schema, probeId: id }).strict(),
        z
          .object({
            protocol: z.literal('TCP'),
            src: ipv6Schema,
            dst: ipv6Schema,
            sourcePort: z.number().int().min(1).max(65535),
            destinationPort: z.number().int().min(1).max(65535),
            sequence: z.number().int().min(0).max(0xffffffff),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict()
  .superRefine((p, c) => {
    if (
      (['ns', 'na'].includes(p.kind) && !p.target) ||
      (p.kind === 'na' && !p.mac) ||
      (p.kind === 'ra' && (p.lifetimeMs === undefined || !p.prefixes)) ||
      (['echo-request', 'echo-reply'].includes(p.kind) && !p.probeId) ||
      (['unreachable', 'time-exceeded', 'packet-too-big'].includes(p.kind) &&
        (!p.quote || p.dst !== p.quote.src)) ||
      (p.kind === 'packet-too-big' && !p.mtu)
    )
      c.addIssue({ code: 'custom', message: 'Campos ICMPv6 incompatíveis.' });
  });
const transport6 = icmp6Schema.shape;
const tcp6Schema = z
  .object({ ...transport6, protocol: z.literal('TCP'), kind: z.literal('tcp'), segment: tcpPacketSchema })
  .strict()
  .refine(
    (p) =>
      p.segment.family === 6 &&
      p.segment.src === p.src &&
      p.segment.dst === p.dst &&
      p.segment.bytes === p.bytes,
    'Cabeçalho TCP/IPv6 inconsistente.'
  );
const udp6Schema = z
  .object({ ...transport6, protocol: z.literal('UDP'), kind: z.literal('udp'), datagram: udp6DatagramSchema })
  .strict()
  .refine((p) => p.bytes === 48 + udp6PayloadBytes(p.datagram.payload), 'Tamanho UDP/IPv6 inconsistente.');
export const packet6Schema = z.discriminatedUnion('protocol', [icmp6Schema, tcp6Schema, udp6Schema]);
export const route6Schema = z
  .object({
    network: ipv6Schema,
    prefix: z.number().int().min(0).max(128),
    nextHop: ipv6Schema,
    port: id,
    metric: z.number().int().min(0).max(65535),
    dhcp6Lease: id.optional(),
    dhcp6RelayLease: id.optional(),
    vrf,
  })
  .strict();
export const neighbor6Schema = z
  .object({
    port: id,
    ip: ipv6Schema,
    mac,
    expiresAt: time,
    state: z.enum(['REACHABLE', 'STALE', 'DELAY', 'PROBE', 'FAILED']).optional(),
    probeAt: time.optional(),
    probes: z.number().int().min(0).max(3).optional(),
    router: z.boolean().optional(),
  })
  .strict();
export const pending6Schema = z.object({ port: id, nextHop: ipv6Schema, packet: packet6Schema }).strict();
export const resolution6Schema = z
  .object({
    port: id,
    ip: ipv6Schema,
    source: ipv6Schema,
    token: id,
    attempts: z.number().int().min(1).max(3),
    nextAt: time,
    state: z.literal('INCOMPLETE').optional(),
  })
  .strict();
export const probe6Schema = z
  .object({
    id,
    device: id,
    target: ipv6Schema,
    port: id,
    vrf,
    start: time,
    hopLimit: z.number().int().min(1).max(255),
    bytes: z.number().int().min(48).max(65535),
    status: z.enum(['pending', 'success', 'timeout', 'unreachable', 'time-exceeded', 'packet-too-big']),
    rtt: time.optional(),
    responder: ipv6Schema.optional(),
    mtu: z.number().int().min(1280).max(9216).optional(),
  })
  .strict();
export const ipv6TickSchema = z
  .object({ kind: z.literal('ipv6-tick'), device: id, port: id, token: id })
  .strict();
export const ndpTimerSchema = z
  .object({ kind: z.literal('ndp-timer'), device: id, port: id, ip: ipv6Schema, token: id })
  .strict();
export const probe6TimerSchema = z
  .object({ kind: z.literal('probe6-timeout'), device: id, probeId: id })
  .strict();
export type Packet6 = z.infer<typeof packet6Schema>;
export type Config6 = z.infer<typeof ipv6ConfigSchema>;
