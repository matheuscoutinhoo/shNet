import { z } from 'zod';
import { ipv4Schema } from '../schemas';
const id = z.string().min(1).max(80),
  mac = z.string().regex(/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/),
  vni = z.number().int().min(1).max(16777215),
  time = z.number().finite().nonnegative(),
  rt = z.string().regex(/^\d{1,10}:\d{1,10}$/);
export const evpnMacSchema = z
  .object({
    vni,
    mac,
    ip: ipv4Schema.optional(),
    sequence: z.number().int().nonnegative(),
    routeTarget: rt,
    nextHop: ipv4Schema,
    asPath: z.array(z.number().int().min(1).max(4294967294)).max(32),
  })
  .strict();
export const evpnWithdrawSchema = z.object({ vni, mac }).strict();
export const vxlanConfigSchema = z
  .object({
    vni,
    vlan: z.number().int().min(1).max(4094),
    enabled: z.boolean(),
    underlay: id,
    peers: z.array(ipv4Schema).max(32),
    evpn: z.boolean(),
    routeTarget: rt,
    mtu: z.number().int().min(576).max(9000).default(1450),
  })
  .strict();
export const vxlanStateSchema = vxlanConfigSchema
  .extend({
    learned: z.array(z.object({ mac, vtep: ipv4Schema, at: time }).strict()).max(1024),
    local: z
      .array(
        z
          .object({ mac, ip: ipv4Schema.optional(), sequence: z.number().int().nonnegative(), port: id })
          .strict()
      )
      .max(512),
    routes: z.array(evpnMacSchema.extend({ peer: ipv4Schema, learnedAt: time }).strict()).max(512),
    sent: z.number().int().nonnegative(),
    received: z.number().int().nonnegative(),
  })
  .strict();
export const vxlanMessageSchema = z
  .object({
    vni,
    iFlag: z.literal(true),
    frame: z.string().max(100000),
    innerBytes: z.number().int().min(28).max(9000),
  })
  .strict();
