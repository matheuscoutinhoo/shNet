import { z } from 'zod';
import { idSchema, ipv4Schema, portNumberSchema, timeSchema, uint32Schema } from '../schemas';
const action = z.enum(['permit', 'deny']);
const domain = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9.-]+$/)
  .transform((s) => s.toLowerCase());
export const inspectionRuleSchema = z
  .object({
    sequence: z.number().int().min(1).max(65535),
    application: z.enum(['http', 'dns']),
    action,
    host: domain.optional(),
    pathPrefix: z.string().min(1).max(1024).startsWith('/').optional(),
    nameSuffix: domain.optional(),
    destinationPort: portNumberSchema.optional(),
    hits: z.number().int().nonnegative().default(0),
  })
  .strict();
export const inspectionFlowSchema = z
  .object({
    id: idSchema,
    clientIp: ipv4Schema,
    serverIp: ipv4Schema,
    clientPort: portNumberSchema,
    serverPort: portNumberSchema,
    input: idSchema,
    output: idSchema,
    nextSequence: uint32Schema,
    buffer: z.string().max(8192),
    pendingSegments: z
      .array(z.object({ sequence: uint32Schema, data: z.string().min(1).max(536) }).strict())
      .max(32)
      .optional(),
    application: z.enum(['pending', 'http', 'unknown']),
    decision: z.enum(['pending', 'permit', 'deny']),
    rule: z.number().int().min(1).max(65535).optional(),
    host: domain.optional(),
    path: z.string().max(4096).optional(),
    expiresAt: timeSchema,
  })
  .strict();
export const inspectionConfigSchema = z
  .object({
    enabled: z.boolean(),
    defaultAction: action,
    rules: z.array(inspectionRuleSchema).max(64),
    flows: z.array(inspectionFlowSchema).max(1024).default([]),
  })
  .strict();
export const inspectionTimerSchema = z
  .object({ kind: z.literal('inspection-expire'), device: idSchema, flow: idSchema, at: timeSchema })
  .strict();
export type InspectionFlow = z.infer<typeof inspectionFlowSchema>;
