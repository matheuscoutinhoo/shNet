import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import console from 'node:console';
const out = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/ha-remediation-2026-10-13';
const read = async (name) => JSON.parse(await readFile(out + '/' + name, 'utf8'));
const [regression, postgres, enterprise, factory, ui, integrated, manifest, qualification] =
  await Promise.all([
    read('regression.json'),
    read('postgres-regression.json'),
    read('enterprise-ha-results.json'),
    read('factory-ha-results.json'),
    read('state-sync-ui-results.json'),
    read('ui-results.json'),
    read('release-manifest.json'),
    read('local-release-qualification.json'),
  ]);
if (
  !regression.success ||
  regression.numFailedTests ||
  !postgres.success ||
  postgres.numFailedTests ||
  !enterprise.passed ||
  !factory.passed ||
  !ui.passed
)
  throw new Error('Há falhas pendentes; não gere relatório aprovado.');
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
    const previous = initial.items.find((item) => item.id === id);
    if (!previous) throw new Error('ID desconhecido: ' + id);
    return { ...previous, status, delivered, remaining };
  });
if (items.length !== 30 || new Set(items.map((i) => i.id)).size !== 30)
  throw new Error('Backlog incompleto.');
const counts = Object.fromEntries(
  Object.entries(Object.groupBy(items, (i) => i.status)).map(([key, value]) => [key, value.length])
);
await writeFile(
  out + '/current-backlog.json',
  JSON.stringify({ date: '2026-10-13', engineContract: manifest.engineContract, counts, items }, null, 2)
);
const csv = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
await writeFile(
  out + '/current-backlog.csv',
  [
    ['ID', 'Fase', 'Prioridade', 'Status', 'Título', 'Entregue', 'Saldo'].map(csv).join(','),
    ...items.map((i) =>
      [i.id, i.phase, i.priority, i.status, i.title, i.delivered, i.remaining].map(csv).join(',')
    ),
  ].join('\n') + '\n'
);
const summary = {
  date: '2026-10-13',
  engineContract: manifest.engineContract,
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
  enterprise,
  factory,
  ui,
  integrated,
  qualification,
  sourceHash: manifest.sourceHash,
  assetHash: manifest.assetHash,
  counts,
};
await writeFile(out + '/validation-summary.json', JSON.stringify(summary, null, 2));
await writeFile(
  out + '/CORRECOES-E-VALIDACAO.md',
  `# Correções HA — fábrica, enterprise e datacenter

Contrato do motor: **${manifest.engineContract}**. Esta rodada acrescenta R09 ao incremento anterior; não conclui todas as 30 frentes.

O backup agora recebe estado de firewall TCP/UDP/ICMP e NAT/PAT por um cabo dedicado. O canal considera energia, porta/cabo, perda, latência e jitter; conserva interfaces mapeadas, sequências e prazos. Revisões, reconciliação e remoções impedem cópia instantânea, sobrescrita por updates antigos e ressurreição após reset. Políticas divergentes e colisões são recusadas.

Foi corrigido também o agendamento NAT por prazo absoluto: o cenário enterprise completo reproduziu uma diferença de ponto flutuante entre timer e binding. O diff de configuração omite o estado e os contadores HA. Os dois templates incluem o canal e a interface/CLI expõem disponibilidade, pendências e recusas.

A troca de zoom/overview registrava 89 avisos distintos de handles no canvas. Os nós agora atualizam sua medição quando mudam de modo/portas e cada enlace aguarda os dois pontos medidos. A regressão visual confirma os 47 cabos enterprise e os 48 da fábrica nos modos geral/detalhado, sem avisos e sem perder os enlaces ao mudar o viewport.

| Validação | Resultado | Evidência |
| --- | --- | --- |
| Regressão completa | ${regression.numPassedTests} aprovados, ${regression.numFailedTests} falhas, ${regression.numPendingTests} teste externo não executado | [regression.json](regression.json) |
| PostgreSQL nativo local | ${postgres.numPassedTests} aprovados, ${postgres.numFailedTests} falhas, ${postgres.numPendingTests} skips | [postgres-regression.json](postgres-regression.json) |
| Enterprise/DC | ${enterprise.devices} dispositivos/${enterprise.links} enlaces; mesma conexão ERP e WAN/PAT recebe before&#124;after&#124;failback&#124;; checkpoint determinístico | [enterprise-ha-results.json](enterprise-ha-results.json) |
| Fábrica Modbus binário | Mesma conexão SCADA→PLC recebe transações 1/2/3 durante failover/failback; escrita confirma registro ${factory.register0} | [factory-ha-results.json](factory-ha-results.json) |
| Interface nos dois templates | Configuração/desativação/reconfiguração e save/reopen; desktop/mobile com zero violações Axe e sem overflow | [state-sync-ui-results.json](state-sync-ui-results.json) |
| Cenário integrado da aplicação | 30 presets disponíveis; cinco fluxos/30 amostras aprovados e resultados persistidos/reabertos | [ui-results.json](ui-results.json) |
| Capturas independentes | Scapy valida 51 checksums IPv4, 35 TCP, 8 UDP, 8 ADUs Modbus e 8 envelopes VXLAN | [independent-captures.json](independent-captures.json) |
| Build e qualificação local | Typecheck/build/lint; manifesto, assets, readiness, persistência/replay e cópia/rollback do artefato | [release-manifest.json](release-manifest.json), [local-release-qualification.json](local-release-qualification.json) |

Os testes do PostgreSQL repetem parte da suíte geral; as contagens não devem ser somadas como testes distintos. A qualificação é local: não houve deploy remoto nem handshake TLS real.

O realtime integrado atingiu razão ${integrated.realtime.ratio.toFixed(3)} com a regressão executando em paralelo; não é um benchmark isolado de capacidade. O build ainda possui chunks acima de 500 kB. R23 permanece aberto para perfis/p95/heap e otimização. ${ui.canvasWarnings?.length ? 'A interface registrou ' + ui.canvasWarnings.length + ' avisos distintos de handles do React Flow ao alternar zoom/overview; essa correção visual permanece em R21.' : 'Nenhum aviso de handles foi observado nesta rodada de configuração HA.'}

## Reprodução

Execute npm test, npm run build e npm run lint. npx tsx scripts/verify-enterprise-ha.ts gera os ensaios enterprise/fábrica. Com o cluster isolado local ativo, npm run test:postgres -- tests/production.test.ts tests/api.test.ts --no-file-parallelism valida migrações/persistência/backup. Os scripts de browser usam a sessão sintética local CDP 9223 sem publicar credenciais. SHLAB_AUDIT_OUTPUT seleciona esta pasta nos scripts de UI, fixtures e qualificação.

## Limites e prioridades mantidas

R09 cobre estado básico de firewall/NAT/PAT. Inspeção de aplicação, SIP ALG, hairpin, codec proprietário do canal e fencing não são replicados; VRRP sozinho não replica estado. Falha antes da cópia, partição e retorno mais rápido que a réplica podem interromper conexões. Contadores/pendências não certificam SLA: o ensaio por fluxo continua necessário. [ADR-045](../../docs/adr/045-firewall-nat-state-synchronization.md).

O plano contém **${counts['Concluída']} concluídas, ${counts['Parcial']} parciais, ${counts['Pendente']} pendentes, ${counts['Validada localmente']} validadas localmente e ${counts['Condicional']} condicionais**. Próximas prioridades: **R08** (HA/replicação de serviços, dados e WAN) e **R10** (NICs/caminhos redundantes de endpoints). Os saldos de cobertura, processo industrial, fabric, MQTT, operação, escala, RBAC e SNMPv3 permanecem no [plano consolidado](../../docs/consolidated-remediation-plan.md) e no [backlog desta rodada](current-backlog.json).
`
);
console.log(JSON.stringify({ regression: summary.regression, postgres: summary.postgres, counts }));
