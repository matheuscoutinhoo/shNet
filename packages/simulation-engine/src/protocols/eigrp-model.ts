import { z } from 'zod';
import { idSchema, ipv4Schema, timeSchema } from '../schemas';

/** EIGRP for IPv4 (RFC 7868), classic metric mode as IOS uses for "router eigrp AS". */
export const EIGRP = {
  destination: '224.0.0.10',
  mac: '01:00:5e:00:00:0a',
  helloMs: 5000,
  holdMs: 15000,
  internalDistance: 90,
  externalDistance: 170,
  summaryDistance: 5,
  // Delay 0xFFFFFFFF marks an unreachable destination.
  infinity: 0xffffffff,
  tickMs: 1000,
  rtoMs: 1000,
  retries: 16,
  activeMs: 180000,
} as const;
const asn = z.number().int().min(1).max(65535);
const prefix = z.number().int().min(0).max(32);
const u32 = z.number().int().min(0).max(0xffffffff);
const byte = z.number().int().min(0).max(255);
/** Vector metric: minimum bandwidth (kbit/s) and total delay (tens of microseconds) along the path. */
export const eigrpVectorSchema = z
  .object({
    bandwidth: z.number().int().min(1).max(0xffffffff),
    delay: u32,
    reliability: byte,
    load: byte,
    mtu: z.number().int().min(0).max(0xffffff),
    hops: byte,
  })
  .strict();
export const eigrpExternalSchema = z
  .object({
    routerId: ipv4Schema,
    asn: u32,
    protocol: z.enum(['static', 'connected', 'ospf', 'bgp', 'rip', 'eigrp']),
    metric: u32,
    tag: u32,
  })
  .strict();
export const eigrpRouteTlvSchema = z
  .object({
    network: ipv4Schema,
    prefix,
    nextHop: ipv4Schema,
    vector: eigrpVectorSchema,
    external: eigrpExternalSchema.optional(),
  })
  .strict();
const kValues = z.array(byte).length(5);
export const eigrpStubSchema = z
  .object({
    connected: z.boolean(),
    summary: z.boolean(),
    static: z.boolean(),
    redistributed: z.boolean(),
    receiveOnly: z.boolean(),
  })
  .strict();
export const eigrpMessageSchema = z.discriminatedUnion('opcode', [
  z
    .object({
      opcode: z.literal('hello'),
      holdTime: z.number().int().min(1).max(65535),
      k: kValues,
      stub: eigrpStubSchema.optional(),
    })
    .strict(),
  // An acknowledgement is a Hello without TLVs and a non-zero acknowledgement number.
  z.object({ opcode: z.literal('ack') }).strict(),
  z
    .object({
      opcode: z.enum(['update', 'query', 'reply']),
      init: z.boolean().optional(),
      routes: z.array(eigrpRouteTlvSchema).max(512),
    })
    .strict(),
]);
export type EigrpMessage = z.infer<typeof eigrpMessageSchema>;
export const eigrpPacketSchema = z
  .object({
    src: ipv4Schema,
    dst: ipv4Schema,
    ttl: z.number().int().min(1).max(255),
    dscp: z.number().int().min(0).max(63).optional(),
    protocol: z.literal('EIGRP'),
    asn,
    sequence: u32,
    ack: u32,
    authentication: z
      .object({ keyId: u32, digest: z.string().regex(/^[a-f0-9]{32}$/) })
      .strict()
      .optional(),
    message: eigrpMessageSchema,
    bytes: z.number().int().min(40).max(65535),
  })
  .strict();
export type EigrpPacket = z.infer<typeof eigrpPacketSchema>;
const metricConfig = z
  .object({
    bandwidth: z.number().int().min(1).max(0xffffffff),
    delay: z.number().int().min(0).max(0xffffffff),
    reliability: byte,
    load: z.number().int().min(1).max(255),
    mtu: z.number().int().min(1).max(0xffffff),
  })
  .strict();
export const eigrpInterfaceSchema = z
  .object({
    port: idSchema,
    helloMs: z.number().int().min(1000).max(65535000).optional(),
    holdMs: z.number().int().min(1000).max(65535000).optional(),
    summaries: z
      .array(z.object({ network: ipv4Schema, prefix }).strict())
      .max(16)
      .default([]),
    // "ip authentication mode eigrp AS md5" and "ip authentication key-chain eigrp AS NAME".
    authenticationMode: z.literal('md5').optional(),
    keyChain: z.string().min(1).max(64).optional(),
    splitHorizon: z.boolean().default(true),
  })
  .strict();
