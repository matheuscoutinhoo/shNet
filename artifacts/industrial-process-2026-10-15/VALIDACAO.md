# Processo PLC/HMI/SCADA/MES — 15/10/2026

Fonte integrada à `main`: `8a0cca62d28831e25af85b351c2842737e831430`, contrato `2026.10.15.3`. A [CI final 38746375043](https://github.com/matheuscoutinhoo/shNet/actions/runs/38746375043) aprovou os cinco gates. O [resumo](ci-r17-final/summary.json) conserva a revisão, as identidades e os resultados completos.

- Regressão CI com PostgreSQL: **880 aprovados, zero falhas, um adiado**, 86 arquivos. [Resultado completo](ci-r17/regression.json).
- Cinco cenários industriais e nove cenários de acesso/serviços passaram também na CI. Relatórios em [industrial-process](ci-r17/industrial-process/industrial-process.json) e [service-availability](ci-r17/service-availability/availability.json).
- Cargas enterprise de 100/500/2000 dispositivos e 20 usuários com projetos privados em 500/2000 dispositivos: aprovadas. [Capacidade](ci-r17/enterprise-capacity/enterprise-capacity.json).
- Containers Linux, TLS/WSS, isolamento de donos, PostgreSQL, backup/restore e rollback de imagem: aprovados. [Resultado](ci-r17/container-qualification/qualification.json).
- Interface industrial nos dois temas, reconhecimento sem interromper a execução, salvar/reabrir e mobile: aprovados localmente. Capturas de [PLC](process-mobile.png) e [HMI](hmi-mobile.png).
- Navegadores na CI final: **63 testes por tema, 126 no total**, zero falhas, instabilidade ou skips. Resultados [claro](ci-r17-final/e2e-sistema-claro.json) e [escuro](ci-r17-final/e2e-sistema-escuro.json). Workers compilados, autosave, recuperação e replay passaram também no Linux da CI.
- Formatação, lint, tipos, build real, Workers, autosave, recuperação e replay: aprovados. [Build compilado local](built-application-ui.json).

O hash de fonte é `cbb0d7ea7c008214df7c963bfa5185e0b07a6f9315d163c2a34aa17cf7bafa85`; o grafo do Worker é `69437f82a4c6c7bddf7345b247eda0625af892d45e4bc31a9afea7754e220bbd`. CI Linux e build Windows produziram as mesmas identidades.

As rodadas locais históricas foram preservadas: a primeira expôs a resposta ARP indevida da NIC de reserva; a seguinte teve 879 testes aprovados e um timeout de 20 s no ensaio longo BGP enquanto build e navegadores compartilhavam a máquina. O [BGP isolado](bgp-isolated.json) passou nos 11 casos em 11,7 s; a regressão completa da CI aprovou todos os 880 casos aplicáveis. Essas rodadas locais não foram reescritas como aprovações completas.

A CI anterior 38742455645 aprovou 62/63 testes por tema: a expectativa de 23 categorias de eventos ficou desatualizada com Bond e processo industrial. O teste passou a conferir as duas categorias e o total de 25; a rodada final acima aprovou a correção completa. O código de produção mantém a mesma fonte `cbb0d7…` nessa correção de teste.

O modelo industrial é educacional, com processo de tanque e resolução por scan, sem ladder, firmware ou certificação física/funcional. Os limites e o saldo das frentes R08/R10/R18/R19/R20/R25 permanecem no [plano consolidado](../../docs/consolidated-remediation-plan.md).
