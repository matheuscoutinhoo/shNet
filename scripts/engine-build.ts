import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
// Stable across checkout location and OS; includes codecs, fixtures and dependency lock.
export function engineSourceHash() {
  const root = fileURLToPath(new URL('../', import.meta.url)),
    engine = join(root, 'packages/simulation-engine');
  const files = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(directory, e.name)) : [join(directory, e.name)]
    );
  const entries = [
    ...files(join(engine, 'src')),
    join(engine, 'package.json'),
    join(root, 'package-lock.json'),
    fileURLToPath(import.meta.url),
  ]
    .map((path) => ({
      path: relative(root, path).replaceAll('\\', '/'),
      sha256: createHash('sha256').update(readFileSync(path, 'utf8').replaceAll('\r\n', '\n')).digest('hex'),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
