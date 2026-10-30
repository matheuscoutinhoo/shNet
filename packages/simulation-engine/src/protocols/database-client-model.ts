import { z } from 'zod';
import { idSchema, portNumberSchema, timeSchema } from '../schemas';
import { databaseConfigSchema } from './database-model';
import { quorumId } from './quorum-data';
import { transportAddressSchema } from './tcp-model';
import { isUnicast } from './dhcp-config';
import { normalize6, unicast6, linkLocal6 } from './ipv6-address';

export const databaseClusterConfigSchema = z
  .object({
    cluster: quorumId,
    targets: z.array(transportAddressSchema).min(1).max(5),
    port: portNumberSchema,
    key: databaseConfigSchema.shape.key,
  })
  .strict()
  .superRefine((c, ctx) => {
    const normalized = c.targets.map((ip) => (ip.includes(':') ? normalize6(ip) : ip));
    if (
      new Set(normalized).size !== normalized.length ||
      c.targets.some((ip) =>
        ip.includes(':') ? !unicast6(ip) || linkLocal6(ip) || normalize6(ip) === '::1' : !isUnicast(ip)
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Réplicas exigem endereços unicast únicos, sem escopo local.',
      });
  });
export const databaseClientRequestSchema = z
  .object({
    id: idSchema,
    config: databaseClusterConfigSchema,
    query: z.string().min(1).max(2048),
    phase: z.enum(['discovering', 'querying', 'complete', 'failed', 'unknown']),
    cursor: z.number().int().min(0).max(4),
    connection: idSchema.optional(),
    started: timeSchema,
    deadline: timeSchema,
    finished: timeSchema.optional(),
    term: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    index: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    response: z.string().max(16384).optional(),
    error: z.string().max(512).optional(),
  })
  .strict();
export const databaseClientSchema = z
  .object({
    config: databaseClusterConfigSchema,
    requests: z.array(databaseClientRequestSchema).max(32),
    token: idSchema,
    nextAt: timeSchema.optional(),
  })
  .strict();
export type DatabaseClientRequest = z.infer<typeof databaseClientRequestSchema>;
export const databaseRequestActive = (r: DatabaseClientRequest) =>
  r.phase === 'discovering' || r.phase === 'querying';
