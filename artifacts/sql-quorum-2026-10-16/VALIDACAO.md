# Banco SQL confirmado por maioria — evidências

Data: 16/10/2026. Contrato `2026.10.16.2`. Revisão de código `656527afb329b9dcee85d9291e977bbcefb6aed0`.

Estado: qualificação local e [CI](https://github.com/matheuscoutinhoo/shNet/actions/runs/38939122872) aprovadas. Os cinco gates passaram. Versão integrada à main, publicada e conferida em https://shnet.up.railway.app/ em 16/10/2026. A [conferência pública](railway/remote-release.json) verificou fonte, contrato, Worker, TLS, headers, readiness e proteção dos endpoints privados. A [comparação dos 26 assets](railway/local-assets.json) confere todos os arquivos locais de JS/CSS/fontes com seus bytes publicados, incluindo estilos carregados sob demanda. Foram somente consultas de leitura; não houve restore/rollback do banco Railway real.

## Resultados da CI

- [989 testes aprovados](ci-qualified/regression.json), zero falhas, um caso adiado em 96 arquivos; [115 casos históricos](ci-qualified/case-coverage.json), com 114 aprovados e P-PCAP adiado.
- 144 cenários de navegador aprovados, sem falhas, skips ou resultados flaky: [72 no tema claro](ci-qualified/sistema-claro.json) e [72 no tema escuro](ci-qualified/sistema-escuro.json).
- [Containers](ci-qualified/container-qualification.json): HTTPS/WSS, ownership, rollback de imagem e restore PostgreSQL isolado aprovados.
- [Capacidade enterprise](ci-qualified/enterprise-capacity/enterprise-capacity.json), [20 projetos com 500 equipamentos](ci-qualified/enterprise-capacity/api-capacity-20-500.json) e [20 projetos com 2000 equipamentos](ci-qualified/enterprise-capacity/api-capacity-20-2000.json) aprovados.
- [Build da CI](ci-qualified/built-application-ui.json) com a mesma fonte, Worker e entrada do cliente da execução local. [Resumo dos cinco gates](ci-qualified/summary.json).

## Resultados locais

- [Regressão](local-regression.json): 989 testes aprovados, zero falhas, um caso P-PCAP adiado, em 96 arquivos; PostgreSQL isolado criado/removido pelo executor, cluster encerrado após a suíte.
- Quatro cenários focados de navegador aprovados nos dois temas, sem falhas, skips ou resultados flaky: [resumo](local-qualification.json).
- Formatação, lint, TypeScript e build aprovados. JS/CSS: 2.514.613 bytes descomprimidos e 663.802 bytes Brotli, com 23 assets pré-comprimidos. O aviso de chunks acima de 500 kB permanece visível.
- [Build compilado](build/built-application-ui.json): Worker real e replay conferidos, autosave contínuo, falha de painel recuperada e preservação do trabalho sob falha de sessão/storage. O tempo de abertura deste smoke é uma amostra, não p95.

Fonte: `7f74417b6df33b8a775bda38607dee7cbe1dc37c827fa4ef9b5b5619108238f1`. Worker: `94b27fc000ac06c225d3bc8205eddbb14cf60db5c0178cfc969bad856ee6dbc6`. Entrada do cliente: `/assets/index-CZsGP1PD.js`, 271.562 bytes.

## Regressão integrada na CI

Os [26 ensaios de disponibilidade e 26 de isolamento](ci-qualified/integrated-availability.json) passaram com a fonte desta revisão, em modelos de 37 equipamentos enterprise e 53 de fábrica. O resumo preserva métricas por fluxo e hashes dos relatórios completos disponíveis no artefato `resilient-laboratories` da execução. Os ensaios são executados por TSX e conservam o marcador binário `development`; a fonte é identificada pelo hash calculado pelo gerador. A identidade do Worker compilado é conferida separadamente no build local e na CI.

## Implementação e aceites

O [ADR-060](../../docs/adr/060-quorum-backed-sql-service.md) registra o vínculo do banco SQL didático ao histórico de quorum. Alterações e SELECT recebem resposta HTTP/TCP apenas após confirmação de maioria. Leituras novas exigem confirmação própria; a cópia histórica de um líder isolado não é servida como leitura atual.

Treze testes novos exercitam CRUD/rejeição SQL ordenados, ausência de resposta antes do commit, credenciais, seguidores, partição, energia, eleição, retorno, snapshot em trânsito, limites, inicialização atômica, clonagem e remoção. Um caso comprova que uma operação pode ser confirmada depois do timeout; a resposta informa resultado indeterminado e não desencadeia retry de alteração. Outro conserva o half-close TCP enquanto até 32 respostas aguardam maioria.

Os quatro cenários focados de navegador passaram nos dois temas: SQL pelo desktop (CREATE/INSERT/SELECT e save/reload), além do armazenamento de quorum com recuperação de HTTP 429. O [roteiro](../../docs/sql-quorum-lab.md) permite reproduzir o laboratório pela interface.

## Limites e pendências

Até 256 entradas por membro, incluindo consultas/barreiras/eleições, sem compactação ou composição dinâmica. As tabelas confirmadas são preservadas ao atingir o limite; novas consultas são recusadas. Cada réplica usa IP individual. A eleição é automática, mas a seleção do novo endereço pelo cliente, VIP e migração de TCP não fazem parte deste incremento. Desabilitar somente o listener SQL não transfere a liderança de consenso.

Remover membro/grupo desabilita todos os bancos vinculados; cópias históricas permanecem. Clonar todo o grupo cria outro grupo vazio; cópias isoladas ficam desabilitadas. A importação de snapshot valida coerência com o histórico, sem autenticar criptograficamente o arquivo.

**R08 permanece parcial:** faltam os adaptadores/estados dos demais serviços e as parcelas de disponibilidade indicadas acima. R19 mantém captura universal P-PCAP adiada; R18/R20/R25 e extensões de R22 continuam no [plano consolidado](../../docs/consolidated-remediation-plan.md). A qualificação de rollback/restore usa ambiente isolado na CI, conforme a escolha do usuário.
