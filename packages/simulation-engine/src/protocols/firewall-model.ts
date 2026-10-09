import { inspectionConfigSchema } from './inspection-model';
import { z } from 'zod';
import { idSchema, ipv4Schema, portNumberSchema, timeSchema, uint32Schema } from '../schemas';

const sessionFields = {
  id: idSchema,
  inside: idSchema,
  outside: idSchema,
  clientIp: ipv4Schema,
  serverIp: ipv4Schema,
  expiresAt: timeSchema,
};
const tcpFirewallSessionSchema = z
  .object({
    ...sessionFields,
    protocol: z.literal('TCP').default('TCP'),
    clientPort: portNumberSchema,
    serverPort: portNumberSchema,
    clientInitial: uint32Schema,
    serverInitial: uint32Schema.optional(),
    clientNext: uint32Schema,
    serverNext: uint32Schema.optional(),
    state: z.enum(['SYN-SENT', 'SYN-RECEIVED', 'ESTABLISHED', 'CLOSING']),
    clientFin: z.boolean(),
    serverFin: z.boolean(),
  })
  .strict();
export const firewallSessionSchema = z.union([
  tcpFirewallSessionSchema,
  z
    .object({
      ...sessionFields,
      protocol: z.literal('UDP'),
      clientPort: portNumberSchema,
      serverPort: portNumberSchema,
      state: z.enum(['UNREPLIED', 'REPLIED']),
    })
    .strict(),
  z
    .object({
      ...sessionFields,
      protocol: z.literal('ICMP'),
      probeId: idSchema,
      state: z.enum(['UNREPLIED', 'REPLIED']),
    })
    .strict(),
]);
export const firewallProtocolSchema = z.enum(['TCP', 'UDP', 'ICMP']);
const zoneName = z.string().regex(/^[a-zA-Z][\w-]{0,31}$/);
export const firewallZonePolicySchema = z
  .object({
    zones: z.array(z.object({ name: zoneName, ports: z.array(idSchema).max(48) }).strict()).max(16),
    rules: z
      .array(
        z
          .object({
            sequence: z.number().int().min(1).max(65535),
            from: zoneName,
            to: zoneName,
            protocol: z.enum(['ip', 'TCP', 'UDP', 'ICMP']),
            destinationPort: portNumberSchema.optional(),
            action: z.enum(['inspect', 'permit', 'deny']),
          })
          .strict()
      )
      .max(128),
  })
  .strict();
export const firewallSchema = z
  .object({
    enabled: z.boolean(),
    application: inspectionConfigSchema.optional(),
    trustedPorts: z.array(idSchema).max(48).default([]),
    zonePolicy: firewallZonePolicySchema.optional(),
    protocols: z.array(firewallProtocolSchema).min(1).max(3).optional(),
    sessions: z.array(firewallSessionSchema).max(1024).default([]),
    dropped: z.number().int().nonnegative().default(0),
  })
  .strict();
export const firewallTimerSchema = z
  .object({
    kind: z.literal('firewall-expire'),
    device: idSchema,
    session: idSchema,
    at: timeSchema,
  })
  .strict();
export type FirewallSession = z.infer<typeof firewallSessionSchema>;
export type TcpFirewallSession = z.infer<typeof tcpFirewallSessionSchema>;
export type FirewallZonePolicy = z.infer<typeof firewallZonePolicySchema>;
