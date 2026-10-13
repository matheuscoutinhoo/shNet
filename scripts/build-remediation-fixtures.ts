import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import {
  makeTemplate,
  ScenarioRunner,
  scenarioReportSchema,
  enterpriseScenarios,
} from '../packages/simulation-engine/src';
const out = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/remediation-2026-10-13';
await mkdir(out, { recursive: true });
const topology = makeTemplate('enterprise-datacenter');
await writeFile(out + '/enterprise-datacenter.shlab.json', JSON.stringify(topology));
await writeFile(
  out + '/native-enterprise-scenarios.json',
  JSON.stringify(enterpriseScenarios(topology), null, 2)
);
const historical = 'artifacts/enterprise-datacenter-audit';
const source = JSON.parse(await readFile(historical + '/recovery-source.shlab.json', 'utf8'));
const original = JSON.parse(await readFile(historical + '/recovery-report-original.json', 'utf8'));
const runner = new ScenarioRunner(source, original.scenario);
while (!runner.step(100));
const report = scenarioReportSchema.parse(runner.report()),
  tampered = structuredClone(report);
tampered.faults[0].recovery[0].recoveryMs = 0;
await writeFile(out + '/recovery-source.shlab.json', JSON.stringify(source));
await writeFile(out + '/recovery-report-original.json', JSON.stringify(report, null, 2));
await writeFile(out + '/recovery-report-tampered.json', JSON.stringify(tampered, null, 2));
for (const name of ['modbus', 'vxlan'])
  await copyFile('.data/captures/' + name + '.pcap', out + '/' + name + '.pcap');
console.log(
  JSON.stringify({
    devices: topology.devices.length,
    links: topology.links.length,
    nativePresets: enterpriseScenarios(topology).length,
    tamperedRejected: !scenarioReportSchema.safeParse(tampered).success,
  })
);