export const eigrpConfigSchema = z
  .object({
    enabled: z.boolean(),
    asn,
    routerId: ipv4Schema.optional(),
    networks: z.array(z.object({ network: ipv4Schema, wildcard: ipv4Schema.optional() }).strict()).max(64),
    passiveDefault: z.boolean().default(false),
    // Passive interfaces, or the "no passive-interface" exceptions after "passive-interface default".
    passive: z.array(idSchema).max(48).default([]),
    k: kValues.default([1, 0, 1, 0, 0]),
    variance: z.number().int().min(1).max(128).default(1),
    maximumPaths: z.number().int().min(1).max(32).default(4),
    stub: eigrpStubSchema.optional(),
    distance: z
      .object({ internal: z.number().int().min(1).max(255), external: z.number().int().min(1).max(255) })
      .strict()
      .optional(),
    defaultMetric: metricConfig.optional(),
    redistribute: z
      .array(
        z
          .object({
            source: z.enum(['static', 'connected', 'ospf', 'bgp', 'rip']),
            process: z.number().int().min(1).max(4294967295).optional(),
            metric: metricConfig.optional(),
            routeMap: z.string().min(1).max(64).optional(),
          })
          .strict()
      )
      .max(8)
      .default([]),
    interfaces: z.array(eigrpInterfaceSchema).max(48).default([]),
  })
  .strict();
export type EigrpConfig = z.infer<typeof eigrpConfigSchema>;
export type EigrpConfigInput = z.input<typeof eigrpConfigSchema>;
export const eigrpPendingSchema = z
  .object({
    sequence: u32,
    message: eigrpMessageSchema,
    sentAt: timeSchema,
    retries: z.number().int().min(0).max(EIGRP.retries),
  })
  .strict();
export const eigrpNeighborSchema = z
  .object({
    address: ipv4Schema,
    mac: z.string().regex(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i),
    port: idSchema,
    holdMs: z.number().int().min(1000).max(65535000),
    expiresAt: timeSchema,
    upAt: timeSchema,
    // Last reliable sequence number received from the neighbor.
    sequence: u32,
    stub: eigrpStubSchema.optional(),
    // The neighbor's INIT update arrived (a second one means it restarted).
    initReceived: z.boolean().optional(),
    pending: z.array(eigrpPendingSchema).max(64),
    srtt: z.number().int().min(0).max(65535),
  })
  .strict();
export const eigrpViaSchema = z
  .object({
    address: ipv4Schema,
    port: idSchema,
    reported: eigrpVectorSchema,
    external: eigrpExternalSchema.optional(),
  })
  .strict();
export const eigrpTopologySchema = z
  .object({
    network: ipv4Schema,
    prefix,
    fd: u32,
    state: z.enum(['passive', 'active']),
    // Directly connected, redistributed or summary routes this router originates.
    local: z
      .object({
        kind: z.enum(['connected', 'redistributed', 'summary']),
        port: idSchema.optional(),
        vector: eigrpVectorSchema,
        external: eigrpExternalSchema.optional(),
      })
      .strict()
      .optional(),
    via: z.array(eigrpViaSchema).max(64),
    // DUAL diffusing computation: who still owes a reply and who asked us (the query origin).
    replies: z.array(ipv4Schema).max(64).default([]),
    origin: ipv4Schema.optional(),
    activeAt: timeSchema.optional(),
    // Distance last advertised to the neighbors (infinity once withdrawn).
    advertised: u32.optional(),
    changedAt: timeSchema,
  })
  .strict();
export type EigrpTopologyEntry = z.infer<typeof eigrpTopologySchema>;
export type EigrpVector = z.infer<typeof eigrpVectorSchema>;
export type EigrpExternal = z.infer<typeof eigrpExternalSchema>;
export type EigrpRouteTlv = z.infer<typeof eigrpRouteTlvSchema>;
export type EigrpStub = z.infer<typeof eigrpStubSchema>;
export const eigrpStateSchema = eigrpConfigSchema
  .extend({
    token: idSchema,
    tickAt: timeSchema,
    sequence: u32,
    ports: z
      .array(
        z
          .object({
            port: idSchema,
            helloAt: timeSchema,
            operational: z.boolean(),
            signature: z.string().max(200),
          })
          .strict()
      )
      .max(48),
    neighbors: z.array(eigrpNeighborSchema).max(256),
    topology: z.array(eigrpTopologySchema).max(4096),
    counters: z
      .object({
        helloSent: u32,
        helloReceived: u32,
        updateSent: u32,
        updateReceived: u32,
        querySent: u32,
        queryReceived: u32,
        replySent: u32,
        replyReceived: u32,
        ackSent: u32,
        ackReceived: u32,
      })
      .strict(),
  })
  .strict();
export type EigrpState = z.infer<typeof eigrpStateSchema>;
export type EigrpNeighbor = z.infer<typeof eigrpNeighborSchema>;
export const eigrpTimerSchema = z
  .object({ kind: z.literal('eigrp-tick'), device: idSchema, token: idSchema })
  .strict();
