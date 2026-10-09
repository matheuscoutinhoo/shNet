# ADR-029: janela TCP, transporte IPv6, DHCPv6 e NUD

Data: 2026-10-07. Estado: implementado e verificado no motor e no navegador.

## Transporte TCP

A conexão mantém o segmento mais antigo em `pending` e os segmentos seguintes em uma fila persistida. O envio respeita a menor janela entre CWND e a janela anunciada pelo receptor. ACK cumulativo retira segmentos confirmados; recepção fora de ordem conserva dados até preencher a lacuna. Sequências continuam em aritmética de 32 bits e UTF-8 é segmentado sem quebrar caracteres.

Slow start e congestion avoidance aumentam CWND conforme novos bytes são confirmados. Três ACKs duplicados provocam fast retransmit; recuperação parcial segue a lógica NewReno. Timeout reduz CWND, recalcula SSTHRESH e aplica backoff. SRTT/RTTVAR usam médias ponderadas; retransmissões não alimentam o RTT ambíguo (Karn). O RTO tem piso de 1 s e teto de 60 s; uma perda no handshake eleva o piso posterior a 3 s.

Referências: [RFC 5681](https://www.rfc-editor.org/rfc/rfc5681.html), [RFC 6298](https://www.rfc-editor.org/rfc/rfc6298.html) e [RFC 6582](https://www.rfc-editor.org/rfc/rfc6582.html). Não há declaração de conformidade completa de uma stack TCP.

## IPv6 e aplicações

O mesmo TCP atende IPv4 e IPv6. IPv6 encapsula segmentos em EtherType IPv6, usa Hop Limit, rotas/VRF, RA e NDP, sem NAT IPv4. HTTP e echo usam a conexão e os ACKs normais. Link-local exige interface de saída, incluída na identidade da conexão. UDP IPv6 transporta datagramas raw/echo e DHCPv6; ACL por interface distingue TCP, UDP, ICMPv6 e NDP.

## DHCPv6

SOLICIT/ADVERTISE/REQUEST/REPLY e rapid commit circulam por UDP 546/547. DUID/IAID e transação correlacionam respostas; pools têm reservas temporárias, concessões e expiração. IA_NA instala endereço /128 sujeito a DAD. IA_PD atribui prefixo ao roteador, instala rota de retorno no servidor e permite anunciar a LAN downstream. RENEW/REBIND preservam a concessão; expiração remove endereço/prefixo; DECLINE coloca endereço duplicado em quarentena; RELEASE devolve recursos.

DHCPv6 fornece DNS, mas não gateway. RA conserva gateways e prefixos on-link separadamente, inclusive quando o prefixo não é autônomo para SLAAC. Referência: [RFC 9915](https://www.rfc-editor.org/rfc/rfc9915.html).

## Alcançabilidade de vizinhos

INCOMPLETE aparece nas resoluções pendentes; vizinhos aprendidos percorrem REACHABLE, STALE, DELAY, PROBE e FAILED. STALE permite o primeiro tráfego pelo MAC conhecido; DELAY aguarda 5 s e PROBE usa até três NS unicast. NA solicitado ou progresso TCP/ICMP confirma o caminho; falha remove o gateway correspondente, permitindo escolher outro RA. NS com o mesmo MAC preserva uma confirmação já obtida; NA com override desabilitado não substitui MAC diferente.

Referência: [RFC 4861](https://www.rfc-editor.org/rfc/rfc4861.html).

## Limites e verificação

Os buffers de texto continuam limitados a 16 KiB, com até 64 segmentos em cada fila. Não há SACK, TCP timestamps, ECN ou codecs binários completos. UDP não retransmite datagramas raw. DHCPv6 atende o enlace local; relay e autenticação DHCPv6 não fazem parte desta ampliação. Identidade e transações não substituem autenticação criptográfica. Delegação é limitada a um prefixo e uma interface downstream por cliente.

Testes exercitam janela em voo, reordenação, perda, fast retransmit, Karn/backoff, wrap, HTTP/UDP IPv6 roteados, ACL, scope link-local, NUD, IA_NA/IA_PD, renovação, expiração, DAD/DECLINE, RELEASE, perda e snapshots adulterados. Estado, filas e timers retomam deterministicamente. O template `ipv6-services`, CLI e painel expõem configuração e tráfego.
