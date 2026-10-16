import { readFile, mkdir, writeFile } from 'node:fs/promises';
const argument = process.argv.indexOf('--results'),
  file = argument >= 0 ? process.argv[argument + 1] : process.env.SHLAB_REGRESSION_RESULTS;
if (!file) throw new Error('Informe --results com o JSON da regressão Vitest.');
const regression = JSON.parse(await readFile(file, 'utf8'));
const assertions = regression.testResults.flatMap(
  (suite: { name: string; assertionResults: { fullName: string; status: string }[] }) =>
    suite.assertionResults.map((test) => ({
      ...test,
      file: suite.name.replaceAll('\\', '/').split('/tests/')[1],
    }))
);
const cases = [];
for (const [path, family] of [
  ['artifacts/factory-audit/scenario-results.json', 'factory'],
  ['artifacts/factory-audit/extended-results.json', 'factory'],
  ['artifacts/enterprise-datacenter-audit/scenario-results.json', 'enterprise'],
  ['artifacts/enterprise-datacenter-audit/protocol-results.json', 'enterprise'],
] as const) {
  const historical = JSON.parse(await readFile(path, 'utf8'));
  for (const row of historical.results as { id: string; name?: string; label?: string }[]) {
    if (row.id.startsWith('T-')) continue; // Five template controls are separate from the 42 factory cases.
    const test = assertions.find((a: { fullName: string }) => a.fullName.includes(row.id + ' — '));
    if (!test) throw new Error('Caso histórico sem teste rastreável: ' + row.id);
    const deferred = row.id === 'P-PCAP';
    if (
      (deferred && !['pending', 'skipped'].includes(test.status)) ||
      (!deferred && test.status !== 'passed')
    )
      throw new Error('Caso sem aceite: ' + row.id + ' ' + test.status);
    cases.push({
      family,
      id: row.id,
      historicalTitle: row.label ?? row.name,
      history: path,
      test: 'tests/' + test.file,
      testTitle: test.fullName,
      status: deferred ? 'deferred-protocol-codecs' : 'passed',
      ...(deferred
        ? {
            requirement: 'R19',
            reason:
              'Captura universal sem exclusões ainda depende dos codecs de controle, aplicação e gestão restantes em R19. BGP/EVPN e DHCPv4 já possuem validação independente; integridade e exclusões dos codecs presentes são verificadas separadamente.',
          }
        : {}),
    });
  }
}
if (cases.length !== 115 || new Set(cases.map((c) => c.family + ':' + c.id)).size !== 115)
  throw new Error('A matriz deve conter exatamente os 42 + 73 casos históricos.');
const out = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/application-completion-2026-10-13';
await mkdir(out, { recursive: true });
await writeFile(
  out + '/case-coverage.json',
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      regression: file,
      total: 115,
      passed: cases.filter((c) => c.status === 'passed').length,
      deferred: cases.filter((c) => c.status !== 'passed').length,
      cases,
    },
    null,
    2
  )
);
console.log(JSON.stringify({ total: 115, passed: 114, deferred: 1 }));
