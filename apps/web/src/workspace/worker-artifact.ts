const hashes = new Map<string, Promise<string>>();
export function workerArtifact(url: string) {
  let pending = hashes.get(url);
  if (!pending) {
    pending = (async () => {
      const entry = new URL(url, location.href),
        files = new Map<string, Uint8Array>();
      const read = async (asset: URL) => {
        const name = asset.pathname.split('/').at(-1)!;
        if (files.has(name)) return;
        if (asset.origin !== location.origin || files.size >= 100)
          throw new Error('Grafo do motor inválido.');
        const response = await fetch(asset, {
          credentials: 'same-origin',
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok)
          throw new Error('Não foi possível carregar o motor do ensaio. Recarregue e tente novamente.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        files.set(name, bytes);
        for (const dependency of artifactDependencies(new TextDecoder().decode(bytes)))
          await read(new URL(dependency, asset));
      };
      await read(entry);
      return artifactIdentity(entry.pathname.split('/').at(-1)!, files);
    })().catch((cause) => {
      hashes.delete(url);
      throw cause;
    });
    hashes.set(url, pending);
  }
  return pending;
}
import {
  artifactDependencies,
  artifactIdentity,
} from '../../../../packages/simulation-engine/src/artifact-identity';
