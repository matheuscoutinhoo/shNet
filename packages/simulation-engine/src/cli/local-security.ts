import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { iosSecretSchema } from '../protocols/local-security-model';
import { CONFIG_MODES, type CommandRegistry } from './registry';

const alphabet = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const text = (value: string) => new TextEncoder().encode(value);
function base64(bytes: Uint8Array) {
  let output = '',
    bits = 0,
    value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      output += alphabet[(value >>> bits) & 63];
    }
  }
  if (bits) output += alphabet[(value << (6 - bits)) & 63];
  return output;
}
export function hashIosSecret(secret: string, type: 8 | 9 = 9, salt?: string) {
  if (
    secret.length < 1 ||
    secret.length > 128 ||
    [...secret].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error('Secret must contain 1 to 128 printable characters.');
  salt ??= Array.from(crypto.getRandomValues(new Uint8Array(14)), (byte) => alphabet[byte & 63]).join('');
  if (!/^[./0-9A-Za-z]{14}$/.test(salt)) throw new Error('Invalid IOS secret salt.');
  const bytes =
    type === 8
      ? pbkdf2(sha256, text(secret), text(salt), { c: 20000, dkLen: 32 })
      : scrypt(text(secret), text(salt), { N: 16384, r: 1, p: 1, dkLen: 32 });
  return '$' + type + '$' + salt + '$' + base64(bytes);
}
export function verifyIosSecret(secret: string, hash: string) {
  if (!iosSecretSchema.safeParse(hash).success) return false;
  try {
    const expected = hashIosSecret(secret, Number(hash[1]) as 8 | 9, hash.split('$')[2]);
    let diff = expected.length ^ hash.length;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ hash.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}
export function registerLocalSecurityCommands(r: CommandRegistry) {
  r.register({
    pattern: /^enable secret (?:([089]) )?(.+)$/i,
    syntax: [
      'enable secret <secret...>',
      'enable secret 0 <secret...>',
      'enable secret 8 <hash>',
      'enable secret 9 <hash>',
    ],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const type = Number(m[1] ?? 0);
      if (type === 8 || type === 9) {
        const hash = iosSecretSchema.parse(m[2]);
        if (hash[1] !== String(type)) throw new Error('Secret type does not match the encoded hash.');
        d.enableSecret = hash;
      } else d.enableSecret = hashIosSecret(m[2]);
    },
  });
  r.register({
    pattern: /^enable algorithm-type (sha256|scrypt) secret (.+)$/i,
    syntax: [
      'enable algorithm-type sha256 secret <secret...>',
      'enable algorithm-type scrypt secret <secret...>',
    ],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      d.enableSecret = hashIosSecret(m[2], m[1].toLowerCase() === 'sha256' ? 8 : 9);
    },
  });
  r.register({
    pattern: /^no enable secret$/i,
    syntax: 'no enable secret',
    modes: CONFIG_MODES,
    run: (_m, _e, d) => {
      delete d.enableSecret;
    },
  });
}
