# ADR-025 — VXLAN e EVPN no simulador

Status: implementado no motor educacional.

## Transporte

Um switch VTEP mapeia uma VLAN local a um VNI. A interface virtual encapsula frames Ethernet em UDP/4789, usando IPv4, ARP, rotas, ACL, perda e MTU do underlay. O VTEP remoto valida VNI, origem, interface WAN e tamanho, retira o encapsulamento e entrega o frame à VLAN local. VLANs com números diferentes podem compartilhar um VNI. ARP, ICMP, HTTP e NDP atravessam o overlay; o Hop Limit IPv6 interno não diminui no trânsito IP do underlay.

Broadcast e destino desconhecido são replicados aos peers configurados. MAC remoto aprendido direciona unicast a um VTEP. BPDUs, LACP e controle de rádio permanecem no enlace local. A [RFC 7348](https://www.rfc-editor.org/rfc/rfc7348) orienta VNI, encapsulamento e separação entre overlay e underlay.

## Controle EVPN

As sessões TCP/BGP existentes negociam a capacidade EVPN e transportam anúncios e retiradas de MAC/IP. A importação exige VNI e route target correspondentes. AS_PATH impede loops; sequência de mobilidade, tamanho do AS_PATH e endereço do VTEP selecionam o destino. Mover uma VM entre portas/VTEPs anuncia sequência maior. Queda da sessão retira seus MACs. Um anúncio permite encaminhar unicast mesmo sem aprendizado prévio pelo plano de dados.

O modelo usa mensagens BGP tipadas e atributos inspirados em rotas MAC/IP da [RFC 7432](https://www.rfc-editor.org/rfc/rfc7432) e no overlay da [RFC 8365](https://www.rfc-editor.org/rfc/rfc8365). Não há codec MP-BGP binário, route reflector EVPN, multihoming ESI/DF, IMET, Type 5, proxy ARP ou anúncios MAC/IP IPv6. Peers de replicação são estáticos. Essa implementação demonstra controle e transporte; não estabelece interoperabilidade com equipamentos reais.

## Configuração e verificação

CLI e painel configuram VNI, VLAN, WAN, peers e route target. Tabelas mostram MAC, IP, next hop e sequência; eventos e PDU expõem encapsulamento e importação. Templates VXLAN e EVPN conectam duas LANs por um roteador IP.

Testes do motor verificam ARP, HTTP, IPv6/NDP, isolamento por VNI/route target, MTU, mobilidade e retirada de MAC. API salva e retoma tráfego e anúncios pendentes com o mesmo resultado. E2E verifica configuração, sessão BGP, MAC/IP, HTTP, PDU e persistência em desktop/mobile. Snapshot valida interfaces virtuais, underlay, mensagens pendentes e referências da RIB.
