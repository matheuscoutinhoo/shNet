# Conceitos e experimentos de rede

O motor usa eventos e tráfego próprios. A interface projeta o estado; um formulário ou comando altera a configuração usada pelo próximo pacote. Clique na timeline para inspecionar encapsulamento e decisão. Abra o inspetor global para comparar equipamentos e dependências.

## BGP / OSPF / RIP

O protocolo de controle aprende destinos. A tabela instalada escolhe o próximo salto; ARP e o enlace ainda precisam funcionar.

Experimento: Compare vizinhos e rotas com o HTTP. Retire um anúncio e repita o tráfego.

Limite: Máquinas educacionais ampliadas: OSPF stub/NSSA/externos e HMAC, RIP next-hop/filtros/hold-down/SHA-256; sem todas as opções de produção.

## SVI / subinterfaces / VRF

VLAN separa broadcast. Uma interface L3 resolve o gateway; VRF seleciona uma tabela independente, inclusive com IPs sobrepostos.

Experimento: Use os labs do switch L3 e de VRF. Compare ARP, interfaces e resposta HTTP de cada tabela.

Limite: Não há route leaking automático; configure a tabela de cada fluxo.

## LACP / gateway VRRP

LACP negocia membros antes de encaminhar pelo agregado. VRRP elege um gateway; tracking reduz a prioridade quando o caminho observado falha.

Experimento: Desligue um membro LACP ou o uplink do primário VRRP e envie uma nova conexão.

Limite: Não equivale a todas as máquinas IEEE de agregação nem a HSRP proprietário.

## IPv6 / NDP / SLAAC

DAD verifica duplicação; RA anuncia prefixos e gateways; NDP resolve o vizinho do próximo salto usando multicast.

Experimento: Compare endereço tentative/preferred, tabela NDP e ping com Hop Limit 1.

TCP, UDP/echo, HTTP e DHCPv6 trafegam por IPv6, com ACL, VRF e scope link-local. DHCPv6 oferece endereços e delegação de prefixo; RA fornece o gateway. NUD acompanha REACHABLE/STALE/DELAY/PROBE/FAILED. Veja ADR-029.

## Wireless

O cliente escolhe rádio compatível e autentica antes de associar. Sinal, distância, canal e interferência influenciam perdas e capacidade.

Experimento: Erre a chave, observe falha, corrija e envie HTTP. Afaste o notebook ou altere canal e compare o RSSI.

Limite: WPA2/WPA3 e proteção de frames são didáticos; PEAP/TLS usa certificados e AES-GCM no modelo; sem chipset real.

## VPN / SD-WAN

O túnel depende de rotas e conectividade do underlay. SD-WAN mede RTT/perda e aplica a política de transporte ao tráfego correspondente.

Experimento: Inspecione a negociação UDP, a política recebida e o caminho após queda do primeiro transporte.

Limite: Encapsulamento e autenticação próprios do modelo; sem interoperabilidade IPsec/IKE.

## QoS / MPLS

QoS classifica frames e escolhe quem usa a capacidade da saída. MPLS classifica uma FEC e encaminha pela pilha e LFIB.

Experimento: Reduza capacidade, compare DSCP/filas/drops. No MPLS, acompanhe push, swap e pop até o HTTP.

Limite: Filas físicas simplificadas e MPLS estático; sem LDP/RSVP ou ASIC.

## VXLAN / EVPN

VXLAN transporta Ethernet em UDP pelo underlay. EVPN anuncia onde o MAC/IP está; route targets controlam importação.

Experimento: Compare VLANs locais distintas com o mesmo VNI, rotas MAC/IP e frames UDP/4789.

Limite: Subconjunto MAC/IP educacional; sem multihoming/DF, type-5 ou codec MP-BGP.

## 802.1X / AAA / firewall

O supplicant responde ao authenticator; RADIUS autoriza o MAC/VLAN. TACACS+ autoriza o terminal. Inspeção de aplicação classifica HTTP/DNS em claro.

Experimento: Compare a porta antes/depois do Access-Accept e teste Host HTTP permitido/bloqueado.

Limite: Proteção didática; 802.1X cabeado, um MAC por porta e primeira requisição HTTP por conexão.

## Automação / telemetria / NTP

Candidate separa proposta de configuração ativa. Jobs aguardam respostas reais. Telemetria envia sensores; NTP mede quatro timestamps para corrigir o relógio do equipamento.

Experimento: Faça edit-config, validate e commit. Compare offset, stratum e sensores do coletor com os contadores de interface.

Limite: NETCONF usa XML e framing/capabilities; RESTCONF usa recursos HTTP/ETag. O canal TLS usa certificados tipados e criptografia real; sem SSH/YANG genérico ou interoperabilidade TLS binária. NTP não disciplina frequência ou UTC real.

## Mídia / transceivers

Socket, módulo, velocidade e alcance devem combinar antes de transmitir. Capacidade serializa os bytes; perda e latência afetam cada entrega.

Experimento: Conecte SFP/QSFP com módulo correspondente; compare DAC de 7 m com fibra. Provoque diferença de velocidade.

Limite: Alcances são regras do modelo; sem óptica/elétrica completa, PoE ou dados de fabricante real.

## Avaliação guiada

Há 23 labs: seis de fundamentos e 17 avançados. Os avançados começam com uma falha específica indicada nas notas. A avaliação copia a configuração, limpa tráfego/estado aprendido e reconverge os protocolos; gera novas conexões e, quando indicado, provoca falha adicional para testar recuperação. O laboratório editado não é alterado pela avaliação. Contadores/resultados históricos enviados pelo cliente não substituem essa execução.

O orçamento por avaliação é limitado a 24 equipamentos, 48 enlaces e 128 regras ACL. A avaliação não certifica conformidade IEEE/RFC nem conectividade externa.

## Aprendizagem e equipamentos

Abra Desafio para escolher objetivos de rede, pesos e dicas; salve o estado inicial e verifique tráfego novo no backend. Tutorial acompanha equipamentos, cabos, endereçamento, ARP/ICMP e TCP. Pontos mantêm o melhor resultado, sem somar tentativas.

Use proxy/balanceador para comparar HTTP via conexões upstream; SIP/RTP para telefonia; IPP para impressão/papel/fila; MQTT para tópicos/retain/keepalive. PoE limita energia por classe e orçamento, serial depende de DCE/clock e console abre CLI sem IP. WLC/CAPWAP, mesh e IDS/IPS estão na configuração avançada de rede. Veja ADRs 030–034.
