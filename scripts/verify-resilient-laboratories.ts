import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import {
  makeTemplate,
  resilientScenarios,
  ScenarioRunner,
  scenarioReportSchema,
  validateSnapshot,
  ENGINE_CONTRACT_VERSION,
} from '../packages/simulation-engine/src';
import { engineSourceHash } from './engine-build';

const output = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/resilient-laboratories-2026-10-15';
await mkdir(output, { recursive: true });
const results = [];
for (const template of ['enterprise-resilient', 'factory-resilient'] as const) {
  const snapshot = makeTemplate(template);
  validateSnapshot(snapshot);
  await writeFile(`${output}/${template}.shlab.json`, JSON.stringify(snapshot));
  const scenarios = resilientScenarios(snapshot);
  assert.equal(scenarios.length, 13, 'Matriz nativa incompleta: ' + template);
  for (const [index, scenario] of scenarios.entries()) {
    const runner = new ScenarioRunner(snapshot, scenario);
    let complete = false;
    for (let n = 0; n < 5000 && !complete; n++) complete = runner.step(200);
    const report = scenarioReportSchema.parse(runner.report());
    validateSnapshot(runner.engine.snapshot());
    // During convergence, lack of a gateway proves neither policy nor leakage.
    // Assess the deny independently after the allowed flows have recovered.
    const deny = new ScenarioRunner(runner.engine.snapshot(), {
      name: 'Guest isolado após convergência',
      durationMs: 2000,
      intervalMs: 1000,
      deadlineMs: 800,
      flows: [
        {
          name: 'Guest isolado dos serviços',
          source: 'HA-GUEST',
          target: '10.70.30.100',
          protocol: 'http',
          expect: 'deny',
          denyEvidence: 'policy',
          requireFinalSuccess: true,
        },
      ],
      faults: [],
    });
    for (let n = 0; n < 1000 && !deny.step(200); n++);
    const isolation = scenarioReportSchema.parse(deny.report());
    await writeFile(
      `${output}/${template}-${index}-isolation.json`,
      JSON.stringify(isolation, null, 2) + '\n'
    );
    const file = `${template}-${index}.json`;
    await writeFile(`${output}/${file}`, JSON.stringify(report, null, 2) + '\n');
    const result = {
      template,
      devices: snapshot.devices.length,
      name: scenario.name,
      passed: complete && report.passed && isolation.passed,
      isolationPassed: isolation.passed,
      isolationFile: `${template}-${index}-isolation.json`,
      flows: report.flows,
      file,
    };
    results.push(result);
    console.log(JSON.stringify({ ...result, flows: report.flows.filter((f) => !f.passed) }));
  }
}
const passed = results.every((r) => r.passed);
assert.equal(results.length, 26);
await writeFile(
  `${output}/availability.json`,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      engineContract: ENGINE_CONTRACT_VERSION,
      engineSourceHash: engineSourceHash(),
      passed,
      results,
      scope:
        'Integrated campus/factory, routed DC and WAN. New service requests; no replicated service sessions or PLC process.',
    },
    null,
    2
  ) + '\n'
);
assert(passed, 'Falha de disponibilidade integrada; consulte availability.json.');
