# Eventos e relógio

TCP usa `tcp-timer` para retransmissão, idle e TIME-WAIT; firewall usa `firewall-expire`. OSPF/RIP usam ticks recorrentes e emitem adjacência/LSA/SPF, anúncio e instalação/retirada de rotas. Protocolos periódicos devem avançar até um horizonte com `advanceTo`, respeitando orçamento de eventos.

SNMP usa `snmp-timeout` vinculado à consulta e à tentativa atual; conclusão cancela o timer. Syslog usa `syslog-send` e não mantém retransmissão/ACK. Eventos `SNMP_QUERY/RESPONSE/ANSWER/REJECTED/FAILED` e `SYSLOG_QUEUED/SENT/RECEIVED/FILTERED/FAILED` explicam o resultado. Todos os PDUs percorrem frames inspecionáveis; a fila e os registros são serializáveis.

STP/RSTP adiciona ações stp-hello, stp-info-expire e stp-transition, além de eventos BPDU_SENT, BPDU_RECEIVED, STP_ROOT_CHANGED, STP_PORT_CHANGED e STP_TOPOLOGY_CHANGED. Identificadores de instância/porta invalidam transições antigas. BPDUs continuam circulando em portas que bloqueiam dados, conforme permitido pelo modelo.

DNS acrescenta ações `dns-timeout` correlacionadas à tentativa atual e eventos `DNS_QUERY`, `DNS_RESPONSE`, `DNS_ANSWER`, `DNS_CACHE_HIT`, `DNS_TIMEOUT` e `DNS_FAILED`. Respostas finalizadas cancelam seus timers. O cache é invalidado pelo tempo virtual em step/advanceTo e antes de consultas. Nenhum timer de DNS depende de setTimeout real.

A fila mantém `{at, order, action}`, ordenada por instante e sequência de inserção. Ações são entrega de frame, timeout ARP, timeout de probe e timers DHCP de retransmissão, T1, T2, expiração e reserva/concessão do servidor. Um evento de rede observável representa uma decisão tomada durante uma ação; uma ação pode gerar múltiplos eventos (ex.: FRAME_RECEIVED, MAC_LEARNED e FRAME_SENT).

Pausar interrompe o consumo da fila, não altera o relógio real nem usa timers para o estado do domínio. O controle de velocidade altera a cadência didática das ações. Na ausência de eventos intermediários, o próximo passo salta diretamente ao próximo instante virtual.

Latência é propagação + serialização por velocidade da porta, com jitter e perda determinados pela seed. Filas de banda concorrente e congestionamento não estão modelados. Timeouts sem trabalho pendente são no-ops e ainda avançam o relógio.

ARP mantém resolução serializável com sourceIp, token, tentativas e próximo timer. Requests em 0/1/2 s e descarte em 3 s são uma escolha educacional; snapshots antigos sem resolução/token concluem pelo timeout legado. Respostas tardias sem pacote pendente não atualizam o cache. Remoção de endereço cancela tráfego pendente comum e conserva um RELEASE já iniciado, que pode concluir sua resolução com o IPv4 anterior.

DHCP expõe RELAY_REQUEST/RELAY_REPLY, além de DISCOVER, OFFER, REQUEST, ACK, NAK, RELEASE, BOUND, RENEWING, REBINDING, EXPIRED, FAILED, POOL_EXHAUSTED e LEASE_EXPIRED. Mensagens transmitidas incluem o frame para inspeção de Ethernet, IPv4, UDP e opções DHCP. Expiração remove IP, gateway e DNS antes de uma nova descoberta. Remover um timer para impedir a expiração torna o snapshot inválido.

WebSocket em `/api/events` transmite somente eventos de persistência do proprietário autenticado. A simulação é local no MVP. Não se grava cada frame no banco; salva-se somente o histórico limitado dentro de um checkpoint.

FIREWALL_PERMIT identifica ICMP RELATED à sessão rastreada, sem alterar estado ou expiração. NAT_TRANSLATED explica a restauração do cabeçalho citado em erros. FRAME_SENT/RECEIVED preservam error.code e error.quote para o inspector; PACKET_SENT descreve a origem do erro e PACKET_DROPPED registra TTL, rede sem rota, porta UDP fechada e erros recusados. Não há uma nova fila/timer para erros ICMP.

VRRP emite `VRRP_STATE_CHANGED`, `VRRP_ADVERT_SENT` e `VRRP_ADVERT_RECEIVED`. A ação `vrrp-timer` identifica roteador, interface, VRID, token, tipo e deadline. Cada grupo operacional possui um timer de anúncio (ACTIVE) ou timeout do ativo (BACKUP); INIT não possui timer. Os anúncios também geram FRAME_SENT/RECEIVED e aprendizado de MAC nos switches. Avance com `advanceTo`, pois a fila contém anúncios recorrentes.

BGP emite `BGP_STATE_CHANGED`, `BGP_SENT`, `BGP_RECEIVED`, `BGP_ROUTE_REJECTED` e `BGP_SESSION_CLOSED`; a FIB emite ROUTE_ADDED/REMOVED. A ação `bgp-tick` usa token/deadline serializáveis. Cada mensagem também atravessa eventos TCP e Ethernet; perdas e ACLs podem derrubar a sessão pelo Hold timer.
