import { inspectionConfigSchema } from './inspection-model';
import { z } from 'zod';
import { idSchema, portNumberSchema, timeSchema, uint32Schema } from '../schemas';
import { transportAddressSchema } from './tcp-model';

const sessionFields = {
  id: idSchema,
  inside: idSchema,
  outside: idSchema,
  clientIp: transportAddressSchema,
  serverIp: transportAddressSchema,
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
            // Also requires a permit in every listed ACL (IOS "match access-group name ACL").
            acls: z
              .array(z.string().regex(/^[\w-]{1,32}$/))
              .min(1)
              .max(4)
              .optional(),
            action: z.enum(['inspect', 'permit', 'deny']),
            // Origin of a rule compiled from the IOS zone-based firewall, and its "drop log".
            zonePair: z
              .string()
              .regex(/^[a-zA-Z0-9][\w-]{0,31}$/)
              .optional(),
            className: z
              .string()
              .regex(/^[a-zA-Z0-9][\w-]{0,31}$/)
              .optional(),
            log: z.boolean().optional(),
          })
          .strict()
      )
      .max(512),
  })
  .strict();
const zbfName = z.string().regex(/^[a-zA-Z0-9][\w-]{0,31}$/);
/** Native IOS zone-based firewall configuration; compiled into the firewall zone policy. */
export const zbfSchema = z
  .object({
    zones: z
      .array(
        z
          .object({
            name: zoneName,
            description: z.string().max(200).optional(),
          })
          .strict()
      )
      .max(16),
    classMaps: z
      .array(
        z
          .object({
            name: zbfName,
            matchAll: z.boolean(),
            matches: z
              .array(
                z.union([
                  z.object({ protocol: z.string().regex(/^[a-z0-9-]{2,20}$/) }).strict(),
                  z.object({ acl: z.string().regex(/^[\w-]{1,32}$/) }).strict(),
                  z.object({ classMap: zbfName }).strict(),
                ])
              )
              .max(32),
          })
          .strict()
      )
      .max(64),
    policyMaps: z
      .array(
        z
          .object({
            name: zbfName,
            classes: z
              .array(
                z
                  .object({
                    className: zbfName,
                    action: z.enum(['inspect', 'pass', 'drop']).optional(),
                    log: z.boolean().optional(),
                  })
                  .strict()
              )
              .max(32),
          })
          .strict()
      )
      .max(32),
    zonePairs: z
      .array(
        z
          .object({
            name: zbfName,
            source: zoneName,
            destination: zoneName,
            policy: zbfName.optional(),
          })
          .strict()
      )
      .max(32),
  })
  .strict();
export type ZbfConfig = z.infer<typeof zbfSchema>;
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
