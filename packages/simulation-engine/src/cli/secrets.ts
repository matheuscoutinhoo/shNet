import type { Device } from '../model';

// Cisco type 7 ("service password-encryption"): a reversible XOR with a fixed key stream. It only
// keeps secrets from being read over a shoulder; like IOS, the router can always recover them.
const XLAT = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87';
const TYPE7 = /^\d{2}(?:[0-9A-Fa-f]{2})+$/;
export function type7Encode(plain: string) {
  const bytes = new TextEncoder().encode(plain);
  // IOS picks a random seed; a stable one keeps show running-config deterministic.
  const seed = bytes.reduce((sum, b) => sum + b, 0) % 16;
  return (
    String(seed).padStart(2, '0') +
    [...bytes]
      .map((b, i) =>
        (b ^ XLAT.charCodeAt((seed + i) % XLAT.length)).toString(16).toUpperCase().padStart(2, '0')
      )
      .join('')
  );
}
export function type7Decode(cipher: string) {
  const seed = Number(cipher.slice(0, 2));
  if (!TYPE7.test(cipher) || seed >= XLAT.length) throw new Error('Invalid encrypted password.');
  const bytes = Uint8Array.from({ length: (cipher.length - 2) / 2 }, (_, i) => {
    const value = parseInt(cipher.slice(2 + i * 2, 4 + i * 2), 16);
    return value ^ XLAT.charCodeAt((seed + i) % XLAT.length);
  });
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
/** A secret typed as "[0|7] <value>": type 7 is decoded, type 0 (or none) is clear text. */
export function readSecret(type: string | undefined, value: string) {
  return type === '7' ? type7Decode(value) : value;
}
/** How running-config prints a reversible secret: clear text, or "7 <cipher>" when encrypted. */
export function printSecret(d: Device, plain: string) {
  return d.iosSystem?.passwordEncryption ? '7 ' + type7Encode(plain) : plain;
}
// The JSON form of the simulator's composite commands carries secrets in these fields.
const SECRET_FIELDS = new Set(['key', 'password']);
const ENCRYPTED = /^7 (\d{2}(?:[0-9A-Fa-f]{2})+)$/;
/** Running-config JSON with "key"/"password" values printed like any other IOS secret. */
export function printSecretsJson(d: Device, value: unknown) {
  return JSON.stringify(value, (field, entry) =>
    SECRET_FIELDS.has(field) && typeof entry === 'string' ? printSecret(d, entry) : entry
  );
}
/** Parses a JSON command argument, decoding secrets that running-config printed as type 7. */
export function parseConfigJson(text: string): unknown {
  return JSON.parse(text, (field, entry) => {
    const match = SECRET_FIELDS.has(field) && typeof entry === 'string' ? ENCRYPTED.exec(entry) : null;
    return match ? type7Decode(match[1]) : entry;
  });
}
