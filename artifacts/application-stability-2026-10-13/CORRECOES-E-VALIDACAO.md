# Correções do funcionamento da aplicação — 13/10/2026

Contrato **2026.10.13.6**, migração SQL **011**. Este incremento atende recuperação/persistência, configuração/execução confiável, diagnóstico e operação. Novos protocolos e features industriais foram adiados conforme orientação do usuário. Requisitos e saldo estão no [plano consolidado](../../docs/consolidated-remediation-plan.md); contratos no [ADR-046](../../docs/adr/046-application-recovery-and-run-integrity.md).

| Correção | Evidência |
| --- | --- |
| Autosave durante alterações contínuas, save finito, API com timeout/erros recuperáveis | Build real em navegador: revisão 2, clock salvo 4738.6 ms, save manual resolvido; testes API de rede/HTML/JSON inválidos. |
| Rascunhos, revisão/cópia/arquivo em conflitos, quota, recuperação de projeto excluído | 5 fluxos completos no navegador; IndexedDB + API com 503 controlado; falha conjunta API/armazenamento local explícita. |
| Sessão expirada com armazenamento indisponível | Build compilado mantém editor/topologia/nome para exportação; o processamento é pausado e não há redirecionamento com trabalho desprotegido. |
| Lote atômico, proposta protegida, patch/rollback, formulários, restore DHCP/BGP | Testes de determinismo 1/100 ms, rejeição/rollback, aliases, aplicação pela UI e replay matched. |
| Origem exata do motor/Worker e admissão compartilhada de replay | Fingerprint e SHA dos bytes do Worker carregado coincidem com o servidor; API recusa divergência; lease ocupado/expirado/release testados. |
| Evidências overlay/LB, retenção e preflight | Intermediários/health checks/fluxo permitido isolados; captura limitada indicada; próximo salto e regra IPv4/IPv6 coberta identificados. |
| Canvas e limites de memória/CPU | Autolayout/undo/redo, grupos/RF preservados, clones VTEP/HA válidos, histórico limitado e estado realtime idêntico ao motor sem fatias. |
| Regressão completa | **738 aprovados, 0 falhas, 1 ignorado** (739 casos). O caso PostgreSQL externo ignorado nesta rodada tem execução nativa abaixo. |
| PostgreSQL nativo isolado | **57 aprovados, 0 falhas, 0 ignorados**, incluindo API, migrações e backup/restore com identidade do build. Estes casos sobrepõem a suíte completa; não somar contagens. |
| UI/acessibilidade | Desktop, mobile e gerenciador mobile: **zero violações Axe, zero pageerrors e sem overflow horizontal**; build compilado também sem pageerrors. |
| Qualificação local | 11 migrações e 14 assets, cookie Secure/CSP/HSTS/readiness, origem imutável/replay matched e cópia restaurada do artefato. |
| Empacotamento do runtime | Cópia isolada dos arquivos declarados pelo Dockerfile inicia a API com 11 migrações e fingerprint/Worker corretos; helper de identidade incluído na imagem. Não executa daemon/build Docker. |

## Escala e limites

O JS inicial do painel tem **277.53 kB**, porque o catálogo deixou de importar o motor. Workspace/Workers permanecem grandes e o build ainda mostra avisos acima de 500 kB; eles não foram suprimidos. O tempo de abertura observado (1094.73 ms) é uma verificação funcional local, sem série estatística de carregamento.

| Carga / três repetições | p95 de fatia (ms) | Razão virtual/real | Heap Node durante execução (MiB) | Respostas |
| --- | --- | --- | --- | --- |
| 38 dispositivos — enterprise/DC nativo, HTTP ERP/LB + controle | 23.12–24.08 | 1.61–1.78 | 125.04–153.01 | 12/12, 12/12, 12/12 |
| 100 dispositivos — árvore L2, seis ICMP | 14.48–20.83 | 74.28–103.63 | 76.19–115.56 | 6/6, 6/6, 6/6 |
| 500 dispositivos — árvore L2, seis ICMP | 22.71–22.87 | 11.42–11.97 | 79.13–138.41 | 6/6, 6/6, 6/6 |
| 2000 dispositivos — árvore L2, seis ICMP | 30.71–31.72 | 0.84–0.89 | 150.19–180.6 | 6/6, 6/6, 6/6 |

Benchmark Node isolado, aquecimento fora da medição, orçamento de 20 ms mais delta. O caso enterprise e as árvores L2 são cargas diferentes. Heap medido é de processo Node, não do navegador. O caso de 2.000 nós não garante realtime 1×; o produto indica lag e permite reduzir a velocidade ou pausar. Captura descartada por retenção é distinta de perda de rede. [Dados completos](performance.json) preservam bytes de deltas/retidos e repetições; a rodada anterior à agregação de métricas está em performance-before-metrics-optimization.json, sem alegar ganho causal por poucas medições.

## Identidade e reprodução

Fontes do motor: **74b465348946f820bd75040c2b550cf6b56a51be63066e6da3a9a01c5852df4f**. Worker carregado: **1bfe1e35de4ca9fe3a284e3c2e12201dc582be9882c81d8df59bd289aeb15039**.

Manifesto de fontes da aplicação: **c9644c1719eb3f432a08c6d954e49deba2ec94b4a8c0bba194945a4324bc4084**. Assets: **049fdbb9c724aafddc45ad72b681367ebcade47034ebc9b97f2d8cbb3af1d70d**. [Manifesto](release-manifest.json) e [qualificação](local-release-qualification.json) registram arquivos individuais. A normalização LF do fingerprint do motor permite comparar checkouts; o manifesto de release registra os bytes qualificados localmente.

Comandos: npm test -- --reporter=json --outputFile=artifacts/application-stability-2026-10-13/regression.json; npm run build; npm run lint; npm run test:postgres -- tests/production.test.ts tests/api.test.ts --no-file-parallelism --reporter=json --outputFile=artifacts/application-stability-2026-10-13/postgres-regression.json; node --expose-gc --import tsx scripts/benchmark-application.ts; node scripts/verify-application-stability-ui.mjs; npx tsx scripts/verify-built-application.ts; node scripts/verify-runtime-package.mjs; npm run qualify:local. Use SHLAB_AUDIT_OUTPUT para outra pasta. Scripts de browser usam sessão sintética local em memória; o roteiro do build cria banco/servidor descartáveis.

Novos protocolos, HA de serviços/NICs, processo industrial e colaboração/RBAC de equipe são ampliações fora deste incremento. Precisão da recuperação é amostral; evidência limitada por retenção não certifica um caminho completo. Deploy remoto, handshake TLS real e rollback operacional de aplicação/banco continuam aguardando homologação. O rollback local exercitado restaura uma cópia do artefato, sem representar rollback de produção. Nenhuma dessas parcelas foi marcada como entregue.
