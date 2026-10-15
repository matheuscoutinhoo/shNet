import { z } from 'zod';
import { idSchema, timeSchema } from '../schemas';

export const dhcpHaPairSchema = z.object({ portA: idSchema, portB: idSchema }).strict();
// The whole DHCP database is paired. Pool names and policies must match; only
// listener interface identities and the two physical server IPs may differ.
export const dhcpHaSchema = z
  .object({
    peer: idSchema,
    port: idSchema,
    token: idSchema,
    role: z.enum(['active', 'standby']),
    revision: z.number().int().positive(),
    applied: z.number().int().nonnegative(),
    confirmed: z.number().int().nonnegative(),
    solo: z.boolean(),
    sent: z.number().int().nonnegative(),
    received: z.number().int().nonnegative(),
    lastReceivedAt: timeSchema.optional(),
  })
  .strict();
