import { z } from 'zod';
import { ipv4Schema } from '../schemas';
export const dnsNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(254)
  .transform((value) => value.toLowerCase().replace(/\.$/, ''))
  .pipe(
    z
      .string()
      .min(1)
      .max(253)
      .refine(
        (value) => value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
        'Nome DNS inválido'
      )
  );
const dnsRecordBase = { name: dnsNameSchema, ttl: z.number().int().min(0).max(86400) };
export const dnsRecordSchema = z.discriminatedUnion('type', [
  z.object({ ...dnsRecordBase, type: z.literal('A'), value: ipv4Schema }).strict(),
  z.object({ ...dnsRecordBase, type: z.literal('AAAA'), value: z.ipv6() }).strict(),
  z.object({ ...dnsRecordBase, type: z.literal('CNAME'), value: dnsNameSchema }).strict(),
]);
export type DnsRecord = z.infer<typeof dnsRecordSchema>;
export const dnsQuestionSchema = z
  .object({ name: dnsNameSchema, type: z.enum(['A', 'AAAA', 'CNAME']) })
  .strict();
export const dnsCodeSchema = z.enum(['NOERROR', 'NXDOMAIN', 'SERVFAIL', 'REFUSED', 'BADVERS']);
const hex = (bytes: number) => z.string().regex(new RegExp(`^[a-f0-9]{${bytes * 2}}$`));
export const ednsSchema = z
  .object({
    udpSize: z.number().int().min(512).max(4096),
    version: z.number().int().min(0).max(255),
    dnssecOk: z.boolean(),
  })
  .strict();
export const dnssecZoneSchema = z
  .object({ name: dnsNameSchema, seed: hex(32), validity: z.number().int().min(30).max(86400) })
  .strict();
export const dnsResolverSchema = z
  .object({
    edns: ednsSchema.optional(),
    validation: z.enum(['off', 'allow-unsigned', 'require']),
    anchors: z.array(z.object({ zone: dnsNameSchema, digest: hex(32) }).strict()).max(32),
  })
  .strict();
export const nsecSchema = z
  .object({
    name: dnsNameSchema,
    type: z.literal('NSEC'),
    ttl: z.number().int().min(0).max(86400),
    next: dnsNameSchema,
    types: z.array(z.enum(['A', 'AAAA', 'CNAME', 'DNSKEY', 'RRSIG', 'NSEC'])).max(6),
  })
  .strict();
export const dnssecProofSchema = z
  .object({
    zone: dnsNameSchema,
    publicKey: hex(32),
    keyTag: z.number().int().min(0).max(65535),
    signatures: z
      .array(
        z
          .object({
            name: dnsNameSchema,
            type: z.enum(['A', 'AAAA', 'CNAME', 'NSEC']),
            ttl: z.number().int().min(0).max(86400),
            inception: z.number().int().nonnegative(),
            expiration: z.number().int().nonnegative(),
            signature: hex(64),
          })
          .strict()
      )
      .max(64),
    denial: z.array(nsecSchema).max(4),
  })
  .strict();
export const dnsMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('query'),
      transactionId: z.number().int().min(0).max(65535),
      question: dnsQuestionSchema,
      recursionDesired: z.boolean(),
      edns: ednsSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('response'),
      transactionId: z.number().int().min(0).max(65535),
      question: dnsQuestionSchema,
      recursionDesired: z.boolean(),
      recursionAvailable: z.boolean(),
      authoritative: z.boolean(),
      truncated: z.boolean(),
      code: dnsCodeSchema,
      answers: z.array(dnsRecordSchema).max(64),
      edns: ednsSchema.optional(),
      dnssec: dnssecProofSchema.optional(),
    })
    .strict(),
]);
