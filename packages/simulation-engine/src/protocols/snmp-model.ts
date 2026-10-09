import { z } from 'zod';
import { idSchema, ipv4Schema, portNumberSchema, timeSchema } from '../schemas';
export const oidSchema = z
  .string()
  .min(5)
  .max(128)
  .regex(/^[0-2](?:\.(?:0|[1-9]\d*)){2,}$/)
  .refine(
    (oid) =>
      oid.split('.').every((arc) => Number(arc) <= 4294967295) &&
      (oid.startsWith('2.') || Number(oid.split('.')[1]) <= 39),
    'OID inválido'
  );
const communitySchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-zA-Z0-9_-]+$/);
const requestIdSchema = z.number().int().min(0).max(2147483647);
export const snmpVarbindSchema = z.discriminatedUnion('type', [
  z.object({ oid: oidSchema, type: z.literal('OctetString'), value: z.string().max(300) }).strict(),
  z
    .object({
      oid: oidSchema,
      type: z.enum(['Integer', 'TimeTicks', 'Gauge32', 'Counter64']),
      value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .strict()
    .refine(
      (entry) =>
        entry.type === 'Counter64' || entry.value <= (entry.type === 'Integer' ? 2147483647 : 4294967295),
      'Valor SNMP fora do tipo declarado'
    ),
  z.object({ oid: oidSchema, type: z.enum(['noSuchObject', 'endOfMibView']) }).strict(),
]);
export const snmpMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.enum(['get', 'get-next']),
      requestId: requestIdSchema,
      community: communitySchema,
      oids: z.array(oidSchema).min(1).max(16),
    })
    .strict(),
  z
    .object({
      type: z.literal('response'),
      requestId: requestIdSchema,
      community: communitySchema,
      errorStatus: z.enum(['noError', 'tooBig']),
      varbinds: z.array(snmpVarbindSchema).max(16),
    })
    .strict(),
]);
export const snmpAgentSchema = z
  .object({ enabled: z.boolean(), community: communitySchema, startedAt: timeSchema })
  .strict();
export const snmpQuerySchema = z
  .object({
    id: idSchema,
    requestId: requestIdSchema,
    community: communitySchema,
    server: ipv4Schema,
    port: idSchema,
    sourceIp: ipv4Schema,
    sourcePort: portNumberSchema,
    operation: z.enum(['get', 'get-next']),
    oids: z.array(oidSchema).min(1).max(16),
    startedAt: timeSchema,
    deadline: timeSchema,
    attempts: z.number().int().min(1).max(2),
    status: z.enum(['pending', 'success', 'tooBig', 'timeout', 'cancelled']),
    varbinds: z.array(snmpVarbindSchema).max(16),
    elapsed: timeSchema.optional(),
  })
  .strict();
export const snmpTimerSchema = z
  .object({
    kind: z.literal('snmp-timeout'),
    device: idSchema,
    queryId: idSchema,
    attempt: z.number().int().min(1).max(2),
  })
  .strict();
export type SnmpMessage = z.infer<typeof snmpMessageSchema>;
export type SnmpQuery = z.infer<typeof snmpQuerySchema>;
export type SnmpVarbind = z.infer<typeof snmpVarbindSchema>;
export const SNMP = { port: 161, timeout: 5000, attempts: 2 } as const;
