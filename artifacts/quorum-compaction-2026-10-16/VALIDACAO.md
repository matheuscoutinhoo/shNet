# Compactação de quorum e recuperação SQL — evidências

Data: 16/10/2026. Contrato `2026.10.16.3`. Revisão de código `3e3884d42d61501007468ea4f3b65740893b8ae3`.

Estado: qualificação local e [CI final](https://github.com/matheuscoutinhoo/shNet/actions/runs/38956201045) aprovadas nos cinco gates. Integrada à main, publicada e conferida em https://shnet.up.railway.app/ em 16/10/2026. A [conferência pública](railway/remote-release.json) verificou fonte, contrato, Worker, TLS, headers, readiness e proteção dos endpoints privados. A [comparação dos 26 assets](railway/local-assets.json) confirmou todos os arquivos JS/CSS/fontes do build local, inclusive estilos carregados sob demanda. Somente consultas de leitura, sem restore/rollback do banco Railway real. A execução anterior, substituída pela correção final de importação, não é a evidência de qualificação desta versão.

## Resultados da CI

- [1.000 testes aprovados](ci-qualified/regression.json), zero falhas e um caso P-PCAP adiado em 97 arquivos. A [matriz histórica](ci-qualified/case-coverage.json) conserva 114 casos aprovados e um adiado entre 115 catalogados.
- 144 cenários de navegador aprovados, sem falhas, skips ou instabilidade: [72 no tema claro](ci-qualified/sistema-claro.json) e [72 no tema escuro](ci-qualified/sistema-escuro.json).
- [26 ensaios de disponibilidade e 26 de isolamento](ci-qualified/integrated-availability.json) aprovados em modelos enterprise de 37 equipamentos e fábrica de 53. O resumo preserva métricas por fluxo e hashes dos relatórios completos disponíveis no artefato `resilient-laboratories` da CI. Esses relatórios executam por TSX e conservam o marcador binário `development`; a fonte é identificada pelo hash do gerador. O Worker compilado é conferido separadamente.
- [Containers](ci-qualified/container-qualification.json): HTTPS/WSS, ownership, rollback de imagem e restore PostgreSQL isolado aprovados.
- [Capacidade enterprise](ci-qualified/enterprise-capacity/enterprise-capacity.json), [20 projetos com 500 equipamentos](ci-qualified/enterprise-capacity/api-capacity-20-500.json) e [20 projetos com 2000 equipamentos](ci-qualified/enterprise-capacity/api-capacity-20-2000.json) aprovados.
- [Build da CI](ci-qualified/built-application-ui.json) com fonte, Worker e entrada do cliente iguais ao build local. [Resumo dos cinco gates](ci-qualified/summary.json).

## Resultados locais

- [Regressão completa](local-regression.json): 1.000 testes aprovados, zero falhas, um caso P-PCAP adiado, em 97 arquivos. PostgreSQL isolado, com banco temporário removido pelo executor e cluster encerrado após a suíte.
- Quatro cenários focados de navegador aprovados nos dois temas, sem falhas, skips ou resultados flaky: [resumo](local-qualification.json). Exercitam SQL pela rede, compactação manual, histórico com 300 operações, exclusão replicada, save/reload, mobile e recuperação de leituras HTTP 429.
- Formatação, lint, TypeScript e build aprovados. JS/CSS: 2.523.216 bytes descomprimidos e 666.300 bytes Brotli, com 23 assets pré-comprimidos. O aviso existente de chunks acima de 500 kB continua visível.
- [Build compilado](build/built-application-ui.json): Worker real, replay, autosave contínuo e recuperação de falhas de painel, sessão e storage aprovados. O tempo de abertura é uma amostra, não p95. A fonte e o Worker coincidem com a imagem de produção aprovada no gate de containers.

Fonte: `922d9abf4c55a0b97c107469992d691e8157185b5ba50837f909b0eead39ba74`. Worker: `28eab107817eb0612b57a0a900e6c69f753a0efa4acc7c54aef3f3deecac4521`. Entrada do cliente: `/assets/index-D5131xox.js`, 271.562 bytes.

## Implementação e falhas corrigidas

O [ADR-061](../../docs/adr/061-quorum-compaction.md) registra índices absolutos, compactação do prefixo confirmado e transferência em blocos com instalação atômica. O limite histórico de 256 operações deixa de encerrar um laboratório cujo estado vivo permanece dentro do orçamento. O [roteiro SQL](../../docs/sql-quorum-lab.md) permite reproduzir o comportamento.

Nove testes novos do núcleo exercitam prefixo confirmado, sufixo não confirmado, eleições, líder antigo, perda, duplicação, corrupção, UTF-8, retomada parcial e quota. Dois testes SQL novos executam mais de 256 transações HTTP/TCP e salvam/restauram uma réplica durante a recepção física de um checkpoint. Os testes existentes também passaram a conferir a continuidade de um histórico legado cheio e a contenção de propostas sem maioria.

A qualificação encontrou duas falhas adicionais, reproduzidas antes da correção: eleição local durante uma transferência mantinha um buffer do termo anterior e interrompia a simulação; importação podia aceitar termos confirmados divergentes quando os estados materializados eram iguais. O receptor agora descarta o buffer ao iniciar eleição, e a validação compara também o termo no índice confirmado comum. Os testes de regressão correspondentes passaram na fonte final.

## Limites e pendências

Até 256 entradas retidas, 128 propostas sem confirmação e 512 KiB de dados materializados por checkpoint, compartilhados entre chaves e tabelas. Compactação nunca incorpora entradas não confirmadas nem elimina dados vivos para cumprir quota. Saves antigos acima do orçamento preservam seus dados e podem precisar de redução antes de compactar. O checkpoint não conserva recibos individuais nem auditoria de toda a história descartada.

Transferência usa a imagem atual do emissor; nova compactação reinicia o envio daquele par. Não há SLA universal de recuperação sob compactação contínua. SHA-256 verifica integridade, sem autenticar o arquivo. Permanecem composição fixa, IPs individuais e resultado indeterminado em timeout; não há migração de TCP nem retry automático de mutações.

**R08 permanece parcial:** autoridade de endereço/descoberta do líder e adaptadores de dados/logs/sessões dos demais serviços. R19 mantém captura universal P-PCAP e os codecs restantes; R18/R20/R25 e extensões de R22 continuam no [plano consolidado](../../docs/consolidated-remediation-plan.md). Restore/rollback é qualificado em ambiente isolado, conforme a escolha do usuário.
