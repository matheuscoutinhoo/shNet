import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
const out = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/application-stability-2026-10-13';
const read = async (name) => JSON.parse(await readFile(out + '/' + name + '.json', 'utf8'));
const [regression, postgres, ui, built, performance, qualification, manifest, runtime] = await Promise.all(
  [
    'regression',
    'postgres-regression',
    'application-ui',
    'built-application-ui',
    'performance',
    'local-release-qualification',
    'release-manifest',
    'runtime-package',
  ].map(read)
);
for (const [name, value] of [
  ['regression', regression.success],
  ['postgres', postgres.success],
  ['ui', ui.passed],
  ['built', built.passed],
  ['runtime-package', runtime.passed],
])
  if (!value) throw new Error(name + ' não concluído com sucesso');
const round = (n) => Number(n.toFixed(2)),
  ranges = (trials, key) =>
    `${round(Math.min(...trials.map((t) => t[key])))}–${round(Math.max(...trials.map((t) => t[key])))}`;
const report = `# Correções do funcionamento da aplicação — 13/10/2026

Contrato **2026.10.13.6**, migração SQL **011**. Este incremento atende recuperação/persistência, configuração/execução confiável, diagnóstico e operação. Novos protocolos e features industriais foram adiados conforme orientação do usuário. Requisitos e saldo estão no [plano consolidado](../../docs/consolidated-remediation-plan.md); contratos no [ADR-046](../../docs/adr/046-application-recovery-and-run-integrity.md).

| Correção | Evidência |
| --- | --- |
| Autosave durante alterações contínuas, save finito, API com timeout/erros recuperáveis | Build real em navegador: revisão ${built.continuousAutosave.revision}, clock salvo ${round(built.continuousAutosave.clock)} ms, save manual resolvido; testes API de rede/HTML/JSON inválidos. |
| Rascunhos, revisão/cópia/arquivo em conflitos, quota, recuperação de projeto excluído | ${ui.checks.length} fluxos completos no navegador; IndexedDB + API com 503 controlado; falha conjunta API/armazenamento local explícita. |
| Sessão expirada com armazenamento indisponível | Build compilado mantém editor/topologia/nome para exportação; o processamento é pausado e não há redirecionamento com trabalho desprotegido. |
| Lote atômico, proposta protegida, patch/rollback, formulários, restore DHCP/BGP | Testes de determinismo 1/100 ms, rejeição/rollback, aliases, aplicação pela UI e replay matched. |
| Origem exata do motor/Worker e admissão compartilhada de replay | Fingerprint e SHA dos bytes do Worker carregado coincidem com o servidor; API recusa divergência; lease ocupado/expirado/release testados. |
| Evidências overlay/LB, retenção e preflight | Intermediários/health checks/fluxo permitido isolados; captura limitada indicada; próximo salto e regra IPv4/IPv6 coberta identificados. |
| Canvas e limites de memória/CPU | Autolayout/undo/redo, grupos/RF preservados, clones VTEP/HA válidos, histórico limitado e estado realtime idêntico ao motor sem fatias. |
| Regressão completa | **${regression.numPassedTests} aprovados, ${regression.numFailedTests} falhas, ${regression.numPendingTests} ignorado** (${regression.numTotalTests} casos). O caso PostgreSQL externo ignorado nesta rodada tem execução nativa abaixo. |
| PostgreSQL nativo isolado | **${postgres.numPassedTests} aprovados, ${postgres.numFailedTests} falhas, ${postgres.numPendingTests} ignorados**, incluindo API, migrações e backup/restore com identidade do build. Estes casos sobrepõem a suíte completa; não somar contagens. |
| UI/acessibilidade | Desktop, mobile e gerenciador mobile: **zero violações Axe, zero pageerrors e sem overflow horizontal**; build compilado também sem pageerrors. |
| Qualificação local | ${qualification.migrations.length} migrações e ${qualification.checks.staticAssets} assets, cookie Secure/CSP/HSTS/readiness, origem imutável/replay matched e cópia restaurada do artefato. |
| Empacotamento do runtime | Cópia isolada dos arquivos declarados pelo Dockerfile inicia a API com 11 migrações e fingerprint/Worker corretos; helper de identidade incluído na imagem. Não executa daemon/build Docker. |

## Escala e limites

O JS inicial do painel tem **${round(built.build.entryBytes / 1000)} kB**, porque o catálogo deixou de importar o motor. Workspace/Workers permanecem grandes e o build ainda mostra avisos acima de 500 kB; eles não foram suprimidos. O tempo de abertura observado (${round(built.openMs)} ms) é uma verificação funcional local, sem série estatística de carregamento.

| Carga / três repetições | p95 de fatia (ms) | Razão virtual/real | Heap Node durante execução (MiB) | Respostas |
| --- | --- | --- | --- | --- |
${performance.results.map((row) => `| ${row.devices} dispositivos — ${row.devices === 38 ? 'enterprise/DC nativo, HTTP ERP/LB + controle' : 'árvore L2, seis ICMP'} | ${ranges(row.trials, 'p95ChunkMs')} | ${ranges(row.trials, 'realtimeRatio')} | ${ranges(row.trials, 'heapDuringMiB')} | ${row.trials.map((t) => t.responses + '/' + t.sent).join(', ')} |`).join('\n')}

Benchmark Node isolado, aquecimento fora da medição, orçamento de 20 ms mais delta. O caso enterprise e as árvores L2 são cargas diferentes. Heap medido é de processo Node, não do navegador. O caso de 2.000 nós não garante realtime 1×; o produto indica lag e permite reduzir a velocidade ou pausar. Captura descartada por retenção é distinta de perda de rede. [Dados completos](performance.json) preservam bytes de deltas/retidos e repetições; a rodada anterior à agregação de métricas está em performance-before-metrics-optimization.json, sem alegar ganho causal por poucas medições.

## Identidade e reprodução

Fontes do motor: **${built.build.engineBuild}**. Worker carregado: **${built.build.workerArtifactHash}**.

Manifesto de fontes da aplicação: **${manifest.sourceHash}**. Assets: **${manifest.assetHash}**. [Manifesto](release-manifest.json) e [qualificação](local-release-qualification.json) registram arquivos individuais. A normalização LF do fingerprint do motor permite comparar checkouts; o manifesto de release registra os bytes qualificados localmente.

Comandos: npm test -- --reporter=json --outputFile=${out}/regression.json; npm run build; npm run lint; npm run test:postgres -- tests/production.test.ts tests/api.test.ts --no-file-parallelism --reporter=json --outputFile=${out}/postgres-regression.json; node --expose-gc --import tsx scripts/benchmark-application.ts; node scripts/verify-application-stability-ui.mjs; npx tsx scripts/verify-built-application.ts; node scripts/verify-runtime-package.mjs; npm run qualify:local. Use SHLAB_AUDIT_OUTPUT para outra pasta. Scripts de browser usam sessão sintética local em memória; o roteiro do build cria banco/servidor descartáveis.

Novos protocolos, HA de serviços/NICs, processo industrial e colaboração/RBAC de equipe são ampliações fora deste incremento. Precisão da recuperação é amostral; evidência limitada por retenção não certifica um caminho completo. Deploy remoto, handshake TLS real e rollback operacional de aplicação/banco continuam aguardando homologação. O rollback local exercitado restaura uma cópia do artefato, sem representar rollback de produção. Nenhuma dessas parcelas foi marcada como entregue.
`;
await writeFile(out + '/CORRECOES-E-VALIDACAO.md', report);
const summary = {
  engineContract: built.build.engineContract,
  regression: {
    passed: regression.numPassedTests,
    failed: regression.numFailedTests,
    skipped: regression.numPendingTests,
  },
  postgres: {
    passed: postgres.numPassedTests,
    failed: postgres.numFailedTests,
    skipped: postgres.numPendingTests,
  },
  ui,
  built,
  sourceHash: manifest.sourceHash,
  assetHash: manifest.assetHash,
  scope: 'application operation; industrial/protocol extensions deferred',
};
await writeFile(out + '/summary.json', JSON.stringify(summary, null, 2));
process.stdout.write(
  JSON.stringify({
    regression: summary.regression,
    postgres: summary.postgres,
    uiPassed: ui.passed,
    compiledUiPassed: built.passed,
    sourceHash: manifest.sourceHash,
    assetHash: manifest.assetHash,
  }) + '\n'
);
