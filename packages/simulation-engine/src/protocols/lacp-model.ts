import { z } from 'zod';
import { idSchema, timeSchema } from '../schemas';
const mac = z.string().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i);
const number = z.number().int().min(1).max(64);
export const LACP = { mac: '01:80:c2:00:00:02', tickMs: 1000, timeoutMs: 3000 } as const;
const identity = z
  .object({
    system: mac,
    key: number,
    port: idSchema,
    portNumber: z.number().int().min(1).max(65535).optional(),
    systemPriority: z.number().int().min(0).max(65535).optional(),
    portPriority: z.number().int().min(0).max(65535).optional(),
    state: z.number().int().min(0).max(255).optional(),
  })
  .strict();
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
    // "on" bundles statically, without LACPDUs.
    mode: z.enum(['active', 'passive', 'on']),
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
/** "port-channel load-balance": the frame fields hashed to pick a member link. */
export const LOAD_BALANCE_METHODS = [
  'src-mac',
  'dst-mac',
  'src-dst-mac',
  'src-ip',
  'dst-ip',
  'src-dst-ip',
  'src-port',
  'dst-port',
  'src-dst-port',
  'src-dst-mixed-ip-port',
] as const;
export const loadBalanceSchema = z.enum(LOAD_BALANCE_METHODS);
