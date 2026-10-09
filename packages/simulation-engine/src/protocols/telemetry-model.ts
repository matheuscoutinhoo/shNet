import { z } from 'zod';
import { idSchema, ipv4Schema, timeSchema } from '../schemas';
const key = z.string().min(8).max(64),
  counter = z.number().int().nonnegative(),
  timestamp = z.number().finite();
export const telemetryMessageSchema = z
  .object({
    stream: idSchema,
    sequence: counter.min(1),
    hostname: z.string().max(32),
    timestamp,
    metrics: z.array(z.object({ path: z.string().max(160), value: z.number().finite() }).strict()).max(256),
    tag: z.string().regex(/^[a-f0-9]{8}$/),
  })
  .strict();
export const telemetryConfigSchema = z
  .object({
    enabled: z.boolean(),
    collector: ipv4Schema,
    key,
    intervalMs: z.number().int().min(1000).max(60000),
    sensors: z
      .array(z.enum(['interfaces', 'routes', 'tcp', 'qos', 'aaa']))
      .min(1)
      .max(5),
  })
  .strict();
export const telemetryStateSchema = telemetryConfigSchema
  .extend({ stream: idSchema, sequence: counter, token: idSchema, tickAt: timeSchema, sent: counter })
  .strict();
export const collectorConfigSchema = z.object({ enabled: z.boolean(), key }).strict();
export const collectorStateSchema = collectorConfigSchema
  .extend({
    received: counter,
    rejected: counter,
    records: z
      .array(
        z.object({ source: ipv4Schema, receivedAt: timeSchema, message: telemetryMessageSchema }).strict()
      )
      .max(256),
    streams: z
      .array(
        z
          .object({
            source: ipv4Schema,
            id: idSchema,
            lastSequence: counter.min(1),
            receivedSequences: z.array(counter.min(1)).min(1).max(64),
          })
          .strict()
      )
      .max(128),
  })
  .strict();
export const telemetryTimerSchema = z
  .object({ kind: z.literal('telemetry-tick'), device: idSchema, token: idSchema })
  .strict();
export const ntpMessageSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('client'), id: idSchema, originate: timestamp }).strict(),
  z
    .object({
      mode: z.literal('server'),
      id: idSchema,
      originate: timestamp,
      receive: timestamp,
      transmit: timestamp,
      stratum: z.number().int().min(1).max(15),
    })
    .strict(),
]);
export const clockConfigSchema = z
  .object({
    offsetMs: z.number().finite().min(-3600000).max(3600000),
    server: z.boolean(),
    stratum: z.number().int().min(1).max(15).default(1),
  })
  .strict();
export const ntpConfigSchema = z
  .object({
    enabled: z.boolean(),
    servers: z.array(ipv4Schema).min(1).max(8),
    intervalMs: z.number().int().min(5000).max(60000).default(10000),
  })
  .strict();
export const ntpStateSchema = ntpConfigSchema
  .extend({
    token: idSchema,
    tickAt: timeSchema,
    index: z.number().int().min(0).max(7),
    pending: z
      .object({
        id: idSchema,
        server: ipv4Schema,
        source: ipv4Schema,
        port: z.number().int().min(49152).max(65535),
        originate: timestamp,
        at: timeSchema,
      })
      .strict()
      .optional(),
    synchronized: z.boolean(),
    lastSync: timeSchema.optional(),
    stratum: z.number().int().min(1).max(16),
    samples: z
      .array(
        z
          .object({
            server: ipv4Schema,
            at: timeSchema,
            offsetMs: timestamp,
            delayMs: z.number().finite().nonnegative(),
          })
          .strict()
      )
      .max(32),
    failures: counter,
  })
  .strict();
export const ntpTimerSchema = z
  .object({ kind: z.literal('ntp-tick'), device: idSchema, token: idSchema })
  .strict();
