import { z } from 'zod';
import { idSchema, timeSchema } from '../schemas';

export const databaseHaSchema = z
  .object({
    cluster: idSchema,
    start: z.number().int().nonnegative().max(256),
    applied: z.number().int().nonnegative().max(256),
    pending: z
      .array(
        z
          .object({
            connection: idSchema,
            term: z.number().int().positive(),
            index: z.number().int().min(1).max(256),
            deadline: timeSchema,
          })
          .strict()
      )
      .max(32),
  })
  .strict();
