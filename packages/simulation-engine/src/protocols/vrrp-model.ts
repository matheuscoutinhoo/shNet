import { z } from 'zod';
import { ipv4Schema } from '../schemas';

export const VRRP = { ip: '224.0.0.18', mac: '01:00:5e:00:00:12' } as const;
const id = z.string().min(1).max(80);
const time = z.number().finite().nonnegative();
const interval = z.number().int().min(100).max(10000).multipleOf(10);
export const vrrpTrackSchema = z
  .object({
    port: id.optional(),
    route: ipv4Schema.optional(),
    decrement: z.number().int().min(1).max(254),
  })
  .strict()
  .refine((t) => (t.port === undefined) !== (t.route === undefined), 'Tracking exige interface ou rota.');
export const vrrpGroupConfigSchema = z
  .object({
    port: id,
    vrid: z.number().int().min(1).max(255),
    vip: ipv4Schema,
    priority: z.number().int().min(1).max(255).default(100),
    preempt: z.boolean().default(true),
    advertMs: interval.default(1000),
    track: z.array(vrrpTrackSchema).max(8).optional(),
  })
  .strict();
export const vrrpConfigSchema = z
  .object({
    enabled: z.boolean(),
    groups: z.array(vrrpGroupConfigSchema).max(32),
  })
  .strict();
export const vrrpGroupSchema = vrrpGroupConfigSchema
  .extend({
    token: id,
    state: z.enum(['INIT', 'BACKUP', 'ACTIVE']),
    changedAt: time,
    activeAdvertMs: interval,
    activeIp: ipv4Schema.optional(),
    activePriority: z.number().int().min(1).max(255).optional(),
    lastAdvertAt: time.optional(),
    downAt: time.optional(),
    advertAt: time.optional(),
    sent: z.number().int().nonnegative(),
    received: z.number().int().nonnegative(),
    effectivePriority: z.number().int().min(1).max(255).optional(),
  })
  .strict();
export const vrrpStateSchema = z
  .object({
    enabled: z.boolean(),
    groups: z.array(vrrpGroupSchema).max(32),
  })
  .strict();
export const vrrpPacketSchema = z
  .object({
    src: ipv4Schema,
    dst: ipv4Schema,
    ttl: z.number().int().min(0).max(255),
    dscp: z.number().int().min(0).max(63).optional(),
    protocol: z.literal('VRRP'),
    version: z.literal(3),
    vrid: z.number().int().min(1).max(255),
    vip: ipv4Schema,
    priority: z.number().int().min(0).max(255),
    advertMs: interval,
    bytes: z.literal(32),
  })
  .strict();
export const vrrpTimerSchema = z
  .object({
    kind: z.literal('vrrp-timer'),
    device: id,
    port: id,
    vrid: z.number().int().min(1).max(255),
    token: id,
    timer: z.enum(['advertise', 'active-down']),
    at: time,
  })
  .strict();
export type VrrpGroupConfig = z.infer<typeof vrrpGroupConfigSchema>;
export type VrrpGroup = z.infer<typeof vrrpGroupSchema>;
export type VrrpPacket = z.infer<typeof vrrpPacketSchema>;
export type VrrpTimer = z.infer<typeof vrrpTimerSchema>;
export function vrrpMac(vrid: number) {
  return '00:00:5e:00:01:' + vrid.toString(16).padStart(2, '0');
}
