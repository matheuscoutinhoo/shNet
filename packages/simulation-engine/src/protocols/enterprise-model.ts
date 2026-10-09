import { z } from 'zod';
import { idSchema, ipv4Schema, timeSchema, portNumberSchema } from '../schemas';
import { identitySchema, trustSchema } from './security-crypto';
import { tlsClientConfigSchema, tlsSessionSchema } from './tls-model';
const username = z.string().regex(/^[a-zA-Z0-9_.@-]{1,64}$/),
  method = z.enum(['tls', 'peap']);
const wire = z
  .string()
  .max(32768)
  .regex(/^(?:[a-f0-9]{2})*$/);
export const eapFragmentsSchema = z
  .object({
    incoming: wire.default(''),
    total: z.number().int().min(1).max(16000).optional(),
    outgoing: wire.default(''),
    outgoingTotal: z.number().int().min(1).max(16000).optional(),
    first: z.boolean().default(false),
  })
  .strict();
export const eapServerConfigSchema = z
  .object({
    enabled: z.boolean(),
    method,
    identity: identitySchema,
    trust: trustSchema,
    key: z.string().min(8).max(64),
    clients: z.array(ipv4Schema).max(64),
    users: z
      .array(
        z
          .object({
            username,
            password: z.string().max(64).optional(),
            certificateSubject: z.string().max(128).optional(),
            enabled: z.boolean().default(true),
          })
          .strict()
      )
      .max(64),
  })
  .strict();
export const eapServerStateSchema = eapServerConfigSchema
  .extend({
    sessions: z
      .array(
        z
          .object({
            id: idSchema,
            source: ipv4Schema,
            mac: z.string(),
            binding: z.string().max(256),
            method,
            identifier: z.number().int().min(0).max(255),
            fragments: eapFragmentsSchema,
            tls: tlsSessionSchema.optional(),
            lastAt: timeSchema,
            lastRequest: wire,
            lastResponse: wire,
          })
          .strict()
      )
      .max(128),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  })
  .strict();
export const eapAuthenticatorConfigSchema = z
  .object({
    enabled: z.boolean(),
    server: ipv4Schema,
    underlay: idSchema,
    key: z.string().min(8).max(64),
    reauthMs: z.number().int().min(10000).max(3600000).default(60000),
  })
  .strict();
export const eapAuthenticatorStateSchema = eapAuthenticatorConfigSchema
  .extend({
    queries: z
      .array(
        z
          .object({
            token: idSchema,
            mac: z.string(),
            identifier: z.number().int().min(0).max(255),
            sourcePort: portNumberSchema,
            authenticator: z.string().regex(/^[a-f0-9]{32}$/),
            wire,
            lastEap: wire,
            deadline: timeSchema,
            attempts: z.number().int().min(1).max(3),
          })
          .strict()
      )
      .max(32),
  })
  .strict();
export const eapSupplicantConfigSchema = z
  .object({
    enabled: z.boolean(),
    method,
    username,
    password: z.string().max(64).optional(),
    outerIdentity: username.default('anonymous'),
    tls: tlsClientConfigSchema,
  })
  .strict();
export const eapSupplicantStateSchema = eapSupplicantConfigSchema
  .extend({
    token: idSchema.optional(),
    tlsState: tlsSessionSchema.optional(),
    fragments: eapFragmentsSchema,
    lastIdentifier: z.number().int().min(0).max(255).optional(),
    lastResponse: wire.optional(),
    phase: z.enum(['idle', 'authenticating', 'authorized', 'rejected']),
  })
  .strict();
export type EapFragments = z.infer<typeof eapFragmentsSchema>;
