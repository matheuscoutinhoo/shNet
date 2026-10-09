import { z } from 'zod';
import { ipv4Schema } from '../schemas';
const id = z.string().min(1).max(80),
  time = z.number().finite().nonnegative();
const prefix = z.object({ network: ipv4Schema, prefix: z.number().int().min(0).max(32) }).strict();
export const tunnelConfigSchema = z
  .object({
    number: z.number().int().min(1).max(64),
    enabled: z.boolean(),
    mode: z.enum(['ipsec', 'sdwan']),
    channel: z.number().int().min(1).max(65535),
    underlay: id,
    remote: ipv4Schema,
    remotePort: z.number().int().min(1).max(65535).default(4500),
    key: z.string().min(8).max(64),
    ip: ipv4Schema,
    prefix: z.number().int().min(1).max(32),
    peerIp: ipv4Schema,
    transport: z.enum(['internet', 'mpls', 'lte']),
    advertise: z.array(prefix).max(16),
    lifetimeMs: z.number().int().min(10000).max(3600000).default(60000),
    mtu: z.number().int().min(576).max(1400).default(1400),
  })
  .strict();
export const tunnelStateSchema = tunnelConfigSchema
  .extend({
    token: id,
    tickAt: time,
    status: z.enum(['down', 'negotiating', 'up']),
    lastRx: time.optional(),
    peerNonce: id.optional(),
    ike: z
      .object({
        phase: z.enum(['INIT', 'AUTH', 'ESTABLISHED']),
        secret: z.string().regex(/^[a-f0-9]{64}$/),
        localSpi: z.string().regex(/^[a-f0-9]{16}$/),
        localChildSpi: z.string().regex(/^[a-f0-9]{8}$/),
        peerSpi: z
          .string()
          .regex(/^[a-f0-9]{16}$/)
          .optional(),
        peerChildSpi: z
          .string()
          .regex(/^[a-f0-9]{8}$/)
          .optional(),
        peerShare: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        master: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        expiresAt: time.optional(),
        retired: z.array(id).max(16),
      })
      .strict()
      .optional(),
    pending: z
      .object({ nonce: id, at: time, stage: z.enum(['INIT', 'AUTH']).optional() })
      .strict()
      .optional(),
    peerEndpoint: z
      .object({ ip: ipv4Schema, port: z.number().int().min(1).max(65535) })
      .strict()
      .optional(),
    samples: z.array(z.object({ at: time, rtt: time.optional(), success: z.boolean() }).strict()).max(16),
    remotePrefixes: z.array(prefix).max(16),
    txSequence: z.number().int().nonnegative(),
    receivedSequences: z.array(z.number().int().positive()).max(64),
    sent: z.number().int().nonnegative(),
    received: z.number().int().nonnegative(),
  })
  .strict();
const header = {
  session: id,
  channel: z.number().int().min(1).max(65535),
  nonce: id,
  proof: z.string().regex(/^[a-f0-9]{64}$/),
};
export const tunnelMessageSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...header,
      kind: z.literal('hello'),
      proposal: z.literal('X25519/AES256GCM/SHA256'),
      keyShare: z.string().regex(/^[a-f0-9]{64}$/),
      ikeSpi: z.string().regex(/^[a-f0-9]{16}$/),
      childSpi: z.string().regex(/^[a-f0-9]{8}$/),
      prefixes: z.array(prefix).max(16),
    })
    .strict(),
  z
    .object({
      ...header,
      kind: z.literal('ack'),
      proposal: z.literal('X25519/AES256GCM/SHA256'),
      keyShare: z.string().regex(/^[a-f0-9]{64}$/),
      ikeSpi: z.string().regex(/^[a-f0-9]{16}$/),
      childSpi: z.string().regex(/^[a-f0-9]{8}$/),
      prefixes: z.array(prefix).max(16),
    })
    .strict(),
  z
    .object({
      ...header,
      kind: z.enum(['auth', 'auth-ack']),
      ikeSpi: z.string().regex(/^[a-f0-9]{16}$/),
      childSpi: z.string().regex(/^[a-f0-9]{8}$/),
      prefixes: z.array(prefix).max(16),
    })
    .strict(),
  z
    .object({
      ...header,
      kind: z.literal('data'),
      sequence: z.number().int().positive(),
      spi: z.string().regex(/^[a-f0-9]{8}$/),
      innerBytes: z.number().int().min(28).max(65535),
      body: z
        .string()
        .max(65536)
        .regex(/^(?:[a-f0-9]{2})*$/),
      tag: z.string().regex(/^[a-f0-9]{32}$/),
    })
    .strict(),
]);
export const tunnelTimerSchema = z
  .object({ kind: z.literal('tunnel-tick'), device: id, port: id, token: id })
  .strict();
const match = z
  .object({
    destination: prefix,
    protocol: z.enum(['ip', 'icmp', 'tcp', 'udp']),
    destinationPort: z.number().int().min(1).max(65535).optional(),
  })
  .strict();
export const sdwanPolicySchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
    match,
    prefer: z
      .array(z.enum(['internet', 'mpls', 'lte']))
      .min(1)
      .max(3),
    maxRtt: time.max(10000),
    maxLoss: z.number().finite().min(0).max(100),
    fallback: z.boolean(),
    hits: z.number().int().nonnegative().default(0),
  })
  .strict()
  .refine(
    (p) =>
      new Set(p.prefer).size === p.prefer.length &&
      (!p.match.destinationPort || ['tcp', 'udp'].includes(p.match.protocol)),
    'Política SD-WAN inválida.'
  );
export const sdwanStateSchema = z
  .object({
    enabled: z.boolean(),
    site: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
    controller: ipv4Schema.optional(),
    underlay: id.optional(),
    key: z.string().min(8).max(64).optional(),
    policies: z.array(sdwanPolicySchema).max(32),
    receivedPolicies: z.array(sdwanPolicySchema).max(32),
    token: id,
    tickAt: time,
    lastController: time.optional(),
    pendingNonce: id.optional(),
    pendingAt: time.optional(),
    requests: z.number().int().nonnegative(),
    selected: z.array(z.object({ policy: z.string().max(32), port: id, at: time }).strict()).max(32),
  })
  .strict();
export const sdwanControllerSchema = z
  .object({
    enabled: z.boolean(),
    key: z.string().min(8).max(64),
    sites: z
      .array(
        z
          .object({
            site: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
            policies: z.array(sdwanPolicySchema).max(32),
          })
          .strict()
      )
      .max(32),
  })
  .strict();
export const sdwanMessageSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('request'),
      site: z.string().max(32),
      nonce: id,
      proof: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('policies'),
      site: z.string().max(32),
      nonce: id,
      proof: z.string().regex(/^[a-f0-9]{64}$/),
      policies: z.array(sdwanPolicySchema).max(32),
    })
    .strict(),
]);
export const sdwanTimerSchema = z.object({ kind: z.literal('sdwan-tick'), device: id, token: id }).strict();

export const sdwanConfigSchema = sdwanStateSchema
  .pick({ enabled: true, site: true, controller: true, underlay: true, key: true, policies: true })
  .refine((c) => !c.controller || (!!c.underlay && !!c.key), 'Controller exige underlay e chave.');
