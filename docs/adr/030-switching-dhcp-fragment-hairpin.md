# ADR-030: instâncias STP, proteção DHCP, fragmentação IPv4 e hairpin

Data: 2026-10-07. Estado: implementado no motor e na configuração; ampliação de serviços e verificação final do terceiro bloco em andamento.

## Instâncias e VLANs

PVST mantém uma árvore RSTP independente por VLAN, incluindo eleição, prioridades, estados e timers. BPDUs por VLAN usam o destino PVST+ e a tag/native VLAN correspondente; a árvore comum continua disponível. MSTP agrupa VLANs em até 64 instâncias, compara nome/revisão/digest da região e identifica portas de fronteira. Dados, SVI e EtherChannel consultam o estado da instância da VLAN. Fronteiras usam o CIST, com fallback de transição na interação com STP clássico.

CLI: `spanning-tree configure JSON`, `show spanning-tree instance N`. O painel STP oferece modos PVST/MSTP, configuração do mapa/prioridades e seleção da instância. A duplicação conserva configuração e recria os timers. Testes comprovam raízes distintas, caminhos por VLAN, reconvergência, fronteiras e restauração.

Limites: BPDUs são tipadas; mensagens MSTI circulam individualmente e o digest do modelo usa SHA-256. Não é o codec MSTP binário IEEE com seus registros/HMAC-MD5. A região usa o CIST nas fronteiras; não implementa integralmente a simulação PVST+ e todos os estados de inconsistência de equipamentos Cisco. Referências: [MSTP](https://www.cisco.com/c/en/us/support/docs/lan-switching/spanning-tree-protocol/24248-147.html) e [PVST+/PVID](https://www.cisco.com/c/en/us/support/docs/lan-switching/spanning-tree-protocol/24063-pvid-inconsistency-24063.html).

## Proteção DHCPv4 e conflitos

O switch aprende solicitações DHCP por MAC/transação/VLAN/porta. Respostas exigem porta confiável e solicitação observada; ACK instala binding com expiração. IP Source Guard e Dynamic ARP Inspection conferem IP/MAC/porta; bindings estáticos permitem equipamentos sem DHCP. RELEASE/DECLINE/NAK removem concessões observadas. Probes ARP são permitidos apenas para a concessão correspondente quando DAI está ativo.

O cliente pode habilitar três probes ARP antes de usar um endereço novo. Conflito envia DHCPDECLINE e reinicia a descoberta; o servidor retira a concessão e coloca o endereço em quarentena por 600 segundos virtuais. Renovação do mesmo endereço conserva o fluxo habitual. O relay transmite DECLINE além de DISCOVER/REQUEST.

CLI: `ip dhcp snooping configure JSON`, `show ip dhcp snooping`, `[no] ip dhcp conflict-detection` na interface. Os controles estão na aba DHCP de clientes/servidores/switches. Probes têm intervalos determinísticos de um segundo; não reproduzem todas as temporizações aleatórias, defesa contínua de endereços ou opção 82. Referências: [RFC 5227](https://www.rfc-editor.org/rfc/rfc5227.html), [RFC 2131](https://www.rfc-editor.org/rfc/rfc2131.html) e [DAI/IPSG](https://www.cisco.com/c/en/us/support/docs/switches/lan-switch-software/222274-troubleshoot-dynamic-arp-inspection-dai.html).

## Fragmentação IPv4

Um frame fragmentado contém bytes de um trecho do payload; não carrega cópias completas do pacote em cada fragmento. Identification, offset, MF, TTL e comprimento acompanham o tráfego. Roteadores de trânsito encaminham/refragmentam conforme a MTU, resolvendo ARP e preservando os offsets. O destino só entrega à aplicação após reunir todos os trechos. Fragmentos sobrepostos ou com comprimento contraditório invalidam o datagrama; buffers e timers de 30 segundos são limitados e persistidos.

Gateways com ACL, NAT ou firewall reconstituem antes da política/tradução para impedir evasão por fragmentos. Switches L2 não fragmentam. DF produz ICMP Unreachable code 4 com a MTU. CLI: `ping IP size BYTES [df]`; o diálogo de ping e o inspetor expõem tamanho, DF e cabeçalhos dos fragmentos.

Limites: o payload usa o codec tipado do simulador, com envelope UTF-8 e padding dos dados Echo; não é um codec binário interoperável de IPv4/transportes. Não há opções IPv4, checksum, fragmentação IPv6 ou PMTUD TCP automático. Referências: [RFC 791](https://www.rfc-editor.org/rfc/rfc791.html), [RFC 815](https://www.rfc-editor.org/rfc/rfc815.html) e [RFC 1191](https://www.rfc-editor.org/rfc/rfc1191.html).

## Hairpin NAT

Clientes inside acessam o IP global de um mapeamento estático. DNAT ocorre antes do roteamento/firewall; SNAT força o retorno pelo gateway. A resposta recupera o destino do cliente antes da política stateful e o IP global do servidor após a decisão. TCP, UDP/DNS e ICMP mantêm correlação, inclusive mensagens ICMP relativas à MTU. Bindings/timers são limitados, validados e restaurados.

CLI: `[no] ip nat hairpin`, `show ip nat hairpin`; o painel NAT permite ativar e inspecionar as traduções. Não substitui port forwarding; o alvo precisa de um mapeamento estático e rota inside. Serviços iniciados pelo próprio roteador não usam esse caminho de cliente inside.

## DNSSEC, EDNS e ALG

DNS usa EDNS com tamanho UDP, DO e BADVERS. DNSKEY/RRSIG algoritmo 15 são assinados/verificados com Ed25519 sobre RRsets canônicos; DS usa SHA-256 e key tag do DNSKEY. NSEC assinado comprova NXDOMAIN/NODATA, incluindo ancestral vazio e negação de wildcard. Resolvedor valida âncora, assinatura, cadeia CNAME, validade e prova negativa; bogus vira SERVFAIL. Cache seguro expira na menor validade entre TTL e assinatura e revalida provas no snapshot. Transporte UDP/TCP funciona sobre IPv4/IPv6, incluindo servidores fornecidos por DHCPv6.

Configuração: Inspector DNS → DNSSEC/EDNS; `dns security configure JSON` e `show dns security`. `tests/dns-security.test.ts` verifica transporte IPv6, Ed25519, respostas negativas, adulteração, validade/cache, BADVERS e fallback TCP. Não há resolução recursiva da hierarquia pública, NSEC3, rollover automático ou cadeia de delegações; zonas usam âncoras DS explícitas.

O ALG implementado é SIP/SDP/RTP, descrito e testado no ADR-031. Referências: [RFC 4034](https://www.rfc-editor.org/rfc/rfc4034.html), [RFC 4035](https://www.rfc-editor.org/rfc/rfc4035.html), [RFC 6891](https://www.rfc-editor.org/rfc/rfc6891.html), [RFC 8080](https://www.rfc-editor.org/rfc/rfc8080.html).
