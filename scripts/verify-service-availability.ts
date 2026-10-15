import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import {
  makeTemplate,
  dualAccessScenarios,
  serviceHaScenarios,
  ScenarioRunner,
  scenarioReportSchema,
  validateSnapshot,
  ENGINE_CONTRACT_VERSION,
} from '../packages/simulation-engine/src';
import { engineSourceHash } from './engine-build';
const out = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/service-availability-2026-10-15';
await mkdir(out, { recursive: true });
const results = [];
for (const template of ['dual-access', 'service-ha'] as const) {
  const snapshot = makeTemplate(template);
  validateSnapshot(snapshot);
  await writeFile(out + '/' + template + '.shlab.json', JSON.stringify(snapshot));
  const scenarios = template === 'dual-access' ? dualAccessScenarios(snapshot) : serviceHaScenarios(snapshot);
  for (const [index, scenario] of scenarios.entries()) {
    const runner = new ScenarioRunner(snapshot, scenario);
    for (let n = 0; n < 3000 && !runner.step(100); n++);
    const report = scenarioReportSchema.parse(runner.report());
    validateSnapshot(runner.engine.snapshot());
    const file = template + '-' + index + '.json';
    await writeFile(out + '/' + file, JSON.stringify(report, null, 2) + '\n');
    results.push({
      template,
      name: report.name,
      passed: report.passed,
      complete: report.complete,
      flows: report.flows,
      faults: report.faults,
      report: file,
    });
  }
}
const passed = results.every((r) => r.passed && r.complete);
await writeFile(
  out + '/availability.json',
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      engineContract: ENGINE_CONTRACT_VERSION,
      engineSourceHash: engineSourceHash(),
      passed,
      scope:
        'Native access/power A/B and service VIP scenarios; new requests, not replicated service sessions/data.',
      samplingMs: 1000,
      responseDeadlineMs: 800,
      ntpToleranceMs: 10,
      results,
    },
    null,
    2
  ) + '\n'
);
assert(passed, 'Falha em cenário nativo; consulte availability.json.');
console.log(JSON.stringify({ passed, scenarios: results.length, output: out }));
