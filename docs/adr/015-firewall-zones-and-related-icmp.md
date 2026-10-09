# ADR-015 — Zonas e erros ICMP relacionados

Status: aceito. Amplia e substitui os limites de zonas/ICMP relacionado do [ADR-012](012-multiprotocol-firewall.md).

## Política de trânsito

Um roteador pode usar a política legada de interfaces confiáveis ou `zonePolicy`. Snapshots antigos continuam válidos, inclusive a seleção TCP implícita do ADR-012. Zonas são opcionais, têm nomes únicos e agrupam interfaces roteadas sem sobreposição. Há até 16 zonas e 128 regras por roteador. Regras têm sequência única, zonas de origem/destino, protocolo `ip`, TCP, UDP ou ICMP e porta de destino opcional para TCP/UDP.

A menor sequência correspondente decide: `inspect` abre uma sessão e valida o retorno, `permit` libera sem criar ou renovar sessão e `deny` bloqueia inclusive retorno e erro relacionado. Sem regra, tráfego entre zonas e interfaces sem zona é descartado. Dentro da mesma zona, sem regra explícita, o trânsito é permitido. A seleção global de protocolos vale no modo legado; no modo zonas, as próprias regras definem o que inspecionar. Tráfego originado/destinado ao roteador e OSPF continuam sujeitos às ACLs, fora do firewall de trânsito.

Sessões conservam os campos `inside`/`outside` por compatibilidade; no modo zonas representam interface do iniciador e do respondente. Podem, portanto, começar na WAN em direção à DMZ quando uma regra `inspect` autoriza. O retorno só corresponde aos mesmos IPs, portas, interfaces e estado de transporte. As máquinas TCP, UDP e ICMP Echo e seus limites/expirações são os mesmos do ADR-012. Alterar configuração limpa sessões e timers. Snapshot exige uma regra `inspect` correspondente ao fluxo original de cada sessão, além de um timer exato.

## Citação ICMP

Erros novos transportam `error.code` e `error.quote`. A citação contém apenas origem/destino/TTL IPv4 e os campos relevantes dos primeiros oito octetos de transporte: portas e sequência TCP, portas UDP ou tipo/identificador Echo. Não inclui dados de aplicação nem outro erro. O pacote tem tamanho conceitual de 56 bytes; não há codec binário/checksum. Echo não pode conter uma citação; Time Exceeded exige código 0; Destination Unreachable aceita códigos 0, 1 e 3. O destino externo do erro deve coincidir com a origem citada.

TTL expirado em trânsito produz Time Exceeded para TCP, UDP e Echo. Falta de rota no encaminhamento produz Network Unreachable. Consultas DNS/SNMP e envios syslog para um serviço UDP desativado ou porta incompatível produzem Port Unreachable. Não são gerados erros para outro erro, origem inválida, multicast ou broadcast reconhecido na rede local. Não há geração de Host Unreachable após ARP, Fragmentation Needed/DF, redirects ou extensões ICMP.

O firewall correlaciona o fluxo citado à sessão viva, considerando ambos os sentidos, interfaces, IPs, portas/identificador e tipo Echo. Para TCP, a sequência deve estar no espaço aceito entre a sequência inicial e a próxima sequência, incluindo wrap de 32 bits e ACK sem dados. A origem externa do erro pode ser um roteador intermediário, em vez do servidor final. O erro permitido aparece como `ICMP RELATED`; não abre sessão, não muda UNREPLIED/REPLIED e não renova o timer. Uma citação conhecida pode ser forjada; a correlação é filtragem de estado, sem autenticação criptográfica.

ACL in é aplicada antes de DNAT; a decisão de trânsito usa os endereços internos; SNAT e ACL out continuam no caminho. Os erros não passam por cima das ACLs ou de uma regra `deny` de zona. No modo legado, um erro citado de UDP/TCP rastreado pode ser relacionado mesmo quando Echo não está selecionado.

## NAT

NAT estático, dinâmico e PAT traduzem o endereço externo e a citação nas duas direções. No retorno externo, a origem citada/global e o destino remoto/porta precisam corresponder ao mapeamento vivo; PAT restaura também a porta/identificador citado. A origem do roteador intermediário permanece intacta. Na saída de um erro interno, o destino citado volta ao global e à porta mapeada; a origem externa usa um mapeamento existente ou a interface outside. Não se cria, exclui ou renova binding para traduzir erro. Citações ausentes ou sem mapeamento correspondente são recusadas quando a tradução é necessária. Probes e consultas do próprio roteador são diferenciados dos bindings PAT pelo estado local.

## Validação e limites

O template **Três zonas, caminhos controlados** tem LAN, DMZ, WAN e dois roteadores. HTTP da LAN para WAN usa PAT; HTTP da LAN/WAN para DMZ usa inspeção por porta 80; demais acessos entre zonas são descartados. `traceroute 192.168.20.10` no PC-01 usa oito probes Echo, expondo a resposta de TTL do roteador intermediário pela mesma rede.

Testes cobrem tráfego real, regras ordenadas/por porta, retorno, permissões sem sessão, interfaces sem zona, deny sobre erro relacionado, sequências/tuples adulterados, NAT nas duas direções, timers preservados, snapshot/API, CLI/running-config e interface desktop/mobile. Erros TCP/UDP são registrados, mas não abortam consultas/conexões nem ajustam PMTU/RTO; os próprios transportes continuam com seus mecanismos de timeout. Não há DPI, regras por aplicação, IDS/IPS, ALG, hairpin ou conformidade de firewall comercial.

Referências conceituais: [RFC 792](https://www.rfc-editor.org/rfc/rfc792.html), [RFC 3022, seção 4.3](https://www.rfc-editor.org/rfc/rfc3022.html#section-4.3) e [RFC 5508, seções 4.1–4.3](https://www.rfc-editor.org/rfc/rfc5508.html#section-4). O modelo implementa o subconjunto documentado, não a totalidade desses padrões.
