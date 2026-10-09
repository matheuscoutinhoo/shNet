import { z } from 'zod';
import { idSchema, ipv4Schema, portNumberSchema, uint32Schema } from '../schemas';

// A bounded quotation of the IPv4 header and first eight transport octets.
// Payloads are deliberately excluded: an ICMP error cannot contain another error.
const header = { src: ipv4Schema, dst: ipv4Schema, ttl: z.number().int().min(0).max(255) };
const ports = { sourcePort: portNumberSchema, destinationPort: portNumberSchema };
export const icmpQuoteSchema = z.discriminatedUnion('protocol', [
  z
    .object({
      ...header,
      protocol: z.literal('ICMP'),
      kind: z.enum(['echo-request', 'echo-reply']),
      probeId: idSchema,
    })
    .strict(),
  z.object({ ...header, protocol: z.literal('UDP'), ...ports }).strict(),
  z.object({ ...header, protocol: z.literal('TCP'), ...ports, sequence: uint32Schema }).strict(),
]);
export const icmpErrorSchema = z
  .object({
    code: z.union([z.literal(0), z.literal(1), z.literal(3), z.literal(4)]),
    mtu: z.number().int().min(576).max(9216).optional(),
    quote: icmpQuoteSchema,
  })
  .strict()
  .refine(
    (e) => (e.code === 4 ? e.mtu !== undefined : e.mtu === undefined),
    'Fragmentation Needed exige MTU.'
  );
export type IcmpQuote = z.infer<typeof icmpQuoteSchema>;
