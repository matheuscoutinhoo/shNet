import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import console from 'node:console';
import process from 'node:process';
const out = 'artifacts/enterprise-datacenter-audit';
const reference = await chromium.connectOverCDP('http://127.0.0.1:9223');
const state = await reference.contexts()[0].storageState();
const context = await chromium.launch({ channel: 'msedge', headless: true });
const browserContext = await context.newContext({ storageState: state });
const request = browserContext.request;
const root = 'http://127.0.0.1:5173/api';
const me = await (await request.get(root + '/auth/me')).json();
const headers = { 'X-CSRF-Token': me.csrfToken, Origin: 'http://127.0.0.1:5173' };
const create = await request.post(root + '/projects', {
  headers,
  data: { name: 'Auditoria negativa — integridade de relatórios', template: 'empty' },
});
const project = await create.json();
if (create.status() !== 201) throw new Error('Create: ' + create.status());
const topology = JSON.parse(await readFile(out + '/recovery-source.shlab.json', 'utf8'));
const save = await request.put(root + '/projects/' + project.id, {
  headers,
  data: { name: project.name, revision: project.revision, topology },
});
const saved = await save.json();
if (!save.ok()) throw new Error('Save: ' + save.status());
const tampered = JSON.parse(await readFile(out + '/recovery-report-tampered.json', 'utf8'));
const endpoint = root + '/projects/' + project.id + '/scenario-runs';
const start = await request.post(endpoint, {
  headers,
  data: { revision: saved.revision, kind: 'scenario', scenario: tampered.scenario },
});
const run = await start.json();
if (!start.ok()) throw new Error('Run: ' + start.status());
const completion = await request.put(endpoint + '/' + run.id, { headers, data: { report: tampered } });
const completed = await completion.json();
const read = await (await request.get(endpoint + '/' + run.id)).json();
const conflict = await request.put(root + '/projects/' + project.id, {
  headers,
  data: { name: project.name, revision: saved.revision + 999, topology },
});
const duplicateCompletion = await request.put(endpoint + '/' + run.id, {
  headers,
  data: { report: tampered },
});
const csrf = await request.post(endpoint, {
  headers: { Origin: 'http://127.0.0.1:5173' },
  data: { revision: saved.revision, kind: 'scenario', scenario: tampered.scenario },
});
const results = {
  createStatus: create.status(),
  importStatus: save.status(),
  provenance: { sourceClock: topology.clock, sourceHash: run.source_hash, revision: run.revision },
  recoveryTampering: {
    expectedStatus: 400,
    observedStatus: completion.status(),
    persisted: read.status === 'complete',
    recovery: completed.report?.faults[0]?.recovery[0],
  },
  revisionConflict: { expectedStatus: 409, observedStatus: conflict.status() },
  identicalCompletionRetry: { expectedStatus: 200, observedStatus: duplicateCompletion.status() },
  missingCsrf: { expectedStatus: 403, observedStatus: csrf.status() },
};
// Remove the deliberately invalid result/project so it cannot be mistaken for a valid user report.
const cleanup = await request.delete(root + '/projects/' + project.id, { headers });
results.cleanupStatus = cleanup.status();
await writeFile(out + '/api-results.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
await context.close();
process.exit(0);
