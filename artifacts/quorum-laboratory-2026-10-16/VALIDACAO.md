# Quorum e recuperação de leituras — evidências

Data: 16/10/2026. Contrato `2026.10.16.1`. Revisão de código: `6d39f0365918c87f381f78b62047a06a4c7b5d7f`.

Estado: qualificação local e [CI final](https://github.com/matheuscoutinhoo/shNet/actions/runs/38907945007) concluídas. Os cinco gates passaram. Versão integrada à main e publicada em https://shnet.up.railway.app/; a [conferência pública](railway/remote-release.json) comprova contrato, fonte, Worker, TLS, headers, readiness e proteção dos endpoints privados. Os hashes dos 21 assets remotos também coincidem com os arquivos do build local, incluindo a entrada do cliente com a correção de HTTP 429. A conferência foi somente de leitura; não realizou restore ou rollback do banco Railway.

## Resultados da CI

- 976 testes aprovados, zero falhas e um teste adiado (P-PCAP), em 95 arquivos: [regressão](ci-qualified/regression.json).
- 142 cenários de navegador aprovados, 71 por tema, sem retries aprovados como flaky: [claro](ci-qualified/sistema-claro.json) e [escuro](ci-qualified/sistema-escuro.json).
- [Containers](ci-qualified/container-qualification.json): HTTPS/WSS, isolamento de ownership, rollback de imagem e restore PostgreSQL em ambiente isolado aprovados.
- [Capacidade enterprise](ci-qualified/enterprise-capacity/enterprise-capacity.json), [20 projetos de 500 equipamentos](ci-qualified/enterprise-capacity/api-capacity-20-500.json) e [20 projetos de 2000 equipamentos](ci-qualified/enterprise-capacity/api-capacity-20-2000.json) aprovados.
- [Build compilado na CI](ci-qualified/built-application-ui.json) com a mesma fonte, Worker e entrada do cliente da execução local. [Resumo dos gates](ci-qualified/summary.json) e [cobertura histórica](ci-qualified/case-coverage.json).

## Resultados locais

- 976 testes aprovados, zero falhas, um teste adiado em 95 arquivos: [regressão](local-regression.json).
- Quatro cenários de navegador aprovados nos dois temas: quorum/recarga com 429 injetado e PAT/ACL/recuperação/persistência. O POST de visita limitado não é repetido.
- Formatação, lint, TypeScript e build aprovados. A [verificação do build](build/built-application-ui.json) confere Worker real, recuperação, autosave contínuo e replay.
- JS/CSS: 2.505.976 bytes descomprimidos, 661.625 bytes Brotli e 23 assets pré-comprimidos. O aviso de chunks acima de 500 kB continua visível; não foi suprimido.
- [Resumo local](local-qualification.json). A qualificação usa a última execução com fonte congelada. Execuções anteriores, com revisão carregada durante alterações ou timeout sob verificações concorrentes, não são aceites. O BGP passou sem mudar o timeout ou as assertions.

Fonte do motor: `260d255ce0fca821e0a1c4c6a9a8e7ae1b99429739fe8e645e25ac090f42c965`.

Worker: `27673534aaac8e339bd4ff90061317692d1d0262a8673181c3b3a5be4d70391b`.

Entrada do cliente: `/assets/index-hIWU0xhw.js`, 271.333 bytes. A fonte do motor não substitui a identidade do cliente web; a qualificação também compara a entrada compilada.

## Falha encontrada durante a qualificação

A execução anterior não foi publicada: [CI 38903556681](https://github.com/matheuscoutinhoo/shNet/actions/runs/38903556681). O navegador claro recebeu três respostas 429 com `Retry-After: 1` ao consultar atividades e reabrir o projeto. O [diagnóstico sanitizado](http-429-diagnosis.json) preserva método, rota, status e intervalo, sem cookies, tokens ou identidade de conta.

O [ADR-059](../../docs/adr/059-shared-nat-and-read-cooldowns.md) registra a correção de cota por usuário validado, proteção de autenticação por IP, repetição limitada de GET e desacoplamento da cota de visitas. Não foram aumentados ou desativados os limites para passar a suíte.

## Alcance

O [ADR-058](../../docs/adr/058-quorum-laboratory.md) descreve o novo modelo de estudo e seus limites. Há eleição por mensagens, maioria de réplicas completas, preservação de votos, isolamento de gravações não confirmadas, retorno do líder antigo e snapshot com mensagens em trânsito. O armazenamento é independente dos serviços SQL/DNS/MQTT e dos demais servidores da aplicação.

**R08 permanece parcial.** Ainda precisa integrar autoridade, confirmação e estado dos demais serviços. R19 mantém o único teste adiado de captura universal. R18/R20/R25 e suas extensões de R22 continuam no [plano consolidado](../../docs/consolidated-remediation-plan.md). Este incremento não implementa todo o plano nem certifica emulação de firmware ou protocolos industriais condicionais.
