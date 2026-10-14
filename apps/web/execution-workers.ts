import type { Plugin } from 'vite';
import { fileURLToPath } from 'node:url';

// Emit module workers into the same graph as the editor, sharing protocol code.
export function executionWorkers(command: 'build' | 'serve'): Plugin {
  const entries = new Map([
    ['scenario.worker.ts', fileURLToPath(new URL('./src/workspace/scenario.worker.ts', import.meta.url))],
    ['simulation.worker.ts', fileURLToPath(new URL('./src/workspace/simulation.worker.ts', import.meta.url))],
  ]);
  return {
    name: 'shlab-execution-workers',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!source.endsWith('?execution-worker')) return;
      const name = source.slice(0, -'?execution-worker'.length).split('/').at(-1)!;
      const entry = entries.get(name);
      if (!entry) throw new Error('Unknown execution worker.');
      if (command === 'serve') return this.resolve(entry + '?worker&url', importer, { skipSelf: true });
      return '\0execution-worker:' + name;
    },
    load(id) {
      if (!id.startsWith('\0execution-worker:')) return;
      const name = id.slice('\0execution-worker:'.length);
      const reference = this.emitFile({ type: 'chunk', id: entries.get(name)!, name: name.slice(0, -3) });
      return `export default import.meta.ROLLUP_FILE_URL_${reference};`;
    },
  };
}
