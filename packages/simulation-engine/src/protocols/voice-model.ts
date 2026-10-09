import { z } from 'zod';
import { idSchema, ipv4Schema, portNumberSchema, timeSchema } from '../schemas';
const mediaSchema = z
  .object({ address: ipv4Schema, port: portNumberSchema, codec: z.literal('PCMU') })
  .strict();
export const sipSchema = z
  .object({
    callId: idSchema,
    cseq: z.number().int().min(1).max(65535),
    method: z.enum(['INVITE', 'ACK', 'BYE']),
    status: z
      .union([z.literal(100), z.literal(180), z.literal(200), z.literal(404), z.literal(486)])
      .optional(),
    from: z.string().min(1).max(50),
    to: z.string().min(1).max(50),
    contact: ipv4Schema,
    via: ipv4Schema,
    media: mediaSchema.optional(),
  })
  .strict();
export const rtpSchema = z
  .object({
    callId: idSchema,
    ssrc: z.number().int().nonnegative().max(4294967295),
    sequence: z.number().int().min(0).max(65535),
    timestamp: z.number().int().nonnegative().max(4294967295),
    data: z.string().max(160),
  })
  .strict();
export const phoneConfigSchema = z
  .object({
    enabled: z.boolean(),
    number: z.string().min(1).max(50),
    sipPort: portNumberSchema,
    rtpPort: portNumberSchema,
    autoAnswer: z.boolean(),
  })
  .strict();
export const phoneStateSchema = phoneConfigSchema
  .extend({
    calls: z
      .array(
        z
          .object({
            id: idSchema,
            role: z.enum(['caller', 'callee']),
            remote: ipv4Schema,
            remotePort: portNumberSchema,
            local: ipv4Schema,
            state: z.enum(['CALLING', 'RINGING', 'ESTABLISHED', 'CLOSED', 'FAILED']),
            cseq: z.number().int().positive(),
            media: mediaSchema.optional(),
            deadline: timeSchema,
            attempts: z.number().int().min(0).max(4),
            sent: z.number().int().nonnegative(),
            received: z.number().int().nonnegative(),
            lastSequence: z.number().int().min(0).max(65535).optional(),
            token: idSchema,
          })
          .strict()
      )
      .max(64),
  })
  .strict();
export const voiceTimerSchema = z
  .object({ kind: z.literal('voice-tick'), device: idSchema, call: idSchema, token: idSchema })
  .strict();
export const sipAlgBindingSchema = z
  .object({
    id: idSchema,
    call: idSchema,
    inviteCseq: z.number().int().min(1).max(65535),
    inside: ipv4Schema,
    global: ipv4Schema,
    insidePort: portNumberSchema,
    globalPort: portNumberSchema,
    controlInside: portNumberSchema,
    controlGlobal: portNumberSchema,
    remote: ipv4Schema,
    controlRemote: portNumberSchema,
    remoteMedia: portNumberSchema.optional(),
    input: idSchema,
    output: idSchema,
    expiresAt: timeSchema,
  })
  .strict();
export const sipAlgTimerSchema = z
  .object({ kind: z.literal('sip-alg-expire'), device: idSchema, id: idSchema, expiresAt: timeSchema })
  .strict();
