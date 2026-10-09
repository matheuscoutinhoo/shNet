import { z } from 'zod';
import { ipv4Schema } from '../schemas';
const id = z.string().min(1).max(80),
  vlan = z.number().int().min(1).max(4094);
const mac = z
  .string()
  .regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i)
  .transform((v) => v.toLowerCase());
const binding = z.object({ vlan, port: id, mac, ip: ipv4Schema }).strict();
export const dhcpSnoopingConfigSchema = z
  .object({
    enabled: z.boolean(),
    vlans: z.array(vlan).max(256),
    trustedPorts: z.array(id).max(48),
    sourceGuard: z.boolean().default(false),
    arpInspection: z.boolean().default(false),
    staticBindings: z.array(binding).max(256).default([]),
  })
  .strict();
export const dhcpSnoopingSchema = dhcpSnoopingConfigSchema
  .extend({
    dropped: z.number().int().nonnegative(),
    bindings: z
      .array(binding.extend({ expiresAt: z.number().finite().nonnegative(), server: ipv4Schema }).strict())
      .max(1024),
    requests: z
      .array(
        z
          .object({
            vlan,
            port: id,
            mac,
            transaction: id,
            server: ipv4Schema.optional(),
            ip: ipv4Schema.optional(),
            relay: ipv4Schema.optional(),
            expiresAt: z.number().finite().nonnegative(),
          })
          .strict()
      )
      .max(256),
  })
  .strict();
