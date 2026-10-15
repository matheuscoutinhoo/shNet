# Supressão ARP EVPN — 15/10/2026

Incremento R18, contrato `2026.10.15.5`, aprovado nos cinco gates da [CI 38774060950](https://github.com/matheuscoutinhoo/shNet/actions/runs/38774060950), fonte `46bf53b`. Depende do BGP/EVPN binário do contrato .4. A integração à main preserva o código homologado. [Resumo](ci-qualified/summary.json).

- [Testes focados](protocol-tests.json): 31 aprovados, zero falhas em ARP EVPN, VXLAN e clonagem de topologias.
- Formulário, diagnóstico, salvar/reabrir e mobile: aprovados nos dois temas.
- [Topologia pronta para importar](evpn-arp-ready.shlab.json), [cenários](scenarios.json) e PCAPs de [binding conhecido](known-binding.pcap), [endereço desconhecido](unknown-address.pcap) e [HTTP parado](application-stopped.pcap). Um binding válido evita flooding, mas um serviço HTTP parado continua retornando reset. A supressão ARP não aprova saúde da aplicação.
- [Captura mobile](evpn-arp-mobile.png) verificada visualmente.
- [Regressão completa local com PostgreSQL](regression.json): **899 aprovados, zero falhas e um adiado**, 88 arquivos. O adiado continua sendo a captura universal P-PCAP.
- [Build compilado](built-application-ui.json): Workers, autosave com progresso, recuperação, falha de painel e replay aprovados. Tipos, lint e formatação aprovados.
- [Decodificação independente dos três cenários](independent-captures.json): 348 pacotes, 680 checksums recalculados, zero malformados. ARP local, flooding do endereço desconhecido e reset do HTTP foram confirmados por Scapy/TShark.
- CI completa: **899 testes aprovados, zero falhas, um adiado; 65 testes por tema, 130 de navegador, sem falhas/instabilidade/skips**. [Regressão](ci-qualified/regression.json), [claro](ci-qualified/e2e-sistema-claro.json), [escuro](ci-qualified/e2e-sistema-escuro.json), [Workers/replay](ci-qualified/built-application-ui.json), capacidade, containers e decodificação externa aprovados. As identidades Linux/Windows são iguais.

Fonte `132e488242e751038d12f6c9a795292494f43855437761270948066657b719ad`; Worker `fba3a421378ea3dc2d8d801aa312aa5637e1be2737c3b12e14f79dcc019c3fc3`. JS/CSS: 2.463.797 bytes brutos e 651.318 bytes Brotli. Esse orçamento continua com o motor compartilhado entre os contextos; não representa a soma dos heaps.

Os limites, a distinção entre binding e saúde da VM e o restante de R18 estão no [ADR-053](../../docs/adr/053-evpn-arp-suppression-and-route-target-clones.md) e no [plano consolidado](../../docs/consolidated-remediation-plan.md).
