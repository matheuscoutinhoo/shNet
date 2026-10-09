// Deterministic teaching cipher. It demonstrates sealing/integrity and MUST NOT be used for real security.
export function modelDigest(text: string) {
  let n = 2166136261;
  for (const c of text) n = Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0;
  return n.toString(16).padStart(8, '0');
}
function stream(key: string, nonce: string) {
  let n = parseInt(modelDigest(key + '|' + nonce), 16) || 1;
  return () => {
    n ^= n << 13;
    n ^= n >>> 17;
    n ^= n << 5;
    return (n >>> 0) & 255;
  };
}
export function modelSeal(text: string, key: string, nonce: string) {
  const next = stream(key, nonce),
    bytes = new TextEncoder().encode(text);
  const body = Array.from(bytes, (v) => (v ^ next()).toString(16).padStart(2, '0')).join('');
  return { body, tag: modelDigest(key + '|' + nonce + '|' + body) };
}
export function modelOpen(body: string, tag: string, key: string, nonce: string) {
  if (modelDigest(key + '|' + nonce + '|' + body) !== tag)
    throw new Error('Integridade do ciphertext inválida.');
  const next = stream(key, nonce),
    bytes = Uint8Array.from(body.match(/../g) ?? [], (v) => parseInt(v, 16) ^ next());
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
