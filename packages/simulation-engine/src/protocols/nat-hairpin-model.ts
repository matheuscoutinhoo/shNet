import { z } from 'zod';
import { idSchema, ipv4Schema, timeSchema } from '../schemas';
export const hairpinBindingSchema = z
  .object({
    id: idSchema,
    client: ipv4Schema,
    server: ipv4Schema,
    vip: ipv4Schema,
    snat: ipv4Schema,
    ingress: idSchema,
    egress: idSchema,
    protocol: z.enum(['TCP', 'UDP', 'ICMP']),
    clientToken: z.string().min(1).max(80),
    mappedToken: z.string().min(1).max(80),
    serverPort: z.number().int().min(0).max(65535),
    expiresAt: timeSchema,
  })
  .strict();
export const hairpinTimerSchema = z
  .object({
    kind: z.literal('nat-hairpin-expire'),
    device: idSchema,
    binding: idSchema,
    expiresAt: timeSchema,
  })
  .strict();
