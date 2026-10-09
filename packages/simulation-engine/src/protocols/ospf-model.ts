import { z } from 'zod';
import { idSchema, ipv4Schema, timeSchema } from '../schemas';

export const OSPF = {
  helloMs: 10000,
  deadMs: 40000,
  retryMs: 5000,
  refreshMs: 1800000,
  maxAgeMs: 3600000,
  tickMs: 1000,
  destination: '224.0.0.5',
  mac: '01:00:5e:00:00:05',
} as const;
const cost = z.number().int().min(1).max(65535);
const area = z.number().int().min(0).max(4294967295);
const prefix = z.number().int().min(0).max(32);
const sequence = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const lsaBase = {
  area,
  id: idSchema,
  advertisingRouter: ipv4Schema,
  sequence,
  originatedAt: timeSchema,
  withdrawn: z.boolean(),
  checksum: z.number().int().min(0).max(65535).optional(),
};
export const ospfLsaSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...lsaBase,
      type: z.literal('external'),
      network: ipv4Schema,
      prefix,
      cost: z.number().int().min(1).max(16777215),
      metricType: z.enum(['E1', 'E2']),
      tag: z.number().int().min(0).max(4294967295),
      forwardingAddress: ipv4Schema,
    })
    .strict(),
  z
    .object({
      ...lsaBase,
      type: z.literal('nssa'),
      network: ipv4Schema,
      prefix,
      cost: z.number().int().min(1).max(16777215),
      metricType: z.enum(['E1', 'E2']),
      tag: z.number().int().min(0).max(4294967295),
      forwardingAddress: ipv4Schema,
    })
    .strict(),
  z
    .object({
      ...lsaBase,
      type: z.literal('asbr-summary'),
      routerId: ipv4Schema,
      cost: z.number().int().min(1).max(16777215),
    })
    .strict(),
  z
    .object({
      ...lsaBase,
      type: z.literal('router'),
      links: z
        .array(z.object({ kind: z.enum(['router', 'network']), id: ipv4Schema, cost }).strict())
        .max(256),
      prefixes: z.array(z.object({ network: ipv4Schema, prefix, cost }).strict()).max(48),
    })
    .strict(),
  z
    .object({
      ...lsaBase,
      type: z.literal('network'),
      network: ipv4Schema,
      prefix,
      routers: z.array(ipv4Schema).min(1).max(256),
    })
    .strict(),
  z
    .object({
      ...lsaBase,
      type: z.literal('summary'),
      network: ipv4Schema,
      prefix,
      cost: z.number().int().min(1).max(16777215),
    })
    .strict(),
]);
export type OspfLsa = z.infer<typeof ospfLsaSchema>;
export const lsaKey = (lsa: Pick<OspfLsa, 'area' | 'type' | 'id' | 'advertisingRouter'>) =>
  `${lsa.area}:${lsa.type}:${lsa.id}:${lsa.advertisingRouter}`;
