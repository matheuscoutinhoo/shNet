import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import {
  makeTemplate,
  industrialProcessScenarios,
  ScenarioRunner,
  scenarioReportSchema,
  validateSnapshot,
  ENGINE_CONTRACT_VERSION,
} from '../packages/simulation-engine/src';
import { engineSourceHash } from './engine-build';
const out = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/industrial-process-2026-10-15';
await mkdir(out, { recursive: true });
const snapshot = makeTemplate('industrial-process');
validateSnapshot(snapshot);
await writeFile(out + '/industrial-process.shlab.json', JSON.stringify(snapshot));
const results = [];
for (const [n, scenario] of industrialProcessScenarios(snapshot).entries()) {
  const runner = new ScenarioRunner(snapshot, scenario);
  for (let i = 0; i < 3000 && !runner.step(100); i++);
  const report = scenarioReportSchema.parse(runner.report());
  validateSnapshot(runner.engine.snapshot());
  const file = 'process-' + n + '.json';
  await writeFile(out + '/' + file, JSON.stringify(report, null, 2) + '\n');
  results.push({
    name: report.name,
    passed: report.passed,
    complete: report.complete,
    flows: report.flows,
    assertions: report.assertions,
    faults: report.faults,
    report: file,
    actors: runner.engine.state.devices
      .filter((d) => d.hmiScan)
      .map((d) => ({
        name: d.hostname,
        samples: d.hmiScan!.samples,
        missed: d.hmiScan!.missed,
        communicationAlarm: d.hmiScan!.communicationAlarm,
        processAlarm: d.hmiScan!.processAlarm,
        latencyMs: d.hmiScan!.latencyMs,
      })),
  });
}
const passed = results.length === 5 && results.every((r) => r.passed && r.complete);
await writeFile(
  out + '/industrial-process.json',
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      engineContract: ENGINE_CONTRACT_VERSION,
      engineSourceHash: engineSourceHash(),
      passed,
      scope:
        'Educational tank/PLC scan and binary Modbus HMI/SCADA/MES loads; no firmware or functional-safety certification.',
      results,
    },
    null,
    2
  ) + '\n'
);
assert(passed, 'Falha em cenário industrial; consulte industrial-process.json.');
console.log(JSON.stringify({ passed, scenarios: results.length, output: out }));
