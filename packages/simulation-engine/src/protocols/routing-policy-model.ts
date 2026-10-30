import { z } from 'zod';
import { bgpFilterSchema } from './bgp-model';
export const routingPolicySchema = z
  .object({
    prefixLists: z
      .array(
        z
          .object({ name: z.string().regex(/^[\w-]{1,32}$/), entries: z.array(bgpFilterSchema).max(256) })
          .strict()
      )
      .max(64),
    routeMaps: z
      .array(
        z
          .object({
            name: z.string().regex(/^[\w-]{1,32}$/),
            sequence: z.number().int().min(1).max(65535),
            action: z.enum(['permit', 'deny']),
            prefixLists: z.array(z.string().max(32)).max(16).default([]),
            localPref: z.number().int().min(0).max(4294967295).optional(),
            metric: z.number().int().min(0).max(4294967295).optional(),
            prepend: z.array(z.number().int().min(1).max(4294967294)).max(16).default([]),
          })
          .strict()
      )
      .max(256),
  })
  .strict();
