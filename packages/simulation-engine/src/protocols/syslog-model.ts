import { z } from 'zod';
import { idSchema, ipv4Schema, timeSchema } from '../schemas';
export const syslogMessageSchema = z
  .object({
    id: idSchema,
    timestamp: timeSchema,
    hostname: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/),
    facility: z.number().int().min(0).max(23),
    severity: z.number().int().min(0).max(7),
    appName: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-zA-Z0-9_-]+$/),
    text: z.string().min(1).max(300),
  })
  .strict();
export const syslogClientSchema = z
  .object({
    enabled: z.boolean(),
    server: ipv4Schema,
    severity: z.number().int().min(0).max(7).default(6),
    facility: z.number().int().min(0).max(23).default(23),
    automatic: z.boolean().default(true),
    sourcePort: z.number().int().min(49152).max(65535).optional(),
  })
  .strict();
export const syslogEntrySchema = z
  .object({ receivedAt: timeSchema, source: ipv4Schema, message: syslogMessageSchema })
  .strict();
export const syslogServerSchema = z
  .object({ enabled: z.boolean(), entries: z.array(syslogEntrySchema).max(500).default([]) })
  .strict();
export const syslogSendSchema = z
  .object({
    kind: z.literal('syslog-send'),
    device: idSchema,
    server: ipv4Schema,
    message: syslogMessageSchema,
  })
  .strict();
export type SyslogMessage = z.infer<typeof syslogMessageSchema>;
export const SYSLOG = { port: 514, entries: 500, pending: 64 } as const;
