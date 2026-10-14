import { z } from 'zod';
import { idSchema, ipv4Schema, routeEntrySchema } from './schemas';
import { firewallSchema } from './protocols/firewall-model';
export const portConfigurationPatchSchema = z
  .object({
    port: idSchema,
    adminUp: z.boolean().optional(),
    mtu: z.number().int().min(576).max(9216).optional(),
    description: z.string().max(160).optional(),
    ip: ipv4Schema.nullable().optional(),
    prefix: z.number().int().min(0).max(32).nullable().optional(),
    gateway: ipv4Schema.nullable().optional(),
    dns: z.array(ipv4Schema).max(8).nullable().optional(),
    mode: z.enum(['access', 'trunk', 'routed']).optional(),
    accessVlan: z.number().int().min(1).max(4094).optional(),
    nativeVlan: z.number().int().min(1).max(4094).optional(),
    allowedVlans: z.array(z.number().int().min(1).max(4094)).max(4094).optional(),
  })
  .strict();
export const configurationPatchSchema = z
  .array(
    z
      .object({
        device: idSchema,
        ports: z.array(portConfigurationPatchSchema).min(1).max(48).optional(),
        routes: z.array(routeEntrySchema).max(256).optional(),
        firewall: firewallSchema.omit({ sessions: true, dropped: true }).nullable().optional(),
      })
      .strict()
  )
  .min(1)
  .max(2000);
export type ConfigurationPatch = z.infer<typeof configurationPatchSchema>;
