export const fidelityMatrix = [
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
      'MBAP/PDU binários sobre TCP e PCAP: funções 01/02/03/04/05/06/15/16. Coils, entradas discretas, holding/input registers e amostragem periódica por cenário. Sem ladder, processo físico ou firmware PLC. Conexões antigas hex/newline continuam legadas e são excluídas do PCAP.',
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
    limit: 'Serviços e cargas de rede substitutos; lógica de processo e codecs de vídeo não executados.',
  },
  {
    feature: 'VXLAN / EVPN / underlay',
    status: 'Parcial',
    limit:
      'VTEP em loopback /32 e BGP updateSource permitem caminhos alternativos operacionais. MAC/IP e membros IMET por RT; peerPolicy evpn exige membros no plano de dados. Modo static admite flooding/learning por peers. Sem ESI/DF, Type 5, proxy ARP ou MP-BGP binário.',
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
      'Ethernet/IP/TCP, Modbus binário, DNS, DHCPv6 e VXLAN/UDP com checksums. BGP e aplicações didáticas sem codec permanecem excluídos. Capturas antigas hex/newline ou VXLAN sem padding podem ser excluídas; omissões e truncamento são informados.',
  },
];
