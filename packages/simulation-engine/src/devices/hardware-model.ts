import { z } from 'zod';
import { idSchema } from '../schemas';
export const poePortSchema = z
  .object({
    port: idSchema,
    enabled: z.boolean(),
    standard: z.enum(['af', 'at', 'bt']),
    priority: z.number().int().min(0).max(255),
  })
  .strict();
export const poeSupplySchema = z
  .object({
    enabled: z.boolean(),
    budget: z.number().finite().min(0).max(3000),
    ports: z.array(poePortSchema).max(48),
    allocations: z
      .array(
        z.object({ port: idSchema, device: idSchema, watts: z.number().finite().positive().max(90) }).strict()
      )
      .max(48),
  })
  .strict();
export const poeDeviceSchema = z
  .object({
    required: z.boolean(),
    class: z.number().int().min(0).max(8),
    watts: z.number().finite().positive().max(71),
    requested: z.boolean(),
    powered: z.boolean(),
    source: idSchema.optional(),
  })
  .strict();
export const serialSchema = z
  .object({
    clockRate: z.number().int().min(9600).max(2000000),
    role: z.enum(['DCE', 'DTE']),
    encapsulation: z.literal('hdlc'),
  })
  .strict();
export const consoleSchema = z
  .object({ baud: z.enum(['9600', '19200', '38400', '57600', '115200']) })
  .strict();
export const consoleSessionsSchema = z
  .array(
    z
      .object({
        link: idSchema,
        context: z
          .object({
            mode: z.enum(['user', 'privileged', 'config', 'interface', 'vlan', 'dhcp']),
            port: idSchema.optional(),
            vlan: z.number().int().min(1).max(4094).optional(),
            pool: z.string().max(50).optional(),
          })
          .strict(),
        history: z.array(z.string().max(512)).max(200),
      })
      .strict()
  )
  .max(48);
export const wanHeaderSchema = z
  .object({
    encapsulation: z.literal('hdlc'),
    protocol: z.enum(['IPv4', 'IPv6', 'ARP']),
    fcs: z.number().int().min(0).max(65535),
  })
  .strict();
