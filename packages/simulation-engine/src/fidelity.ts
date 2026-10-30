export const fidelityMatrix = [
  {
    feature: 'Cisco IOS/IOS XE CLI e startup',
    status: 'Parcial',
    limit:
      'Subset de IOS/IOS XE: modos, abreviações, ACLs, PAT, VRF, OSPF/BGP, MST, segurança de campus, MQC e IP SLA. write memory valida a reprodução antes de salvar; configurações sem replay completo são recusadas. SSH/VTY nativo, SNMPv3, OSPFv3, EIGRP, IS-IS e paridade com todos os comandos/plataformas permanecem pendentes. Não executa firmware Cisco.',
  },
  {
    feature: 'CDP, LLDP e HSRP',
    status: 'Parcial',
    limit:
      'CDP/LLDP e HSRP IPv4 v1/v2 possuem codecs Ethernet/UDP. HSRP inclui eleição, preempção, tracking de interfaces e objetos IP SLA, MAC/ARP virtual e relay DHCP ativo. Autenticação HSRP e IPv6 permanecem pendentes; o decoder recusa TLVs de autenticação não suportados.',
  },
  {
    feature: 'NICs e acesso A/B',
    status: 'Simulado',
    limit:
      'Bond ativo/backup em PC/servidor/PLC/HMI, IPv4/IPv6 e DHCP na interface lógica. Modelos enterprise/fábrica combinam acesso, energia e gateways WAN/DC A/B. Carrier detecta falha local; monitor ARP observa um alvo L2. Falha do endpoint ou dos dois caminhos interrompe o fluxo.',
  },
  {
    feature: 'Disponibilidade de serviços',
    status: 'Parcial',
    limit:
      'VRRP accept mode e tracking permitem DNS/HTTP/NTP/syslog no VIP ativo, com conteúdo equivalente configurado. DHCPv4 replica leases por canal dedicado e permite promoção administrativa com fencing. Dados/logs/sessões dos demais serviços não são replicados; quorum/eleição automática permanecem pendentes.',
  },
  {
    feature: 'Ethernet, IPv4/IPv6, TCP/UDP, VLAN, ACL',
    status: 'Simulado',
    limit: 'Modelo de eventos discretos; não executa firmware de fabricante.',
  },
  {
    feature: 'RSTP/MST, VRRP, OSPF, BGP, QoS',
    status: 'Parcial',
    limit:
      'OSPFv2 inclui ECMP por fluxo, áreas stub/NSSA, sumarização, default condicional e MD5. BGP inclui prefix-lists/route-maps, peer-groups, maximum-prefix e TCP MD5. MQC aplica classificação, marcação, LLQ/WRR, policer e shaping global; pesos discretos aproximam bandwidth percent. Não representa todos os mecanismos de hardware, protocolos ou comandos Cisco.',
  },
  {
    feature: 'Segurança de campus e detecção de falhas',
    status: 'Parcial',
    limit:
      'DHCP snooping, DAI, IP source guard, port-security, voice VLAN e root/loop guard atuam no encaminhamento. UDLD usa anúncios/eco de um salto e oito tentativas antes de err-disable; sua temporização é simplificada e não há codec PCAP. BFD assíncrono IPv4 de um salto usa UDP/3784 e derruba adjacências OSPF; sem Echo, Demand, autenticação, multihop ou integração BGP. 802.1X nativo controla o modelo EAPOL/RADIUS existente; não é uma implementação completa de todos os métodos EAP.',
  },
  {
    feature: 'WAN e operação empresarial',
    status: 'Parcial',
    limit:
      'PAT por ACL/interface, NTP, timezone, arquivos virtuais de configuração, IP SLA ICMP, tracking e consultas de inventário/erros/forwarding usam estado real do modelo. MPLS usa LFIB/FEC manual, sem LDP. Túneis cifrados usam handshake didático, sem CLI completa IKEv2 ou formato IKEv2/ESP interoperável. NETCONF/RESTCONF do modelo não equivalem ao gerenciamento nativo Cisco por SSH/TLS certificado.',
  },
  {
    feature: 'Firewall stateful',
    status: 'Simulado',
    limit:
      'Zonas ip/TCP/UDP/ICMP e sessões de trânsito cobrem IPv4/IPv6 em roteadores. Par HA explícito replica sessões e NAT/PAT por canal dedicado sujeito a falhas; VRRP sozinho não replica estado. Inspeção de aplicação/SIP ALG e hairpin não são replicados. Switch L3 oferece ACL.',
  },
  {
    feature: 'Wi-Fi/RF',
    status: 'Parcial',
    limit: 'Modelo aproximado de distância, obstáculos e interferência; não substitui levantamento de campo.',
  },
  {
    feature: 'MQTT',
    status: 'Parcial',
    limit:
      'Verifique o nível QoS e autenticação configurados; transporte do modelo não equivale a homologação de broker industrial.',
  },
  {
    feature: 'SNMP',
    status: 'Parcial',
    limit: 'GET/GETNEXT com community; SNMPv3 authPriv e traps não implementados.',
  },
  {
    feature: 'Modbus TCP',
    status: 'Parcial',
    limit:
      'MBAP/PDU binários sobre TCP e PCAP: funções 01/02/03/04/05/06/15/16. Processo de tanque simplificado, scans PLC e ciclos HMI/SCADA/MES com alarmes e deadlines. Sem ladder, firmware ou física certificada. Conexões antigas hex/newline são legadas e excluídas do PCAP.',
  },
  {
    feature: 'PROFINET, EtherNet/IP, OPC UA',
    status: 'Não suportado',
    limit: 'Não há emulação desses protocolos.',
  },
  {
    feature: 'MRP, DLR, PRP, HSR',
    status: 'Não suportado',
    limit: 'RSTP não substitui os protocolos de redundância industrial.',
  },
  {
    feature: 'PTP / TSN',
    status: 'Não suportado',
    limit: 'NTP não valida sincronismo de precisão ou agendamento determinístico.',
  },
  {
    feature: 'SCADA, MES, câmeras e processo',
    status: 'Representado',
    limit:
      'Cargas Modbus periódicas, setpoint e processo de tanque educacional. Não executa aplicações MES/SCADA completas, firmware ou codecs de vídeo.',
  },
  {
    feature: 'VXLAN / EVPN / underlay',
    status: 'Parcial',
    limit:
      'VTEP em loopback /32 e BGP updateSource permitem caminhos alternativos operacionais. MAC/IP e membros IMET por RT; peerPolicy evpn exige membros no plano de dados. BGP/MP-BGP binários com AS4 e tipos EVPN 2/3. Supressão ARP opcional por binding EVPN e membro IMET; não atesta saúde da VM. Sem ESI/DF, Type 5 ou proxy NDP.',
  },
  {
    feature: 'VRF e executor dual stack',
    status: 'Parcial',
    limit:
      'ICMP/HTTP/Modbus aceitam IPv6, VRF e escopo link-local. Outros adaptadores de cenário usam IPv4 na tabela padrão. Protocolos dinâmicos de VRF não implementados.',
  },
  {
    feature: 'Alimentação A/B',
    status: 'Simulado',
    limit:
      'Uma carga pode ter múltiplas UPS: mantém energia enquanto uma fonte solicitada tem saída. Cada UPS reserva a potência nominal completa; não representa chaveamento elétrico real.',
  },
  {
    feature: 'PCAP',
    status: 'Parcial',
    limit:
      'Ethernet/IP/TCP, OSPFv2/MD5, HSRPv1/v2 sem autenticação, BFD, CDP/LLDP, Modbus, DNS, DHCPv4/v6, syslog, VXLAN e BGP/EVPN têm codecs binários com validação. Exportar/decodificar não atesta interoperabilidade com equipamento Cisco. Protocolos sem codec, autenticação OSPF HMAC legada e cabeçalhos OSPF legados sem metadados são explicitamente excluídos. O canal de réplica DHCP não tem codec de fabricante.',
  },
];
