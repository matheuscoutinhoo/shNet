import { z } from 'zod';
import { idSchema, ipv4Schema, timeSchema } from '../schemas';
import { identitySchema, trustSchema } from './security-crypto';
import { tlsSessionSchema, tlsClientConfigSchema } from './tls-model';
const key = z.string().min(8).max(64),
  username = z.string().regex(/^[a-zA-Z0-9_.@-]{1,64}$/);
const hostname = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^(?:[0-9a-f]{8}|[0-9a-f]{64})$/);
const vrf = z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/);
export const remoteRouteSchema = z
  .object({
    network: ipv4Schema,
    prefix: z.number().int().min(0).max(32),
    nextHop: ipv4Schema,
    metric: z.number().int().min(0).max(65535),
    vrf: vrf.optional(),
  })
  .strict();
export const remotePortSchema = z
  .object({
    id: idSchema,
    adminUp: z.boolean(),
    description: z.string().max(160),
    ip: ipv4Schema.optional(),
    prefix: z.number().int().min(0).max(32).optional(),
    gateway: ipv4Schema.optional(),
    mode: z.enum(['access', 'trunk', 'routed']),
    accessVlan: z.number().int().min(1).max(4094),
    speed: z.union([z.literal(100), z.literal(1000), z.literal(10000), z.literal(40000), z.literal(100000)]),
    mtu: z.number().int().min(576).max(9216),
    vrf: vrf.optional(),
  })
  .strict();
export const remoteNetworkSchema = z
  .object({
    hostname,
    interfaces: z.array(remotePortSchema).min(1).max(48),
    routes: z.array(remoteRouteSchema).max(256),
  })
  .strict();
export const remotePatchSchema = z
  .object({
    hostname: hostname.optional(),
    interfaces: z
      .array(remotePortSchema.partial().extend({ id: idSchema, clearIp: z.boolean().optional() }))
      .max(32)
      .default([]),
    routesAdd: z.array(remoteRouteSchema).max(32).default([]),
    routesRemove: z.array(remoteRouteSchema).max(32).default([]),
  })
  .strict();
export const remoteOperationSchema = z.enum([
  'hello',
  'get',
  'get-config',
  'edit-config',
  'validate',
  'commit',
  'discard-changes',
  'lock',
  'unlock',
  'patch',
  'copy-config',
  'delete-config',
  'replace',
  'create',
  'delete',
]);
export const remoteRpcSchema = z
  .object({
    operation: remoteOperationSchema,
    datastore: z.enum(['running', 'candidate', 'startup']).default('running'),
    source: z.enum(['running', 'candidate', 'startup']).optional(),
    patch: remotePatchSchema.optional(),
    config: remoteNetworkSchema.optional(),
    resource: z
      .string()
      .regex(
        /^\/restconf(?:\/data\/(?:shlab|netlab):network(?:\/(?:hostname|interfaces(?:\/interface=[a-zA-Z0-9_-]+)?|routes))?|\/yang-library-version)?$/
      )
      .optional(),
    offset: z.number().int().min(0).max(256).default(0),
    ifMatch: revision.optional(),
  })
  .strict();
export const remoteTransportSchema = z
  .object({
    tls: tlsSessionSchema,
    stage: z.enum(['handshake', 'hello', 'rpc', 'closed']),
    transmit: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
    receive: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
    plain: z.string().max(12000),
    negotiated: z.enum(['1.0', '1.1']).optional(),
    sessionId: z.number().int().positive().optional(),
    capabilities: z.array(z.string().max(256)).max(32).optional(),
    credential: z.string().max(64).optional(),
    clientConfig: tlsClientConfigSchema.optional(),
    connection: idSchema.optional(),
    username: username.optional(),
    privilege: z.number().int().min(0).max(15).optional(),
    id: idSchema.optional(),
  })
  .strict();
export const remoteResponseSchema = z
  .object({
    id: idSchema,
    ok: z.boolean(),
    revision,
    code: z.number().int().min(200).max(599),
    error: z.string().max(500).optional(),
    data: z.string().max(6000).optional(),
  })
  .strict();
export const remoteConfigSchema = z
  .object({
    enabled: z.boolean(),
    netconf: z.boolean(),
    restconf: z.boolean(),
    key,
    clients: z.array(ipv4Schema).max(64).default([]),
    users: z
      .array(
        z
          .object({
            username,
            password: z.string().min(1).max(64),
            privilege: z.number().int().min(0).max(15).default(15),
          })
          .strict()
      )
      .min(1)
      .max(32),
    identity: identitySchema.optional(),
    trust: trustSchema.optional(),
    base11: z.boolean().default(true),
  })
  .strict();
export const remoteStateSchema = remoteConfigSchema
  .extend({
    revision,
    fingerprint: digest,
    candidate: z
      .object({ config: remoteNetworkSchema, base: digest, owner: z.string().max(100) })
      .strict()
      .optional(),
    lock: z
      .object({ owner: z.string().max(100), expiresAt: timeSchema })
      .strict()
      .optional(),
    seen: z
      .array(
        z
          .object({
            id: idSchema,
            source: ipv4Schema,
            username,
            hash: digest,
            at: timeSchema,
            response: remoteResponseSchema,
          })
          .strict()
      )
      .max(64),
    commits: z.number().int().nonnegative(),
    sessions: z.array(remoteTransportSchema).max(128).default([]),
    startup: remoteNetworkSchema.optional(),
  })
  .strict();
export const remoteQuerySchema = z
  .object({
    id: idSchema,
    target: ipv4Schema,
    protocol: z.enum(['netconf', 'restconf']),
    key,
    username,
    rpc: remoteRpcSchema,
    connection: idSchema,
    status: z.enum(['pending', 'success', 'error', 'timeout']),
    startedAt: timeSchema,
    deadline: timeSchema,
    response: remoteResponseSchema.optional(),
    job: idSchema.optional(),
    transport: remoteTransportSchema.optional(),
  })
  .strict();
export const remoteTimerSchema = z
  .object({ kind: z.literal('remote-timeout'), device: idSchema, query: idSchema, at: timeSchema })
  .strict();
export const automationConfigSchema = z
  .object({
    name: z.string().min(1).max(64),
    username,
    password: z.string().min(1).max(64),
    key,
    steps: z
      .array(remoteRpcSchema.extend({ target: ipv4Schema, protocol: z.enum(['netconf', 'restconf']) }))
      .min(1)
      .max(32),
  })
  .strict();
export const automationJobSchema = automationConfigSchema
  .extend({
    id: idSchema,
    status: z.enum(['running', 'success', 'error']),
    index: z.number().int().min(0).max(32),
    queries: z.array(idSchema).max(32),
    startedAt: timeSchema,
    updatedAt: timeSchema,
  })
  .strict();
export const automationTimerSchema = z
  .object({ kind: z.literal('automation-next'), device: idSchema, job: idSchema })
  .strict();
export type RemoteRpc = z.infer<typeof remoteRpcSchema>;
export type RemoteNetwork = z.infer<typeof remoteNetworkSchema>;
export type RemoteResponse = z.infer<typeof remoteResponseSchema>;
export type RemoteQuery = z.infer<typeof remoteQuerySchema>;
export type RemoteTransport = z.infer<typeof remoteTransportSchema>;
