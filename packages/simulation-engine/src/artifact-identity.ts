import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export function artifactDependencies(code: string): string[] {
  return [
    ...new Set(
      [...code.matchAll(/(?:["'`])(?:\.\/|\/assets\/)?([\w.-]+-[\w-]+\.js)(?:["'`])/g)].map((m) => m[1])
    ),
  ].sort();
}

// Preserve identity of older single-file workers; bind every byte in module graphs.
export function artifactIdentity(root: string, files: ReadonlyMap<string, Uint8Array>): string {
  const entry = files.get(root);
  if (!entry) throw new Error('Execution entry is missing.');
  const visited = new Set<string>();
  const visit = (name: string) => {
    if (visited.has(name)) return;
    const bytes = files.get(name);
    if (!bytes) throw new Error('Execution dependency is missing: ' + name);
    if (visited.size >= 100) throw new Error('Execution graph exceeds 100 assets.');
    visited.add(name);
    for (const dependency of artifactDependencies(new TextDecoder().decode(bytes))) visit(dependency);
  };
  visit(root);
  if (visited.size === 1) return bytesToHex(sha256(entry));
  const manifest = [...visited]
    .sort()
    .map((name) => ({ name, sha256: bytesToHex(sha256(files.get(name)!)) }));
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify({ version: 1, root, files: manifest }))));
}
