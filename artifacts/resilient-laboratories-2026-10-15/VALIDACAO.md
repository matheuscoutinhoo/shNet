# Laboratórios redundantes e integridade — 16/10/2026

Contrato `2026.10.15.9`, commit `c5d1e371c0fa2edc207734e6d45c9dcf008e011f`, aprovado nos cinco gates da [CI 38895733044](https://github.com/matheuscoutinhoo/shNet/actions/runs/38895733044). O [resumo qualificado](ci-qualified/summary.json) conserva revisão, identidades e resultados. [Decisão técnica](../../docs/adr/057-integrated-redundant-laboratories.md) e [roteiro de estudo](../../docs/integrated-redundancy-lab.md).

Os modelos [enterprise](enterprise-resilient.shlab.json), com 37 equipamentos, e [fábrica](factory-resilient.shlab.json), com 53, combinam acesso, core, gateways WAN/DC e energia A/B. Cada endpoint usa duas NICs e duas fontes. A fábrica contém três células PLC/HMI/SCADA e MES. Os modelos históricos permanecem disponíveis para comparação.

A [matriz de disponibilidade](availability.json) registra **26 cenários aprovados e 26 testes de isolamento após recuperação**. Cada entrada aponta o relatório completo e sua prova de bloqueio. Baseline exige zero perda; falhas usam amostras de 1 s, deadline de 800 ms e sucesso final, com a tolerância declarada. A perda do core A recuperou HTTP no VIP em aproximadamente 3,1 s virtuais no ensaio enterprise, com resolução de 1 s. Falta de caminho durante convergência não é certificada como isolamento.

Os testes verificam continuidade da mesma conexão TCP através de FW/WAN-GW/DC-GW, DHCP via relay alternativo e T2 após fencing, restore determinístico e interrupção quando os dois cores falham. Também corrigem snapshots inválidos ao salvar imediatamente após mudanças físicas, referências de rádio recriadas durante remoção de AP e reprovação indevida de deny com `requireFinalSuccess`. Relatórios de contratos anteriores conservam a avaliação histórica.

Qualificação:

- [Regressão local](local-regression.json) e [regressão CI](ci-qualified/regression.json): **949 aprovados, zero falhas, um adiado**, em 92 arquivos. O adiado é P-PCAP universal.
- [Matriz histórica](ci-qualified/case-coverage.json): 114 dos 115 casos aprovados; captura universal continua explicitamente adiada.
- Navegador: **70 cenários por tema, 140 aprovados**, sem falhas, instabilidade ou skips — [claro](ci-qualified/e2e-sistema-claro.json) e [escuro](ci-qualified/e2e-sistema-escuro.json). Inclui criação, presets, desligamento, salvamento/reabertura e mobile dos novos modelos. [Fábrica mobile](factory-mobile.png) e [enterprise mobile](enterprise-mobile.png).
- [Workers, autosave, recuperação e replay no build](ci-qualified/built-application-ui.json) aprovados; [build local](build/built-application-ui.json) com as mesmas identidades.
- [Carga enterprise 100/500/2000](ci-qualified/enterprise-capacity.json), [20 usuários com 500 equipamentos](ci-qualified/api-capacity-20-500.json), [20 usuários com 2000](ci-qualified/api-capacity-20-2000.json) e [benchmark](ci-qualified/scale.json) aprovados nos perfis declarados.
- [Containers, TLS e backup/restauração/rollback isolados](ci-qualified/container-qualification/qualification.json) aprovados. Não houve restore, rollback ou fencing no Railway real.

Fonte `c960d61b5de0e4a4cfcd07ec0a32256396d7ce4c6fcf718fea76c1d769a0ba84`; Worker `c332e9e7b201d09204b1669dd9ced80c9978515c92432256d18a915bd4c1011f`. As identidades coincidem nos builds Windows/Linux. Formatação, lint e typecheck passaram. A integração deve conservar o código desse commit qualificado.

R10 conclui as variantes de acesso/endpoint/energia no escopo IP. R08 entrega WAN/DC-GW e integração, mas continua parcial para dados/logs/sessões dos demais serviços e quorum/eleição automática. R18/R19/R20/R25 e as extensões de análise correspondentes permanecem no [plano consolidado](../../docs/consolidated-remediation-plan.md). O próprio endpoint/PLC e a perda das duas vias ainda interrompem o serviço; multihoming EVPN não é representado como entregue por este modelo roteado.
