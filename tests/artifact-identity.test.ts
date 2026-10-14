import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { artifactDependencies, artifactIdentity } from '../packages/simulation-engine/src/artifact-identity';
const bytes = (value: string) => new TextEncoder().encode(value);
describe('Identidade do grafo de execução', () => {
  it('reconhece imports relativos e URLs de assets na identificação transitiva', () => {
    expect(artifactDependencies('import "./engine-abc.js"; import "/assets/runtime-def.js";')).toEqual([
      'engine-abc.js',
      'runtime-def.js',
    ]);
  });
  it('preserva a identidade dos Workers antigos e detecta adulteração de dependência transitiva', () => {
    const root = 'scenario.worker-abc.js',
      single = bytes('self.onmessage = () => {};');
    expect(artifactIdentity(root, new Map([[root, single]]))).toBe(
      createHash('sha256').update(single).digest('hex')
    );
    const graph = new Map([
      [root, bytes('import { run } from "./runner-def.js"; self.onmessage = run;')],
      ['runner-def.js', bytes('import "./engine-ghi.js"; export const run = () => {};')],
      ['engine-ghi.js', bytes('export const version = 1;')],
    ]);
    const original = artifactIdentity(root, graph);
    expect(artifactIdentity(root, new Map([...graph].reverse()))).toBe(original);
    graph.set('unused-jkl.js', bytes('unused'));
    expect(artifactIdentity(root, graph)).toBe(original);
    graph.set('engine-ghi.js', bytes('export const version = 2;'));
    expect(artifactIdentity(root, graph)).not.toBe(original);
    graph.delete('engine-ghi.js');
    expect(() => artifactIdentity(root, graph)).toThrow('dependency is missing');
  });
  it('termina ciclos de imports sem perder a identidade', () => {
    const graph = new Map([
      ['worker-abc.js', bytes('import "./engine-def.js";')],
      ['engine-def.js', bytes('import "./worker-abc.js";')],
    ]);
    expect(artifactIdentity('worker-abc.js', graph)).toMatch(/^[a-f0-9]{64}$/);
  });
});
