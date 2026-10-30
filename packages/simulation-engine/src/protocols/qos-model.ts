import { z } from 'zod';
import { mqcMatchSchema } from './mqc-model';
const name = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
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
    share:z.number().finite().positive().max(100).optional(),
    queueLimit:z.number().int().min(1).max(256).optional(),
    groups:z.array(z.object({matchAny:z.boolean(),matches:z.array(mqcMatchSchema).max(32)}).strict()).max(4).optional(),
    shapePaths:z.array(z.object({name,rateMbps:z.number().positive().max(100000),burst:z.number().int().min(64).max(1048576)}).strict()).max(4).optional(),
    policePaths:z.array(z.object({name,rateMbps:z.number().positive().max(100000),burst:z.number().int().min(64).max(1048576)}).strict()).max(4).optional(),
    mark: z.number().int().min(0).max(63).optional(),
    policeMbps: z.number().finite().min(0.001).max(100000).optional(),
    llqMbps: z.number().finite().min(0.001).max(100000).optional(),
    matches: z.array(mqcMatchSchema).max(32).optional(),
    matchAny: z.boolean().optional(),
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
    scheduler: z.enum(['priority', 'wrr', 'llq-wrr','llq-cbwfq']),
    classes: z.array(qosClassSchema).max(64),
  })
  .strict();
export const qosStateSchema = qosConfigSchema
  .extend({
    token: z.string().min(1).max(80),
    timerAt: time.optional(),
    cursor: z.number().int().min(0).max(64),
    virtualTime:time.optional(),
    buckets:z.array(z.object({name,kind:z.enum(['shape','police']),tokens:time,updatedAt:time}).strict()).max(128).optional(),
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
            finish:time.optional(),
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
            lastFinish:time.optional(),
          })
          .strict()
      )
      .max(65),
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
