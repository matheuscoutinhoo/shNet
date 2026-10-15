import { z } from 'zod';
import { idSchema, ipv4Schema, timeSchema, portNumberSchema } from '../schemas';
const level = z.number().int().min(0).max(1000);
const index = z.number().int().min(0).max(1023);
export const plcProcessConfigSchema = z
  .object({
    enabled: z.boolean(),
    scanMs: z.number().int().min(100).max(10000).multipleOf(100).default(100),
    control: z.enum(['manual', 'automatic']).default('automatic'),
    initialLevel: level.default(500),
    fillPerSecond: level.default(80),
    drainPerSecond: level.default(20),
    lowAlarm: level.default(100),
    highAlarm: level.default(900),
    hysteresis: z.number().int().min(0).max(100).default(10),
    setpointRegister: index.default(0),
    levelInputRegister: index.default(0),
    pumpCoil: index.default(0),
    alarmDiscreteInput: index.default(0),
  })
  .strict()
  .refine(
    (p) => p.highAlarm - p.lowAlarm > 2 * p.hysteresis,
    'A faixa entre alarmes deve exceder duas vezes a histerese.'
  );
export const plcProcessStateSchema = plcProcessConfigSchema
  .safeExtend({
    token: idSchema,
    tickAt: timeSchema,
    lastAt: timeSchema,
    levelMilli: z.number().int().min(0).max(1000000),
    lastPump: z.boolean(),
    scans: z.number().int().nonnegative(),
    alarms: z
      .object({
        low: z.boolean(),
        high: z.boolean(),
        invalidSetpoint: z.boolean(),
        latched: z.boolean(),
        acknowledged: z.boolean(),
        changedAt: timeSchema,
      })
      .strict(),
  })
  .strict();
export const hmiScanConfigSchema = z
  .object({
    enabled: z.boolean(),
    target: ipv4Schema,
    port: portNumberSchema.default(502),
    unit: z.number().int().min(1).max(247).default(1),
    function: z.union([z.literal(3), z.literal(4)]).default(4),
    address: z.number().int().min(0).max(65535).default(0),
    quantity: z.number().int().min(1).max(125).default(1),
    intervalMs: z.number().int().min(100).max(30000).multipleOf(100).default(1000),
    deadlineMs: z.number().int().min(100).max(30000).multipleOf(100).default(800),
    missedBeforeAlarm: z.number().int().min(1).max(20).default(3),
    lowAlarm: z.number().int().min(0).max(65535).optional(),
    highAlarm: z.number().int().min(0).max(65535).optional(),
  })
  .strict()
  .refine(
    (p) =>
      p.deadlineMs <= p.intervalMs &&
      p.address + p.quantity <= 65536 &&
      (p.lowAlarm === undefined || p.highAlarm === undefined || p.lowAlarm < p.highAlarm),
    'HMI exige deadline até o intervalo, faixa válida e alarmes ordenados.'
  );
export const hmiScanStateSchema = hmiScanConfigSchema
  .safeExtend({
    token: idSchema,
    tickAt: timeSchema,
    nextPollAt: timeSchema,
    transaction: z.number().int().min(0).max(65535),
    pending: z
      .object({
        connection: idSchema,
        startedAt: timeSchema,
        deadlineAt: timeSchema,
        transaction: z.number().int().min(0).max(65535),
      })
      .strict()
      .optional(),
    values: z.array(z.number().int().min(0).max(65535)).max(125),
    receivedAt: timeSchema.optional(),
    latencyMs: timeSchema.optional(),
    samples: z.number().int().nonnegative(),
    missed: z.number().int().nonnegative(),
    consecutiveMisses: z.number().int().nonnegative(),
    communicationAlarm: z.boolean(),
    processAlarm: z.boolean(),
    lastError: z.string().max(200).optional(),
  })
  .strict();
export const plcProcessTimerSchema = z
  .object({
    kind: z.literal('plc-process-tick'),
    device: idSchema,
    token: idSchema,
  })
  .strict();
export const hmiScanTimerSchema = z
  .object({
    kind: z.literal('hmi-scan-tick'),
    device: idSchema,
    token: idSchema,
  })
  .strict();
export type PlcProcessConfig = z.input<typeof plcProcessConfigSchema>;
export type HmiScanConfig = z.input<typeof hmiScanConfigSchema>;
