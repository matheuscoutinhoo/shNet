import { z } from 'zod';
export const iosSystemSchema = z
  .object({
    timezone: z
      .object({
        name: z.string().regex(/^[\w+-]{1,16}$/),
        hours: z.number().int().min(-23).max(23),
        minutes: z.number().int().min(0).max(59).default(0),
      })
      .strict()
      .optional(),
    archive: z
      .object({
        path: z.string().min(1).max(160).default('flash:/archive'),
        maximum: z.number().int().min(1).max(14).default(14),
        writeMemory: z.boolean().default(false),
        copies: z
          .array(
            z
              .object({
                at: z.number().finite().nonnegative(),
                name: z.string().max(160),
                configuration: z.string().max(65536),
              })
              .strict()
          )
          .max(14)
          .default([]),
      })
      .strict()
      .optional(),
  })
  .strict();
