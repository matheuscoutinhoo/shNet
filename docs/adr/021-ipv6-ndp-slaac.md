# ADR-021 — IPv6, NDP e SLAAC

Status: implementado no simulador educacional.

## Encaminhamento

IPv6 tem endereços canônicos de 128 bits, prefixos até /128 e tabelas separadas do IPv4. Cada interface habilitada cria link-local EUI-64; endereços estáticos e SLAAC passam por DAD antes de se tornarem utilizáveis. Frames EtherType IPv6 atravessam cabos, switching, VLANs, SVIs, subinterfaces e LACP. VRFs isolam rotas, endereços locais, caches NDP e probes. Destinos link-local exigem interface de saída e nunca são encaminhados entre enlaces.

O motor seleciona a rota pelo prefixo mais específico, com preferência connected/static/RA e métrica. Rotas estáticas informam interface e próximo salto, permitindo gateway link-local com escopo explícito. `ipv6 unicast-routing` controla trânsito em roteadores e switches L3. ICMPv6 Echo, Destination Unreachable, Time Exceeded e Packet Too Big percorrem a rede e correlacionam o pacote citado com o probe. Hop Limit diminui em cada roteador. MTU mínima de IPv6 é 1280; roteadores não fragmentam, conforme os conceitos de [RFC 8200](https://www.rfc-editor.org/rfc/rfc8200.html).

## Descoberta e configuração dinâmica

NS usa multicast solicited-node; NA informa o endereço MAC por frame real. Uma falta no cache mantém fila por interface/próximo salto, com três tentativas de um segundo. NA solicited precisa corresponder à resolução e ao endereço de origem. Cache expira após 30 segundos. Mensagens NDP exigem Hop Limit 255 e opções MAC compatíveis com Ethernet. O modelo usa os conceitos de descoberta de vizinhos e roteadores da [RFC 4861](https://www.rfc-editor.org/rfc/rfc4861.html).

DAD envia NS com origem `::`; NS/NA concorrente marca o endereço como duplicado. RS solicita Router Advertisement; RA anuncia vida do gateway e prefixos L/A. Um prefixo autônomo /64 gera endereço EUI-64, novamente sujeito a DAD. Vida preferida expirada produz estado deprecated; vida válida expirada remove o endereço. Atualizações de vida válida SLAAC aplicam a proteção de duas horas para anúncios não autenticados. Os conceitos de DAD e SLAAC seguem a [RFC 4862](https://www.rfc-editor.org/rfc/rfc4862.html).

## Configuração e inspeção

```text
enable
conf t
ipv6 unicast-routing
interface Gi0/1
ipv6 address 2001:db8:1::1/64
ipv6 nd prefix 2001:db8:1::/64 valid 60 preferred 30
exit
ipv6 route 2001:db8:2::/64 Gi0/1 2001:db8:1::2
end
show ipv6 interface
show ipv6 neighbors
show ipv6 route
ping ipv6 2001:db8:2::10 hop-limit 64 size 104
traceroute ipv6 2001:db8:2::10
```

Clientes usam `ipv6 address autoconfig`. A aba IPv6 configura endereços, SLAAC, RA, rotas e ACLs de entrada/saída; exibe estados DAD, gateways, vizinhos e resultados. Regras ACL IPv6 classificam Echo/NDP/erros e prefixos; uma lista configurada tem deny implícito. NDP passa pela ACL e pode ser bloqueado. O inspetor apresenta IPv6/ICMPv6, prefixos RA e citações de erro. O template **Endereços que chegam pela rede** inicia sem convergência, para observar DAD e SLAAC.

Estado e timers são serializados; validação rejeita resoluções órfãs, timers ausentes/duplicados, rotas sem interface e estados incompatíveis. Testes cobrem tráfego roteado, VLAN/SVI, VRF, LACP, erros ICMPv6, duplicação, expiração, ACL, comandos, rollback, API e navegador desktop/mobile.

## Limites

ICMPv6 é o transporte IPv6 implementado nesta etapa. TCP/UDP, DNS como transporte, BGP/OSPF/RIP, firewall stateful e NAT permanecem em IPv4. Não há DHCPv6, NUD completo, SEND, extensões/fragmentação de origem, redirects, endereços temporários, RA guard, multicast routing ou ICMPv6 binário/checksum. Prefixos on-link acompanham os endereços configurados/SLAAC; anúncios L sem A não instalam uma lista independente de prefixos. Timers usam um tick de um segundo, com uma tentativa DAD por endereço, três RS e cache com expiração em vez da máquina NUD completa. Aplicar configuração reinicia DAD/SLAAC naquela interface. O traceroute cria oito probes com Hop Limit crescente, sem sockets reais.
