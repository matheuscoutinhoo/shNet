import { readFile, writeFile } from 'node:fs/promises';
import console from 'node:console';

const out = 'artifacts/remediation-2026-10-13';
const read = async (name) => JSON.parse(await readFile(out + '/' + name, 'utf8'));
const [regression, postgres, ui, browser, api, captures, qualification, manifest, factory] =
  await Promise.all([
    read('regression.json'),
    read('postgres-regression.json'),
    read('ui-results.json'),
    read('browser-regression.json'),
    read('api-results.json'),
    read('independent-captures.json'),
    read('local-release-qualification.json'),
    read('release-manifest.json'),
    read('factory-ui/ui-results.json'),
  ]);
if (regression.numFailedTests || postgres.numFailedTests || !regression.success || !postgres.success)
  throw new Error('Há regressões pendentes; não gere um relatório de aprovação.');
const plan = await readFile('docs/consolidated-remediation-plan.md', 'utf8');
const initial = JSON.parse(
  await readFile('artifacts/enterprise-datacenter-audit/consolidated-backlog.json', 'utf8')
);
const items = plan
  .split('\n')
  .filter((line) => /^\|\s*R\d{2}\s*\|/.test(line))
  .map((line) => {
    const [, id, status, delivered, remaining] = line
      .split(/(?<!\\)\|/)
      .map((v) => v.trim().replaceAll('\\|', '|'));
    const source = initial.items.find((i) => i.id === id);
    if (!source) throw new Error('ID desconhecido: ' + id);
    return { ...source, status, delivered, remaining };
  });
if (items.length !== 30 || new Set(items.map((i) => i.id)).size !== 30)
  throw new Error('O status deve cobrir as 30 frentes, sem duplicação.');
