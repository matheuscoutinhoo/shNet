# ADR-018 — Subinterfaces, SVI, switch L3 e VRF

Status: implementado no simulador educacional.

## Comportamento

Interfaces lógicas usam o mesmo pipeline IPv4/ARP/TCP que interfaces físicas. Uma subinterface de roteador identifica a porta pai e uma VLAN: transmite frames 802.1Q e só recebe a tag correspondente. Uma SVI conecta a stack IP do switch a uma VLAN existente; o switch aprende/faz flooding nas portas dessa VLAN e entrega frames destinados ao MAC da SVI à stack IP. Broadcast ARP continua confinado à VLAN.

O switch roteia trânsito quando `ip routing` está ativo. Sem essa opção, uma SVI ainda permite entrega local e tráfego originado pelo switch, mas não conecta sub-redes. Portas físicas routed são configuráveis com `no switchport`. STP atua apenas nas portas físicas de switching; subinterfaces, SVIs e portas routed não recebem estado STP. Cabos não podem se conectar a interfaces lógicas.

Cada interface e rota estática pode pertencer a uma VRF. A recepção define a tabela usada no encaminhamento e na entrega local. Rotas conectadas, padrão e estáticas de outra tabela não são candidatas. O contexto da VRF não é um campo do pacote no cabo. ARP e filas pendentes são separados por interface; probes e conexões TCP conservam o contexto local, e a mesma tupla TCP pode existir simultaneamente em VRFs diferentes.

Configuração é aditiva no snapshot v1. São validados parent físico, VLAN, modo routed, MAC único, VRF existente, duplicação de IPv4 dentro de uma tabela e referências de tráfego. Subinterfaces herdam a disponibilidade administrativa do parent; transmissão da SVI exige uma porta ativa na VLAN com carrier e, quando STP está ligado, forwarding.

## Configuração

```text
enable
configure terminal
interface Gi0/1.10
encapsulation dot1q 10
ip address 192.168.10.1/24
end
```

No switch, crie/configure `interface Vlan10` e ative `ip routing` para encaminhar entre VLANs. A aba **VLAN / VRF** cria interfaces e VRFs; a aba **Portas** configura seus endereços. Switchports/trunks precisam permitir as VLANs.

```text
vrf definition BLUE
interface Gi0/1
vrf forwarding BLUE
ip address 10.0.0.1/24
exit
ip route vrf BLUE 203.0.113.0/24 10.0.0.2
end
show vrf
show ip route vrf BLUE
ping vrf BLUE 10.0.0.2
http get vrf BLUE 10.0.0.2
```

Associar uma interface a outra tabela conserva o endereço, cancela ARP pendente e encerra suas conexões locais antigas. `no interface NAME` remove uma interface lógica; referências de protocolos/políticas precisam ser removidas antes. A remoção de VRF referenciada é recusada. O painel TCP e o diálogo de ping permitem escolher a tabela.

## Limites

- Até 48 interfaces e 32 VRFs por equipamento. Um MAC distinto por interface lógica; sem native VLAN em subinterfaces.
- VRF IPv4 com roteamento conectado/estático, trânsito de pacotes e ICMP/TCP locais; sem route leaking/import/export, RD/RT ou protocolos dinâmicos por VRF.
- OSPF/RIP/BGP, DHCP e NAT usam a tabela padrão. Configurações incompatíveis de DHCP/NAT/OSPF/RIP/VRRP na interface de uma VRF são recusadas. Serviços UDP locais não são atendidos em VRFs.
- SVIs não oferecem OSPF/BGP/VRRP no switch nesta etapa. Não há emulação de ASIC.
- A seleção de rotas conectadas usa estado administrativo; uma rota pode ser selecionada e depois descartada por ausência de carrier/STP/VLAN, conforme as regras de disponibilidade na transmissão.

## Verificação

Testes geram ARP, ping e HTTP entre VLANs, verificam tags, filtros de VLAN, shutdown do parent/subinterface, switching/STP/SVI, endereços e tuplas TCP sobrepostos, ausência de vazamento entre tabelas, CLI, save/load determinístico e rejeição de referências inválidas. A API persiste tráfego pendente nos três templates novos e valida alterações adulteradas. O contexto VRF permanece no snapshot sem modificar os cabeçalhos IPv4/Ethernet.
