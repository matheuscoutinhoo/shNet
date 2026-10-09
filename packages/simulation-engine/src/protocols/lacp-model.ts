import { z } from 'zod';
import { idSchema, timeSchema } from '../schemas';
const mac = z.string().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i);
const number = z.number().int().min(1).max(64);
export const LACP = { mac: '01:80:c2:00:00:02', tickMs: 1000, timeoutMs: 3000 } as const;
const identity = z.object({ system: mac, key: number, port: idSchema }).strict();
export const lacpPduSchema = z
  .object({
    actor: identity,
    partner: identity.optional(),
    active: z.boolean(),
    version: z.literal(1),
  })
  .strict();
export const aggregateSchema = z
  .object({
    number,
    mode: z.enum(['active', 'passive']),
    members: z.array(idSchema).min(1).max(8),
    minLinks: z.number().int().min(1).max(8),
    token: idSchema,
    tickAt: timeSchema,
    received: z
      .array(z.object({ port: idSchema, pdu: lacpPduSchema, at: timeSchema, expiresAt: timeSchema }).strict())
      .max(8),
    selected: z.array(idSchema).max(8),
  })
  .strict();
export const lacpTimerSchema = z
  .object({ kind: z.literal('lacp-tick'), device: idSchema, port: idSchema, token: idSchema })
  .strict();
export type LacpPdu = z.infer<typeof lacpPduSchema>;
