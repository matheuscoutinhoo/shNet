# Correções e validação — fábrica, enterprise e datacenter

Data: 13/10/2026. Contrato do motor: `2026.10.13.4`. Escopo industrial confirmado: PLC/HMI com Modbus TCP e rede IP. PostgreSQL e qualificação usam ambiente local isolado, conforme orientação do usuário.

Este incremento corrige os dois P0 e diversos problemas do motor/interface, amplia a simulação e prepara a qualificação local. **Todo o plano de 30 frentes ainda não está implementado:** 10 concluídas, 10 parciais, 6 pendentes, 2 validadas localmente e 2 condicionais. O saldo detalhado e a ordem de execução estão no [plano atualizado](../../docs/consolidated-remediation-plan.md), no [CSV](current-backlog.csv) e no [JSON](current-backlog.json).

## Resultado da validação

| Verificação | Resultado | Evidência |
| --- | --- | --- |
| Regressão completa | 700 aprovados, 0 falhas, 1 teste PostgreSQL externo ignorado nesta rodada | [regression.json](regression.json) |
| PostgreSQL servidor nativo isolado | 56 aprovados, zero falhas/ignorados; migrações e backup/restore incluem runs e verificação | [postgres-regression.json](postgres-regression.json) |
| Enterprise/DC na interface | 38 dispositivos, 46 enlaces, 30 presets; cinco fluxos/30 amostras aprovados; persistência e reabertura | [ui-results.json](ui-results.json) |
| Acessibilidade | Zero violações nos três scans gerais e 12 casos de contraste | [browser-regression.json](browser-regression.json) |
| Resultado não salvo | HTTP 503 sintético, IndexedDB, recarga, retry e replay matched; cópia local removida | [browser-regression.json](browser-regression.json) |
| Integridade da API | Adulteração 400, original/retry 200, revisão 409, CSRF 403 e replay matched | [api-results.json](api-results.json) |
| PLC/HMI na interface | Holding registers, coils e input registers; MQTT e cenários persistidos | [factory-ui/ui-results.json](factory-ui/ui-results.json) |
| Decoder independente | Scapy: 8 ADUs Modbus (03/06/16 e exceção), 8 envelopes VXLAN; checksums IP/TCP/UDP internos/externos | [independent-captures.json](independent-captures.json), [Modbus PCAP](modbus.pcap), [VXLAN PCAP](vxlan.pcap) |
| Build/tipos/lint | Aprovados; alerta de chunks grandes preservado | [manifesto](release-manifest.json) |
| Qualificação local | Dez migrações, 16 assets, readiness, Secure cookie, CSP/HSTS, persistência/replay e rollback de cópia isolada | [local-release-qualification.json](local-release-qualification.json) |

Os 56 testes PostgreSQL incluem testes também presentes na regressão; as contagens não representam casos únicos somados. O teste ignorado na regressão padrão foi executado na rodada PostgreSQL nativa.

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

R23 permanece aberto: o realtime enterprise avançou 62.1% da velocidade solicitada durante validações concorrentes; o ensaio industrial avançou 101.2%. Essas medidas locais não certificam desempenho nem estabilidade de heap. O build mantém Worker/módulo do motor próximos de 900–960 kB e Workspace acima de 500 kB; o alerta não foi escondido.

R27/R28 estão validados localmente. Não houve deploy remoto nem handshake TLS real. Secure cookie/CSP/HSTS foram conferidos com configuração de produção e injeção HTTP local. O rollback restaurou uma cópia isolada do index pelo hash; não certifica rollback operacional de aplicação/banco. R29/R30 são condicionais ao requisito adicional.

Código e artefato: sourceHash `0480ee4fd5042c5baa57baebb92f2cb91bcd070f70792cdf0ce4c8200a157cf1`; assetHash `831d48f42fbd35360e8d927361654457b58c914988fd5e9075c104ff04f68d6a`. O manifesto registra o commit-base e os hashes exatos do código e dos assets testados; o commit Git de publicação inclui também documentos e evidências. A [auditoria anterior](../enterprise-datacenter-audit/RELATORIO.md) permanece histórica. Detalhes de fidelidade: [ADR-044](../../docs/adr/044-enterprise-integrity-fabric-binary-modbus.md).

## Reprodução local

Preparação e limites do ambiente: [validação local](../../docs/local-validation.md).

`npm test -- --reporter=json --outputFile=artifacts/remediation-2026-10-13/regression.json`

`npm run test:postgres -- tests/production.test.ts tests/api.test.ts --no-file-parallelism --reporter=json --outputFile=artifacts/remediation-2026-10-13/postgres-regression.json`

`npm run build`, `npm run lint`, `npm run qualify:local`; depois `npx tsx scripts/build-remediation-fixtures.ts` e `.data/scapy-venv/Scripts/python.exe scripts/verify-enterprise-captures.py`.

Com API/web locais e sessão sintética autenticada em CDP 9223, executar os roteiros verify-enterprise-datacenter-ui.mjs, verify-remediation-browser.mjs e verify-enterprise-api.mjs com SHLAB_AUDIT_OUTPUT=artifacts/remediation-2026-10-13; verify-factory-ui.mjs usa o subdiretório factory-ui. As credenciais do PostgreSQL permanecem em .data/test-postgres/connection.json ignorado pelo Git. Cookies/perfis/bancos locais não são publicados. Por último, `node scripts/build-remediation-report.mjs` gera este relatório e o status atual sem sobrescrever a auditoria histórica.
