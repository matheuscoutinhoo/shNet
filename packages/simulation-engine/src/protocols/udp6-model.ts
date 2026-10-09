import { z } from 'zod';
import { dnsMessageSchema } from './dns-model';
import { dnsMessageLength } from './dns-wire';
import { idSchema, portNumberSchema, timeSchema } from '../schemas';
import { dhcp6MessageSchema, dhcp6RelayMessageSchema } from './dhcp6-model';
import { tcpBytes } from './tcp-model';
import { ipv6Schema } from './ipv6-address';
import { encodeDhcp6 } from '../wire/dhcp6-codec';
export const udp6PayloadSchema = z.discriminatedUnion('protocol', [
  z
    .object({ protocol: z.literal('RAW'), id: idSchema, data: z.string().max(8192), reply: z.boolean() })
    .strict(),
  z.object({ protocol: z.literal('DNS'), message: dnsMessageSchema }).strict(),
  z.object({ protocol: z.literal('DHCPv6'), message: dhcp6MessageSchema }).strict(),
  z.object({ protocol: z.literal('DHCPv6-RELAY'), relay: dhcp6RelayMessageSchema }).strict(),
]);
export const udp6DatagramSchema = z
  .object({ sourcePort: portNumberSchema, destinationPort: portNumberSchema, payload: udp6PayloadSchema })
  .strict();
export const udp6ServiceSchema = z
  .object({ port: portNumberSchema, kind: z.literal('echo'), enabled: z.boolean() })
  .strict();
export const udp6RecordSchema = z
  .object({
    id: idSchema,
    source: ipv6Schema,
    target: ipv6Schema,
    sourcePort: portNumberSchema,
    destinationPort: portNumberSchema,
    data: z.string().max(8192),
    reply: z.boolean(),
    at: timeSchema,
    port: idSchema,
  })
  .strict();
export const udp6PayloadBytes = (p: z.infer<typeof udp6PayloadSchema>): number =>
  p.protocol === 'DNS'
    ? dnsMessageLength(p.message)
    : p.protocol === 'RAW'
      ? tcpBytes(p.data)
      : encodeDhcp6(p.protocol === 'DHCPv6' ? p.message : p.relay).length;
