import { z } from 'zod';
import { idSchema, timeSchema, ipv4Schema } from '../schemas';
export const bondMonitorSchema = z.object({
  target: ipv4Schema,
  intervalMs: z.number().int().min(100).max(10000).default(1000),
  timeoutMs: z.number().int().min(300).max(30000).default(3000),
}).strict().refine(v => v.timeoutMs >= v.intervalMs * 3, 'Timeout exige três intervalos de sondagem.');
export const bondStateSchema = z.object({
  number: z.number().int().min(1).max(64),
  members: z.array(idSchema).min(2).max(8),
  primary: idSchema,
  active: idSchema.optional(),
  monitor: bondMonitorSchema.optional(),
  startedAt: timeSchema,
  nextProbeAt: timeSchema,
  health: z.array(z.object({ port: idSchema, lastResponseAt: timeSchema.optional() }).strict()).max(8),
  token: idSchema,
  tickAt: timeSchema,
  announcements: z.number().int().min(0).max(3),
  announceAt: timeSchema,
}).strict();
export const bondTimerSchema = z.object({ kind: z.literal('bond-tick'), device: idSchema, port: idSchema, token: idSchema }).strict();
export type BondMonitor = z.input<typeof bondMonitorSchema>;
