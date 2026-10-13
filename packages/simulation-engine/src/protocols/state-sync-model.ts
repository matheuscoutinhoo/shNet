import { z } from 'zod';
import { idSchema, timeSchema } from '../schemas';

export const stateSyncRecordSchema = z
  .object({
    table: z.enum(['firewall', 'nat']),
    id: idSchema,
    revision: z.number().int().positive(),
    expiresAt: timeSchema,
    deleted: z.boolean(),
  })
  .strict();
export const stateSyncSchema = z
  .object({
    peer: idSchema,
    port: idSchema,
    token: idSchema,
    portMap: z
      .array(z.object({ local: idSchema, remote: idSchema }).strict())
      .min(1)
      .max(48),
    records: z.array(stateSyncRecordSchema).max(4096).default([]),
    sent: z.number().int().nonnegative().default(0),
    received: z.number().int().nonnegative().default(0),
    rejected: z.number().int().nonnegative().default(0),
    lastReceivedAt: timeSchema.optional(),
  })
  .strict();
export const stateSyncPairSchema = z
  .object({
    portA: idSchema,
    portB: idSchema,
    mappings: z
      .array(z.object({ a: idSchema, b: idSchema }).strict())
      .min(1)
      .max(48),
  })
  .strict();
export type StateSyncPair = z.infer<typeof stateSyncPairSchema>;
export type StateSyncRecord = z.infer<typeof stateSyncRecordSchema>;
