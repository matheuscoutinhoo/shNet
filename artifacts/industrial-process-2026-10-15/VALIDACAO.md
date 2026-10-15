# Processo PLC/HMI/SCADA/MES — 15/10/2026

Fonte: `ea28d87573a12a713b2ca5b7e6182a63383dfe75`, contrato `2026.10.15.3`. A [CI 38742455645](https://github.com/matheuscoutinhoo/shNet/actions/runs/38742455645) já aprovou regressão, capacidade e containers; os dois jobs de navegador ainda precisam concluir antes da integração à `main`.

- Regressão CI com PostgreSQL: **880 aprovados, zero falhas, um adiado**, 86 arquivos. [Resultado completo](ci-r17/regression.json).
- Cinco cenários industriais e nove cenários de acesso/serviços passaram também na CI. Relatórios em [industrial-process](ci-r17/industrial-process/industrial-process.json) e [service-availability](ci-r17/service-availability/availability.json).
- Cargas enterprise de 100/500/2000 dispositivos e 20 usuários com projetos privados em 500/2000 dispositivos: aprovadas. [Capacidade](ci-r17/enterprise-capacity/enterprise-capacity.json).
- Containers Linux, TLS/WSS, isolamento de donos, PostgreSQL, backup/restore e rollback de imagem: aprovados. [Resultado](ci-r17/container-qualification/qualification.json).
- Interface industrial nos dois temas, reconhecimento sem interromper a execução, salvar/reabrir e mobile: aprovados localmente. Capturas de [PLC](process-mobile.png) e [HMI](hmi-mobile.png).
- Formatação, lint, tipos, build real, Workers, autosave, recuperação e replay: aprovados. [Build compilado local](built-application-ui.json).

O hash de fonte é `cbb0d7ea7c008214df7c963bfa5185e0b07a6f9315d163c2a34aa17cf7bafa85`; o grafo do Worker é `69437f82a4c6c7bddf7345b247eda0625af892d45e4bc31a9afea7754e220bbd`. CI Linux e build Windows produziram as mesmas identidades.

As rodadas locais históricas foram preservadas: a primeira expôs a resposta ARP indevida da NIC de reserva; a seguinte teve 879 testes aprovados e um timeout de 20 s no ensaio longo BGP enquanto build e navegadores compartilhavam a máquina. O [BGP isolado](bgp-isolated.json) passou nos 11 casos em 11,7 s; a regressão completa da CI aprovou todos os 880 casos aplicáveis. Essas rodadas locais não foram reescritas como aprovações completas.

O modelo industrial é educacional, com processo de tanque e resolução por scan, sem ladder, firmware ou certificação física/funcional. Os limites e o saldo das frentes R08/R10/R18/R19/R20/R25 permanecem no [plano consolidado](../../docs/consolidated-remediation-plan.md).
