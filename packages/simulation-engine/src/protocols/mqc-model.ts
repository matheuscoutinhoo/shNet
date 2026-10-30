import { z } from 'zod';
import { idSchema } from '../schemas';
const name = z.string().regex(/^[\w-]{1,32}$/);
export const mqcMatchSchema = z
  .object({
    protocol: z.enum(['any', 'icmp', 'tcp', 'udp', 'mpls']).optional(),
    dscp: z.number().int().min(0).max(63).optional(),
    dscps: z.array(z.number().int().min(0).max(63)).max(64).optional(),
    destinationPort: z.number().int().min(1).max(65535).optional(),
    acl:name.optional(),
  })
  .strict();
export const mqcSchema = z
  .object({
    classMaps: z
      .array(z.object({ name, matchAny: z.boolean(), matches: z.array(mqcMatchSchema).max(32) }).strict())
      .max(64),
    policyMaps: z
      .array(
        z
          .object({
            name,
            classes: z
              .array(
                z
                  .object({
                    name,
                    priorityPercent: z.number().int().min(1).max(100).optional(),
                    bandwidthPercent: z.number().int().min(1).max(100).optional(),
                    bandwidthRemainingPercent: z.number().int().min(1).max(100).optional(),
                    mark: z.number().int().min(0).max(63).optional(),
                    policeMbps: z.number().min(0.001).max(100000).optional(),
                    shapeMbps: z.number().min(0.001).max(100000).optional(),
                    childPolicy: name.optional(),
                    queueLimit: z.number().int().min(1).max(256).optional(),
                  })
                  .strict()
              )
              .max(8),
          })
          .strict()
      )
      .max(64),
    attachments: z.array(z.object({ port: idSchema, policy: name, direction:z.enum(['in','out']).optional() }).strict()).max(96),
  })
  .strict();
