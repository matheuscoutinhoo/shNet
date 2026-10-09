import { z } from 'zod';
const name = z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
  time = z.number().finite().nonnegative();
export const qosClassSchema = z
  .object({
    name,
    protocol: z.enum(['any', 'icmp', 'tcp', 'udp', 'mpls']),
    tc: z.number().int().min(0).max(7).optional(),
    markTc: z.number().int().min(0).max(7).optional(),
    destinationPort: z.number().int().min(1).max(65535).optional(),
    dscp: z.number().int().min(0).max(63).optional(),
    priority: z.number().int().min(0).max(7),
    weight: z.number().int().min(1).max(16),
    mark: z.number().int().min(0).max(63).optional(),
    policeMbps: z.number().finite().min(0.001).max(100000).optional(),
    burst: z.number().int().min(64).max(1048576).default(65536),
  })
  .strict()
  .refine((p) => !p.destinationPort || ['tcp', 'udp'].includes(p.protocol), 'Porta QoS exige TCP/UDP.');
export const qosConfigSchema = z
  .object({
    enabled: z.boolean(),
    rateMbps: z.number().finite().min(0.001).max(100000),
    queueLimit: z.number().int().min(1).max(256),
    ecnThreshold: z.number().int().min(1).max(256).optional(),
    scheduler: z.enum(['priority', 'wrr']),
    classes: z.array(qosClassSchema).max(8),
  })
  .strict();
export const qosStateSchema = qosConfigSchema
  .extend({
    token: z.string().min(1).max(80),
    timerAt: time.optional(),
    cursor: z.number().int().min(0).max(8),
    remaining: z.number().int().min(0).max(16),
    queues: z
      .array(
        z
          .object({
            class: name,
            frame: z.string().max(100000),
            bytes: z.number().int().min(1).max(65600),
            at: time,
            link: z.string().min(1).max(80),
          })
          .strict()
      )
      .max(256),
    stats: z
      .array(
        z
          .object({
            name,
            enqueued: z.number().int().nonnegative(),
            dequeued: z.number().int().nonnegative(),
            dropped: z.number().int().nonnegative(),
            bytes: z.number().int().nonnegative(),
            tokens: time,
            updatedAt: time,
          })
          .strict()
      )
      .max(9),
  })
  .strict();
export const qosTimerSchema = z
  .object({
    kind: z.literal('qos-tick'),
    device: z.string().min(1).max(80),
    port: z.string().min(1).max(80),
    token: z.string().min(1).max(80),
  })
  .strict();
