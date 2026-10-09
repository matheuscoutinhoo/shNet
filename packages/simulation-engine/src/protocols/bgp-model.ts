import { evpnMacSchema, evpnWithdrawSchema } from './vxlan-model';
import { z } from 'zod';
import { idSchema, ipv4Schema, timeSchema } from '../schemas';

export const BGP = { port: 179, tickMs: 1000, retryMs: 5000, maxRoutes: 512, maxMessage: 4096 } as const;
const asn = z.number().int().min(1).max(4294967294);
const prefix = z.object({ network: ipv4Schema, prefix: z.number().int().min(0).max(32) }).strict();
export const bgpFilterSchema = prefix
  .extend({
    action: z.enum(['permit', 'deny']),
    sequence: z.number().int().min(1).max(65535).default(10),
    minPrefix: z.number().int().min(0).max(32).optional(),
    maxPrefix: z.number().int().min(0).max(32).optional(),
  })
  .strict();
export const bgpNeighborSchema = z
  .object({
    ip: ipv4Schema,
    remoteAs: asn,
    passive: z.boolean().default(false),
    nextHopSelf: z.boolean().default(false),
    reflectorClient: z.boolean().default(false),
    localPref: z.number().int().min(0).max(4294967295).default(100),
    med: z.number().int().min(0).max(4294967295).default(0),
    prepend: z.number().int().min(0).max(5).default(0),
    importFilter: z.array(bgpFilterSchema).max(32).default([]),
    exportFilter: z.array(bgpFilterSchema).max(32).default([]),
  })
  .strict();
const configShape = {
  enabled: z.boolean(),
  asn,
  routerId: ipv4Schema,
  holdMs: z.number().int().min(3000).max(180000).multipleOf(1000).default(90000),
  networks: z.array(prefix).max(128),
  neighbors: z.array(bgpNeighborSchema).max(32),
};
export const bgpConfigSchema = z.object(configShape).strict();
export const bgpPathSchema = prefix
  .extend({
    nextHop: ipv4Schema,
    asPath: z.array(asn).max(32),
    origin: z.enum(['IGP', 'EGP', 'INCOMPLETE']),
    localPref: z.number().int().min(0).max(4294967295),
    med: z.number().int().min(0).max(4294967295),
    originatorId: ipv4Schema.optional(),
    clusterList: z.array(ipv4Schema).max(16).optional(),
  })
  .strict();
export const bgpMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('OPEN'),
      evpn: z.boolean().optional(),
      version: z.literal(4),
      asn,
      routerId: ipv4Schema,
      holdMs: configShape.holdMs,
    })
    .strict(),
  z.object({ type: z.literal('KEEPALIVE') }).strict(),
  z
    .object({
      type: z.literal('UPDATE'),
      announcements: z.array(bgpPathSchema).max(16),
      withdrawn: z.array(prefix).max(32),
      evpnAnnouncements: z.array(evpnMacSchema).max(16).optional(),
      evpnWithdrawn: z.array(evpnWithdrawSchema).max(16).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('NOTIFICATION'),
      code: z.number().int().min(1).max(6),
      reason: z.string().min(1).max(120),
    })
    .strict(),
]);
export const bgpPeerSchema = z
  .object({
    ip: ipv4Schema,
    state: z.enum(['Idle', 'Connect', 'Active', 'OpenSent', 'OpenConfirm', 'Established']),
    changedAt: timeSchema,
    retryAt: timeSchema,
    connection: idSchema.optional(),
    remoteId: ipv4Schema.optional(),
    holdMs: configShape.holdMs.optional(),
    receivedAt: timeSchema.optional(),
    holdAt: timeSchema.optional(),
    keepaliveAt: timeSchema.optional(),
    establishedAt: timeSchema.optional(),
    sent: z.number().int().nonnegative(),
    received: z.number().int().nonnegative(),
    advertised: z.array(bgpPathSchema).max(BGP.maxRoutes),
    evpnAdvertised: z.array(evpnMacSchema).max(512).optional(),
  })
  .strict();
export const bgpStateSchema = z
  .object({
    ...configShape,
    token: idSchema,
    tickAt: timeSchema,
    peers: z.array(bgpPeerSchema).max(32),
    rib: z
      .array(bgpPathSchema.extend({ peer: ipv4Schema, learnedAt: timeSchema }).strict())
      .max(BGP.maxRoutes),
    routes: z
      .array(
        prefix
          .extend({
            port: idSchema,
            nextHop: ipv4Schema,
            peer: ipv4Schema,
            distance: z.union([z.literal(20), z.literal(200)]),
            metric: z.number().int().nonnegative(),
          })
          .strict()
      )
      .max(BGP.maxRoutes),
  })
  .strict();
export const bgpTimerSchema = z
  .object({ kind: z.literal('bgp-tick'), device: idSchema, token: idSchema })
  .strict();
export type BgpConfig = z.infer<typeof bgpConfigSchema>;
export type BgpNeighbor = z.infer<typeof bgpNeighborSchema>;
export type BgpPeer = z.infer<typeof bgpPeerSchema>;
export type BgpPath = z.infer<typeof bgpPathSchema>;
export type BgpMessage = z.infer<typeof bgpMessageSchema>;
export type BgpState = z.infer<typeof bgpStateSchema>;
export type BgpTimer = z.infer<typeof bgpTimerSchema>;
export const bgpPrefixKey = (path: { network: string; prefix: number }) => `${path.network}/${path.prefix}`;