export const lsaHeaderSchema = z.object({ key: z.string().min(1).max(140), sequence }).strict();
export type LsaHeader = z.infer<typeof lsaHeaderSchema>;
export const ospfMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('hello'),
      areaType: z.enum(['normal', 'stub', 'nssa']).optional(),
      prefix,
      helloMs: timeSchema,
      deadMs: timeSchema,
      priority: z.number().int().min(0).max(255),
      dr: ipv4Schema,
      bdr: ipv4Schema,
      neighbors: z.array(ipv4Schema).max(256),
      networkType: z.enum(['point-to-point', 'broadcast']),
    })
    .strict(),
  z
    .object({
      type: z.literal('database'),
      exchange: idSchema,
      page: z.number().int().min(0).max(63),
      pages: z.number().int().min(1).max(64),
      reply: z.boolean(),
      mtu: z.number().int().min(576).max(9216),
      headers: z.array(lsaHeaderSchema).max(16),
    })
    .strict(),
  z.object({ type: z.literal('request'), headers: z.array(lsaHeaderSchema).min(1).max(16) }).strict(),
  z.object({ type: z.literal('update'), lsa: ospfLsaSchema, flush: z.boolean() }).strict(),
  z.object({ type: z.literal('ack'), header: lsaHeaderSchema }).strict(),
]);
export type OspfMessage = z.infer<typeof ospfMessageSchema>;
export const ospfPacketSchema = z
  .object({
    src: ipv4Schema,
    dst: ipv4Schema,
    ttl: z.literal(1),
    dscp: z.number().int().min(0).max(63).optional(),
    protocol: z.literal('OSPF'),
    routerId: ipv4Schema,
    authentication: z
      .object({ sequence: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .optional(),
    area,
    message: ospfMessageSchema,
    bytes: z.number().int().min(44).max(65535),
  })
  .strict();
export type OspfPacket = z.infer<typeof ospfPacketSchema>;
export const ospfInterfaceSchema = z
  .object({
    port: idSchema,
    area,
    cost: cost.default(1),
    passive: z.boolean().default(false),
    authenticationKey: z.string().min(8).max(64).optional(),
    networkType: z.enum(['point-to-point', 'broadcast']).default('point-to-point'),
    priority: z.number().int().min(0).max(255).default(1),
    helloMs: z.number().int().min(1000).max(60000).multipleOf(1000).default(OSPF.helloMs),
    deadMs: z.number().int().min(2000).max(240000).multipleOf(1000).default(OSPF.deadMs),
  })
  .strict()
  .refine(
    (value) => value.deadMs >= value.helloMs * 2,
    'Dead interval deve ser pelo menos duas vezes o Hello.'
  );
export type OspfInterface = z.infer<typeof ospfInterfaceSchema>;
export const ospfConfigSchema = z
  .object({
    enabled: z.boolean(),
    routerId: ipv4Schema,
    interfaces: z.array(ospfInterfaceSchema).max(48),
    areas: z
      .array(
        z
          .object({ id: area, type: z.enum(['normal', 'stub', 'nssa']), defaultCost: cost.default(1) })
          .strict()
      )
      .max(48)
      .default([]),
    externalRoutes: z
      .array(
        z
          .object({
            network: ipv4Schema,
            prefix,
            cost: z.number().int().min(1).max(16777215).default(20),
            metricType: z.enum(['E1', 'E2']).default('E2'),
            tag: z.number().int().min(0).max(4294967295).default(0),
            forwardingAddress: ipv4Schema.default('0.0.0.0'),
          })
          .strict()
      )
      .max(64)
      .default([]),
  })
  .strict();
export type OspfConfig = z.infer<typeof ospfConfigSchema>;
const neighborSchema = z
  .object({
    port: idSchema,
    area,
    routerId: ipv4Schema,
    ip: ipv4Schema,
    mac: z.string().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i),
    priority: z.number().int().min(0).max(255),
    dr: ipv4Schema,
    bdr: ipv4Schema,
    state: z.enum(['Init', '2-Way', 'ExStart', 'Exchange', 'Loading', 'Full']),
    lastSeen: timeSchema,
    deadAt: timeSchema,
    exchange: idSchema,
    remoteExchange: idSchema.optional(),
    pages: z.number().int().min(1).max(64).optional(),
    description: z.array(lsaHeaderSchema).max(1024).optional(),
    receivedPages: z.array(z.number().int().min(0).max(63)).max(64),
    requests: z.array(lsaHeaderSchema).max(1024),
    pending: z.array(lsaHeaderSchema).max(1024),
    retryAt: timeSchema,
  })
  .strict();
export type OspfNeighbor = z.infer<typeof neighborSchema>;
export const dynamicRouteSchema = z
  .object({
    network: ipv4Schema,
    prefix,
    nextHop: ipv4Schema,
    port: idSchema,
    metric: z.number().int().min(0).max(16777215),
    protocol: z.enum(['OSPF', 'RIP']),
    distance: z.number().int().min(1).max(255),
    area: area.optional(),
    pathType: z.enum(['intra', 'inter', 'E1', 'E2', 'N1', 'N2']).optional(),
    internalCost: z.number().int().min(0).max(16777215).optional(),
    tag: z.number().int().min(0).max(4294967295).optional(),
  })
  .strict();
export type DynamicRoute = z.infer<typeof dynamicRouteSchema>;
export const ospfStateSchema = ospfConfigSchema
  .extend({
    token: idSchema,
    tickAt: timeSchema,
    ports: z
      .array(
        z
          .object({
            port: idSchema,
            dr: ipv4Schema,
            bdr: ipv4Schema,
            waitUntil: timeSchema,
            helloAt: timeSchema,
            operational: z.boolean(),
            signature: z.string().max(100),
          })
          .strict()
      )
      .max(48),
    neighbors: z.array(neighborSchema).max(256),
    lsdb: z.array(ospfLsaSchema).max(1024),
    routes: z.array(dynamicRouteSchema).max(1024),
    receivedSequences: z
      .array(
        z
          .object({
            port: idSchema,
            routerId: ipv4Schema,
            sequence: z.number().int().positive(),
            seen: z.array(z.number().int().positive()).max(64).default([]),
            at: timeSchema,
          })
          .strict()
      )
      .max(256)
      .default([]),
    spfRuns: z.number().int().nonnegative(),
  })
  .strict();
export const ospfTimerSchema = z
  .object({ kind: z.literal('ospf-tick'), device: idSchema, token: idSchema })
  .strict();
