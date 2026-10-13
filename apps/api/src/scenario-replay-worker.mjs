import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';
const { ScenarioRunner } = await tsImport(workerData.engine, import.meta.url);
const runner = new ScenarioRunner(workerData.topology, workerData.scenario);
while (!runner.step(50));
parentPort.postMessage(runner.report());
