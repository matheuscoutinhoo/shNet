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
    limit: 'Trânsito em roteadores. Switch L3 oferece ACL; VRRP não replica sessões.',
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
      'Leitura/escrita de holding registers no modelo. Enquadramento hexadecimal sobre TCP didático; não representa processo físico ou firmware PLC.',
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
    feature: 'PCAP',
    status: 'Parcial',
    limit: 'Somente codecs suportados. Omissões e truncamento são informados na exportação.',
  },
];
