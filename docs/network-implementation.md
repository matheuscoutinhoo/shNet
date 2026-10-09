# Implementação das pendências de redes

Escopo autorizado: concluir as funcionalidades e os conceitos de redes do prompt original no simulador educacional. Conta, compartilhamento, colaboração e implantação externa ficam para depois. Um item só é entregue quando altera o tráfego/estado do motor, possui configuração utilizável e passa na verificação correspondente.

## Ordem de trabalho

- [x] BGP IPv4: sessões sobre TCP, OPEN/KEEPALIVE/UPDATE/NOTIFICATION, eBGP/iBGP, atributos, políticas, seleção/retirada de rotas, reconvergência e persistência.
- [x] Interfaces VLAN: subinterfaces, SVI e switch L3; isolamento de tabelas com VRF.
- [x] LACP/EtherChannel, agregação e falha de membros; tracking de gateway.
- [x] IPv6: endereços/rotas, ICMPv6, NDP e configuração dinâmica.
- [x] Wireless: AP/clientes, associação, autenticação, canais, sinal/interferência e transporte real do modelo.
- [x] VPN e SD-WAN: túneis, políticas, conectividade sobre underlay, detecção de falhas e seleção de caminho.
- [x] QoS e MPLS conceitual: classificação, filas/capacidade e encaminhamento por labels.
- [x] VXLAN/EVPN e isolamento de redes virtuais.
- [x] Firewall com inspeção de aplicação e autenticação de rede 802.1X/RADIUS/TACACS+.
- [x] Automação, NETCONF/RESTCONF e telemetria de rede.
- [x] Catálogo/perfis, meios físicos/transceivers e visões de análise dos recursos entregues.
- [x] Completar labs e explicações dos conceitos novos; revisar limites de fidelidade dos protocolos existentes.

O detalhamento e as limitações permanecem em `requirements-coverage.md` e nos ADRs. Este checklist acompanha execução; não substitui evidência de testes nem certificação de conformidade de protocolos.

Tracking de gateway foi entregue (ADR-019), seguido de LACP/EtherChannel (ADR-020).

IPv6/ICMPv6, DAD, NDP, SLAAC, RA, rotas e ACL por interface entregues (ADR-021). A ampliação de TCP/UDP IPv6, DHCPv6 e NUD está descrita no ADR-029.

Wireless com AP/cliente, associação, WPA2/WPA3 conceituais, transporte real do modelo, sinal/interferência e roaming após falha entregue (ADR-022).

VPN/SD-WAN com encapsulamento pelo underlay, PAT, SLA medido, controller e failover entregues (ADR-023).

QoS física com filas, WRR/prioridade, DSCP/TC e MPLS estático com FEC/LFIB/labels entregues (ADR-024).

VXLAN/EVPN com transporte UDP pelo underlay, anúncios MAC/IP por TCP/BGP, route targets e mobilidade entregue (ADR-025).

802.1X cabeado, RADIUS, TACACS+, autorização de terminal e inspeção HTTP/DNS entregues (ADR-026).

Automação por RPCs/jobs, NETCONF/RESTCONF, telemetria com antirreplay e NTP com relógio por equipamento entregues (ADR-027).

Catálogo extensível com 36 perfis, DAC/QSFP, módulos configuráveis, análise global especializada e 17 desafios avançados (23 labs no total) entregues (ADR-028). Os perfis ativam somente capacidades existentes; especializações sem motor correspondente ficam identificadas nos limites, sem serem apresentadas como equipamentos funcionais.

Verificação desta etapa: 354 testes em 30 arquivos aprovados. Os 33 cenários E2E foram aprovados em Windows/Edge, incluindo reexecução dos cenários de firewall/zonas, criação da LAN e catálogo após os ajustes finais. Typecheck, lint e formatação aprovados; build verificado. Capturas desktop/mobile revisadas.

## Ampliação solicitada: funcionalidades e fidelidade

Os itens anteriores registram a base entregue. O pedido de ampliar todos os sete blocos reabre o trabalho de redes abaixo; um bloco só será marcado após implementação, configuração e testes de comportamento.

- [x] IPv6: TCP/UDP, DHCPv6 e estados completos de descoberta/alcançabilidade de vizinhos (ADR-029; testes de motor e navegador).
- [x] TCP: janela deslizante, controle de congestionamento, recuperação de perdas e RTO adaptativo (ADR-029).
- [x] Switching/serviços: PVST/MSTP, DHCP snooping/conflitos, fragmentação IPv4, NAT hairpin/ALG e DNSSEC/EDNS (ADR-030; testes de comportamento e persistência).
- [x] Wireless/segurança: WLC/CAPWAP, mesh, PEAP/TLS e IDS/IPS.
- [x] Equipamentos: proxy, balanceador, telefonia/impressão/IoT, serial/console e PoE (ADR-031; testes de comportamento e persistência).
- [x] Fidelidade: OSPF stub/NSSA/externos/autenticação, RIPv2 com key chains/filtros, VPN com INIT/AUTH/SAs/rekey, AAA com codecs/autorizações/accounting e NETCONF XML/RESTCONF HTTP sobre canal TLS (ADR-033).
- [x] Aprendizagem: editor visual/declarativo de desafios, avaliação por tráfego novo, pontuação agregada e tutorial interativo persistido (ADR-034).

Conta, compartilhamento, colaboração e implantação externa continuam fora deste pedido.

## Verificação da ampliação — 2026-10-08

Os sete blocos estão implementados no motor, nos controles de configuração e nos testes correspondentes. O catálogo atual possui 47 perfis; há 23 labs guiados, além do editor de desafios. O template Campus com autenticação empresarial permite experimentar EAP-TLS e PEAP com um servidor RADIUS e HTTP na WLAN.

A suíte completa passou: 429 testes em 48 arquivos, incluindo persistência determinística, codecs, rejeição de adulteração/replay, falhas de transporte, avaliação no backend e controle de acesso aos novos dados de aprendizagem. Nove cenários de aprendizagem, AAA, VPN/SD-WAN, automação NETCONF/RESTCONF, RIP, OSPF, serviços IPv6, EAP-TLS e PEAP foram verificados no navegador com save/reload e viewport mobile. Lint, typecheck, build e formatação passaram; capturas mobile foram revisadas. As verificações de navegador são incrementais; o resultado desta ampliação não declara uma nova execução completa de toda a suíte E2E.

Os limites estão nos [ADRs 029](adr/029-tcp-window-ipv6-dhcp6-nud.md), [030](adr/030-switching-dhcp-fragment-hairpin.md), [031](adr/031-network-appliances-voice-print-iot-hardware.md), [032](adr/032-wireless-controller-mesh-enterprise-ids.md), [033](adr/033-routing-vpn-aaa-management-fidelity.md) e [034](adr/034-challenges-score-interactive-tutorial.md). Criptografia e tráfego participam da simulação; certificados/PDUs tipados não representam interoperabilidade binária completa com equipamentos reais. A pontuação agrega o progresso privado do usuário; ranking público e recursos novos de conta continuam para depois.
