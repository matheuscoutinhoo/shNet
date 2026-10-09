import { z } from 'zod';
import { portNumberSchema } from '../schemas';
export const databaseNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
export const databaseValueSchema = z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]);
export const databaseConfigSchema = z
  .object({
    enabled: z.boolean(),
    port: portNumberSchema,
    key: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[^\r\n]+$/),
  })
  .strict();
export const databaseStateSchema = databaseConfigSchema
  .extend({
    tables: z
      .array(
        z
          .object({
            name: databaseNameSchema,
            columns: z.array(databaseNameSchema).min(1).max(16),
            rows: z.array(z.record(databaseNameSchema, databaseValueSchema)).max(256),
          })
          .strict()
      )
      .max(16),
    queries: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  })
  .strict();
