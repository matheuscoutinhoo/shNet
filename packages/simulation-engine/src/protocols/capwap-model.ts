import { z } from 'zod';
import { idSchema, ipv4Schema, portNumberSchema, timeSchema } from '../schemas';
import { wirelessConfigSchema } from './wireless-model';
export const capwapMessageSchema = z
  .object({
    kind: z.enum(['discovery', 'discovery-response', 'join', 'joined', 'record']),
    wtp: idSchema,
    session: idSchema,
    sequence: z.number().int().nonnegative(),
    nonce: idSchema.optional(),
    keyShare: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    authenticator: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    ciphertext: z
      .string()
      .max(65536)
      .regex(/^(?:[a-f0-9]{2})*$/)
      .optional(),
  })
  .strict();
export const wlcProfileSchema = z
  .object({
    name: z.string().min(1).max(32),
    vlan: z.number().int().min(1).max(4094),
    wireless: wirelessConfigSchema,
  })
  .strict();
export const wlcConfigSchema = z
  .object({
    enabled: z.boolean(),
    underlay: idSchema,
    key: z.string().min(8).max(64),
    allowedWtps: z.array(idSchema).max(64),
    profiles: z.array(wlcProfileSchema).min(1).max(16),
  })
  .strict();
export const wtpConfigSchema = z
  .object({
    enabled: z.boolean(),
    underlay: idSchema,
    controller: ipv4Schema,
    key: z.string().min(8).max(64),
    profile: z.string().min(1).max(32),
  })
  .strict();
const replay = z.array(z.number().int().positive()).max(64);
export const wlcStateSchema = wlcConfigSchema
  .extend({
    token: idSchema,
    nextAt: timeSchema,
    sessions: z
      .array(
        z
          .object({
            wtp: idSchema,
            address: ipv4Schema,
            clientPort: portNumberSchema,
            session: idSchema,
            clientNonce: idSchema,
            serverNonce: idSchema,
            keyShare: z.string().regex(/^[a-f0-9]{64}$/),
            secret: z.string().regex(/^[a-f0-9]{64}$/),
            key: z.string().regex(/^[a-f0-9]{64}$/),
            phase: z.enum(['CONFIGURE', 'RUN']),
            profile: z.string().max(32).optional(),
            port: idSchema.optional(),
            lastAt: timeSchema,
            txSequence: z.number().int().nonnegative(),
            receivedSequences: replay,
          })
          .strict()
      )
      .max(64),
  })
  .strict();
export const wtpStateSchema = wtpConfigSchema
  .extend({
    token: idSchema,
    nextAt: timeSchema,
    session: idSchema,
    nonce: idSchema,
    secret: z.string().regex(/^[a-f0-9]{64}$/),
    phase: z.enum(['DISCOVERY', 'JOIN', 'CONFIGURE', 'RUN']),
    radioConfigured: z.boolean().optional(),
    serverNonce: idSchema.optional(),
    sessionKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    lastAt: timeSchema,
    txSequence: z.number().int().nonnegative(),
    receivedSequences: replay,
    attempts: z.number().int().nonnegative(),
  })
  .strict();
export const capwapRecordSchema = z
  .object({
    type: z.enum(['configure', 'configured', 'run', 'running', 'echo', 'echo-reply', 'data']),
    profile: z.string().max(32).optional(),
    config: wlcProfileSchema.optional(),
    frame: z.string().max(30000).optional(),
  })
  .strict();
export const capwapTimerSchema = z
  .object({ kind: z.literal('capwap-tick'), device: idSchema, role: z.enum(['wlc', 'wtp']), token: idSchema })
  .strict();
