import { z } from 'zod';
import { idSchema, ipv4Schema, timeSchema } from '../schemas';

const mac = z.string().regex(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i);
export const discoveryConfigSchema = z
  .object({
    cdp: z.boolean().default(true),
    lldp: z.boolean().default(false),
    cdpTimer: z.number().int().min(5).max(254).default(60),
    cdpHoldtime: z.number().int().min(10).max(255).default(180),
    lldpTimer: z.number().int().min(5).max(65534).default(30),
    lldpHoldtime: z.number().int().min(1).max(65535).default(120),
  })
  .strict();
export const discoveryMessageSchema = z
  .object({
    protocol: z.enum(['CDP', 'LLDP']),
    chassisId: mac,
    deviceId: z.string().min(1).max(64),
    portId: z.string().min(1).max(64),
    platform: z.string().max(80),
    capabilities: z.array(z.enum(['Router', 'Switch', 'Host', 'Phone'])).max(4),
    addresses: z.array(ipv4Schema).max(8),
    ttl: z.number().int().min(0).max(65535),
    voiceVlan: z.number().int().min(1).max(4094).optional(),
    voiceVlanQuery: z.boolean().optional(),
  })
  .strict();
export const discoveryNeighborSchema = discoveryMessageSchema
  .extend({
    port: idSchema,
    receivedAt: timeSchema,
    expiresAt: timeSchema,
  })
  .strict();
export const discoveryStateSchema = discoveryConfigSchema
  .extend({
    token: idSchema,
    tickAt: timeSchema.optional(),
    nextCdp: timeSchema,
    nextLldp: timeSchema,
    neighbors: z.array(discoveryNeighborSchema).max(512),
    voiceSignature: z.string().max(8192).optional(),
  })
  .strict();
export const discoveryTimerSchema = z
  .object({ kind: z.literal('discovery-tick'), device: idSchema, token: idSchema })
  .strict();
export type DiscoveryConfig = z.infer<typeof discoveryConfigSchema>;
export type DiscoveryMessage = z.infer<typeof discoveryMessageSchema>;
