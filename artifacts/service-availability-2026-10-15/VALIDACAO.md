# Disponibilidade de acesso e serviços — 15/10/2026

Os P2 estão integrados e verificados no Railway. R10 foi integrada em `b1ec4393643de16893b8af1231fe858cf7f67d14`: a [CI completa](https://github.com/matheuscoutinhoo/shNet/actions/runs/38732323373) aprovou 855 testes e 122 cenários de navegador; um teste de captura universal permanece adiado. Containers, PostgreSQL, backup/restauração, rollback, capacidade e Workers passaram. [Resumo](r10-ci-qualified/summary.json). A [verificação remota](railway-r10/remote-release.json) confirmou contrato `2026.10.14.2`, fonte e Worker esperados, TLS e proteção dos endpoints privados.

O primeiro incremento de R08 está em qualificação na [CI 38735803183](https://github.com/matheuscoutinhoo/shNet/actions/runs/38735803183), fonte `7f27a77f1cc18c4a8a07137013426dbfb2153068`. Localmente:

- Regressão com PostgreSQL isolado: **867 aprovados, zero falhas, um adiado**, 85 arquivos. [Resultado completo](regression.json).
- Nove presets nativos de PLC/HMI e serviços: aprovados, com relatórios validados e snapshots restauráveis. [Métricas e hash](availability.json).
- Interface de VIP/tracking/presets/salvar/reabrir/mobile: dois temas aprovados. [Captura mobile](service-ha-mobile.png).
- Formatação, lint, tipos e build: aprovados. O checkout passou a usar LF também no Windows, consistente com o formatador.
- Build real com Workers, autosave, recuperação, falhas de painel/armazenamento e replay: aprovado. [Resultado](built-application-ui.json).

O motor local R08 usa contrato `2026.10.15.1`, fonte `236a1e2e9b827cb1d67d7df6ebc12aa1653c2d55195f1fa35f5c0e1f92989fda` e grafo do Worker `d00f26ca944648099d5bd9009ffc6dde95149f3b6400129aefaafed83aa44eab`. São identidades diferentes das versões P2/R10 já verificadas no Railway.

Foram corrigidas a limpeza de ARP ao dissolver bond, a expectativa de cache VRRP que ignorava a renovação de validade, o encaminhamento por entrada MAC com porta sem caminho operacional e a coleta de evidência syslog dirigida ao VIP. A suíte mantém controles negativos: sem accept mode, sem DNS nas duas instâncias, origem VIP no backup e sessão TCP de serviço que não foi replicada.

R08 continua parcial: faltam replicação de leases/dados/logs/sessões, quorum/fencing, gateways/WAN e variantes completas de fábrica/enterprise. O saldo de R10 é a integração dessas variantes. R17/R18/R19/R20/R25 seguem no [plano consolidado](../../docs/consolidated-remediation-plan.md). Os requisitos opcionais R24/R29/R30 permanecem fora do escopo.
