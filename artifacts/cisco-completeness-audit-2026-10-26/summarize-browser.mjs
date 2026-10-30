import { readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { log } from 'node:console';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
function read(name) {
  const bytes = readFileSync(resolve(dir, name));
  const text =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? bytes.toString('utf16le').replace(/^\uFEFF/, '')
      : bytes.toString('utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}
function specs(suites) {
  return suites.flatMap((suite) => [...(suite.specs ?? []), ...specs(suite.suites ?? [])]);
}
const key = (test) => `${test.line}:${test.title}`;
const inventory = specs(read('browser-inventory.json').suites);
const prior = read('prior-browser-passes.json');
const report = read('browser.json');
const current = specs(report.suites).map((spec) => ({
  title: spec.title,
  line: spec.line,
  passed: spec.tests.every((test) => test.results.at(-1)?.status === 'passed'),
  statuses: spec.tests.flatMap((test) => test.results.map((r) => r.status)),
}));
const originalFailures = current.filter((test) => !test.passed);
const results = new Map(prior.map((test) => [key(test), { ...test, passed: true, source: 'initial logs' }]));
for (const test of current) results.set(key(test), { ...test, source: 'browser.json' });
let rechecked = [];
let recheckErrors = [];
if (existsSync(resolve(dir, 'browser-recheck.json'))) {
  const recheckReport = read('browser-recheck.json');
  recheckErrors = recheckReport.errors ?? [];
  rechecked = specs(recheckReport.suites).map((spec) => ({
    title: spec.title,
    line: spec.line,
    passed: spec.tests.every((test) => test.results.at(-1)?.status === 'passed'),
    statuses: spec.tests.flatMap((test) => test.results.map((r) => r.status)),
  }));
  for (const test of rechecked) results.set(key(test), { ...test, source: 'browser-recheck.json' });
}
const missing = inventory.filter((spec) => !results.has(key(spec))).map((spec) => spec.title);
const failed = [...results.values()].filter((test) => !test.passed);
const errors = [...(report.errors ?? []), ...recheckErrors];
const summary = {
  scope:
    'One complete sistema-claro project, including its mobile and appearance tests. No second full OS-theme project claimed.',
  execution:
    'Completed cases preserved across controlled resumptions; remaining independent cases used three browser workers and a fresh in-memory API database.',
  expected: inventory.length,
  recorded: results.size,
  passed: [...results.values()].filter((test) => test.passed).length,
  failed,
  originalFailures,
  cleanInitialExecution: originalFailures.length === 0,
  rechecked,
  missing,
  errors,
  success:
    inventory.length === 72 && results.size === 72 && !failed.length && !missing.length && !errors.length,
  cases: [...results.values()].sort((a, b) => a.line - b.line || a.title.localeCompare(b.title)),
};
writeFileSync(resolve(dir, 'browser-summary.json'), JSON.stringify(summary, null, 2) + '\n');
log(
  JSON.stringify({
    expected: summary.expected,
    passed: summary.passed,
    missing: missing.length,
    failed: failed.length,
    success: summary.success,
  })
);
if (!summary.success) process.exitCode = 1;
