import { Worker } from 'node:worker_threads';
import type { Scenario, ScenarioReport, Snapshot } from '@shlab/engine';
import { error } from './security';
let busy = false;
export async function replayScenario(
  topology: Snapshot,
  scenario: Scenario,
  engineBuild?: string,
  engineArtifact?: string
): Promise<ScenarioReport> {
  if (busy) throw error(503, 'Verificação ocupada. Tente novamente em alguns segundos.');
  busy = true;
  let worker: Worker | undefined;
  let timeout: NodeJS.Timeout | undefined;
  try {
    worker = new Worker(new URL('./scenario-replay-worker.mjs', import.meta.url), {
      workerData: {
        topology,
        scenario,
        engineBuild,
        engineArtifact,
        engine: new URL('../../../packages/simulation-engine/src/index.ts', import.meta.url).href,
      },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 },
    });
    return await new Promise<ScenarioReport>((resolve, reject) => {
      timeout = setTimeout(
        () => reject(error(503, 'Verificação excedeu 20 segundos. Divida o cenário e tente novamente.')),
        20000
      );
      worker!.once('message', resolve);
      worker!.once('error', () =>
        reject(error(503, 'Worker de verificação falhou. O resultado permanece sem atestado.'))
      );
      worker!.once('exit', (code) => {
        if (code !== 0) reject(error(503, 'Worker de verificação interrompido.'));
      });
    });
  } finally {
    clearTimeout(timeout);
    await worker?.terminate();
    busy = false;
  }
}
