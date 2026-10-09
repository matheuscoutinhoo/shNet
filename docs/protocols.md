# Protocolos e fidelidade

## VRRP IPv4

O template **Um gateway, dois roteadores** usa VIPs 192.168.10.1 e 192.168.20.1, R-PRIMARY com prioridade 150 e R-BACKUP com 100. Faça ping/HTTP de PC-01 para WEB-01, desligue R-PRIMARY e avance cerca de quatro segundos virtuais. O backup assume e o MAC virtual continua no cache ARP. Ao religar, preempt retoma a função no primário.

Configure cada participante na mesma LAN com VRID/VIP iguais, IPv4 físico próprio e prioridades diferentes:

```text
enable
configure terminal
interface Gi0/1
ip address 192.168.10.2 24
vrrp 10 ip 192.168.10.1
vrrp 10 priority 150
vrrp 10 advertisement-interval 1000
vrrp 10 preempt
exit
service vrrp
end
show vrrp
show running-config
```

`no vrrp 10 preempt` mantém um ativo de prioridade menor até ele falhar. `no vrrp 10` remove o grupo na interface; `no service vrrp` desativa todos os grupos conservando configuração. A aba **VRRP** oferece os mesmos ajustes e mostra estado, VIP, MAC, ativo conhecido, timer e contadores. O filtro **VRRP** inspeciona versão, VRID, VIP, prioridade, intervalo, protocolo 112 e TTL.

