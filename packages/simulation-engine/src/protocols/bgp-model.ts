import { evpnMacSchema, evpnWithdrawSchema, evpnImetSchema } from './vxlan-model';
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
    updateSource: idSchema.optional(),
    passive: z.boolean().default(false),
    nextHopSelf: z.boolean().default(false),
    reflectorClient: z.boolean().default(false),
    localPref: z.number().int().min(0).max(4294967295).default(100),
    med: z.number().int().min(0).max(4294967295).default(0),
    prepend: z.number().int().min(0).max(5).default(0),
    importFilter: z.array(bgpFilterSchema).max(32).default([]),
    exportFilter: z.array(bgpFilterSchema).max(32).default([]),
    importPrefixList: z.string().max(32).optional(),
    exportPrefixList: z.string().max(32).optional(),
    importRouteMap: z.string().max(32).optional(),
    exportRouteMap: z.string().max(32).optional(),
    maximumPrefix: z.number().int().min(1).max(2147483647).optional(),
    password: z.string().min(1).max(80).optional(),
    bfd: z.boolean().optional(),
    bfdStrict: z.boolean().optional(),
    peerGroup: z.string().max(32).optional(),
    peerGroupOverrides: z.array(z.string().max(32)).max(32).optional(),
    // eBGP peers must share a connected subnet unless multihop (TTL > 1) or the check is disabled.
    ebgpMultihop: z.number().int().min(1).max(255).optional(),
    disableConnectedCheck: z.boolean().optional(),
    description: z
      .string()
      .regex(/^[\x20-\x7e]{1,80}$/)
      .optional(),
    // IPv4 unicast activation; undefined follows "bgp default ipv4-unicast" (on by default).
    activate: z.boolean().optional(),
    sendCommunity: z.enum(['standard', 'extended', 'both']).optional(),
    softReconfigurationInbound: z.boolean().optional(),
    defaultOriginate: z
      .union([z.literal(true), z.object({ routeMap: z.string().regex(/^[\w-]{1,32}$/) }).strict()])
      .optional(),
    maximumPrefixThreshold: z.number().int().min(1).max(100).optional(),
    maximumPrefixWarningOnly: z.boolean().optional(),
    // Accept paths that already contain the local AS up to N times (hub-and-spoke MPLS designs).
    allowasIn: z.number().int().min(1).max(10).optional(),
  })
  .strict();
const redistributionSchema = z
  .object({
    source: z.enum(['connected', 'static', 'ospf', 'rip']),
    process: z.number().int().min(1).max(65535).optional(),
    metric: z.number().int().min(0).max(4294967295).optional(),
    routeMap: z
      .string()
      .regex(/^[\w-]{1,32}$/)
      .optional(),
  })
  .strict();
export type BgpRedistribution = z.infer<typeof redistributionSchema>;
const aggregateSchema = prefix
  .extend({ summaryOnly: z.boolean().optional(), asSet: z.boolean().optional() })
  .strict();
export type BgpAggregate = z.infer<typeof aggregateSchema>;
const configShape = {
  enabled: z.boolean(),
  asn,
  routerId: ipv4Schema,
  autoRouterId: z.boolean().optional(),
  // IOS default: keepalive 60 s, hold time 180 s ("timers bgp 60 180").
  holdMs: z.number().int().min(3000).max(180000).multipleOf(1000).default(180000),
  // IOS default (undefined): a directly connected eBGP session drops as soon as its link goes down.
  fastExternalFallover: z.boolean().optional(),
  // "no bgp log-neighbor-changes" (false) stops %BGP-5-ADJCHANGE messages.
  logNeighborChanges: z.boolean().optional(),
  // "no bgp default ipv4-unicast" (false): neighbors need "neighbor X activate".
  defaultIpv4Unicast: z.boolean().optional(),
  // Configured in "address-family ipv4": show running-config prints the address-family block.
  addressFamily: z.boolean().optional(),
  networks: z.array(prefix).max(128),
  redistribute: z.array(redistributionSchema).max(8).optional(),
  aggregates: z.array(aggregateSchema).max(32).optional(),
  neighbors: z.array(bgpNeighborSchema).max(32),
  peerGroups: z
    .array(
      z
        .object({
          name: z.string().regex(/^[\w-]{1,32}$/),
          settings: bgpNeighborSchema.omit({ ip: true, peerGroup: true, peerGroupOverrides: true }).partial(),
        })
        .strict()
    )
    .max(32)
    .optional(),
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
      evpnImet: z.array(evpnImetSchema).max(16).optional(),
      evpnImetWithdrawn: z
        .array(evpnImetSchema.partial({ routeTarget: true, asPath: true }))
        .max(16)
        .optional(),
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
    maximumPrefixExceeded: z.boolean().optional(),
    // The %BGP-4-MAXPFX threshold warning was already logged for this session.
    maximumPrefixWarned: z.boolean().optional(),
    evpnAdvertised: z.array(evpnMacSchema).max(512).optional(),
    evpnImetAdvertised: z.array(evpnImetSchema).max(48).optional(),
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
/** IPv4 unicast is exchanged with a neighbor unless it was deactivated (or never activated). */
export const bgpNeighborActive = (state: Pick<BgpConfig, 'defaultIpv4Unicast'>, neighbor: BgpNeighbor) =>
  neighbor.activate ?? state.defaultIpv4Unicast !== false;
