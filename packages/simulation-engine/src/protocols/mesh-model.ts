import { z } from 'zod';
import { idSchema, timeSchema } from '../schemas';
export const meshConfigSchema = z
  .object({
    enabled: z.boolean(),
    meshId: z.string().min(1).max(32),
    key: z.string().min(8).max(64),
    root: z.boolean(),
    priority: z.number().int().min(0).max(65535),
    maxDistance: z.number().finite().min(1).max(300),
  })
  .strict();
const routeSchema = z
  .object({
    root: idSchema,
    priority: z.number().int().min(0).max(65535),
    metric: z.number().finite().nonnegative().max(100000),
    path: z.array(idSchema).min(1).max(16),
  })
  .strict();
export const meshHelloSchema = z
  .object({
    meshId: z.string().min(1).max(32),
    from: idSchema,
    nonce: idSchema,
    sequence: z.number().int().positive(),
    route: routeSchema.optional(),
    authenticator: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const meshStateSchema = meshConfigSchema
  .extend({
    token: idSchema,
    sequence: z.number().int().nonnegative(),
    tickAt: timeSchema,
    parent: idSchema.optional(),
    route: routeSchema.optional(),
    peers: z
      .array(
        z
          .object({
            device: idSchema,
            port: idSchema,
            lastSeen: timeSchema,
            nonce: idSchema.optional(),
            sequence: z.number().int().nonnegative(),
            route: routeSchema.optional(),
            txSequence: z.number().int().nonnegative(),
            receivedSequences: z.array(z.number().int().positive()).max(64),
          })
          .strict()
      )
      .max(32),
  })
  .strict();
export const meshTimerSchema = z
  .object({ kind: z.literal('mesh-tick'), device: idSchema, token: idSchema })
  .strict();
