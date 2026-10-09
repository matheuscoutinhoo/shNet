import { z } from 'zod';
import { idSchema, ipv4Schema, timeSchema } from '../schemas';
import { transportAddressSchema, tcpPacketSchema } from './tcp-model';
export const idsRuleSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(80),
    protocol: z.enum(['any', 'TCP', 'UDP', 'ICMP', 'ICMPv6']),
    destinationPort: z.number().int().min(1).max(65535).optional(),
    source: z
      .object({ network: ipv4Schema, prefix: z.number().int().min(0).max(32) })
      .strict()
      .optional(),
    pattern: z.string().min(1).max(256).optional(),
    threshold: z.number().int().min(1).max(10000).optional(),
    windowMs: z.number().int().min(100).max(60000).default(1000),
    synOnly: z.boolean().default(false),
    action: z.enum(['alert', 'drop']),
  })
  .strict()
  .refine((r) => r.pattern !== undefined || r.threshold !== undefined, 'IDS exige assinatura ou limiar.');
export const idsConfigSchema = z
  .object({ enabled: z.boolean(), mode: z.enum(['ids', 'ips']), rules: z.array(idsRuleSchema).max(64) })
  .strict();
export const idsStateSchema = idsConfigSchema
  .extend({
    dropped: z.number().int().nonnegative(),
    alerts: z
      .array(
        z
          .object({
            at: timeSchema,
            rule: idSchema,
            source: transportAddressSchema,
            destination: transportAddressSchema,
            protocol: z.string().max(10),
            port: idSchema,
            blocked: z.boolean(),
            reason: z.string().max(300),
          })
          .strict()
      )
      .max(256),
    counters: z
      .array(
        z
          .object({
            rule: idSchema,
            source: transportAddressSchema,
            startedAt: timeSchema,
            count: z.number().int().nonnegative(),
            alerted: z.boolean(),
          })
          .strict()
      )
      .max(1024),
    flows: z
      .array(
        z
          .object({
            id: z.string().min(1).max(512),
            next: z.number().int().min(0).max(4294967295),
            text: z.string().max(4096),
            chunks: z.array(tcpPacketSchema).max(64),
            lastAt: timeSchema,
          })
          .strict()
      )
      .max(256),
  })
  .strict();
