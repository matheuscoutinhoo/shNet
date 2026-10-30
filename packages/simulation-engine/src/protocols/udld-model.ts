import { z } from 'zod';
import { idSchema, timeSchema } from '../schemas';
const identity = z.object({ device: idSchema, port: idSchema }).strict();
export const udldMessageSchema = identity
  .extend({
    opcode: z.enum(['probe', 'echo', 'flush']),
    intervalMs: z.number().int().min(7000).max(90000),
    echoes: z.array(identity).max(8),
  })
  .strict();
export const udldStateSchema = z
  .object({
    mode: z.enum(['normal', 'aggressive']),
    intervalMs: z.number().int().min(7000).max(90000).default(15000),
    token: idSchema,
    tickAt: timeSchema.optional(),
    nextAt: timeSchema,
    state: z.enum(['unknown', 'bidirectional', 'unidirectional', 'disabled']),
    established: z.boolean(),
    retryAt: timeSchema.optional(),
    attempts: z.number().int().min(0).max(8),
    peers: z.array(identity.extend({ expiresAt: timeSchema, echoed: z.boolean() })).max(8),
  })
  .strict();
export const udldTimerSchema = z
  .object({ kind: z.literal('udld-tick'), device: idSchema, port: idSchema, token: idSchema })
  .strict();
