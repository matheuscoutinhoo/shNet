import { z } from 'zod';
import { idSchema } from '../schemas';
import { certificateSchema, identitySchema, trustSchema } from './security-crypto';
const hex = (n: number) => z.string().regex(new RegExp(`^[a-f0-9]{${n * 2}}$`));
export const tlsClientConfigSchema = z
  .object({ trust: trustSchema, serverName: z.string().min(1).max(128), identity: identitySchema.optional() })
  .strict();
export const tlsMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('ClientHello'),
      version: z.literal('TLS1.3'),
      suite: z.literal('TLS_AES_128_GCM_SHA256'),
      session: idSchema,
      nonce: idSchema,
      keyShare: hex(32),
      context: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      type: z.literal('ServerHello'),
      session: idSchema,
      nonce: idSchema,
      keyShare: hex(32),
      flight: z
        .string()
        .max(6000)
        .regex(/^(?:[a-f0-9]{2})+$/),
    })
    .strict(),
  z
    .object({
      type: z.enum(['ClientFinished', 'ProtectedResult', 'ResultAcknowledgment']),
      session: idSchema,
      ciphertext: z
        .string()
        .max(6000)
        .regex(/^(?:[a-f0-9]{2})+$/),
    })
    .strict(),
]);
export const tlsSessionSchema = z
  .object({
    role: z.enum(['client', 'server']),
    phase: z.enum(['HELLO', 'FINISHED', 'RESULT', 'ESTABLISHED', 'FAILED']),
    session: idSchema,
    secret: hex(32),
    nonce: idSchema,
    hello: tlsMessageSchema,
    peerShare: hex(32).optional(),
    peerNonce: idSchema.optional(),
    master: hex(32).optional(),
    transcript: hex(32).optional(),
    accepted: z.boolean().optional(),
    username: z.string().max(64).optional(),
    peerCertificate: certificateSchema.optional(),
  })
  .strict();
export type TlsSession = z.infer<typeof tlsSessionSchema>;
export type TlsMessage = z.infer<typeof tlsMessageSchema>;
