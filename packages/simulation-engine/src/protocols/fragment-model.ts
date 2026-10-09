import { z } from 'zod';
import { idSchema, ipv4Schema, timeSchema } from '../schemas';
import { icmpQuoteSchema } from './icmp-model';
export const fragmentSchema = z
  .object({
    src: ipv4Schema,
    dst: ipv4Schema,
    ttl: z.number().int().min(0).max(255),
    protocol: z.enum(['ICMP', 'UDP', 'TCP', 'OSPF', 'VRRP']),
    identification: z.number().int().min(0).max(65535),
    offset: z.number().int().min(0).max(65512).multipleOf(8),
    more: z.boolean(),
    data: z.array(z.number().int().min(0).max(255)).min(1).max(9196),
    bytes: z.number().int().min(21).max(9216),
    dscp: z.number().int().min(0).max(63).optional(),
    traceId: idSchema.optional(),
    first: icmpQuoteSchema.optional(),
  })
  .strict()
  .superRefine((f, c) => {
    if (
      f.bytes !== 20 + f.data.length ||
      f.offset + f.data.length > 65515 ||
      (f.more && f.data.length % 8) ||
      (f.first &&
        (f.offset !== 0 || f.first.src !== f.src || f.first.dst !== f.dst || f.first.protocol !== f.protocol))
    )
      c.addIssue({
        code: 'custom',
        message: 'Cabeçalho, alinhamento ou comprimento de fragmento IPv4 inválido.',
      });
  });
export type IpFragment = z.infer<typeof fragmentSchema>;
export const reassemblySchema = z
  .object({
    id: idSchema,
    port: idSchema,
    sourceMac: z.string().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i),
    src: ipv4Schema,
    dst: ipv4Schema,
    protocol: z.enum(['ICMP', 'UDP', 'TCP', 'OSPF', 'VRRP']),
    identification: z.number().int().min(0).max(65535),
    vrf: z.string().max(32).optional(),
    expiresAt: timeSchema,
    failed: z.boolean().optional(),
    fragments: z.array(fragmentSchema).max(128),
  })
  .strict();
export const fragmentPendingSchema = z
  .object({
    port: idSchema,
    nextHop: ipv4Schema,
    source: ipv4Schema,
    token: idSchema,
    startedAt: timeSchema,
    nextAt: timeSchema,
    attempts: z.number().int().min(1).max(3),
    fragments: z.array(fragmentSchema).min(1).max(128),
  })
  .strict();
export const fragmentExpireSchema = z
  .object({ kind: z.literal('fragment-expire'), device: idSchema, id: idSchema, expiresAt: timeSchema })
  .strict();
export const fragmentArpTimerSchema = z
  .object({ kind: z.literal('fragment-arp'), device: idSchema, token: idSchema })
  .strict();
