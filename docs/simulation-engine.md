# Motor de simulação

OSPF e RIPv2 mantêm estado por roteador e timers recorrentes. Use `advanceTo` com orçamento para avançar um intervalo conhecido; `run` não drena indefinidamente protocolos periódicos. `configureOspf` e `configureRip` validam e reiniciam o processo local. OSPF calcula SPF sobre a LSDB local; RIP conserva vetores recebidos. O encaminhamento compara prefixo, distância administrativa e métrica. Veja [ADR-010](adr/010-dynamic-routing.md).

O pacote `@shlab/engine` é independente da UI e do backend. Exporte/importe `Snapshot` para transferir a execução entre runtimes. `SimulationEngine.step()` consome uma ação agendada; `run(maxSteps)` drena a fila com orçamento explícito.

`advanceTo(timestamp, maxSteps)` processa eventos até um instante virtual absoluto. Use esse horizonte em cenários DHCP: leases ativos geram renovações recorrentes e a fila pode nunca ficar vazia. `run()` continua limitado pelo orçamento e não deve ser usado para drenar indefinidamente esses cenários.

## Pipeline

TCP separa contratos, transmissão/timers, máquina de estados, serviços e validação. `openTcp`, `writeTcp`, `closeTcp` e `httpGet` geram pacotes; não executam I/O externo. `configureTcpService` configura listeners echo/HTTP e `configureFirewall` define interfaces confiáveis e protocolos rastreados TCP/UDP/ICMP Echo. Os estados, contadores e ações pendentes ficam no snapshot; versões anteriores permanecem válidas porque os campos são opcionais. Veja [ADR-009](adr/009-tcp-and-stateful-firewall.md) e [ADR-012](adr/012-multiprotocol-firewall.md).

DNS usa módulos de registros, cliente, servidor e mensagem, despachados pelo protocolo do payload UDP. A consulta percorre roteamento, ARP e Ethernet; uma resposta válida pode concluir uma resolução pendente e iniciar seu ping IPv4. Consultas locais ao próprio equipamento são entregues à stack sem inventar um cabo ou uma resolução ARP externa. Cache e retries usam somente o relógio virtual.

`configureSnmpAgent` e `querySnmp` configuram e consultam agentes de leitura. A MIB é derivada do estado do equipamento; request IDs e timers correlacionam respostas/retries. `configureSyslog`, `setSyslogEnabled` e `sendSyslog` configuram origem/coletor e enfileiram mensagens UDP. Eventos selecionados podem gerar syslog; mensagens recebidas e falhas de entrega não são reenviadas. Porta de origem estável permite reutilizar NAT/firewall. Os dois serviços compartilham o pipeline e a validação de snapshots; veja [ADR-013](adr/013-snmp-and-syslog.md).

1. Um probe escolhe endereço de origem e consulta longest prefix match.
2. Sem entrada ARP válida, o pacote entra em fila por interface/próximo salto.
3. ARP usa até três requests, separados por 1 s, com um token/timer por interface/próximo salto. Resposta cancela o timer e libera todos os pacotes desse grupo; após 3 s a fila é descartada. Frames são reais do modelo; switches aprendem MAC por VLAN e fazem flooding restrito.
4. A resposta ARP atualiza cache e libera pacotes pendentes.
5. Roteadores removem o envelope Ethernet, decrementam TTL, consultam rotas e resolvem ARP no segmento de saída.
6. O destino responde ICMP usando o mesmo processo de roteamento. Um caminho de ida não garante retorno.
7. Timeouts virtuais produzem falhas observáveis. Um ICMP time-exceeded identifica o roteador que expirou o TTL.

## Estado

STP/RSTP possui estado por bridge/porta, BPDUs e timers Hello/expiração/transição. O modelo reconcilia mudanças físicas e recalcula a eleição local a partir das informações recebidas, não de um spanning tree global da UI. A árvore interfere no aprendizado e no encaminhamento Ethernet. O snapshot preserva decisões, informações recebidas e a fila; o relógio real não avança a convergência.

Snapshot inclui relógio, PRNG, sequência, fila serializável, dispositivos/interfaces, links, tabelas, probes, eventos e notas/tema. Não contém callbacks ou referências do DOM. MAC aging = 300 s, ARP aging = 60 s, timeout ARP = 3 s e probe = 30 s, todos virtuais.

IPv4 discrimina ICMP, UDP, TCP, OSPF e VRRP. UDP discrimina DHCP, DNS, RIP, SNMP e syslog. DHCP possui estado por interface, destinos relay em interfaces estáticas de roteadores e pools/bindings no dispositivo servidor; sua transmissão passa pelos mesmos frames, VLANs, links, perdas e MTU usados pelos demais protocolos. O gateway aprendido é uma rota padrão da interface, compartilhada pelo encaminhamento e pelas tabelas exibidas. Um gateway estático legado não substitui o DHCP na interface dinâmica.

T1, T2, expiração de leases, reservas de oferta e retransmissões são ações da fila. Tokens de transação/lease tornam respostas e timers antigos inócuos. Nenhum temporizador do protocolo usa o relógio real. Os snapshots incluem os timers ativos e são recusados se uma concessão ou binding perder seu timer de expiração.

Snapshots são cópias independentes e validados com Zod e invariantes referenciais. Engine não usa Date.now/Math.random. IDs são derivados da sequência do estado. Nova topologia começa com seed 42; alterações probabilísticas atualizam o estado do PRNG.

## Limites operacionais

200 dispositivos, 800 links, 10 mil ações pendentes, 1.500 eventos de histórico, 200 probes, 256 pacotes pendentes por equipamento, 32 hops Ethernet. São limites de proteção desta versão, não uma promessa de escala. Fila usa inserção binária em array; para volumes maiores, trocar por heap preservando (tempo, ordem). A UI processa uma ação por tick educacional e renderiza após o batch de eventos resultante.

Firewall pode agrupar interfaces roteadas em zonas e aplicar regras ordenadas inspect/permit/deny. O estado de trânsito é validado depois de DNAT e antes de SNAT. Erros ICMP têm citação limitada dos cabeçalhos IPv4/transporte; NAT traduz essa citação e o firewall procura a sessão correspondente sem renovar timers. TTL expirado, falta de rota de trânsito e porta de serviço UDP fechada geram respostas pela mesma rede. Não há fragmentação/PMTU nem alteração automática de transportes ao receber erro. Veja [ADR-015](adr/015-firewall-zones-and-related-icmp.md).

VRRP usa grupos por interface e eleição a partir de anúncios multicast reais do modelo. `configureVrrp` reinicia grupos modificados; `refreshVrrp` reconcilia energia/carrier, e `vrrp-timer` agenda anúncio ou ausência do ativo. ARP e recepção Ethernet reconhecem o MAC virtual somente no ACTIVE. Não há replicação de sessões entre os roteadores. Veja [ADR-016](adr/016-vrrp-ipv4-gateway.md).

BGP mantém RIB/FIB e sessões sobre TCP/179; `configureBgp` reinicia o processo configurado, `refreshBgp` reconcilia underlay/transporte, e `bgp-tick` controla Hold, Keepalive, retry e exportação. Buffers TCP consumidos são liberados para manter sessões longas. [ADR-017](adr/017-bgp-over-simulated-tcp.md) descreve políticas, seleção e limites.

EtherChannel mantém interfaces agregadas e PDUs LACP. `configureLacp` inicia negociação e um `lacp-tick` por agregado. `refreshLacp` deriva membros ativos dos anúncios e do carrier; forwarding usa hash por fluxo e o STP atua no agregado. [ADR-020](adr/020-lacp-etherchannel.md).
