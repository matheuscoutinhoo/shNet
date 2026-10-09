import { z } from 'zod';
const id = z.string().min(1).max(80),
  mac = z.string().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i),
  time = z.number().finite().nonnegative();
export const securitySchema = z.enum(['open', 'wpa2-psk', 'wpa3-sae', 'wpa2-enterprise']);
const base = {
  role: z.enum(['ap', 'client']),
  ssid: z.string().min(1).max(32),
  security: securitySchema,
  key: z.string().min(8).max(63).optional(),
  band: z.enum(['2.4', '5']),
  channel: z.number().int().min(1).max(165),
  txPower: z.number().finite().min(0).max(30),
  noise: z.number().finite().min(-110).max(-30),
  attenuation: z.number().finite().min(0).max(40),
  enabled: z.boolean(),
};
function valid(c: { security: string; key?: string; band: string; channel: number }) {
  return (
    (c.security === 'open' || c.security === 'wpa2-enterprise' || !!c.key) &&
    (c.band === '2.4'
      ? c.channel >= 1 && c.channel <= 11
      : [36, 40, 44, 48, 149, 153, 157, 161, 165].includes(c.channel))
  );
}
export const wirelessConfigSchema = z
  .object(base)
  .strict()
  .refine(valid, 'SSID seguro exige chave de 8–63 caracteres; canal deve corresponder à banda.');
const association = z
  .object({
    bssid: mac,
    token: id,
    nonce: id,
    pmk: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    eapExpires: time.optional(),
    txSequence: z.number().int().nonnegative().optional(),
    receivedSequences: z.array(z.number().int().positive()).max(64).optional(),
    saeNonce: id.optional(),
    lastSeen: time,
    startedAt: time,
  })
  .strict();
const peer = z
  .object({
    mac,
    token: id,
    nonce: id,
    pmk: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    eapExpires: time.optional(),
    txSequence: z.number().int().nonnegative().optional(),
    receivedSequences: z.array(z.number().int().positive()).max(64).optional(),
    saeNonce: id.optional(),
    phase: z.enum(['challenged', 'confirmed', 'associated']),
    lastSeen: time,
  })
  .strict();
export const wirelessStateSchema = z
  .object({
    ...base,
    port: id,
    token: id,
    tickAt: time,
    phase: z.enum(['disabled', 'scanning', 'authenticating', 'associating', 'associated', 'failed', 'ap']),
    association: association.optional(),
    peers: z.array(peer).max(32),
    seen: z
      .array(
        z
          .object({
            bssid: mac,
            ssid: z.string().min(1).max(32),
            security: securitySchema,
            signal: z.number().finite(),
            at: time,
          })
          .strict()
      )
      .max(32),
    attempts: z.number().int().min(0).max(4),
    retryAt: time,
  })
  .strict()
  .refine(valid, 'Configuração wireless inválida.');
export const wifiPduSchema = z
  .object({
    kind: z.enum([
      'eap',
      'beacon',
      'auth-request',
      'sae-commit',
      'sae-confirm',
      'auth-response',
      'authorized',
      'key1',
      'key2',
      'key3',
      'key4',
      'association-request',
      'association-response',
      'reject',
      'keepalive',
      'deauth',
    ]),
    ssid: z.string().min(1).max(32),
    security: securitySchema,
    token: id.optional(),
    nonce: id.optional(),
    proof: z
      .string()
      .regex(/^(?:[a-f0-9]{8}|[a-f0-9]{64})$/)
      .optional(),
    eap: z
      .string()
      .max(2000)
      .regex(/^(?:[a-f0-9]{2})+$/)
      .optional(),
    accepted: z.boolean().optional(),
  })
  .strict()
  .superRefine((p, c) => {
    if (p.kind !== 'beacon' && p.kind !== 'deauth' && !p.token)
      c.addIssue({ code: 'custom', message: 'PDU Wi-Fi exige token de negociação.' });
    if (['key1', 'key2', 'key3', 'sae-commit', 'sae-confirm'].includes(p.kind) && !p.nonce)
      c.addIssue({ code: 'custom', message: 'PDU Wi-Fi exige nonce.' });
    if (['key2', 'key3', 'sae-commit', 'sae-confirm'].includes(p.kind) && !p.proof)
      c.addIssue({ code: 'custom', message: 'PDU de chave exige prova.' });
  });
export const wirelessTimerSchema = z
  .object({ kind: z.literal('wireless-tick'), device: id, token: id })
  .strict();
export type WirelessConfig = z.infer<typeof wirelessConfigSchema>;

export const secureWifiSchema = z
  .object({
    token: id,
    sequence: z.number().int().positive(),
    cipher: z.enum(['CCMP-model', 'GCMP-model', 'AES-GCM']),
    innerBytes: z.number().int().min(28).max(65535),
    body: z
      .string()
      .max(65536)
      .regex(/^(?:[a-f0-9]{2})*$/),
    tag: z.string().regex(/^(?:[a-f0-9]{8}|[a-f0-9]{32})$/),
  })
  .strict();
