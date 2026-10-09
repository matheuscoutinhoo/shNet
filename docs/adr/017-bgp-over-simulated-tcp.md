# ADR-017 — BGP IPv4 sobre TCP simulado

Status: implementado no simulador educacional.

## Decisão

BGP usa conexões TCP/179 do motor. OPEN, KEEPALIVE, UPDATE e NOTIFICATION atravessam segmentação, ACK, retransmissão, ARP, enlaces, ACLs e políticas existentes. Atributos de uma rota só chegam ao vizinho por mensagens recebidas; não há descoberta global de redes ou preenchimento antecipado da RIB.

O modelo reproduz os conceitos de [BGP-4, RFC 4271](https://www.rfc-editor.org/rfc/rfc4271.html) e [reflexão de rotas, RFC 4456](https://www.rfc-editor.org/rfc/rfc4456.html). O codec interno é JSON tipado delimitado por newline, limitado a 4096 bytes por mensagem; não é o formato binário BGP e não interoperará com equipamentos reais.

## Comportamento

Cada vizinho percorre Idle, Connect, Active, OpenSent, OpenConfirm e Established. OPEN verifica versão, ASN e router ID e negocia Hold time. Colisões de conexões usam os router IDs. KEEPALIVE mantém a sessão e o vencimento de Hold retira suas rotas. Falha de transporte/underlay reinicia a sessão com retry limitado pelo relógio virtual.

Redes locais exigem uma rota correspondente. UPDATE transporta NEXT_HOP, AS_PATH, ORIGIN, LOCAL_PREF e MED. O motor rejeita loops de ASN e atributos de reflexão que retornem à origem/cluster. A seleção considera origem local, LOCAL_PREF, comprimento de AS_PATH, ORIGIN, MED no mesmo AS vizinho, eBGP/iBGP e desempate determinístico por ID/IP. A FIB instala distância 20 para eBGP e 200 para iBGP. Tráfego de ICMP e HTTP usa essas rotas.

Filtros de prefixo de entrada/saída usam sequência, permit/deny e intervalo ge/le. Uma lista não vazia termina com deny implícito. Exportação eBGP acrescenta o ASN local; prepend, MED, LOCAL_PREF e next-hop-self são configuráveis. iBGP não retransmite rotas iBGP sem reflexão configurada. Refletores mantêm ORIGINATOR_ID e CLUSTER_LIST.

O stream TCP libera buffers já consumidos/confirmados e conserva contadores cumulativos. Isso permite sessões periódicas além do limite de 16 KiB de uma transação TCP comum. Snapshot v1 conserva FSM, conexão, atributos, anúncios pendentes e um timer BGP por processo; valida referências, timers e correspondência entre RIB e FIB. CLI, painel e running-config configuram o mesmo estado. Aplicar uma configuração reinicia as sessões do processo.

## Limites

- IPv4 unicast; até 32 vizinhos, 128 redes locais e 512 caminhos. ASN de 32 bits no modelo lógico, sem negociação de capabilities binárias.
- NEXT_HOP resolve pelo underlay conectado/estático/OSPF/RIP; sem recursão arbitrária por outras rotas BGP.
- Sem ECMP, custo IGP no desempate, MRAI, dampening, graceful restart, BFD, autenticação TCP, confederações ou famílias multiprotocolo.
- Hold configurável de 3 a 180 segundos; keepalive igual a um terço do Hold negociado. Não há Hold zero.
- Transporte conserva as simplificações TCP do motor; mensagens periódicas exigem horizonte com `advanceTo`.

## Verificação

Onze testes do motor cobrem sessões, colisões, eBGP/iBGP, reflexão, políticas, loop de AS, ASN inválido, retirada, Hold, failover com ping/HTTP e restauração determinística. Uma sessão de 83 minutos virtuais ultrapassa 16 KiB por direção sem perder a conexão. A API verifica save/load durante OPEN e rejeita FIB/timers adulterados. O template **Três sistemas autônomos** permite reproduzir o caminho direto e a alternativa via terceiro AS.
