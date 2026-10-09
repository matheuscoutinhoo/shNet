import { z } from 'zod';
import { ipv4Schema } from '../schemas';
const label = z.number().int().min(16).max(1048575),
  id = z.string().min(1).max(80);
export const mplsPayloadSchema = z
  .object({
    labels: z
      .array(
        z
          .object({ value: label, ttl: z.number().int().min(0).max(255), tc: z.number().int().min(0).max(7) })
          .strict()
      )
      .min(1)
      .max(8),
    packet: z.string().max(100000),
    bytes: z.number().int().min(32).max(65567),
  })
  .strict();
export const mplsConfigSchema = z
  .object({
    enabled: z.boolean(),
    ingress: z
      .array(
        z
          .object({
            network: ipv4Schema,
            prefix: z.number().int().min(0).max(32),
            port: id,
            nextHop: ipv4Schema,
            labels: z.array(label).min(1).max(8),
          })
          .strict()
      )
      .max(64),
    lfib: z
      .array(
        z
          .object({
            incoming: label,
            operation: z.enum(['swap', 'pop']),
            outgoing: z.array(label).min(1).max(8).optional(),
            port: id.optional(),
            nextHop: ipv4Schema.optional(),
          })
          .strict()
      )
      .max(128),
  })
  .strict();