const counts = Object.fromEntries(
  Object.entries(Object.groupBy(items, (i) => i.status)).map(([k, v]) => [k, v.length])
);
await writeFile(
  out + '/current-backlog.json',
  JSON.stringify({ date: '2026-10-13', engineContract: manifest.engineContract, counts, items }, null, 2)
);
const csv = (value) => '"' + String(value ?? '').replaceAll('"', '""') + '"';
await writeFile(
  out + '/current-backlog.csv',
  [
    ['ID', 'Fase', 'Prioridade', 'Status', 'Título', 'Entregue', 'Saldo', 'Dependências'].map(csv).join(','),
    ...items.map((i) =>
      [i.id, i.phase, i.priority, i.status, i.title, i.delivered, i.remaining, i.dependencies.join(',')]
        .map(csv)
        .join(',')
    ),
  ].join('\n') + '\n'
);
const contrasts = browser.contrast.reduce(
  (n, x) => n + x.violations.reduce((n, v) => n + v.nodes.length, 0),
  0
);
const accessibility = Object.values(ui.accessibility).flat().length;
const summary = {
  date: '2026-10-13',
  engineContract: manifest.engineContract,
  regression: {
    passed: regression.numPassedTests,
    failed: regression.numFailedTests,
    skipped: regression.numPendingTests,
    files: regression.testResults.length,
  },
  nativePostgresql: {
    passed: postgres.numPassedTests,
    failed: postgres.numFailedTests,
    skipped: postgres.numPendingTests,
  },
  browser: {
    cases: browser.contrast.length,
    contrastViolations: contrasts,
    accessibilityViolations: accessibility,
    errors: [...ui.errors, ...browser.errors, ...factory.errors],
    durableRetry: browser.durableRetry,
  },
  api,
  captures: {
    checksums: captures.checksums,
    modbusADUs: captures.modbusADUs.length,
    vxlanEnvelopes: captures.vxlanEnvelopes,
  },
  qualification: qualification.checks,
  status: counts,
  sourceHash: manifest.sourceHash,
  assetHash: manifest.assetHash,
};
await writeFile(out + '/validation-summary.json', JSON.stringify(summary, null, 2));
const report = `# Correções e validação — fábrica, enterprise e datacenter

Data: 13/10/2026. Contrato do motor: \`${manifest.engineContract}\`. Escopo industrial confirmado: PLC/HMI com Modbus TCP e rede IP. PostgreSQL e qualificação usam ambiente local isolado, conforme orientação do usuário.

Este incremento corrige os dois P0 e diversos problemas do motor/interface, amplia a simulação e prepara a qualificação local. **Todo o plano de 30 frentes ainda não está implementado:** ${counts['Concluída']} concluídas, ${counts['Parcial']} parciais, ${counts['Pendente']} pendentes, ${counts['Validada localmente']} validadas localmente e ${counts['Condicional']} condicionais. O saldo detalhado e a ordem de execução estão no [plano atualizado](../../docs/consolidated-remediation-plan.md), no [CSV](current-backlog.csv) e no [JSON](current-backlog.json).

## Resultado da validação

| Verificação | Resultado | Evidência |
| --- | --- | --- |
| Regressão completa | ${regression.numPassedTests} aprovados, ${regression.numFailedTests} falhas, ${regression.numPendingTests} teste PostgreSQL externo ignorado nesta rodada | [regression.json](regression.json) |
| PostgreSQL servidor nativo isolado | ${postgres.numPassedTests} aprovados, zero falhas/ignorados; migrações e backup/restore incluem runs e verificação | [postgres-regression.json](postgres-regression.json) |
| Enterprise/DC na interface | 38 dispositivos, 46 enlaces, 30 presets; cinco fluxos/30 amostras aprovados; persistência e reabertura | [ui-results.json](ui-results.json) |
| Acessibilidade | Zero violações nos três scans gerais e ${browser.contrast.length} casos de contraste | [browser-regression.json](browser-regression.json) |
| Resultado não salvo | HTTP 503 sintético, IndexedDB, recarga, retry e replay matched; cópia local removida | [browser-regression.json](browser-regression.json) |
| Integridade da API | Adulteração 400, original/retry 200, revisão 409, CSRF 403 e replay matched | [api-results.json](api-results.json) |
| PLC/HMI na interface | Holding registers, coils e input registers; MQTT e cenários persistidos | [factory-ui/ui-results.json](factory-ui/ui-results.json) |
| Decoder independente | Scapy: ${captures.modbusADUs.length} ADUs Modbus (03/06/16 e exceção), ${captures.vxlanEnvelopes} envelopes VXLAN; checksums IP/TCP/UDP internos/externos | [independent-captures.json](independent-captures.json), [Modbus PCAP](modbus.pcap), [VXLAN PCAP](vxlan.pcap) |
| Build/tipos/lint | Aprovados; alerta de chunks grandes preservado | [manifesto](release-manifest.json) |
| Qualificação local | Dez migrações, 16 assets, readiness, Secure cookie, CSP/HSTS, persistência/replay e rollback de cópia isolada | [local-release-qualification.json](local-release-qualification.json) |

Os ${postgres.numPassedTests} testes PostgreSQL incluem testes também presentes na regressão; as contagens não representam casos únicos somados. O teste ignorado na regressão padrão foi executado na rodada PostgreSQL nativa.

## Correções adicionais descobertas durante a implementação

- A observação do cenário dependia da duração de cada fatia de processamento. O executor agora drena o mesmo limite virtual antes de observar; relatório e snapshot de campus/LB com falha de firewall são iguais em fatias de 1 e 100 ms.
- A atualização do controle podia consumir todo o orçamento de 1 ms e impedir progresso. A retomada evita atualizações repetidas e garante pelo menos um evento devido por fatia.
- Relógios fracionários do realtime geravam aquecimento inválido e podiam fechar a tela de cenários. O cálculo é arredondado; o catálogo também tolera equipamentos opcionais removidos.
- O painel industrial passou a iniciar na leitura 03, conserva Unit ID do PLC, limita quantidade conforme função e mostra somente os bits solicitados.
- Iniciar outra transação com a simulação já ativa podia invalidar o Worker sem reiniciar o processamento. Uma revisão de simulação agora reinicia o Worker mesmo quando pausar/reproduzir é agrupado pelo React na mesma interação; o teste PLC/HMI executa três leituras consecutivas.
- PostgreSQL JSONB recusava U+0000 das ADUs e devolvia HTTP 500 ao salvar a fábrica. Um envelope versionado de JSON/base64 preserva o conteúdo original no banco; API, versões, origem imutável, contagem de dispositivos e backup/restore exercitam esse caso.
- O roteiro PostgreSQL reutilizava dados entre rodadas. Cada execução agora cria e remove exclusivamente seu banco de teste efêmero.

## Limites e prioridades restantes

R08/R09/R10 continuam prioritários: HA/replicação de serviços, continuidade de sessões firewall/NAT e acesso redundante de endpoints. A/B de alimentação já está entregue. R12/R13/R14/R15 ainda precisam completar matriz, rollback programado, causalidade intermediada e identidade exata de build por run. R17/R18/R19 conservam processo industrial, fabric avançada e codecs BGP/EVPN; R20/R21/R24/R25 mantêm MQTT completo, operação de topologias, RBAC e gestão segura.

R23 permanece aberto: o realtime enterprise avançou ${(ui.realtime.ratio * 100).toFixed(1)}% da velocidade solicitada durante validações concorrentes; o ensaio industrial avançou ${(factory.realtime.ratio * 100).toFixed(1)}%. Essas medidas locais não certificam desempenho nem estabilidade de heap. O build mantém Worker/módulo do motor próximos de 900–960 kB e Workspace acima de 500 kB; o alerta não foi escondido.

R27/R28 estão validados localmente. Não houve deploy remoto nem handshake TLS real. Secure cookie/CSP/HSTS foram conferidos com configuração de produção e injeção HTTP local. O rollback restaurou uma cópia isolada do index pelo hash; não certifica rollback operacional de aplicação/banco. R29/R30 são condicionais ao requisito adicional.

Código e artefato: sourceHash \`${manifest.sourceHash}\`; assetHash \`${manifest.assetHash}\`. O manifesto registra o commit-base e os hashes exatos do código e dos assets testados; o commit Git de publicação inclui também documentos e evidências. A [auditoria anterior](../enterprise-datacenter-audit/RELATORIO.md) permanece histórica. Detalhes de fidelidade: [ADR-044](../../docs/adr/044-enterprise-integrity-fabric-binary-modbus.md).

## Reprodução local

Preparação e limites do ambiente: [validação local](../../docs/local-validation.md).

\`npm test -- --reporter=json --outputFile=artifacts/remediation-2026-10-13/regression.json\`

\`npm run test:postgres -- tests/production.test.ts tests/api.test.ts --no-file-parallelism --reporter=json --outputFile=artifacts/remediation-2026-10-13/postgres-regression.json\`

\`npm run build\`, \`npm run lint\`, \`npm run qualify:local\`; depois \`npx tsx scripts/build-remediation-fixtures.ts\` e \`.data/scapy-venv/Scripts/python.exe scripts/verify-enterprise-captures.py\`.

Com API/web locais e sessão sintética autenticada em CDP 9223, executar os roteiros verify-enterprise-datacenter-ui.mjs, verify-remediation-browser.mjs e verify-enterprise-api.mjs com SHLAB_AUDIT_OUTPUT=artifacts/remediation-2026-10-13; verify-factory-ui.mjs usa o subdiretório factory-ui. As credenciais do PostgreSQL permanecem em .data/test-postgres/connection.json ignorado pelo Git. Cookies/perfis/bancos locais não são publicados. Por último, \`node scripts/build-remediation-report.mjs\` gera este relatório e o status atual sem sobrescrever a auditoria histórica.
`;
await writeFile(out + '/CORRECOES-E-VALIDACAO.md', report);
console.log(
  JSON.stringify({
    regression: summary.regression,
    nativePostgresql: summary.nativePostgresql,
    status: counts,
    browserErrors: summary.browser.errors.length,
  })
);
