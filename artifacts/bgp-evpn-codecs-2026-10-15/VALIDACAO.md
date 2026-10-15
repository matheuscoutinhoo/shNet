# BGP/EVPN binário — 15/10/2026

Incremento R19 no contrato `2026.10.15.4`, aprovado nos cinco gates da [CI 38771544113](https://github.com/matheuscoutinhoo/shNet/actions/runs/38771544113), fonte `011c5bc`. A integração à main usa o mesmo código de produção. [Resumo da homologação](ci-qualified/summary.json).

- [Testes de protocolo](protocol-tests.json): 29 aprovados, zero falhas em BGP, VXLAN/EVPN e codec. Cobrem AS32, reflexão, controle/dados, falhas, snapshots, legado, segmentação, vetores fixos e mensagens inválidas.
- [Decodificação independente](independent-captures.json): TShark/Wireshark 4.6.7 reconheceu BGP e EVPN. Scapy recalculou 452 checksums; 162 registros BGP e 84 EVPN, zero pacotes malformados, excluídos ou descartados nessas duas capturas.
- [Regressão local com PostgreSQL](regression.json): **891 aprovados, zero falhas e um adiado**, em 87 arquivos. Após a normalização de RT e a recusa de prefixos não canônicos, os 29 testes de protocolo passaram novamente. A [regressão final da CI](ci-qualified/regression.json) aprovou os mesmos 891 casos aplicáveis no código final.
- Build de produção, tipos, lint e formatação: aprovados. JS/CSS somam 2.461.164 bytes brutos e 650.550 bytes Brotli, com o motor compartilhado entre editor e Workers.
- PDU binária visível, download PCAP, acessibilidade e tela mobile: aprovados nos dois temas. As categorias de eventos passaram nos dois temas. [Captura mobile](bgp-binary-mobile.png).
- [Aplicação compilada](built-application-ui.json): Workers, autosave com progresso, recuperação, falha de painel e replay aprovados; abertura em 852 ms nesta máquina.
- CI completa: **891 testes aprovados, zero falhas, um adiado; 64 testes por tema, 128 de navegador no total, zero falhas/instabilidade/skips**. [Claro](ci-qualified/e2e-sistema-claro.json), [escuro](ci-qualified/e2e-sistema-escuro.json), [Workers/replay](ci-qualified/built-application-ui.json), [containers](ci-qualified/container-qualification/qualification.json) e capacidade aprovados. TShark 4.2.2 no Linux validou as mesmas capturas e identidades do build local.

Identidade final: fonte `9428fa9f928311eba4049cfe1ae19195e1c15798023cf2433f70d20c43c99502`; Worker `be9ecd5589b668fe2de7179746948753ff16c4e9db54ebd388c02a5c7c9b5148`. PCAPs reproduzíveis: [BGP](bgp-binary.pcap) e [EVPN](evpn-binary.pcap).

As capturas são subconjuntos selecionados. P-PCAP universal permanece adiado, e protocolos sem codec continuam excluídos com motivo. O [ADR-052](../../docs/adr/052-binary-bgp-evpn-captures.md) registra o formato e seus limites; o [plano consolidado](../../docs/consolidated-remediation-plan.md) preserva o restante de R08/R10/R18/R19/R20/R25.
