import { z } from 'zod';
import { idSchema, portNumberSchema, timeSchema } from '../schemas';
import { transportAddressSchema } from './tcp-model';
export const proxyConfigSchema = z
  .object({
    enabled: z.boolean(),
    port: portNumberSchema,
    kind: z.enum(['proxy', 'load-balancer']),
    algorithm: z.enum(['round-robin', 'least-connections']),
    backends: z.array(z.object({ address: transportAddressSchema, port: portNumberSchema }).strict()).max(16),
    allowedNetworks: z.array(transportAddressSchema).max(32),
    healthIntervalMs: z.number().int().min(1000).max(60000),
  })
  .strict();
export const proxyStateSchema = proxyConfigSchema
  .extend({
    cursor: z.number().int().nonnegative(),
    health: z
      .array(
        z
          .object({
            address: transportAddressSchema,
            port: portNumberSchema,
            state: z.enum(['unknown', 'up', 'down']),
            checkedAt: timeSchema,
            connection: idSchema.optional(),
          })
          .strict()
      )
      .max(16),
    requests: z
      .array(
        z
          .object({
            id: idSchema,
            front: idSchema.optional(),
            upstream: idSchema,
            backend: transportAddressSchema,
            port: portNumberSchema,
            deadline: timeSchema,
            state: z.enum(['pending', 'complete', 'failed']),
            health: z.boolean(),
          })
          .strict()
      )
      .max(128),
    token: idSchema,
    nextAt: timeSchema,
  })
  .strict();
export const printerConfigSchema = z
  .object({
    enabled: z.boolean(),
    port: portNumberSchema,
    pagesPerMinute: z.number().int().min(1).max(120),
    paper: z.number().int().min(0).max(1000),
  })
  .strict();
export const printerStateSchema = printerConfigSchema
  .extend({
    sequence: z.number().int().nonnegative(),
    jobs: z
      .array(
        z
          .object({
            id: z.number().int().positive(),
            name: z.string().max(100),
            owner: transportAddressSchema,
            pages: z.number().int().min(1).max(50),
            printed: z.number().int().nonnegative().max(50),
            state: z.enum(['pending', 'processing', 'completed', 'cancelled', 'stopped']),
            nextPage: timeSchema,
          })
          .strict()
      )
      .max(128),
    token: idSchema,
    nextAt: timeSchema,
  })
  .strict();
export const mqttMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('CONNECT'),
      clientId: z.string().min(1).max(64),
      keepAlive: z.number().int().min(1).max(3600),
    })
    .strict(),
  z.object({ type: z.literal('CONNACK'), code: z.number().int().min(0).max(5) }).strict(),
  z
    .object({
      type: z.literal('SUBSCRIBE'),
      id: z.number().int().min(1).max(65535),
      topic: z.string().min(1).max(128),
    })
    .strict(),
  z.object({ type: z.literal('SUBACK'), id: z.number().int().min(1).max(65535) }).strict(),
  z
    .object({
      type: z.literal('PUBLISH'),
      topic: z.string().min(1).max(128),
      payload: z.string().max(1024),
      retain: z.boolean(),
    })
    .strict(),
  z.object({ type: z.enum(['PINGREQ', 'PINGRESP', 'DISCONNECT']) }).strict(),
]);
export const brokerConfigSchema = z.object({ enabled: z.boolean(), port: portNumberSchema }).strict();
export const brokerStateSchema = brokerConfigSchema
  .extend({
    clients: z
      .array(
        z
          .object({
            connection: idSchema,
            clientId: z.string().min(1).max(64),
            subscriptions: z.array(z.string().min(1).max(128)).max(32),
            keepAlive: z.number().int().min(1).max(3600),
            lastAt: timeSchema,
          })
          .strict()
      )
      .max(128),
    retained: z
      .array(z.object({ topic: z.string().min(1).max(128), payload: z.string().max(1024) }).strict())
      .max(128),
    token: idSchema,
    nextAt: timeSchema,
  })
  .strict();
export const iotStateSchema = z
  .object({
    connection: idSchema,
    broker: transportAddressSchema,
    port: portNumberSchema,
    clientId: z.string().min(1).max(64),
    state: z.enum(['CONNECTING', 'CONNECTED', 'DISCONNECTED']),
    subscriptions: z.array(z.string().min(1).max(128)).max(32),
    readings: z
      .array(z.object({ topic: z.string().max(128), payload: z.string().max(1024), at: timeSchema }).strict())
      .max(256),
    keepAlive: z.number().int().min(1).max(3600),
    lastAt: timeSchema,
    pingPending: z.boolean(),
    token: idSchema,
    nextAt: timeSchema,
  })
  .strict();
export const applicationTimerSchema = z
  .object({
    kind: z.literal('application-tick'),
    device: idSchema,
    service: z.enum(['proxy', 'printer', 'broker', 'iot']),
    token: idSchema,
  })
  .strict();
