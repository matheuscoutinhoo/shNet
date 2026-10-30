import { z } from 'zod';
import { idSchema, ipv4Schema, timeSchema } from '../schemas';
const discriminator = z.number().int().min(0).max(4294967295);
export const bfdAuthenticationTypeSchema = z.enum(['md5', 'meticulous-md5', 'sha-1', 'meticulous-sha-1']);
export const bfdAuthenticationSchema = z
  .object({ type: bfdAuthenticationTypeSchema, keyChain: z.string().regex(/^[\w-]{1,32}$/) })
  .strict();
const configShape = {
  intervalMs: z.number().int().min(50).max(999),
  minRxMs: z.number().int().min(50).max(999),
  multiplier: z.number().int().min(3).max(50),
  ospf: z.boolean().default(false),
  template: z
    .string()
    .regex(/^[\w-]{1,32}$/)
    .optional(),
  authentication: bfdAuthenticationSchema.optional(),
};
export const bfdConfigSchema = z.object(configShape).strict();
export const bfdTemplatesSchema = z
  .array(
    z
      .object({
        name: z.string().regex(/^[\w-]{1,32}$/),
        intervalMs: configShape.intervalMs.default(750),
        minRxMs: configShape.minRxMs.default(750),
        multiplier: configShape.multiplier.default(3),
        authentication: bfdAuthenticationSchema.optional(),
      })
      .strict()
  )
  .max(32);
export const bfdMessageSchema = z
  .object({
    state: z.enum(['AdminDown', 'Down', 'Init', 'Up']),
    my: discriminator,
    your: discriminator,
    desiredTx: z.number().int().min(1).max(4294967295),
    requiredRx: z.number().int().min(0).max(4294967295),
    multiplier: z.number().int().min(1).max(255),
    diagnostic: z.number().int().min(0).max(31).optional(),
    poll: z.boolean().optional(),
    final: z.boolean().optional(),
    controlPlaneIndependent: z.boolean().optional(),
    authentication: z
      .object({
        type: bfdAuthenticationTypeSchema,
        keyId: z.number().int().min(0).max(255),
        sequence: discriminator,
        digest: z.string().regex(/^(?:[0-9a-f]{32}|[0-9a-f]{40})$/),
      })
      .strict()
      .optional(),
  })
  .strict();
export const bfdStateSchema = z
  .object({
    ...configShape,
    token: idSchema,
    tickAt: timeSchema,
    sessions: z
      .array(
        z
          .object({
            ip: ipv4Schema,
            my: discriminator,
            remote: discriminator,
            state: z.enum(['Down', 'Init', 'Up']),
            hadUp: z.boolean(),
            clients: z
              .array(z.enum(['ospf', 'bgp']))
              .max(2)
              .default([]),
            nextAt: timeSchema,
            deadline: timeSchema.optional(),
            remoteTx: z.number().finite().positive(),
            remoteRx: z.number().finite().nonnegative(),
            remoteMultiplier: z.number().int().min(1).max(255).optional(),
            localTx: z.number().finite().positive().optional(),
            localRx: z.number().finite().positive().optional(),
            polling: z.boolean().optional(),
            lastSent: timeSchema.optional(),
            lastReceived: timeSchema.optional(),
            diagnostic: z.number().int().min(0).max(31).optional(),
            authSequence: discriminator.optional(),
            receivedAuth: z
              .array(
                z
                  .object({
                    keyId: z.number().int().min(0).max(255),
                    sequence: discriminator,
                    at: timeSchema,
                  })
                  .strict()
              )
              .max(64)
              .default([]),
            sent: z.number().int().nonnegative(),
            received: z.number().int().nonnegative(),
          })
          .strict()
      )
      .max(32),
  })
  .strict();
export const bfdTimerSchema = z
  .object({ kind: z.literal('bfd-tick'), device: idSchema, port: idSchema, token: idSchema })
  .strict();
export type BfdMessage = z.infer<typeof bfdMessageSchema>;
export type BfdConfig = z.infer<typeof bfdConfigSchema>;
export type BfdState = z.infer<typeof bfdStateSchema>;
export type BfdSession = BfdState['sessions'][number];
