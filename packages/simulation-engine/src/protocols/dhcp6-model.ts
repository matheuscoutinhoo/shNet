import { z } from 'zod';
import { idSchema, timeSchema } from '../schemas';
import { ipv6Schema } from './ipv6-address';
const duid = z.string().regex(/^[0-9a-f]{12,128}$/);
export const dhcp6MessageSchema = z
  .object({
    type: z.enum([
      'SOLICIT',
      'ADVERTISE',
      'REQUEST',
      'REPLY',
      'RENEW',
      'REBIND',
      'RELEASE',
      'DECLINE',
      'INFORMATION-REQUEST',
    ]),
    transactionId: z.number().int().min(0).max(0xffffff),
    clientId: duid,
    serverId: duid.optional(),
    iaid: z.number().int().nonnegative().max(0xffffffff),
    requestAddress: z.boolean(),
    requestPrefix: z.boolean(),
    rapidCommit: z.boolean().optional(),
    address: ipv6Schema.optional(),
    delegatedPrefix: ipv6Schema.optional(),
    prefixLength: z.number().int().min(1).max(128).optional(),
    preferredMs: timeSchema.max(86400000).optional(),
    validMs: timeSchema.max(86400000).optional(),
    t1Ms: timeSchema.max(86400000).optional(),
    t2Ms: timeSchema.max(86400000).optional(),
    dns: z.array(ipv6Schema).max(8).optional(),
    status: z.enum(['Success', 'NoAddrsAvail', 'NoPrefixAvail', 'NotOnLink', 'NoBinding']).optional(),
  })
  .strict();
export type Dhcp6Message = z.infer<typeof dhcp6MessageSchema>;
export const dhcp6RelayHopSchema = z
  .object({
    hopCount: z.number().int().min(0).max(31),
    linkAddress: ipv6Schema,
    peerAddress: ipv6Schema,
    interfaceId: idSchema,
  })
  .strict();
export const dhcp6RelayMessageSchema = z
  .object({
    type: z.enum(['RELAY-FORW', 'RELAY-REPL']),
    hops: z.array(dhcp6RelayHopSchema).min(1).max(8),
    message: dhcp6MessageSchema,
  })
  .strict()
  .refine(
    (m) => m.hops.every((h, i) => h.hopCount === m.hops.length - i - 1),
    'Contagem de hops DHCPv6 inconsistente.'
  );
export type Dhcp6RelayMessage = z.infer<typeof dhcp6RelayMessageSchema>;
export const dhcp6RelayConfigSchema = z
  .object({ enabled: z.boolean(), servers: z.array(ipv6Schema).min(1).max(4) })
  .strict();
export const dhcp6RelayStateSchema = dhcp6RelayConfigSchema
  .extend({
    pending: z
      .array(
        z
          .object({
            transactionId: z.number().int().min(0).max(0xffffff),
            clientId: duid,
            iaid: z.number().int().min(0).max(0xffffffff),
            peerAddress: ipv6Schema,
            expiresAt: timeSchema,
            hops: z.array(dhcp6RelayHopSchema).min(1).max(8),
          })
          .strict()
      )
      .max(128),
    leases: z
      .array(
        z
          .object({
            id: idSchema,
            clientId: duid,
            iaid: z.number().int().min(0).max(0xffffffff),
            network: ipv6Schema,
            prefix: z.number().int().min(1).max(128),
            nextHop: ipv6Schema,
            expiresAt: timeSchema,
          })
          .strict()
      )
      .max(128),
    forwarded: z.number().int().nonnegative(),
    replied: z.number().int().nonnegative(),
  })
  .strict();
export const dhcp6PoolSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
    port: idSchema,
    relayLink: z
      .object({ network: ipv6Schema, prefix: z.number().int().min(1).max(128) })
      .strict()
      .optional(),
    addresses: z.object({ start: ipv6Schema, end: ipv6Schema }).strict().optional(),
    delegation: z
      .object({
        network: ipv6Schema,
        prefix: z.number().int().min(1).max(127),
        delegatedLength: z.number().int().min(2).max(128),
        maxLeases: z.number().int().min(1).max(256),
      })
      .strict()
      .optional(),
    validMs: z.number().int().min(10000).max(86400000),
    preferredMs: z.number().int().min(1000).max(86400000),
    t1Ms: z.number().int().min(1000).max(86400000),
    t2Ms: z.number().int().min(2000).max(86400000),
    dns: z.array(ipv6Schema).max(8),
  })
  .strict()
  .refine(
    (p) =>
      (!!p.addresses || !!p.delegation) &&
      p.preferredMs <= p.validMs &&
      p.t1Ms < p.t2Ms &&
      p.t2Ms < p.validMs,
    'DHCPv6: pool exige endereços/prefixos e T1 < T2 < validade.'
  );
export const dhcp6ServerConfigSchema = z
  .object({
    enabled: z.boolean(),
    rapidCommit: z.boolean().optional(),
    relayPeers: z.array(ipv6Schema).max(32).optional(),
    pools: z.array(dhcp6PoolSchema).max(8),
  })
  .strict();
const lease = z
  .object({
    id: idSchema,
    pool: z.string().max(32),
    port: idSchema,
    clientId: duid,
    clientIp: ipv6Schema.optional(),
    iaid: z.number().int().nonnegative().max(0xffffffff),
    address: ipv6Schema.optional(),
    delegatedPrefix: ipv6Schema.optional(),
    prefixLength: z.number().int().min(1).max(128).optional(),
    state: z.enum(['offered', 'bound']),
    expiresAt: timeSchema,
  })
  .strict();
export const dhcp6ServerStateSchema = dhcp6ServerConfigSchema.extend({
  duid,
  leases: z.array(lease).max(256),
  declined: z.array(z.object({ address: ipv6Schema, until: timeSchema }).strict()).max(256),
});
export const dhcp6ClientConfigSchema = z
  .object({
    enabled: z.boolean(),
    requestAddress: z.boolean(),
    requestPrefix: z.boolean(),
    rapidCommit: z.boolean().optional(),
    delegatePort: idSchema.optional(),
  })
  .strict()
  .refine((c) => !c.enabled || c.requestAddress || c.requestPrefix, 'DHCPv6: solicite endereço ou prefixo.');
export const dhcp6ClientStateSchema = dhcp6ClientConfigSchema.safeExtend({
  duid,
  iaid: z.number().int().nonnegative().max(0xffffffff),
  token: idSchema,
  tickAt: timeSchema,
  state: z.enum(['INIT', 'SOLICITING', 'REQUESTING', 'BOUND', 'RENEWING', 'REBINDING', 'FAILED', 'DISABLED']),
  transactionId: z.number().int().min(0).max(0xffffff),
  attempts: z.number().int().min(0).max(8),
  nextAt: timeSchema,
  serverId: duid.optional(),
  serverIp: ipv6Schema.optional(),
  address: ipv6Schema.optional(),
  delegatedPrefix: ipv6Schema.optional(),
  prefixLength: z.number().int().min(1).max(128).optional(),
  validUntil: timeSchema.optional(),
  preferredUntil: timeSchema.optional(),
  t1At: timeSchema.optional(),
  t2At: timeSchema.optional(),
  dns: z.array(ipv6Schema).max(8),
});
export const dhcp6TimerSchema = z
  .object({ kind: z.literal('dhcp6-tick'), device: idSchema, port: idSchema, token: idSchema })
  .strict();
export const dhcp6Duid = (mac: string) => '00030001' + mac.replaceAll(':', '').toLowerCase();
