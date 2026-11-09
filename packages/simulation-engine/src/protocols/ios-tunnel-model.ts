import { z } from 'zod';
import { idSchema, ipv4Schema, timeSchema } from '../schemas';

const hex = (bytes: number) => z.string().regex(new RegExp(`^[a-f0-9]{${bytes * 2}}$`));
const name = z.string().regex(/^[\w.+@-]{1,64}$/);
const secret = z.string().min(1).max(128);

/** IKE/IPsec security association protecting one IOS tunnel interface. */
export const tunnelSaSchema = z
  .object({
    phase: z.enum(['init', 'auth', 'established']),
    version: z.union([z.literal(1), z.literal(2)]),
    initiator: z.boolean(),
    peer: ipv4Schema,
    spi: hex(8),
    peerSpi: hex(8).optional(),
    secret: hex(32),
    master: hex(32).optional(),
    // ESP SPIs: inbound is chosen locally, outbound is the peer's inbound SPI.
    inSpi: hex(4),
    outSpi: hex(4).optional(),
    proposal: z.string().max(80).optional(),
    transform: z.string().max(80).optional(),
    startedAt: timeSchema,
    establishedAt: timeSchema.optional(),
    expiresAt: timeSchema.optional(),
    txSequence: z.number().int().nonnegative(),
    rxSequences: z.array(z.number().int().positive()).max(64),
    encaps: z.number().int().nonnegative(),
    decaps: z.number().int().nonnegative(),
    lastError: z.string().max(120).optional(),
  })
  .strict();
/** IOS "interface TunnelN": point-to-point GRE (default) or an IPsec VTI ("tunnel mode ipsec ipv4"). */
export const iosTunnelSchema = z
  .object({
    source: z.string().max(64).optional(),
    destination: ipv4Schema.optional(),
    mode: z.enum(['gre', 'ipsec']),
    key: z.number().int().min(0).max(4294967295).optional(),
    keepalive: z
      .object({ periodS: z.number().int().min(1).max(32767), retries: z.number().int().min(1).max(255) })
      .strict()
      .optional(),
    protection: name.optional(),
    // Line protocol, with the reason IOS would give for it being down.
    status: z.enum(['up', 'down']),
    reason: z.string().max(120).optional(),
    keepaliveMisses: z.number().int().min(0).max(255).optional(),
    keepaliveAt: timeSchema.optional(),
    token: idSchema,
    tickAt: timeSchema.optional(),
    // Established SA carrying traffic, and an IKE exchange in progress (first SA or rekey).
    sa: tunnelSaSchema.optional(),
    negotiation: tunnelSaSchema.optional(),
    // After a rekey the old inbound SA still decrypts in-flight packets for a moment.
    previous: z
      .object({ inSpi: hex(4), master: hex(32), until: timeSchema })
      .strict()
      .optional(),
  })
  .strict();
export type IosTunnel = z.infer<typeof iosTunnelSchema>;
export type TunnelSa = z.infer<typeof tunnelSaSchema>;

