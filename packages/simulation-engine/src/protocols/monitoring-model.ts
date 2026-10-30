import { z } from 'zod';
import { idSchema, ipv4Schema, timeSchema } from '../schemas';
export const monitoringSchema = z
  .object({
    token: idSchema,
    tickAt: timeSchema.optional(),
    operations: z
      .array(
        z
          .object({
            id: z.number().int().min(1).max(2147483647),
            target: ipv4Schema.optional(),
            sourcePort: idSchema.optional(),
            frequencyMs: z.number().int().min(1000).max(604800000).default(60000),
            timeoutMs: z.number().int().min(1).max(604800000).default(5000),
            scheduled: z.boolean().default(false),
            nextAt: timeSchema.optional(),
            probe: idSchema.optional(),
            sentAt: timeSchema.optional(),
            status: z.enum(['unknown', 'up', 'down']).default('unknown'),
            rtt: timeSchema.optional(),
          })
          .strict()
      )
      .max(128),
    tracks: z
      .array(
        z
          .object({
            id: z.number().int().min(1).max(1000),
            kind: z.enum(['sla', 'interface']),
            operation: z.number().int().positive().optional(),
            port: idSchema.optional(),
            state: z.boolean().default(false),
            changedAt: timeSchema,
          })
          .strict()
      )
      .max(128),
  })
  .strict();
export const monitoringTimerSchema = z
  .object({ kind: z.literal('monitoring-tick'), device: idSchema, token: idSchema })
  .strict();
