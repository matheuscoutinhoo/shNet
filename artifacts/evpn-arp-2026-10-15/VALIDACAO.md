# Supressão ARP EVPN — 15/10/2026

Incremento R18, contrato `2026.10.15.5`, em qualificação. Depende do BGP/EVPN binário do contrato .4; ainda não publicado em produção.

- [Testes focados](protocol-tests.json): 31 aprovados, zero falhas em ARP EVPN, VXLAN e clonagem de topologias.
- Formulário, diagnóstico, salvar/reabrir e mobile: aprovados nos dois temas.
- [Topologia pronta para importar](evpn-arp-ready.shlab.json), [cenários](scenarios.json) e PCAPs de [binding conhecido](known-binding.pcap), [endereço desconhecido](unknown-address.pcap) e [HTTP parado](application-stopped.pcap). Um binding válido evita flooding, mas um serviço HTTP parado continua retornando reset. A supressão ARP não aprova saúde da aplicação.
- [Captura mobile](evpn-arp-mobile.png) verificada visualmente.
- [Regressão completa local com PostgreSQL](regression.json): **899 aprovados, zero falhas e um adiado**, 88 arquivos. O adiado continua sendo a captura universal P-PCAP.
- [Build compilado](built-application-ui.json): Workers, autosave com progresso, recuperação, falha de painel e replay aprovados. Tipos, lint e formatação aprovados.
- [Decodificação independente dos três cenários](independent-captures.json): 348 pacotes, 680 checksums recalculados, zero malformados. ARP local, flooding do endereço desconhecido e reset do HTTP foram confirmados por Scapy/TShark.
- CI completa: pendente; os resultados locais não equivalem à publicação em produção.

Fonte `132e488242e751038d12f6c9a795292494f43855437761270948066657b719ad`; Worker `fba3a421378ea3dc2d8d801aa312aa5637e1be2737c3b12e14f79dcc019c3fc3`. JS/CSS: 2.463.797 bytes brutos e 651.318 bytes Brotli. Esse orçamento continua com o motor compartilhado entre os contextos; não representa a soma dos heaps.

Os limites, a distinção entre binding e saúde da VM e o restante de R18 estão no [ADR-053](../../docs/adr/053-evpn-arp-suppression-and-route-target-clones.md) e no [plano consolidado](../../docs/consolidated-remediation-plan.md).
