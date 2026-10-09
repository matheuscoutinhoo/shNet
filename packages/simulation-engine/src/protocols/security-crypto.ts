import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { gcm } from '@noble/ciphers/aes.js';
import { z } from 'zod';
const hex = (bytes: number) => z.string().regex(new RegExp(`^[a-f0-9]{${bytes * 2}}$`));
export const certificateSchema = z
  .object({
    serial: z.string().min(1).max(80),
    subject: z.string().min(1).max(128),
    issuer: z.string().min(1).max(128),
    names: z.array(z.string().min(1).max(128)).max(16),
    publicKey: hex(32),
    usage: z.enum(['ca', 'server', 'client']),
    notBefore: z.number().int().nonnegative(),
    notAfter: z.number().int().positive(),
    signature: hex(64),
  })
  .strict();
export type Certificate = z.infer<typeof certificateSchema>;
export const identitySchema = z.object({ seed: hex(32), certificate: certificateSchema }).strict();
export const trustSchema = z
  .array(z.object({ name: z.string().min(1).max(128), publicKey: hex(32) }).strict())
  .max(16);
const text = (s: string) => new TextEncoder().encode(s);
export const hashHex = (s: string) => bytesToHex(sha256(text(s)));
export const hmacHex = (key: string, data: string) => bytesToHex(hmac(sha256, text(key), text(data)));
export const publicKey = (seed: string) => bytesToHex(ed25519.getPublicKey(hexToBytes(seed)));
export function issueCertificate(seed: string, fields: Omit<Certificate, 'signature'>): Certificate {
  fields = certificateSchema.omit({ signature: true }).parse(fields);
  if (fields.notAfter <= fields.notBefore) throw new Error('Validade de certificado inválida.');
  const signature = bytesToHex(ed25519.sign(text(JSON.stringify(fields)), hexToBytes(seed)));
  return certificateSchema.parse({ ...fields, signature });
}
export function verifyCertificate(
  c: Certificate,
  trust: z.infer<typeof trustSchema>,
  clock: number,
  usage: 'server' | 'client',
  name?: string
) {
  const authority = trust.find((a) => a.name === c.issuer),
    now = Math.floor(clock / 1000);
  if (
    !authority ||
    c.usage !== usage ||
    c.notBefore > now ||
    c.notAfter <= now ||
    (name && !c.names.includes(name))
  )
    return false;
  const { signature, ...fields } = certificateSchema.parse(c);
  try {
    return ed25519.verify(
      hexToBytes(signature),
      text(JSON.stringify(fields)),
      hexToBytes(authority.publicKey)
    );
  } catch {
    return false;
  }
}
export const signText = (seed: string, data: string) =>
  bytesToHex(ed25519.sign(text(data), hexToBytes(seed)));
export function verifyText(key: string, data: string, signature: string) {
  try {
    return ed25519.verify(hexToBytes(signature), text(data), hexToBytes(key));
  } catch {
    return false;
  }
}
export const keyShare = (secret: string) => bytesToHex(x25519.getPublicKey(hexToBytes(secret)));
export function deriveSecret(secret: string, remoteKey: string, salt: string, context: string) {
  return bytesToHex(
    hkdf(
      sha256,
      x25519.getSharedSecret(hexToBytes(secret), hexToBytes(remoteKey)),
      text(salt),
      text(context),
      32
    )
  );
}
function nonce(direction: number, sequence: number) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Sequência criptográfica inválida.');
  const n = new Uint8Array(12);
  n[0] = direction;
  let value = BigInt(sequence);
  for (let i = 11; i >= 4; i--) {
    n[i] = Number(value & 255n);
    value >>= 8n;
  }
  return n;
}
export function sealRecord(
  key: string,
  direction: number,
  sequence: number,
  data: string,
  associated: string
) {
  return bytesToHex(gcm(hexToBytes(key), nonce(direction, sequence), text(associated)).encrypt(text(data)));
}
export function openRecord(
  key: string,
  direction: number,
  sequence: number,
  cipher: string,
  associated: string
) {
  if (cipher.length > 131072) throw new Error('Registro criptográfico excede limite.');
  return new TextDecoder('utf-8', { fatal: true }).decode(
    gcm(hexToBytes(key), nonce(direction, sequence), text(associated)).decrypt(hexToBytes(cipher))
  );
}
