import { z } from 'zod';

export const ipv4Schema = z
  .string()
  .regex(/^(\d{1,3}\.){3}\d{1,3}$/)
  .refine(
    (value) => value.split('.').every((part) => Number(part) <= 255 && String(Number(part)) === part),
    'IPv4 inválido'
  );
export const idSchema = z.string().min(1).max(80);
export const uint32Schema = z.number().int().min(0).max(4294967295);
export const portNumberSchema = z.number().int().min(1).max(65535);
export const timeSchema = z.number().finite().nonnegative();
export const routeEntrySchema = z
  .object({
    network: ipv4Schema,
    prefix: z.number().int().min(0).max(32),
    nextHop: ipv4Schema,
    metric: z.number().int().min(0).max(65535),
    distance: z.number().int().min(1).max(255).optional(),
    track: z.number().int().min(1).max(1000).optional(),
    port: idSchema.optional(),
    vrf: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,32}$/)
      .optional(),
    // "ip route ... Null0": matching packets are discarded (summary or blackhole route).
    discard: z.literal(true).optional(),
    // "permanent": stays in the routing table even when the exit interface or next hop is lost.
    permanent: z.literal(true).optional(),
    name: z
      .string()
      .regex(/^[\x21-\x7e]{1,64}$/)
      .optional(),
    tag: uint32Schema.optional(),
  })
  .strict()
  .refine((route) => !route.discard || (!route.port && route.nextHop === '0.0.0.0'), {
    message: 'Null0 route cannot have an exit interface or next hop.',
  })
  .refine((route) => !(route.permanent && route.track), {
    message: 'A static route is either permanent or tracked.',
  });
