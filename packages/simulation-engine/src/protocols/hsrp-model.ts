import { z } from 'zod';
import { idSchema, ipv4Schema, timeSchema } from '../schemas';
const groupId = z.number().int().min(0).max(4095);
const version = z.union([z.literal(1), z.literal(2)]);
const state = z.enum(['INIT', 'LISTEN', 'SPEAK', 'STANDBY', 'ACTIVE']);
export const hsrpGroupConfigSchema = z
  .object({
    port: idSchema,
    group: groupId,
    version: version.default(1),
    vip: ipv4Schema.optional(),
    priority: z.number().int().min(0).max(255).default(100),
    preempt: z.boolean().default(false),
    objectTrack: z
      .array(
        z
          .object({
            object: z.number().int().min(1).max(1000),
            decrement: z.number().int().min(1).max(255).default(10),
          })
          .strict()
      )
      .max(16)
      .default([]),
    helloMs: z.number().int().min(15).max(254000).default(3000),
    holdMs: z.number().int().min(50).max(255000).default(10000),
    track: z
      .array(z.object({ port: idSchema, decrement: z.number().int().min(1).max(255).default(10) }).strict())
      .max(16)
      .default([]),
  })
  .strict();
export const hsrpConfigSchema = z.object({ groups: z.array(hsrpGroupConfigSchema).max(64) }).strict();
export const hsrpMessageSchema = z
  .object({
    version,
    group: groupId,
    opcode: z.enum(['hello', 'coup', 'resign']),
    state: z.enum(['SPEAK', 'STANDBY', 'ACTIVE']),
    priority: z.number().int().min(0).max(255),
    helloMs: z.number().int().min(15).max(254000),
    holdMs: z.number().int().min(50).max(255000),
    vip: ipv4Schema,
  })
  .strict();
export const hsrpGroupSchema = hsrpGroupConfigSchema
  .extend({
    token: idSchema,
    state,
    changedAt: timeSchema,
    startedAt: timeSchema,
    effectivePriority: z.number().int().min(0).max(255),
    tickAt: timeSchema.optional(),
    nextHello: timeSchema,
    activeDeadline: timeSchema,
    standbyDeadline: timeSchema,
    peers: z
      .array(
        z
          .object({
            ip: ipv4Schema,
            state,
            priority: z.number().int().min(0).max(255),
            expiresAt: timeSchema,
          })
          .strict()
      )
      .max(32),
    sent: z.number().int().nonnegative(),
    received: z.number().int().nonnegative(),
  })
  .strict();
export const hsrpStateSchema = z.object({ groups: z.array(hsrpGroupSchema).max(64) }).strict();
export const hsrpTimerSchema = z
  .object({ kind: z.literal('hsrp-tick'), device: idSchema, token: idSchema })
  .strict();
export type HsrpConfig = z.infer<typeof hsrpGroupConfigSchema>;
export type HsrpGroup = z.infer<typeof hsrpGroupSchema>;
export type HsrpMessage = z.infer<typeof hsrpMessageSchema>;
export const hsrpMulticast = (v: 1 | 2) =>
  v === 1 ? { ip: '224.0.0.2', mac: '01:00:5e:00:00:02' } : { ip: '224.0.0.102', mac: '01:00:5e:00:00:66' };
export const hsrpMac = (g: Pick<HsrpConfig, 'version' | 'group'>) =>
  g.version === 1
    ? '00:00:0c:07:ac:' + g.group.toString(16).padStart(2, '0')
    : '00:00:0c:9f:' +
      ((0xf000 | g.group) >>> 8).toString(16).padStart(2, '0') +
      ':' +
      (g.group & 255).toString(16).padStart(2, '0');
