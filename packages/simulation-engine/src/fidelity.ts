export const fidelityMatrix = [
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
    feature: 'RSTP, VRRP, OSPF, BGP, QoS',
    status: 'Parcial',
    limit: 'Subconjuntos educacionais. Convergência deve ser medida por cenário.',
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
      'Ethernet/IP/TCP, Modbus binário, DNS, DHCPv4/v6, syslog RFC 5424/UTF-8, VXLAN/UDP e BGP/EVPN binários com checksums. Aplicações sem codec permanecem excluídas. Capturas legadas incompatíveis são omitidas; exclusões e truncamento são informados. O canal de réplica DHCP não tem codec de fabricante.',
  },
];
