const hashes = new Map<string, Promise<string>>();
export function workerArtifact(url: string) {
  let pending = hashes.get(url);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(30000) });
      if (!response.ok)
        throw new Error('Não foi possível carregar o motor do ensaio. Recarregue e tente novamente.');
      const bytes = await response.arrayBuffer(),
        hash = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, '0')).join('');
    })().catch((cause) => {
      hashes.delete(url);
      throw cause;
    });
    hashes.set(url, pending);
  }
  return pending;
}
