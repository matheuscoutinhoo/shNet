import { z } from 'zod';
import { idSchema, ipv4Schema, timeSchema, portNumberSchema } from '../schemas';
const username = z.string().regex(/^[a-zA-Z0-9_.@-]{1,64}$/);
const password = z.string().min(1).max(64);
const key = z.string().min(8).max(64);
const proof = z.string().regex(/^[0-9a-f]{32}$/);
const mac = z.string().regex(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/);
const vlan = z.number().int().min(1).max(4094);
const lifetime = z.number().int().min(5000).max(3600000);
export const aaaServerConfigSchema = z
  .object({
    enabled: z.boolean(),
    radius: z.boolean(),
    tacacs: z.boolean(),
    key,
    clients: z.array(ipv4Schema).max(64).default([]),
    users: z
      .array(
        z
          .object({
            username,
            password,
            enabled: z.boolean().default(true),
            privilege: z.number().int().min(0).max(15).default(1),
            vlan: vlan.optional(),
            sessionMs: lifetime.default(60000),
            commands: z.array(z.string().trim().min(1).max(128)).max(16).default(['*']),
          })
          .strict()
      )
      .max(64),
  })
  .strict();
export const aaaServerSchema = aaaServerConfigSchema
  .extend({
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    requests: z
      .array(
        z
          .object({
            id: idSchema,
            source: ipv4Schema,
            wire: z.string().max(8192),
            response: z.string().max(12000),
            expiresAt: timeSchema,
          })
          .strict()
      )
      .max(128)
      .default([]),
    accounting: z
      .array(
        z
          .object({
            at: timeSchema,
            username,
            method: z.enum(['radius', 'tacacs']),
            source: ipv4Schema,
            accepted: z.boolean(),
            privilege: z.number().int().min(0).max(15),
            stage: z.enum(['authentication', 'start', 'stop', 'command']).optional(),
            command: z.string().max(512).optional(),
          })
          .strict()
      )
      .max(128),
  })
  .strict();
export const aaaClientSchema = z
  .object({
    server: ipv4Schema,
    key,
    method: z.enum(['radius', 'tacacs']),
    enforceCli: z.boolean().default(false),
  })
  .strict();
export const radiusRequestSchema = z
  .object({
    type: z.literal('Access-Request'),
    id: idSchema,
    username,
    challenge: idSchema,
    proof,
    authenticator: proof,
    wire: z
      .string()
      .regex(/^(?:[a-f0-9]{2})+$/)
      .max(8192),
  })
  .strict();
export const radiusResponseSchema = z
  .object({
    type: z.enum(['Access-Accept', 'Access-Reject']),
    id: idSchema,
    requestAuthenticator: proof,
    privilege: z.number().int().min(0).max(15),
    vlan: vlan.optional(),
    wire: z
      .string()
      .regex(/^(?:[a-f0-9]{2})+$/)
      .max(8192),
    sessionMs: lifetime,
    commands: z.array(z.string().min(1).max(128)).max(16).default(['*']),
    authenticator: proof,
  })
  .strict();
export const radiusMessageSchema = z.union([radiusRequestSchema, radiusResponseSchema]);
export const aaaQuerySchema = z
  .object({
    id: idSchema,
    username,
    method: z.enum(['radius', 'tacacs']),
    server: ipv4Schema,
    key,
    challenge: idSchema,
    proof,
    requestAuthenticator: proof,
    status: z.enum(['pending', 'accepted', 'rejected', 'timeout']),
    startedAt: timeSchema,
    deadline: timeSchema,
    attempts: z.number().int().min(1).max(3),
    sourceIp: ipv4Schema,
    sourcePort: portNumberSchema.optional(),
    connection: idSchema.optional(),
    port: idSchema.optional(),
    mac: mac.optional(),
    session: idSchema.optional(),
    privilege: z.number().int().min(0).max(15).optional(),
    commands: z.array(z.string().min(1).max(128)).max(16).optional(),
    tacacsPhase: z.enum(['authentication', 'authorization', 'accounting']).optional(),
    vlan: vlan.optional(),
    expiresAt: timeSchema.optional(),
  })
  .strict();
export const dot1xConfigSchema = z
  .object({
    enabled: z.boolean(),
    server: ipv4Schema,
    key,
    underlay: idSchema,
    reauthMs: lifetime.default(60000),
  })
  .strict();
export const dot1xStateSchema = dot1xConfigSchema
  .extend({
    phase: z.enum(['unauthorized', 'authenticating', 'authorized']),
    token: idSchema,
    tickAt: timeSchema.optional(),
    baseVlan: vlan,
    assignedVlan: vlan.optional(),
    mac: mac.optional(),
    session: idSchema.optional(),
    challenge: idSchema.optional(),
    username: username.optional(),
    query: idSchema.optional(),
    expiresAt: timeSchema.optional(),
    lastAt: timeSchema,
    attempts: z.number().int().nonnegative(),
  })
  .strict();
export const supplicantConfigSchema = z.object({ enabled: z.boolean(), username, password }).strict();
export const supplicantStateSchema = supplicantConfigSchema
  .extend({
    phase: z.enum(['unauthorized', 'authenticating', 'authorized', 'rejected']),
    token: idSchema,
    tickAt: timeSchema.optional(),
    session: idSchema.optional(),
    authenticator: mac.optional(),
    challenge: idSchema.optional(),
    lastAt: timeSchema,
    attempts: z.number().int().nonnegative(),
  })
  .strict();
export const eapolSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start') }).strict(),
  z.object({ type: z.literal('logoff'), session: idSchema }).strict(),
  z.object({ type: z.literal('identity-request'), session: idSchema }).strict(),
  z.object({ type: z.literal('identity-response'), session: idSchema, username }).strict(),
  z.object({ type: z.literal('challenge'), session: idSchema, challenge: idSchema }).strict(),
  z.object({ type: z.literal('response'), session: idSchema, username, proof }).strict(),
  z.object({ type: z.enum(['success', 'failure']), session: idSchema }).strict(),
]);
export const dot1xTimerSchema = z
  .object({
    kind: z.literal('dot1x-tick'),
    device: idSchema,
    port: idSchema,
    token: idSchema,
    at: timeSchema,
  })
  .strict();
export const aaaTimerSchema = z
  .object({ kind: z.literal('aaa-timeout'), device: idSchema, query: idSchema, at: timeSchema })
  .strict();
export type AaaQuery = z.infer<typeof aaaQuerySchema>;
export type RadiusRequest = z.infer<typeof radiusRequestSchema>;
export type RadiusResponse = z.infer<typeof radiusResponseSchema>;
export type Eapol = z.infer<typeof eapolSchema>;
