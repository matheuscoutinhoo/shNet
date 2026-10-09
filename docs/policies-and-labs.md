# Políticas e labs

## ACL

ACLs são listas ordenadas por sequência. A primeira regra correspondente decide o pacote; uma lista aplicada sem correspondência usa deny implícito. Sem lista aplicada, o tráfego não é filtrado. Cada regra possui contador e cada descarte registra a ACL/interface/regra.

```text
enable
configure terminal
access-list FILTER 10 permit icmp any any
access-list FILTER 20 deny udp any any eq 53
interface Gi0/1
ip access-group FILTER in
end
show access-lists
```

Origem e destino aceitam `any`, IPv4 ou CIDR. A implementação filtra IP/ICMP/UDP/TCP; portas exigem UDP ou TCP. Exemplo: `access-list WEB 10 permit tcp any any eq 80`. `no ip access-group FILTER in` remove o vínculo; a ACL deve estar desvinculada antes de ser excluída.

## NAT

```text
enable
configure terminal
interface Gi0/1
ip nat inside
interface Gi0/2
ip nat outside
exit
ip nat pool WAN 192.168.10.0/24 192.168.20.100 192.168.20.100 overload
end
show ip nat translations
```

Sem `overload`, o pool faz tradução dinâmica um-para-um. `ip nat static 192.168.10.10 192.168.20.100` cria mapeamento estático. Os globals precisam pertencer à subnet da interface outside; reserve esses endereços e não os atribua a outros hosts.

Ordem: ACL de entrada, tradução de destino no retorno, decisão de rota, firewall de trânsito quando habilitado para o protocolo, tradução de origem e ACL de saída. ARP responde pelos globals pertencentes ao NAT. ICMP usa identificador traduzido, UDP/TCP usam portas. Traduções expiram em tempo virtual (60 s para ICMP/dynamic, 120 s para UDP PAT e 300 s para TCP PAT). Alterar a configuração limpa traduções dinâmicas. TCP conserva sequência, ACK e payload na tradução.

Limites: 8 pools, 256 endereços por intervalo e 1024 bindings por roteador; sem hairpin, ALG ou VRF. NAT traduz o cabeçalho externo e a citação dos erros ICMP nos dois sentidos, usando o mapeamento existente sem renovar seu timer. NAT não equivale a firewall. O template "Além da rede privada" permite provar o efeito da tradução porque o destino não possui rota de retorno para a subnet interna.

## Firewall stateful TCP/UDP/ICMP Echo

No roteador, configure `firewall trust Gi0/1`, `firewall protocols tcp udp icmp` e `service firewall`. O painel Políticas oferece seleção de protocolos/interfaces confiáveis, ativação, tabela e contadores. Um SYN iniciado na rede confiável cria uma sessão TCP; retornos precisam corresponder a IPs, portas, interfaces, handshake e sequência/ACK rastreados. UDP rastreia IPs/portas/interfaces; ICMP correlaciona Echo Request de saída e Echo Reply pelo identificador e IPs. Trânsito entre interfaces confiáveis continua permitido. Trânsito entre interfaces não confiáveis é bloqueado para protocolos rastreados. `show firewall` mostra sessões e `no service firewall` desativa a política.

Sessões TCP expiram após 60 s durante abertura, 300 s estabelecidas e 120 s no encerramento; tráfego aceito renova o prazo. RST válido remove a sessão; FIN preserva estado temporário para permitir retransmissões finais. UDP expira após 120 s e ICMP Echo após 60 s de inatividade. Há no máximo 1024 sessões compartilhadas pelos protocolos. Alterar configuração reinicia a tabela. ACLs continuam filtrando conexões rastreadas. Os eventos FIREWALL_PERMIT/DENY/EXPIRED explicam as decisões.

