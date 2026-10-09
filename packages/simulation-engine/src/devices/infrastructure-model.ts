import { z } from 'zod';
import { idSchema, timeSchema } from '../schemas';
const watts = z.number().finite().min(0).max(10000);
export const infrastructureConfigSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('rack'),
      units: z.number().int().min(1).max(60),
      ambientC: z.number().finite().min(-20).max(60),
      ventilation: z.number().finite().min(0).max(1),
      slots: z
        .array(
          z
            .object({
              device: idSchema,
              unit: z.number().int().min(1),
              units: z.number().int().min(1).max(60),
            })
            .strict()
        )
        .max(60),
    })
    .strict(),
  z
    .object({
      kind: z.literal('patch-panel'),
      pairs: z.array(z.object({ a: idSchema, b: idSchema }).strict()).max(24),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ups'),
      mains: z.boolean(),
      capacityWh: z.number().finite().min(1).max(100000),
      maxWatts: watts,
      chargeWatts: watts,
      efficiency: z.number().finite().min(0.1).max(1),
      loads: z
        .array(z.object({ device: idSchema, watts, requested: z.boolean().default(true) }).strict())
        .max(64),
      remainingWh: z.number().finite().min(0).max(100000),
      lastAt: timeSchema,
      output: z.boolean(),
    })
    .strict(),
]);
export const systemConfigSchema = z
  .object({
    enabled: z.boolean(),
    capacityPps: z.number().int().min(1).max(10000000),
    memoryLimitKiB: z.number().int().min(64).max(1048576),
    ambientC: z.number().finite().min(-20).max(60),
    thermalLimitC: z.number().finite().min(40).max(120),
  })
  .strict();
export const systemStateSchema = systemConfigSchema
  .extend({
    windowAt: timeSchema,
    work: z.number().int().nonnegative(),
    processed: z.number().int().nonnegative(),
    nextReadyAt: timeSchema,
    lastAt: timeSchema,
    cpuPercent: z.number().finite().min(0).max(100),
    memoryKiB: z.number().int().nonnegative(),
    temperatureC: z.number().finite().min(-20).max(200),
    throttled: z.boolean(),
  })
  .strict();
