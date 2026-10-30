import { md5, sha1 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { BfdMessage } from '../protocols/bfd-model';
import { encodeBfd } from './bfd-codec';
export function bfdAuthenticator(m: BfdMessage, key: string) {
  const auth = m.authentication;
  if (!auth) throw new Error('BFD authentication header is required.');
  const size = auth.type.includes('md5') ? 16 : 20,
    secret = new TextEncoder().encode(key);
  if (!secret.length || secret.length > size)
    throw new Error('BFD authentication key exceeds the digest length.');
  const bytes = encodeBfd({ ...m, authentication: { ...auth, digest: '00'.repeat(size) } });
  bytes.set(secret, 32);
  return bytesToHex((size === 16 ? md5 : sha1)(bytes));
}
export function bfdDigestMatches(a: string, b: string) {
  let difference = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
