import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';
const { ScenarioRunner } = await tsImport(workerData.engine, import.meta.url);
const runner = new ScenarioRunner(workerData.topology, workerData.scenario);
while (!runner.step(50));
const report = runner.report();
// Origin metadata is compared as recorded; the verifier records its own source hash separately.
if (workerData.engineBuild !== undefined) report.engineBuild = workerData.engineBuild;
else delete report.engineBuild;
if (workerData.engineArtifact !== undefined) report.engineArtifact = workerData.engineArtifact;
parentPort.postMessage(report);
