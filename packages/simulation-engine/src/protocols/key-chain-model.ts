import { z } from 'zod';
import { timeSchema } from '../schemas';
export const keyLifetimeSchema = z.object({ startAt: timeSchema, endAt: timeSchema.optional() }).strict();
export const keyChainKeySchema = z
  .object({
    id: z.number().int().min(0).max(2147483647),
    keyString: z.string().min(1).max(80).optional(),
    sendLifetime: keyLifetimeSchema.optional(),
    acceptLifetime: keyLifetimeSchema.optional(),
  })
  .strict();
export const keyChainsSchema = z
  .array(
    z.object({ name: z.string().regex(/^[\w-]{1,32}$/), keys: z.array(keyChainKeySchema).max(64) }).strict()
  )
  .max(32);
export type KeyChainKey = z.infer<typeof keyChainKeySchema>;
