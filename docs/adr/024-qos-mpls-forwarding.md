# ADR-024 — Filas QoS e MPLS conceitual

Status: implementado no motor educacional.

## QoS

Portas físicas cabeadas podem configurar taxa de saída, limite de frames, classes e scheduler. As classes ordenadas combinam protocolo, porta de destino, DSCP e MPLS TC. Marcação modifica DSCP no pacote IPv4/ICMPv6 ou TC no label externo. Um policer por classe usa token bucket em bytes e descarta quando o orçamento acaba. Congestionamento aplica tail drop.

Prioridade estrita atende a maior prioridade disponível; WRR atende quotas de pacotes por peso, incluindo a classe default. Um evento de saída por porta transmite um frame e reserva o intervalo necessário para sua serialização na taxa configurada. Outros frames aguardam na fila; eventos e contadores mostram espera, entrada, saída e descarte. ACL e estado físico são conferidos na transmissão efetiva. Snapshot inclui filas, frames, créditos, tokens e timer. Remover o cabo descarta suas filas sem referências órfãs.

A [RFC 2474](https://www.rfc-editor.org/rfc/rfc2474) orienta o uso do campo DSCP. Não há ECN, WRED, ECMP, WFQ por bytes, hierarquia de filas ou QoS em interfaces virtuais/rádio. Prioridade estrita pode causar inanição. Sem QoS habilitada, permanece o atraso de serialização individual do modelo, sem fila por capacidade compartilhada. O simulador não prevê desempenho de um ASIC real.

## MPLS

Uma FEC IPv4 de entrada aplica até oito labels e determina porta/próximo salto. Roteadores de trânsito consultam a LFIB pelo label externo, trocam ou removem labels e respeitam TTL. Pop com saída mantém labels internos ou faz penultimate hop popping; pop local do último label entrega o pacote à stack IP, com ACL/NAT e roteamento normais. Unknown label, saída indisponível, tamanho inválido e MTU excedida impedem o transporte. TTL expirado produz ICMP relacionado ao pacote original.

ARP resolve o próximo salto do enlace; um pacote pendente conserva o encapsulamento MPLS até receber resposta. Tamanho inclui quatro bytes por label. O modo de TTL é uniforme, sem decremento adicional no pop local. A volta pode usar FEC/LFIB própria. O template **O pacote segue os labels** inclui PE-A, P-CORE e PE-B, com HTTP e ping nas duas direções. **Quem passa primeiro na fila** demonstra QoS.

A [RFC 3031](https://www.rfc-editor.org/rfc/rfc3031) é referência para FEC, label stack e operações de encaminhamento. O modelo usa EtherType 0x8847 e campos tipados; não há codec binário, LDP, RSVP-TE, labels reservados, VPNv4, pseudowires ou sinalização por operadora. O payload interno é IPv4; protocolos link-local OSPF/VRRP não são transportados pela FEC. LFIB/FEC são configuradas manualmente. O TC participa da QoS física.

## Verificação

Testes exercitam ordem/espera, DSCP/TC, WRR, policer, congestionamento, restauração, CLI e remoção de enlace. MPLS tem testes de ping/HTTP, stack, swap/pop/PHP, TTL, MTU, label ausente e ARP pendente. API retoma filas e labels; E2E configura os painéis, transporta HTTP, inspeciona PDU e salva/restaura em desktop/mobile. Os limites ficam explícitos na UI.