const ipv4Mask = ipv4Schema;
export const ISAKMP_ENCRYPTION = ['des', '3des', 'aes', 'aes 192', 'aes 256'] as const;
export const ISAKMP_HASH = ['md5', 'sha', 'sha256', 'sha384', 'sha512'] as const;
export const ESP_TRANSFORMS = [
  'esp-des',
  'esp-3des',
  'esp-aes',
  'esp-aes 192',
  'esp-aes 256',
  'esp-gcm',
  'esp-gcm 256',
  'esp-md5-hmac',
  'esp-sha-hmac',
  'esp-sha256-hmac',
  'esp-sha384-hmac',
  'esp-sha512-hmac',
  'esp-null',
] as const;
/** Global "crypto ..." configuration: ISAKMP/IKEv2 policies and keys, transform sets, IPsec profiles. */
export const cryptoConfigSchema = z
  .object({
    isakmpPolicies: z
      .array(
        z
          .object({
            priority: z.number().int().min(1).max(10000),
            encryption: z.enum(ISAKMP_ENCRYPTION),
            hash: z.enum(ISAKMP_HASH),
            authentication: z.enum(['pre-share', 'rsa-sig']),
            group: z.number().int().min(1).max(24),
            lifetimeS: z.number().int().min(60).max(86400),
          })
          .strict()
      )
      .max(16),
    isakmpKeys: z.array(z.object({ address: ipv4Schema, mask: ipv4Mask, key: secret }).strict()).max(64),
    transformSets: z
      .array(
        z
          .object({
            name,
            transforms: z.array(z.enum(ESP_TRANSFORMS)).min(1).max(3),
            mode: z.enum(['tunnel', 'transport']),
          })
          .strict()
      )
      .max(16),
    ipsecProfiles: z
      .array(
        z
          .object({
            name,
            transformSets: z.array(name).max(6),
            ikev2Profile: name.optional(),
            pfs: z.number().int().min(1).max(24).optional(),
            lifetimeS: z.number().int().min(120).max(86400).optional(),
          })
          .strict()
      )
      .max(16),
    ikev2Proposals: z
      .array(
        z
          .object({
            name,
            encryption: z.array(z.string().regex(/^[\w-]{2,24}$/)).max(4),
            integrity: z.array(z.string().regex(/^[\w-]{2,24}$/)).max(4),
            groups: z.array(z.number().int().min(1).max(32)).max(4),
          })
          .strict()
      )
      .max(8),
    ikev2Policies: z.array(z.object({ name, proposals: z.array(name).max(8) }).strict()).max(8),
    ikev2Keyrings: z
      .array(
        z
          .object({
            name,
            peers: z
              .array(
                z
                  .object({
                    name,
                    address: ipv4Schema.optional(),
                    mask: ipv4Mask.optional(),
                    key: secret.optional(),
                  })
                  .strict()
              )
              .max(64),
          })
          .strict()
      )
      .max(8),
    ikev2Profiles: z
      .array(
        z
          .object({
            name,
            remote: z.array(z.object({ address: ipv4Schema, mask: ipv4Mask }).strict()).max(16),
            keyring: name.optional(),
            localAuth: z.literal('pre-share').optional(),
            remoteAuth: z.literal('pre-share').optional(),
          })
          .strict()
      )
      .max(8),
  })
  .strict();
export type CryptoConfig = z.infer<typeof cryptoConfigSchema>;
export const emptyCrypto = (): CryptoConfig => ({
  isakmpPolicies: [],
  isakmpKeys: [],
  transformSets: [],
  ipsecProfiles: [],
  ikev2Proposals: [],
  ikev2Policies: [],
  ikev2Keyrings: [],
  ikev2Profiles: [],
});

const ipHeader = {
  src: ipv4Schema,
  dst: ipv4Schema,
  ttl: z.number().int().min(0).max(255),
  df: z.boolean().optional(),
  dscp: z.number().int().min(0).max(63).optional(),
  bytes: z.number().int().min(28).max(65535),
};
/** IP protocol 47. The passenger IPv4 packet is serialized like an MPLS payload. */
export const grePacketSchema = z
  .object({
    ...ipHeader,
    protocol: z.literal('GRE'),
    key: z.number().int().min(0).max(4294967295).optional(),
    // GRE keepalive: the inner packet is addressed back to the sender.
    keepalive: z.enum(['request', 'reply']).optional(),
    inner: z.string().max(140000),
  })
  .strict();
/** IP protocol 50: an authenticated, encrypted passenger packet. */
export const espPacketSchema = z
  .object({
    ...ipHeader,
    protocol: z.literal('ESP'),
    spi: hex(4),
    sequence: z.number().int().positive(),
    body: z
      .string()
      .regex(/^(?:[a-f0-9]{2})*$/)
      .max(280000),
    tag: hex(16),
  })
  .strict();
const ikeHeader = {
  version: z.union([z.literal(1), z.literal(2)]),
  spi: hex(8),
  peerSpi: hex(8).optional(),
};
/** IKE (UDP/500): proposal exchange with a key share, then mutual pre-shared-key authentication. */
export const ikeMessageSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...ikeHeader,
      kind: z.literal('init'),
      proposals: z.array(z.string().max(80)).min(1).max(16),
      transforms: z.array(z.string().max(80)).min(1).max(6),
      keyShare: hex(32),
    })
    .strict(),
  z
    .object({
      ...ikeHeader,
      kind: z.literal('init-reply'),
      proposal: z.string().max(80),
      transform: z.string().max(80),
      keyShare: hex(32),
    })
    .strict(),
  z.object({ ...ikeHeader, kind: z.literal('auth'), proof: hex(32), childSpi: hex(4) }).strict(),
  z.object({ ...ikeHeader, kind: z.literal('auth-reply'), proof: hex(32), childSpi: hex(4) }).strict(),
  z
    .object({
      ...ikeHeader,
      kind: z.literal('notify'),
      error: z.enum(['NO_PROPOSAL_CHOSEN', 'AUTHENTICATION_FAILED', 'NO_PEER_CONFIGURATION']),
    })
    .strict(),
]);
export type IkeMessage = z.infer<typeof ikeMessageSchema>;
