import { z } from 'zod';
import { idSchema, ipv4Schema, timeSchema } from '../schemas';
export const RIP = {
  destination: '224.0.0.9',
  mac: '01:00:5e:00:00:09',
  port: 520,
  updateMs: 30000,
  timeoutMs: 180000,
  garbageMs: 120000,
  tickMs: 1000,
  infinity: 16,
} as const;
const authentication = z
  .object({
    keyId: z.number().int().min(1).max(255),
    sequence: z.number().int().min(0).max(4294967295),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const filter = z.object({ network: ipv4Schema, prefix: z.number().int().min(0).max(32) }).strict();
const entry = {
  network: ipv4Schema,
  prefix: z.number().int().min(0).max(32),
  metric: z.number().int().min(1).max(16),
  tag: z.number().int().min(0).max(65535),
  nextHop: ipv4Schema.optional(),
};
export const ripMessageSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('request'), version: z.literal(2), authentication: authentication.optional() })
    .strict(),
  z
    .object({
      authentication: authentication.optional(),
      type: z.literal('response'),
      version: z.literal(2),
      entries: z.array(z.object(entry).strict()).max(25),
    })
    .strict(),
]);
export type RipMessage = z.infer<typeof ripMessageSchema>;
export const ripConfigSchema = z
  .object({
    enabled: z.boolean(),
    holdDownMs: z.number().int().min(0).max(180000).default(0),
    redistributeStatic: z.boolean().default(false),
    staticMetric: z.number().int().min(1).max(15).default(1),
    staticTag: z.number().int().min(0).max(65535).default(0),
    interfaces: z
      .array(
        z
          .object({
            port: idSchema,
            passive: z.boolean().default(false),
            poisonReverse: z.boolean().default(true),
            cost: z.number().int().min(1).max(15).default(1),
            inputPrefixes: z.array(filter).max(32).default([]),
            outputPrefixes: z.array(filter).max(32).default([]),
            keys: z
              .array(
                z
                  .object({
                    id: z.number().int().min(1).max(255),
                    key: z.string().min(8).max(64),
                    from: timeSchema.default(0),
                    through: timeSchema.optional(),
                  })
                  .strict()
              )
              .max(4)
              .default([]),
          })
          .strict()
      )
      .max(48),
  })
  .strict();
export type RipConfig = z.infer<typeof ripConfigSchema>;
export const ripRouteSchema = z
  .object({
    ...entry,
    nextHop: ipv4Schema,
    port: idSchema,
    learnedFrom: ipv4Schema.optional(),
    expiresAt: timeSchema.optional(),
    garbageAt: timeSchema.optional(),
    holdDownUntil: timeSchema.optional(),
    lastMetric: z.number().int().min(1).max(15).optional(),
  })
  .strict();
export type RipRoute = z.infer<typeof ripRouteSchema>;
export const ripStateSchema = ripConfigSchema
  .extend({
    token: idSchema,
    tickAt: timeSchema,
    updateAt: timeSchema,
    triggerAt: timeSchema.optional(),
    table: z.array(ripRouteSchema).max(1024),
    receivedSequences: z
      .array(
        z
          .object({
            port: idSchema,
            source: ipv4Schema,
            keyId: z.number().int().min(1).max(255),
            sequence: z.number().int().min(0).max(4294967295),
            at: timeSchema,
          })
          .strict()
      )
      .max(256)
      .default([]),
    ports: z
      .array(z.object({ port: idSchema, operational: z.boolean(), signature: z.string().max(100) }).strict())
      .max(48),
  })
  .strict();
export const ripTimerSchema = z
  .object({ kind: z.literal('rip-tick'), device: idSchema, token: idSchema })
  .strict();