Limites: um VIP por grupo, IPv4 estático /1 a /30, 32 grupos por roteador, intervalos 100–10000 ms. Prioridade 255 exige VIP igual ao IP físico e inicia ACTIVE imediatamente. Não donos usam o VIP apenas como gateway, sem atender ping/HTTP local nesse endereço. Tracking por interface/rota está entregue (ADR-019); HSRP, VRRP IPv6 e replicação NAT/firewall não são modelados. ACL pode filtrar `vrrp`; bloquear anúncios pode provocar split brain. Grupos em interfaces diferentes são independentes. Veja [ADR-016](adr/016-vrrp-ipv4-gateway.md) e [RFC 9568](https://www.rfc-editor.org/rfc/rfc9568.html).

## SNMP e syslog

O painel **Gerenciamento** configura os serviços e envia consultas/mensagens. O template **Rede sob observação** possui agentes SNMP no router/servidor, community public, e coletor syslog no servidor 192.168.20.10. O packet inspector mostra os PDUs e o filtro Gerenciamento acompanha seus eventos.

SNMP GET lê OIDs e GETNEXT retorna o próximo objeto em ordem numérica. A MIB inclui identificação, tempo desde ativação do agente, número/nome/MTU/velocidade e estado de interfaces. Contadores shLab usam a árvore de exemplo 1.3.6.1.4.1.32473.1: RX .1.INDEX, TX .2.INDEX, descartes .3.0, erros .4.INDEX. Eles representam frames/erros da simulação. Há 16 OIDs por consulta, duas tentativas de 5 s e até 128 consultas armazenadas. Community errada não recebe resposta; tooBig indica que a resposta excede a MTU de saída. GET inexistente retorna noSuchObject; GETNEXT além da MIB retorna endOfMibView.

```text
# No servidor
enable
configure terminal
snmp-server community public
service snmp
service syslog
end
# No cliente
snmp get 192.168.20.10 public 1.3.6.1.2.1.1.5.0
snmp get-next 192.168.20.10 public 1.3.6.1.2.1.1.1.0
show snmp
```

Syslog usa UDP/514. Facility × 8 + severity determina PRI; o limite permite severidade menor ou igual. Eventos automáticos incluem configuração, link, vizinhança OSPF e STP, sem retransmitir mensagens recebidas ou erros de entrega. Cada origem aceita 64 envios pendentes; o coletor conserva os 500 registros mais recentes. O timestamp é virtual e a origem exibida é o IPv4 observado, podendo ser traduzido por NAT.

```text
enable
configure terminal
logging host 192.168.20.10
logging severity 6
logging facility 23
logging automatic
end
syslog send 5 Alteração planejada no laboratório
show syslog
```

Avance os eventos para entregar os datagramas. ACL, firewall, MTU, rota e perdas influenciam os dois serviços. SNMP é leitura v2c conceitual, sem SET, GETBULK, traps, SNMPv3 ou BER; syslog não possui relay, TLS, ACK/retry ou codec interoperável. Switch L2 não tem IP de gerenciamento nesta entrega. Detalhes em [ADR-013](adr/013-snmp-and-syslog.md).

## Firewall stateful de trânsito

O painel Políticas permite escolher TCP, UDP e ICMP. Configurações novas rastreiam os três; snapshots anteriores mantêm TCP. Protocolos desmarcados seguem as ACLs. Alterar a política reinicia sessões e timers.

UDP correlaciona IPs, portas e interfaces dos dois sentidos; o primeiro datagrama cria UNREPLIED e o retorno muda para REPLIED. Inatividade de 120 s expira a entrada. ICMP aceita Echo Request da rede confiável e Echo Reply com IPs invertidos e o mesmo probeId; inatividade de 60 s expira a entrada. Retorno externo sem sessão, porta/interface incorreta e Echo Request externo são bloqueados.

```text
enable
configure terminal
firewall trust Gi0/1
firewall protocols tcp udp icmp
service firewall
end
show firewall
```

Há até 1024 sessões por roteador. O inspector mostra protocolo, estado e expiração; eventos FIREWALL_PERMIT/DENY/EXPIRED explicam decisões. ACLs continuam podendo bloquear uma sessão existente. O rastreamento ocorre depois de DNAT e antes de SNAT, permitindo retorno com PAT.

Erros Time Exceeded e Destination Unreachable incluem uma citação limitada ao cabeçalho IPv4 e aos campos de transporte, sem copiar dados da aplicação. O firewall autoriza ICMP RELATED apenas quando o fluxo citado corresponde a uma sessão viva. O erro pode vir de um roteador intermediário; não muda o estado nem renova a sessão. NAT estático/dinâmico/PAT traduzem o cabeçalho externo e a citação nos dois sentidos, restaurando portas/identificadores sem criar ou renovar bindings. O inspector mostra código, IPs, portas e sequência citados.

No modo Zonas, atribua nomes às interfaces e escreva regras ordenadas por sequência. A primeira correspondência decide: inspect rastreia e autoriza retorno, permit libera sem sessão, deny bloqueia inclusive retorno e ICMP relacionado. Sem regra, tráfego entre zonas ou sem zona é descartado; dentro da mesma zona é permitido. Protocolos e portas são definidos pelas regras, independentemente da seleção global do modo legado. Alterar configuração reinicia sessões.

```text
enable
configure terminal
firewall mode zones
firewall zone LAN Gi0/1
firewall zone WAN Gi0/2
firewall zone DMZ Gi0/3
firewall rule 10 LAN WAN inspect ip
firewall rule 20 WAN DMZ inspect tcp eq 80
service firewall
end
show firewall zones
show firewall
```

O template **Três zonas, caminhos controlados** demonstra HTTP com PAT na WAN, inspeção por TCP/80 na DMZ e bloqueio dos demais acessos entre zonas. No PC-01, `traceroute 192.168.20.10` mostra erros de TTL atravessando PAT e firewall.

Limites: identificação Echo conceitual; erros UDP não abortam transportes. DF/Fragmentation Needed e PMTUD TCP estão nos ADRs 030/035; inspeção HTTP/DNS e IDS/IPS nos ADRs 026/032. Host Unreachable após ARP e redirects permanecem ausentes. Tráfego destinado/originado no roteador usa ACLs. Decisões em [ADR-012](adr/012-multiprotocol-firewall.md) e [ADR-015](adr/015-firewall-zones-and-related-icmp.md).

## OSPF

OSPF transporta Hello e mensagens de sincronização pelo protocolo IPv4 89, TTL 1; Hello usa 224.0.0.5. O motor percorre Init, 2-Way, ExStart, Exchange, Loading e Full; verifica área, máscara, tipo de rede, intervalos e MTU. Há interfaces passivas, custos, DR/BDR em redes broadcast, LSDB por área, flooding com ACK/retry, SPF e sumários entre áreas através do backbone 0. O cálculo utiliza apenas a LSDB recebida pelo roteador, com enlaces recíprocos e próximo salto único. Falhas de carrier são percebidas no próximo tick; falhas atrás de um switch dependem do Dead interval.

Hello/Dead padrão: 10/40 s. Retransmissão: 5 s. Refresh/MaxAge: 1800/3600 s. Manutenção: 1 s virtual. LSAs retiradas ficam como tombstones até MaxAge. O contador `spfRuns` registra alterações no conjunto de rotas. A distância administrativa é 110; rotas intra-área têm preferência sobre interárea. O painel apresenta vizinhos, DR/BDR, LSAs, rotas e timers; o inspector detalha as mensagens transmitidas.

```text
enable
configure terminal
router ospf 1.1.1.1
interface Gi0/1
ip ospf area 0
ip ospf cost 10
ip ospf network point-to-point
exit
interface Gi0/3
ip ospf area 0
ip ospf passive
end
show ip ospf neighbor
show ip ospf database
show ip ospf interface
show ip route
```

`router ospf` recebe o router ID nesta DSL, não um número de processo Cisco. Em broadcast, `ip ospf priority 0` impede eleição local. `ip ospf hello-interval` e `ip ospf dead-interval` recebem segundos inteiros. `no ip ospf` remove uma interface do processo; `no service ospf` desativa o processo. Aplicar configuração reinicia suas adjacências. O template **Rotas que se adaptam** permite observar custo 21 via R-02 e custo 31 pelo caminho alternativo após `shutdown` em Gi0/1 de R-01.

Limites: troca de descrições por páginas de até 16 cabeçalhos, sem codec/checksum binário nem negociação master/slave completa; ExStart é uma transição imediata. LSAs conceituais; externos, redistribuição, autenticação e áreas stub/NSSA foram acrescentados no ADR-033. ECMP, virtual links e negociação integral das máquinas OSPF permanecem ausentes. Uma LSA maior que a MTU é descartada; não há fragmentação. Máximo de 256 vizinhos, 1024 LSAs e 1024 rotas por roteador. Não é implementação completa ou interoperável da [RFC 2328](https://www.rfc-editor.org/rfc/rfc2328.html).

## RIPv2

RIPv2 envia requests e responses via UDP/520, multicast 224.0.0.9, TTL 1. Cada response leva até 25 entradas. O receptor valida origem na sub-rede, portas e prefixos, incrementa a métrica e conserva o melhor vetor por rede. Neste modelo, uma rede conectada custa 1 e uma rede conectada ao vizinho custa 2. Métricas 1–15 são utilizáveis; 16 indica infinito. O encaminhamento usa distância administrativa 120.

Atualizações periódicas ocorrem a cada 30 s com jitter de ±5 s. Mudanças disparam anúncios após 1–5 s, sujeitos ao tick de 1 s. Rotas aprendidas expiram em 180 s sem atualização do próximo salto; rotas inválidas permanecem 120 s para anunciar sua retirada. Split horizon omite rotas aprendidas pela interface de saída; poison reverse, habilitado por padrão, anuncia essas rotas com métrica 16. Interfaces passivas anunciam sua rede nas outras interfaces, sem enviar nem processar anúncios locais.

```text
enable
configure terminal
router rip
interface Gi0/1
ip rip enable
exit
interface Gi0/3
ip rip enable
ip rip passive
end
show ip rip database
show ip rip interface
show ip route
```

`no ip rip poison-reverse` seleciona split horizon simples; `no ip rip` remove a interface; `no service rip` desativa o processo. O template **Rotas por distância** mostra métrica 2 pelo enlace direto e métrica 3 via R-02 após desligar Gi0/2 de R-01. Estados e timers são persistidos e o painel mostra a contagem até expiração/coleta.

RIPv2 possui codec, autenticação, filtros, hold-down, next hop e redistribuição no ADR-033. Limites: RIPv1, sumarização automática e requests seletivos permanecem ausentes. Route tags são preservadas. Uma única rota por prefixo, no máximo 1024 entradas. Segue os mecanismos de vetor de distância da [RFC 2453](https://www.rfc-editor.org/rfc/rfc2453.html), sem representar conformidade completa.

Os dois protocolos passam por ACL. OSPF aceita regras de protocolo `ospf`; RIP aceita regras UDP com porta 520. A comparação de rotas usa primeiro o prefixo mais específico, depois distância administrativa e métrica. Tráfego de controle fica no segmento local e não passa por NAT. Rotas estáticas continuam configuradas separadamente. Decisões de arquitetura: [ADR-010](adr/010-dynamic-routing.md).

## TCP, echo e HTTP

TCP usa IPv4 protocolo 6 e IPv6 Next Header 6 e passa por ARP/Ethernet, roteamento, VLAN/STP, perda, MTU, ACL e NAT. O modelo executa SYN → SYN/ACK → ACK, entrega ordenada sem duplicação, ACK cumulativo, FIN com half-close, fechamento simultâneo, RST e TIME-WAIT. Porta fechada responde RST; uma conexão bloqueada esgota as tentativas. Eventos mostram estados, descartes e retransmissões; o packet inspector mostra flags, sequência, ACK, janela e dados.

Há até 64 segmentos em voo por direção, MSS legado de 536 bytes (configurável/negociado de 64 a 8960 no ADR-035) e até 16384 bytes de texto UTF-8 por direção/conexão. CWND e a janela do receptor limitam o envio; ACK cumulativo, reordenação, slow start, congestion avoidance e recuperação NewReno são persistidos. A janela anunciada reflete o espaço restante desse histórico de recepção. RTO é adaptativo por SRTT/RTTVAR e Karn, com piso de 1 s, teto de 60 s e backoff nas retransmissões (no máximo cinco). Inatividade expira em 120 s; TIME-WAIT dura 120 s e reinicia quando recebe FIN duplicado. Tudo usa tempo virtual. Cada equipamento comporta 128 conexões e servidores/roteadores podem configurar 32 listeners.

Echo devolve os bytes efetivamente recebidos. HTTP aceita uma requisição por conexão após o terminador de cabeçalho: GET / retorna o texto configurado; caminho ausente, método diferente ou request line inválida retornam 404, 405 ou 400. Content-Length conta bytes UTF-8. Respostas são texto, sem HTML executável. Desativar um listener impede novas conexões; conexões aceitas continuam com o serviço capturado na abertura.

```text
enable
configure terminal
service http 80
service echo 7
end
show services
http get 192.168.20.10 80 /
tcp echo 192.168.20.10 7 Mensagem de teste
show tcp
tcp connect 192.168.20.10 7
tcp send tcp-ID Dados
tcp close tcp-ID
tcp reset tcp-ID
```

Substitua tcp-ID pelo identificador retornado. Avance a simulação antes de enviar dados em uma conexão aberta manualmente. O painel TCP / HTTP permite essas operações e a configuração do corpo HTTP. O template **Da conexão à resposta** já possui HTTP, echo, PAT e firewall configurados.

SACK/ECN/timestamps, MSS negociado, PMTUD e codecs binários estão no ADR-035. Limites: transporte educacional de texto, sem persist probes para janela zero, keepalive ou simultaneous open. Uma janela zero aguarda atualização ou timeout de inatividade. O histórico de recepção não é consumido pela aplicação. HTTP não implementa HTTP completo, TLS, DNS para URLs, streaming, chunked, POST ou conexões persistentes. Não executa fetch nem sockets reais.

Referências: [TCP RFC 9293](https://www.rfc-editor.org/rfc/rfc9293.html), [RTO RFC 6298](https://www.rfc-editor.org/rfc/rfc6298.html); trade-offs em [ADR-009](adr/009-tcp-and-stateful-firewall.md).

| Recurso    | Implementação                                                              | Limite                                                  |
| ---------- | -------------------------------------------------------------------------- | ------------------------------------------------------- |
| Ethernet   | unicast/broadcast, source learning, MAC aging, flooding por VLAN           | FCS e multicast especializado não modelados             |
| 802.1Q     | access, trunk, allowed, native VLAN                                        | sem DTP, QinQ, SVI ou subinterfaces                     |
| ARP        | broadcast request, unicast reply, cache por porta, pending queue e timeout | sem retransmissões, proxy ARP ou gratuitous ARP         |
| IPv4       | validação, CIDR, máscaras contíguas, redes /0–/32                          | fragmentação/reassembly IPv4; DF gera ICMP MTU          |
| ICMP       | echo request/reply, time-exceeded, RTT                                     | não emite todas as variantes de Destination Unreachable |
| Rotas      | conectadas, estáticas, default, longest prefix match e metric              | next-hop deve ser diretamente alcançável; sem recursão  |
| Traceroute | oito probes ICMP com TTL 1–8                                               | sem UDP traceroute, não para cedo no primeiro destino   |
| Física     | RJ45/SFP, transceiver, distância, speed, estado, latência/jitter/perda     | speed precisa coincidir; Auto-MDIX conceitual           |
| STP/RSTP   | BPDUs, eleição, estados e reconvergência em árvore comum                   | sem PVST/MSTP; negociação rápida simplificada           |

O comportamento modelado prioriza configuração → mudança de tráfego → explicação. Duplex controla a elegibilidade para a negociação rápida RSTP, mas não há simulação elétrica de colisões ou autonegociação. RX/TX/erros/descartes são contadores reais da simulação.

Referências: [ARP RFC 826](https://www.rfc-editor.org/info/rfc826/), [IPv4 RFC 791](https://www.rfc-editor.org/rfc/rfc791), [ICMP RFC 792](https://www.rfc-editor.org/rfc/rfc792). O modelo é educacional e não reivindica conformidade completa.

## STP e RSTP

O domínio usa uma Common Spanning Tree para todas as VLANs. BPDUs trafegam pelo mesmo link físico e fila de eventos, para o endereço reservado 01:80:c2:00:00:00; não são flooded como dados. Sua representação é LLC/BPDU tipada, não um EtherType real nem um codec binário IEEE. A prioridade é múltipla de 4096 e o MAC da primeira interface identifica a bridge. A eleição compara root ID, custo, bridge ID, port ID e porta local; não consulta um caminho global calculado pelo canvas.

Portas alternate/disabled descartam dados, learning aprende MAC sem encaminhar e forwarding encaminha. Custos automáticos são 19/4/2 para 100 Mb/s, 1 Gb/s e 10 Gb/s; overrides alteram a eleição. STP clássico aguarda 15 s em discarding e 15 s em learning. RSTP usa proposta/acordo e sincronização local em full-duplex; vizinhos STP ou portas half-duplex usam transição temporizada. PortFast/edge deve ser usado apenas para endpoints; receber BPDU suspende a condição operacional de edge.

Hello ocorre a cada 2 s virtuais. Informação recebida expira por timer, limitada por MaxAge de 20 s ou três intervalos Hello em RSTP. Mudanças de topologia limpam MACs e são propagadas com identificação interna limitada para evitar duplicação infinita. Esse identificador é metadado do simulador, não um campo de BPDU IEEE. A fila serializa Hello, expiração e transições; use advanceTo, não run para tentar esvaziar uma simulação com Hellos recorrentes.

Limites: árvore comum, PVST e MSTP disponíveis (ADR-030); não há topologias de meio compartilhado, papel backup, prioridade de porta configurável, Root Guard, BPDU Guard ou autenticação de BPDUs. Temporizadores fixos e negociação RSTP simplificada não implementam todas as máquinas de estado IEEE. Mudanças de modo/prioridade/custo reiniciam o estado local da bridge de forma conservadora. O modelo não promete convergência instantânea nem conformidade completa; perda/latência de BPDUs pode retardar convergência. Limites de hops/eventos continuam protegendo laboratórios com STP desabilitado ou mal configurado.

```text
enable
configure terminal
spanning-tree mode rstp
spanning-tree priority 4096
interface Gi0/1
spanning-tree portfast
interface Gi0/2
spanning-tree cost 100
end
show spanning-tree
show running-config
```

`spanning-tree mode stp` seleciona o modo clássico; `no spanning-tree` desabilita a árvore; `no spanning-tree cost` restaura o custo automático e `no spanning-tree portfast` remove a configuração edge. Snapshots com portas bloqueadas em forwarding, timers ausentes ou referências inconsistentes são rejeitados.

## UDP e DHCPv4

UDP é um datagrama IPv4 tipado com portas de origem/destino e payload discriminado. Há DHCP nas portas 67/68 e DNS na porta 53. Não há socket real. Os codecs e a captura PCAP do subconjunto suportado estão no ADR-035.

DHCP usa Discover/Offer/Request/ACK, oferta reservada por 30 s virtuais, identificação de transação/cliente e concessões exclusivas por rede do pool. IP, prefixo, gateway e DNS só são aplicados após um ACK correspondente. O servidor exclui seus endereços, o gateway e as exclusões configuradas da alocação.

T1 ocorre em 50% do lease e tenta renovação unicast pela tabela de rotas, resolvendo o próximo salto por ARP. O servidor pode estar em outra sub-rede. T2 ocorre em 87,5% e usa broadcast. O cliente remove a configuração ao expirar e inicia nova descoberta. NAK reinicia a descoberta com atraso limitado; release devolve a concessão ao servidor. Há até quatro tentativas por fase, com backoff de 4/8/16/32 s, e limite de quatro reinícios por NAK.

Limites: 16 pools e 2.048 bindings por servidor; cada intervalo contém até 2.048 endereços; leases entre 8 s e 7 dias virtuais. Há relay e reservas por MAC (descritos abaixo). DHCPv6 está disponível separadamente (ADR-029). Snooping, DECLINE e detecção de conflitos ARP foram acrescentados no ADR-030. INIT-REBOOT e autenticação DHCP permanecem ausentes; snooping exige portas confiáveis configuradas. A opção DNS alimenta o resolvedor descrito abaixo.

### Relay e reservas por MAC

O template **Um servidor, duas redes** tem um servidor central na rede 192.168.20.0/24 e clientes na rede 192.168.10.0/24. O roteador recebe Discover/Request em broadcast, preserva transação/MAC/ciaddr, preenche giaddr com o IPv4 da interface de entrada e hops=1, e envia UDP 67 → 67 aos servidores configurados. O servidor seleciona pools pelo giaddr exato e devolve Offer/ACK/NAK ao relay na porta 67. O relay aceita respostas apenas dos servidores configurados e entrega UDP 67 → 68 na interface de giaddr. Descoberta inicial e NAK usam broadcast; respostas T2 usam o MAC conhecido do cliente. T1 e RELEASE seguem unicast normal, sem preencher giaddr; o servidor seleciona a rede pelo ciaddr e pelo IPv4 de destino.

Cada pool remoto possui uma interface IPv4 estática do servidor, que define seu identificador, e um relayAddress na rede dos clientes. Um pool local deve corresponder à rede da interface. A mesma interface do roteador não pode executar servidor local e relay. Até oito destinos por interface, sem repetição ou endereço do próprio roteador; os pacotes ainda dependem de rotas, Ethernet, MTU, ACL, perdas e firewall nos roteadores de trânsito. Sem Option 82, relays encadeados, codec BOOTP binário ou autenticação DHCP. NAT não reescreve giaddr/ciaddr; configure caminhos roteados e políticas adequadas.

Reservas associam MAC a endereço dentro do intervalo do pool (até 128/pool). Endereços reservados não são entregues a outros MACs, inclusive após RELEASE ou expiração. MACs são normalizados; duplicações, exclusões e endereços de servidor/gateway/relay são recusados. A concessão continua temporária. Editar uma reserva invalida bindings/timers incompatíveis no servidor; clientes usam sua concessão atual até renovar/expirar. A capacidade inclui reservas; “livres para outros” desconta todas as reservas e os bindings dinâmicos ativos.

```text
# No roteador da rede dos clientes
enable
configure terminal
interface Gi0/1
ip helper-address 192.168.20.10
end
show ip dhcp relay
# No servidor central com Eth0 = 192.168.20.10/24 e gateway = 192.168.20.1
enable
configure terminal
ip dhcp pool USERS relay 192.168.10.1/24 interface Eth0
range 192.168.10.50 192.168.10.70
default-router 192.168.10.1
dns-server 192.168.20.10
reservation 02:00:00:01:00:00 192.168.10.60
end
show ip dhcp binding
```

`no ip helper-address SERVER` remove um destino; sem SERVER remove todos. No modo do pool, `no reservation MAC` remove uma reserva. O painel DHCP configura pools locais/remotos, relay e reservas. Referências e decisões em [ADR-014](adr/014-dhcp-relay-and-arp-retry.md).

### CLI do servidor

```text
enable
configure terminal
interface Eth0
ip address 192.168.50.2/24
exit
service dhcp
ip dhcp pool LAN interface Eth0
network 192.168.50.0/24
range 192.168.50.10 192.168.50.20
excluded-address 192.168.50.11
lease 3600
end
show ip dhcp pool
show ip dhcp binding
```

No modo do pool, `default-router IPv4` e `dns-server IPv4...` definem opções; `no default-router`, `no dns-server` e `no excluded-address IPv4...` as removem. `lease` recebe segundos. `no service dhcp` interrompe respostas sem apagar leases dos clientes; estes dependem de seus timers. `no ip dhcp pool NAME` remove o pool.

### CLI do cliente

```text
enable
configure terminal
interface Eth0
ip address dhcp
end
show dhcp lease
```

Avance a simulação para processar as mensagens. `ip dhcp renew Eth0` renova ou inicia descoberta e `ip dhcp release Eth0` devolve o endereço. Configurar um IP estático desativa o cliente DHCP e cancela seus timers. Configurações inválidas são rejeitadas sem deixar alterações parciais.

Referências: [DHCP RFC 2131](https://www.rfc-editor.org/info/rfc2131), [opções DHCP RFC 2132](https://www.rfc-editor.org/info/rfc2132), [UDP RFC 768](https://www.rfc-editor.org/info/rfc768).

## DNS sobre UDP/TCP e IPv4

O modo automático repete a pergunta por TCP/53 após TC=1. No painel, selecione **Transporte DNS**; na CLI, use `nslookup -tcp [-type=A|AAAA|CNAME] NAME [SERVER]` ou `-udp` para impedir fallback. O serviço DNS habilita os dois transportes. Consultas TCP atravessam handshake, segmentação, retransmissões, ACL/NAT/firewall e FIN. Respostas só completam a consulta na conexão correspondente. Cache é compartilhado entre os modos.

Cada conexão carrega uma consulta. O framing interno usa quatro caracteres hexadecimais de comprimento mais JSON tipado sobre o stream UTF-8; não é o formato DNS binário. O limite é de 64 registros e 16 KiB por direção, incluindo framing; resultados maiores retornam SERVFAIL. Não há reutilização ou pipelining. O prazo de 5 s inclui a abertura e recepção da resposta TCP; ao receber TC=1 o prazo é reiniciado. Veja [ADR-011](adr/011-dns-over-tcp.md).

O servidor responde com base em seus registros locais A, AAAA e CNAME. Nomes ASCII são normalizados para minúsculas e sem ponto final, com limite de 253 caracteres e 63 por label. Um CNAME não pode coexistir com outros registros do mesmo nome. Cadeias de até oito aliases são resolvidas localmente; ciclos produzem SERVFAIL. Nome inexistente produz NXDOMAIN; nome existente sem o tipo solicitado produz NOERROR sem dados (NODATA no cliente).

Consultas iniciam em UDP/53 no modo automático, usam fallback TCP após TC=1 e também aceitam TCP ou UDP explícitos. Usam portas efêmeras 49152-65535 e identificadores de 16 bits derivados da PRNG determinística. Respostas só são aceitas quando IP do servidor, destino, porta, ID e pergunta correspondem à consulta pendente. O cache positivo respeita o menor TTL da cadeia, entre 0 e 86400 s; TTL zero não é armazenado. Há duas tentativas por servidor, cada uma com timeout de 5 s virtuais, e até oito servidores. O cliente tenta o servidor seguinte após timeout, não após todo código de erro.

São permitidos 256 registros por servidor, 128 consultas em histórico e 128 entradas de cache por equipamento. O snapshot valida registros, referências, timers pendentes, conteúdo e validade do cache. Eventos e logs têm textos limitados; os registros completos permanecem no resultado e no pacote.

Limites: DNS autoritativo local, sem recursão/delegação externa, PTR/MX/TXT/SOA, cache negativo ou codec DNS binário completo. DNSSEC Ed25519/DS/RRSIG/NSEC e EDNS são suportados; o resolvedor exige âncoras explícitas quando configurado. Consultas IPv4/IPv6 percorrem a rede do modelo e não usam sockets/resolvedor do sistema. UDP usa o tamanho negociado EDNS (512–4096); TC repete por TCP. Veja ADR-030.

### Comandos DNS

```text
enable
configure terminal
service dns
dns record server.lab A 192.168.50.2 ttl 60
dns record server.lab AAAA 2001:db8::2 ttl 60
dns record web.lab CNAME server.lab ttl 30
end
show dns records
```

Em uma interface estática, configure `ip name-server 192.168.50.2`; `no ip name-server` remove a lista. Em uma interface DHCP, altere `dns-server` no pool: o resolvedor usa as opções do lease.

```text
nslookup web.lab
nslookup -type=AAAA server.lab
nslookup -type=CNAME web.lab 192.168.50.2
ping web.lab
show dns queries
show dns cache
clear dns cache
```

`no service dns` interrompe respostas sem apagar o cache dos clientes. `no dns record NAME TYPE VALUE` remove um registro. A UI permite criar, editar e excluir registros. O atalho legado de ping para hostnames de equipamentos da topologia permanece compatível; FQDNs como `server.lab` são resolvidos por DNS.

Referências: [DNS RFC 1034](https://www.rfc-editor.org/info/rfc1034), [DNS RFC 1035](https://www.rfc-editor.org/info/rfc1035), [AAAA RFC 3596](https://www.rfc-editor.org/info/rfc3596).

## BGP IPv4

Use a aba **BGP** ou `router bgp ASN`, `bgp router-id IPv4`, `bgp network CIDR` e `neighbor IPv4 remote-as ASN`. `show ip bgp summary` mostra as sessões e `show ip bgp` mostra caminhos e atributos. `neighbor IP local-preference N`, `metric N`, `as-path-prepend N`, `next-hop-self` e `route-reflector-client` configuram políticas. `neighbor IP prefix-filter in|out SEQ permit|deny CIDR [ge N] [le N]` filtra anúncios. Avance a simulação para estabelecer TCP/179 e trocar mensagens. Alterar a configuração reinicia as sessões. Veja [ADR-017](adr/017-bgp-over-simulated-tcp.md).

## Interfaces VLAN e VRF

`interface Gi0/1.10` cria uma subinterface; `encapsulation dot1q 10` define a tag. No switch, `interface Vlan10` cria uma SVI e `ip routing` habilita trânsito entre VLANs. `no switchport` transforma uma porta física em routed. `vrf definition BLUE` cria a tabela e `vrf forwarding BLUE` associa a interface. Rotas e tráfego: `ip route vrf BLUE CIDR NEXT_HOP`, `show ip route vrf BLUE`, `ping vrf BLUE IPv4` e `http get vrf BLUE IPv4`. O painel TCP também seleciona VRF. Limites em [ADR-018](adr/018-vlan-routing-and-vrf.md).

## IPv6

Endereçamento de 128 bits, DAD, ICMPv6, TCP, UDP/echo, HTTP, DHCPv6 IA_NA/IA_PD, NUD e RS/RA/SLAAC passam pelos frames do motor, com rotas, ACL e VRF. CLI: `ipv6 dhcp client address|prefix|both`, `ipv6 dhcp server JSON`, `show ipv6 dhcp`, `udp6 send IP PORT DATA` e os comandos TCP usuais. Link-local exige interface. [ADR-021](adr/021-ipv6-ndp-slaac.md) e [ADR-029](adr/029-tcp-window-ipv6-dhcp6-nud.md).

## Wireless

PDUs 802.11 didáticas negociam associação e autorização antes do transporte Ethernet pelo rádio. Broadcast, DHCP, ARP, TCP e NDP atravessam a bridge do AP; sinal e interferência afetam PDUs/dados. Consulte [ADR-022](adr/022-wireless-association-radio.md) para os limites de segurança e RF.

## VPN e SD-WAN

`tunnel configure JSON`, `[no] service tunnel N`, `no tunnel N` e `show tunnels` configuram peers/underlay/selectors e mostram RTT/perda. `sdwan site SITE [controller IP underlay PORT key KEY]`, `sdwan policy JSON`, `sdwan controller JSON` e `show sdwan` usam os mesmos contratos dos painéis. Avance a simulação para autenticar peers e receber políticas. INIT/AUTH negocia X25519 e SAs AES-GCM com SPI e rekey. O encapsulamento IKE/ESP permanece tipado; veja ADR-033.

## QoS e MPLS

`qos configure JSON` no modo interface configura filas físicas; `show qos` mostra contadores. `mpls configure JSON`, `mpls ingress JSON` e `mpls lfib JSON` configuram FEC e labels; `show mpls forwarding-table` inspeciona a tabela. Os painéis aceitam os mesmos contratos. [ADR-024](adr/024-qos-mpls-forwarding.md) define o modelo e seus limites.

## Automação, relógio, catálogo e desafios

NETCONF/RESTCONF, candidate/commit, jobs, telemetria e NTP percorrem a rede do motor. Use **Gerenciamento → Automação e monitoramento** ou os comandos `management`, `automation`, `telemetry`, `clock` e `ntp` com JSON tipado. Limites atuais e novos contratos em [ADR-033](adr/033-routing-vpn-aaa-management-fidelity.md); telemetria/NTP mantêm os limites do ADR-027.

O catálogo contém 47 perfis com funções reais suportadas. DAC/QSFP e módulos são configuráveis no editor de interface e com `speed`/`transceiver`. O inspetor global expõe estado especializado e referências da configuração. Há 17 novos desafios, somando 23 labs. [ADR-028](adr/028-device-profiles-physical-analysis-labs.md) e [guia de conceitos](network-concepts.md).

## Ampliação dos protocolos e serviços

IPv6 TCP/UDP, DHCPv6 e NUD: [ADR-029](adr/029-tcp-window-ipv6-dhcp6-nud.md). Switching, snooping, conflitos, fragmentação, hairpin, SIP ALG, DNSSEC e EDNS: [ADR-030](adr/030-switching-dhcp-fragment-hairpin.md). Equipamentos e serviços de aplicação, serial/console/PoE: [ADR-031](adr/031-network-appliances-voice-print-iot-hardware.md). Wireless empresarial, WLC/CAPWAP, mesh e IDS/IPS: [ADR-032](adr/032-wireless-controller-mesh-enterprise-ids.md).

OSPF/RIP, VPN com rekey, AAA com autorização/accounting e NETCONF XML/RESTCONF HTTP com canal TLS estão descritos no [ADR-033](adr/033-routing-vpn-aaa-management-fidelity.md). OSPF e RIP oferecem configuração avançada JSON além dos controles básicos; o formulário básico preserva áreas, autenticação, filtros e políticas. A VPN permite ajustar a validade das chaves. O painel Gerenciamento aceita resources, datastores, If-Match e configuração TLS.

Para praticar, abra Desafio ou Tutorial no laboratório. Definições e evidências são avaliadas no backend, e a pontuação aparece no dashboard. Veja [ADR-034](adr/034-challenges-score-interactive-tutorial.md).

As extensões TCP, PMTUD, relay DHCPv6 e codecs/capturas atuais estão detalhados no [ADR-035](adr/035-transport-extensions-relay-captures.md). Essa ampliação substitui os limites anteriores de transporte e relay dos ADRs 029–030, preservando os demais limites explícitos.
