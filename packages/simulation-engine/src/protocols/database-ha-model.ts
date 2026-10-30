import { z } from 'zod';
import { idSchema, timeSchema } from '../schemas';

export const databaseHaSchema = z
  .object({
    cluster: idSchema,
    start: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    applied: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    pending: z
      .array(
        z
          .object({
            connection: idSchema,
            term: z.number().int().positive(),
            index: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
            deadline: timeSchema,
            discovery: z.literal(true).optional(),
          })
          .strict()
      )
      .max(32),
  })
  .strict();
