import { z } from 'zod';
import { idSchema, ipv4Schema, timeSchema } from '../schemas';
import { ipv6Schema } from './ipv6-address';

/** OSPFv3 for IPv6 (RFC 5340): link-local Hellos to FF02::5, LSAs per area and SPF. */
export const OSPF3 = {
  allRouters: 'ff02::5',
  mac: '33:33:00:00:00:05',
  helloMs: 10000,
  deadMs: 40000,
  tickMs: 1000,
  distance: 110,
} as const;
const area = z.number().int().min(0).max(4294967295);
const prefix6 = z.object({ network: ipv6Schema, prefix: z.number().int().min(0).max(128) }).strict();
export const ospf3InterfaceSchema = z
  .object({
    port: idSchema,
    area,
    cost: z.number().int().min(1).max(65535).optional(),
    priority: z.number().int().min(0).max(255).default(1),
    networkType: z.enum(['broadcast', 'point-to-point']).default('broadcast'),
    helloMs: z.number().int().min(1000).max(65535000).default(OSPF3.helloMs),
    deadMs: z.number().int().min(1000).max(65535000).default(OSPF3.deadMs),
  })
  .strict();
export const ospf3ConfigSchema = z
  .object({
    enabled: z.boolean(),
    processId: z.number().int().min(1).max(65535),
    routerId: ipv4Schema.optional(),
    passiveDefault: z.boolean().default(false),
    // Passive interfaces, or the exceptions after "passive-interface default".
    passive: z.array(idSchema).max(48).default([]),
    maximumPaths: z.number().int().min(1).max(32).default(4),
    referenceBandwidth: z.number().int().min(1).max(4294967).default(100),
    interfaces: z.array(ospf3InterfaceSchema).max(48).default([]),
  })
  .strict();
export type Ospf3Config = z.infer<typeof ospf3ConfigSchema>;
export const ospf3LsaSchema = z
  .object({
    type: z.enum(['router', 'prefix', 'inter-prefix']),
    area,
    advertisingRouter: ipv4Schema,
    id: z.number().int().min(0).max(4294967295),
    sequence: z.number().int().min(1),
    originatedAt: timeSchema,
    links: z
      .array(z.object({ neighbor: ipv4Schema, cost: z.number().int().min(1).max(65535) }).strict())
      .max(256)
      .default([]),
    prefixes: z
      .array(prefix6.extend({ metric: z.number().int().min(0).max(16777215) }).strict())
      .max(512)
      .default([]),
    // A flushed LSA (MaxAge) withdraws everything its router advertised.
    flushed: z.boolean().optional(),
  })
  .strict();
export type Ospf3Lsa = z.infer<typeof ospf3LsaSchema>;
export const ospf3MessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('hello'),
      interfaceId: z.number().int().min(0).max(4294967295),
      priority: z.number().int().min(0).max(255),
      helloMs: z.number().int().min(1000).max(65535000),
      deadMs: z.number().int().min(1000).max(65535000),
      dr: ipv4Schema,
      bdr: ipv4Schema,
      neighbors: z.array(ipv4Schema).max(256),
    })
    .strict(),
  z.object({ type: z.literal('update'), lsas: z.array(ospf3LsaSchema).max(256) }).strict(),
]);
export type Ospf3Message = z.infer<typeof ospf3MessageSchema>;
export const ospf3PacketSchema = z
  .object({
    src: ipv6Schema,
    dst: ipv6Schema,
    hopLimit: z.literal(1),
    dscp: z.number().int().min(0).max(63).optional(),
    protocol: z.literal('OSPFv3'),
    kind: z.literal('ospf'),
    routerId: ipv4Schema,
    area,
    message: ospf3MessageSchema,
    bytes: z.number().int().min(56).max(65535),
  })
  .strict();
export type Ospf3Packet = z.infer<typeof ospf3PacketSchema>;
export const ospf3NeighborSchema = z
  .object({
    routerId: ipv4Schema,
    port: idSchema,
    address: ipv6Schema,
    mac: z.string().regex(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i),
    priority: z.number().int().min(0).max(255),
    dr: ipv4Schema,
    bdr: ipv4Schema,
    interfaceId: z.number().int().min(0).max(4294967295),
    state: z.enum(['INIT', '2WAY', 'FULL']),
    deadAt: timeSchema,
    upAt: timeSchema,
  })
  .strict();
export type Ospf3Neighbor = z.infer<typeof ospf3NeighborSchema>;
export const ospf3RouteSchema = prefix6
  .extend({
    nextHop: ipv6Schema,
    port: idSchema,
    metric: z.number().int().min(0).max(16777215),
    pathType: z.enum(['intra', 'inter']),
    area,
  })
  .strict();
export type Ospf3Route = z.infer<typeof ospf3RouteSchema>;
export const ospf3StateSchema = ospf3ConfigSchema
  .extend({
    token: idSchema,
    tickAt: timeSchema,
    // Router ID in use: chosen when the process starts, like IOS.
    rid: ipv4Schema.optional(),
    ports: z
      .array(
        z
          .object({
            port: idSchema,
            helloAt: timeSchema,
            // When the interface came up: a broadcast interface waits a dead interval before electing.
            upAt: timeSchema,
            operational: z.boolean(),
            dr: ipv4Schema,
            bdr: ipv4Schema,
          })
          .strict()
      )
      .max(48),
    neighbors: z.array(ospf3NeighborSchema).max(256),
    lsdb: z.array(ospf3LsaSchema).max(4096),
    routes: z.array(ospf3RouteSchema).max(4096),
    // The database or the adjacencies changed since the last SPF run.
    spfDue: z.boolean().optional(),
    // The router ID could not be chosen (no IPv4 address and none configured).
    noRouterId: z.boolean().optional(),
  })
  .strict();
export type Ospf3State = z.infer<typeof ospf3StateSchema>;
export const ospf3TimerSchema = z
  .object({ kind: z.literal('ospf3-tick'), device: idSchema, token: idSchema })
  .strict();