No modo legado de interfaces confiáveis, protocolos desmarcados seguem as ACLs; essa seleção não é uma regra deny. Snapshots antigos sem seleção mantêm TCP. Tráfego destinado ou originado no próprio roteador não passa por essa política. Zonas e erros ICMP relacionados ampliam o modelo conforme a seção abaixo. Sem inspeção profunda, regras por aplicação ou NGFW. Veja [ADR-009](adr/009-tcp-and-stateful-firewall.md), [ADR-012](adr/012-multiprotocol-firewall.md) e [ADR-015](adr/015-firewall-zones-and-related-icmp.md).

## Labs avaliáveis

As definições versionadas ficam em `packages/simulation-engine/src/labs.ts`. Há primeira LAN, correção de roteamento, DHCP, VLAN 20, borda NAT/ACL e failover RSTP. O projeto registra modo free/guided/challenge e o lab escolhido.

O backend avalia somente a topologia salva do proprietário. O cliente não pode enviar notas/resultados aprovados. A avaliação usa uma cópia do engine, remove histórico/caches/traduções dinâmicas, reconstrói serviços necessários e gera tráfego novo com limite de eventos. Não altera o relógio nem os probes da sessão aberta. Limite de avaliação: 24 dispositivos, 48 links e 128 regras ACL.

OSPF/RIP são reiniciados nessa cópia para reaprender rotas. O horizonte inicial de OSPF considera Dead + dois Hellos + um tick, com orçamento de 20 mil eventos, permitindo eleição DR/BDR antes do ping. Conexões TCP, consultas SNMP e sessões de firewall antigas são descartadas; a configuração dos serviços é preservada.

O progresso é armazenado com a revisão avaliada. A interface informa quando há alterações não avaliadas; o histórico de conclusão pode permanecer mesmo após o aluno modificar a rede para novos experimentos. Não há garantia de correção de topologias arbitrárias fora dos objetivos de cada lab.

## Canvas e inspeção

Anotações/regiões/grupos são metadados separados do estado dos protocolos. Mover grupos não altera a distância física dos cabos. Notas e regiões podem ser redimensionadas, coloridas, copiadas e salvas; o snap é opcional e a vista desktop é persistida. No mobile, a topologia é reenquadrada.

O inspetor global mostra inventário, interfaces, VLANs, rotas, erros e caminhos de probes. O caminho é reconstruído de transmissões reais, não de uma busca visual em um grafo. A coluna VLAN mostra a tag que estava no frame; untagged não implica VLAN 1. OSI identifica explicitamente camadas não modeladas.

## Zonas e ICMP relacionado

O firewall de trânsito permite zonas com regras por protocolo/porta, ordenadas pela sequência. inspect cria estado e permite retorno; permit libera sem estado; deny bloqueia inclusive retornos existentes. Sem regra, o trânsito entre zonas e interfaces sem zona é descartado. Dentro da mesma zona, é permitido, salvo regra explícita. ACLs in/out continuam aplicadas e o tráfego local do roteador fica sujeito às ACLs.

Erros ICMP incluem uma citação do fluxo original e precisam corresponder a uma sessão viva para serem RELATED. NAT traduz endereços/portas/identificadores citados nos dois sentidos, sem criar ou renovar bindings. O template Três zonas, caminhos controlados demonstra HTTP e traceroute. Comandos em [protocols.md](protocols.md); contratos e limites em [ADR-015](adr/015-firewall-zones-and-related-icmp.md).

## Desafios avançados

Os 17 novos desafios cobrem BGP/OSPF/RIP, SVI/VRF, LACP/VRRP tracking, SLAAC, wireless, VPN/SD-WAN, QoS/MPLS, EVPN, AAA, inspeção e automação. Cada cenário começa com uma falha informada no objetivo/notas. A avaliação não altera a topologia editada: copia a configuração, renova protocolos e gera tráfego novo. A conclusão exige as respostas e o estado de rede correspondentes; resultados e contadores históricos não substituem o ensaio. LACP/VRRP/SD-WAN incluem falha adicional; VRF exige a resposta de cada tabela. Guia: [network-concepts.md](network-concepts.md).
