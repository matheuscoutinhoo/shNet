import { parentPort } from 'node:worker_threads';
import { URL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
const { validateSnapshot } = await tsImport(
  new URL('../../../packages/simulation-engine/src/core/validation.ts', import.meta.url).href,
  import.meta.url
);
parentPort.on('message', ({ id, value }) => {
  try {
    parentPort.postMessage({ id, snapshot: validateSnapshot(value) });
  } catch {
    parentPort.postMessage({ id, invalid: true });
  }
});
