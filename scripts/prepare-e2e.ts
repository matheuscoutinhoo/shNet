import { existsSync } from 'node:fs';
if (!existsSync('.data/benchmarks/topology2000.json')) {
  process.argv = [process.argv[0], process.argv[1], '2000'];
  await import('./benchmark-scale');
}
