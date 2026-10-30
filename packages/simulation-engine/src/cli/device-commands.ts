import type { Device } from '../model';
import { deviceCapabilities, devicePresentationProfile } from '../devices/capabilities';
import type { Context } from './registry';

export function terminalIdentity(d: Device) {
  const c = deviceCapabilities(d);
  const name = devicePresentationProfile(d)?.name ?? d.type;
  const family = c.switching
    ? 'NetOS Switching'
    : c.ap
      ? 'NetOS Wireless'
      : c.controller
        ? 'NetOS WLAN Controller'
        : c.routing
          ? 'NetOS Routing'
          : d.type === 'server'
            ? 'ServiceShell'
            : 'HostShell';
  return {
    name,
    family: d.operatingSystem
      ? 'IOS XE 17.12 · shLab core subset'
      : c.routingProtocols || c.switching
        ? 'IOS/IOS XE · shLab core subset'
        : family,
    host: c.endpoint,
  };
}

/** The same capability contract drives device menus, help and actual execution. */
export function commandSupported(d: Device, input: string, context: Context): boolean {
  const c = deviceCapabilities(d);
  if (!c.active) return /^(help|\?|show interfaces)$/i.test(input);
  const line = input.toLowerCase().replace(/^no /, '');
  if (/^(?:class-map|policy-map|service-policy|show policy-map)\b/.test(line))
    return (c.routing || c.switching) && !c.endpoint;
  if (
    /^(?:archive|ip sla|track|show (?:track|ip sla|inventory|environment|ip cef)|clock timezone)\b/.test(line)
  )
    return (c.routing || c.switching) && !c.endpoint;
  if (/^(?:bfd|ip ospf bfd|show bfd)\b/.test(line)) return c.routingProtocols;
  if (/^(?:udld|show udld)\b/.test(line)) return c.switching || c.routingProtocols;
  if (/^(?:ip prefix-list|route-map|show (?:ip prefix-list|route-map))\b/.test(line))
    return c.routingProtocols;
  if (
    /^(?:ip arp inspection|ip verify source|ip source binding|authentication port-control|show port-security)\b/.test(
      line
    )
  )
    return c.switching;
  if (/^(?:write\b|copy\b|erase startup-config\b|reload$|show startup-config$)/.test(line))
    return (c.routing || c.switching) && !['ap', 'mesh', 'wlc'].includes(d.profile ?? '');
  if (/^enable (?:secret|algorithm-type)\b/.test(line)) return (c.routing || c.switching) && !c.endpoint;
  if (/^(?:standby|show standby)\b/.test(line)) return c.routingProtocols;
  if (/^(?:cdp|lldp|show (?:cdp|lldp))\b/.test(line))
    return (c.routing || c.switching) && !['ap', 'mesh', 'wlc'].includes(d.profile ?? '');
  if (/^ip access-list /.test(line)) return c.routing || c.switching;
  if (/^(ipconfig|ip (addr|address|link|route) (show|add|del|set)|route print|arp -a|hostname$)/.test(line))
    return c.endpoint;
  if (/^wifi /.test(line)) return c.wireless && c.endpoint;
  if (/^ip route /.test(line)) return c.routing || c.endpoint;
  if (/^(switchport|vlan |name |show vlan|show mac address-table)/.test(line))
    return c.switching || c.ap || c.controller;
  if (/^(spanning-tree|show spanning-tree)/.test(line)) return c.switching;
  if (/^(channel-group|lacp|port-channel|show (etherchannel|lacp))/.test(line)) return c.lacp;
  if (/^(service vrrp|vrrp |show vrrp)/.test(line)) return c.vrrp;
  if (
    /^(router (ospf|rip)|ospf |rip |ip (ospf|rip)|service (ospf|rip|vrrp)|vrrp |show (ip (ospf|rip)|vrrp))/.test(
      line
    )
  )
    return c.routingProtocols;
  if (/^(router bgp|bgp |neighbor |service bgp|show ip bgp)/.test(line)) return c.routingProtocols;
  if (/^ip routing/.test(line)) return c.routing || (c.switching && !d.profile);
  if (/^(ipv6 unicast-routing|ipv6 nd prefix)/.test(line)) return c.routing;
  if (/^(vrf |ip vrf |ip route vrf |show vrf|show ip route vrf|ping vrf|http get vrf)/.test(line))
    return c.vrf;
  if (/^(encapsulation dot1q|switchport$|interface vlan|interface \S+\.\d+)/.test(line)) return c.layer3;
  if (/^(vxlan |service vxlan|show (vxlan|evpn))/.test(line)) return c.vxlan;
  if (/^(mpls |service mpls|show mpls)/.test(line)) return c.routing;
  if (/^(qos |service qos|show qos)/.test(line))
    return c.routing || c.switching || d.interfaces.some((p) => !!p.qos);
  if (/^(tunnel |service tunnel|show tunnels)/.test(line)) return d.type === 'router' && c.routingProtocols;
  if (/^sdwan controller/.test(line)) return c.sdwanController;
  if (/^(sdwan |service sdwan|show sdwan)/.test(line)) return d.type === 'router' || c.sdwanController;
  if (/^wireless ap /.test(line)) return c.ap || (!d.profile && d.type === 'switch');
  if (/^wireless client /.test(line)) return (c.wireless && !c.ap) || (!d.profile && c.endpoint);
  if (/^show wireless clients/.test(line)) return c.ap;
  if (/^(wireless |service wireless|show wireless)/.test(line))
    return c.wireless || (!d.profile && (c.endpoint || d.type === 'switch'));
  for (const kind of [
    'wlc',
    'wtp',
    'mesh',
    'ids',
    'eapServer',
    'eapAuthenticator',
    'eapSupplicant',
  ] as const) {
    const command = kind.startsWith('eap') ? 'eap ' + kind.slice(3).toLowerCase() : kind;
    if (line.startsWith(command + ' ') || line === 'show ' + command) return c.advancedKinds.includes(kind);
  }
  if (line === 'show eap') return c.advancedKinds.some((k) => k.startsWith('eap'));
  for (const kind of ['phone', 'printer', 'proxy', 'broker'] as const) {
    if (line.startsWith(kind + ' configure') || line === 'show ' + kind)
      return c.applicationKinds.includes(kind);
  }
  if (/^phone (call|hangup)/.test(line)) return c.applicationKinds.includes('phone');
  if (/^(mqtt |print |http proxy )/.test(line)) return c.clientApplications;
  if (/^database query /.test(line)) return c.database || c.clientApplications;
  if (/^database (client|cluster) /.test(line)) return c.database || c.clientApplications;
  if (/^(database configure|database ha)/.test(line)) return c.databaseServer;
  if (/^show database/.test(line)) return c.database;
  if (/^hardware add serial/.test(line)) return c.serial;
  if (/^(hardware add console|console )/.test(line)) return c.console;
  if (/^(poe |show poe)/.test(line)) return c.poeSupply || c.poeLoad;
  if (/^(dot1x |dot1x$)/.test(line)) return c.aaaKinds.includes('dot1x');
  if (/^(supplicant |supplicant$)/.test(line)) return c.aaaKinds.includes('supplicant');
  if (/^aaa server /.test(line)) return c.aaaKinds.includes('server');
  if (/^aaa client /.test(line)) return c.aaaKinds.includes('client');
  if (/^(aaa |show aaa)/.test(line)) return c.aaaKinds.length > 0;
  if (/^ip dhcp snooping|^show ip dhcp snooping/.test(line)) return c.switching;
  if (/^ip helper-address|^show ip dhcp relay/.test(line)) return c.routing;
  if (
    /^(ip dhcp (pool|conflict-detection|ha|excluded-address)|service dhcp|show ip dhcp (pool|binding|ha)|dhcp6 server)/.test(
      line
    ) ||
    context.mode === 'dhcp'
  )
    return c.dhcpServer;
  if (/^(dns (record|security)|service dns|show dns (records|security))/.test(line)) return c.dnsServer;
  if (/^service http/.test(line)) return c.tcpServer && d.type !== 'pc';
  if (/^(service (echo|udp6)|show services)/.test(line)) return c.tcpServer;
  if (/^(access-list|ip access-group|show access-lists)/.test(line)) return c.routing || !d.profile;
  if (/^(ip nat|service nat|show ip nat)/.test(line)) return c.routing;
  if (/^(firewall |service firewall|show firewall)/.test(line)) return c.routing || !!d.firewall;
  if (/^(ha state-sync|no ha state-sync|show ha state-sync)/.test(line)) return d.type === 'router';
  if (/^management configure/.test(line)) return c.remoteKinds.includes('server');
  if (/^management request/.test(line)) return c.remoteKinds.includes('request');
  if (/^automation /.test(line)) return c.remoteKinds.includes('automation');
  for (const kind of ['telemetry', 'collector', 'clock', 'ntp'] as const) {
    if (line.startsWith(kind + ' configure')) return c.remoteKinds.includes(kind);
  }
  if (/^service syslog|^clear syslog/.test(line)) return c.syslogServer;
  return true;
}

type HelpEntry = { command: string; description: string; example: string };
export function deviceCommandHelp(d: Device, context: Context): HelpEntry[] {
  const c = deviceCapabilities(d),
    port = d.interfaces[0]?.name ?? 'Eth0';
  const entries: HelpEntry[] = [
    {
      command: 'help',
      description: 'Mostra os comandos deste equipamento e exemplos de uso.',
      example: 'help',
    },
    ...(c.endpoint
      ? [
          {
            command: 'ipconfig /all',
            description: 'Consulta IP, MAC, gateway e DNS das interfaces locais.',
            example: 'ipconfig /all',
          },
          {
            command: 'ip addr add IP/PREFIXO dev INTERFACE',
            description: 'Define o IPv4 de uma interface deste host.',
            example: `ip addr add 192.168.10.10/24 dev ${port}`,
          },
          {
            command: 'ip route add default via GATEWAY',
            description: 'Define para onde enviar tráfego de outras redes.',
            example: 'ip route add default via 192.168.10.1',
          },
          {
            command: 'ip link set dev INTERFACE up|down',
            description: 'Ativa ou desativa uma interface local.',
            example: `ip link set dev ${port} up`,
          },
          {
            command: 'ipconfig /renew',
            description: 'Solicita um endereço ao servidor DHCP da rede.',
            example: 'ipconfig /renew',
          },
        ]
      : [
          {
            command: 'enable → configure terminal',
            description: 'Entra no modo de configuração. Use end para voltar.',
            example: 'enable',
          },
          {
            command: 'interface NOME',
            description: 'Seleciona uma porta; alterações seguintes valem para ela.',
            example: `interface ${port}`,
          },
          {
            command: 'ip address IP/PREFIXO',
            description: 'Define o IPv4 da interface selecionada, quando ela aceita IP.',
            example: 'ip address 192.168.10.1/24',
          },
          {
            command: 'shutdown | no shutdown',
            description: 'Desativa ou ativa a interface selecionada.',
            example: 'no shutdown',
          },
        ]),
    {
      command: 'show interfaces',
      description: 'Consulta as portas, os endereços e o estado administrativo.',
      example: 'show interfaces',
    },
    {
      command: 'show arp',
      description: 'Consulta quais MACs foram resolvidos para os próximos saltos IPv4.',
      example: 'show arp',
    },
    {
      command: 'ping DESTINO',
      description: 'Testa se existe comunicação IP de ida e volta.',
      example: 'ping 192.168.10.1',
    },
    {
      command: 'traceroute DESTINO',
      description: 'Investiga os roteadores encontrados até um destino.',
      example: 'traceroute 192.168.20.10',
    },
    {
      command: 'nslookup NOME [SERVIDOR]',
      description: 'Consulta o DNS para descobrir o IP de um nome.',
      example: 'nslookup www.lab',
    },
    {
      command: 'show ip route',
      description: 'Consulta os caminhos conhecidos para outras redes.',
      example: 'show ip route',
    },
    {
      command: 'show vlan',
      description: 'Lista as VLANs criadas na ponte de rede deste equipamento.',
      example: 'show vlan',
    },
    {
      command: 'vlan ID',
      description: 'Cria uma VLAN na ponte de rede deste equipamento, em modo de configuração.',
      example: 'vlan 20',
    },
    {
      command: 'switchport access vlan ID',
      description: 'Associa a porta selecionada a uma VLAN.',
      example: 'switchport access vlan 20',
    },
    {
      command: 'show mac address-table',
      description: 'Mostra em qual porta a ponte de rede aprendeu cada MAC.',
      example: 'show mac address-table',
    },
    {
      command: 'show spanning-tree',
      description: 'Mostra quais portas encaminham ou bloqueiam para evitar loops.',
      example: 'show spanning-tree',
    },
    {
      command: 'show etherchannel summary',
      description: 'Consulta os enlaces agregados por LACP.',
      example: 'show etherchannel summary',
    },
    {
      command: 'router ospf ID',
      description: 'Inicia a configuração do protocolo de rotas OSPF.',
      example: 'router ospf 1.1.1.1',
    },
    {
      command: 'show ip ospf neighbor',
      description: 'Consulta os vizinhos OSPF e o estado da comunicação entre roteadores.',
      example: 'show ip ospf neighbor',
    },
    {
      command: 'show ip rip',
      description: 'Consulta o aprendizado de rotas por RIP.',
      example: 'show ip rip',
    },
    {
      command: 'show ip bgp summary',
      description: 'Consulta as sessões de troca de rotas por BGP.',
      example: 'show ip bgp summary',
    },
    {
      command: 'show vrrp',
      description: 'Consulta qual equipamento atende ao gateway virtual.',
      example: 'show vrrp',
    },
    {
      command: 'show ha state-sync',
      description: 'Consulta o canal HA, réplicas pendentes e recusas de estado firewall/NAT.',
      example: 'show ha state-sync',
    },
    {
      command: 'show wireless',
      description: 'Consulta SSID, canal, autenticação e estado do rádio.',
      example: 'show wireless',
    },
    {
      command: 'wifi scan',
      description: 'Detecta redes que o rádio deste cliente consegue ouvir.',
      example: 'wifi scan',
    },
    {
      command: 'wifi connect SSID security MODO [key CHAVE]',
      description:
        'Configura o cliente para associar a uma rede anunciada. Modos: open, wpa2-psk ou wpa3-sae. Depois, avance a simulação.',
      example: 'wifi connect MinhaRede security open',
    },
    {
      command: 'wireless ap ssid SSID security MODO [key CHAVE] channel CANAL',
      description: 'Configura o anúncio e a segurança do ponto de acesso, em modo de configuração.',
      example: 'wireless ap ssid MinhaRede security open channel 6',
    },
    {
      command: 'show wireless scan',
      description: 'Lista redes e sinais que o rádio consegue detectar.',
      example: 'show wireless scan',
    },
    {
      command: 'show wireless clients',
      description: 'Lista os clientes associados a este ponto de acesso.',
      example: 'show wireless clients',
    },
    {
      command: 'show wlc',
      description: 'Consulta APs gerenciados e perfis WLAN do controlador.',
      example: 'show wlc',
    },
    {
      command: 'show wtp',
      description: 'Consulta a ligação deste AP com o controlador por CAPWAP.',
      example: 'show wtp',
    },
    {
      command: 'show eap',
      description: 'Consulta o papel de autenticação empresarial EAP deste equipamento.',
      example: 'show eap',
    },
    {
      command: 'show mesh',
      description: 'Consulta a conexão entre APs da mesma rede mesh.',
      example: 'show mesh',
    },
    {
      command: 'show ids',
      description: 'Consulta regras, alertas e descartes de IDS/IPS.',
      example: 'show ids',
    },
    {
      command: 'show ip dhcp pool',
      description: 'Consulta os intervalos de endereços oferecidos por este servidor.',
      example: 'show ip dhcp pool',
    },
    {
      command: 'show dhcp lease',
      description: 'Consulta o endereço e o prazo recebidos como cliente DHCP.',
      example: 'show dhcp lease',
    },
    {
      command: 'show dns records',
      description: 'Consulta os nomes publicados por este servidor DNS.',
      example: 'show dns records',
    },
    {
      command: 'dns record NOME A IP [ttl SEGUNDOS]',
      description: 'Publica um registro IPv4 no servidor DNS, em modo de configuração.',
      example: 'dns record www.lab A 192.168.10.20 ttl 300',
    },
    {
      command: 'service dns',
      description: 'Habilita as respostas do servidor DNS configurado.',
      example: 'service dns',
    },
    {
      command: 'ip dhcp pool NOME',
      description:
        'Seleciona ou cria um pool DHCP. Configure network, range, default-router, dns-server e lease nesse modo.',
      example: 'ip dhcp pool LAN',
    },
    {
      command: 'service dhcp',
      description: 'Habilita as concessões do servidor DHCP depois de configurar o pool.',
      example: 'service dhcp',
    },
    {
      command: 'service http PORTA',
      description: 'Habilita um serviço HTTP neste servidor, em modo de configuração.',
      example: 'service http 80',
    },
    {
      command: 'show services',
      description: 'Lista os serviços TCP que este equipamento atende.',
      example: 'show services',
    },
    {
      command: 'http get IP [PORTA] [/CAMINHO]',
      description: 'Solicita uma página e acompanha a conexão TCP.',
      example: 'http get 192.168.10.20 80 /',
    },
    {
      command: 'show phone',
      description: 'Consulta número, chamadas e estado de telefonia.',
      example: 'show phone',
    },
    {
      command: 'phone configure JSON',
      description:
        'Configura este telefone em modo de configuração. Consulte os campos e os exemplos no painel Aplicações.',
      example:
        'phone configure {"enabled":false,"number":"1001","sipPort":5060,"rtpPort":10000,"autoAnswer":false}',
    },
    {
      command: 'phone call IP [PORTA]',
      description: 'Inicia uma chamada no telefone configurado e observa sinalização e mídia.',
      example: 'phone call 192.168.10.30',
    },
    {
      command: 'show printer',
      description: 'Consulta a fila e os recursos da impressora.',
      example: 'show printer',
    },
    {
      command: 'printer configure JSON',
      description: 'Define serviço, velocidade e papel da impressora, em modo de configuração.',
      example: 'printer configure {"enabled":true,"port":9100,"pagesPerMinute":20,"paper":100}',
    },
    {
      command: 'show broker',
      description: 'Consulta clientes e mensagens do servidor MQTT.',
      example: 'show broker',
    },
    {
      command: 'broker configure JSON',
      description: 'Habilita o servidor de mensagens MQTT, em modo de configuração.',
      example: 'broker configure {"enabled":true,"port":1883}',
    },
    {
      command: 'mqtt connect IP [CLIENTE]',
      description: 'Conecta este cliente a um broker MQTT alcançável.',
      example: 'mqtt connect 192.168.10.40 sensor1',
    },
    {
      command: 'mqtt subscribe TÓPICO',
      description: 'Assina um tópico após a conexão para receber mensagens publicadas.',
      example: 'mqtt subscribe sensores/temperatura',
    },
    {
      command: 'mqtt publish TÓPICO DADOS',
      description: 'Publica dados no broker da conexão MQTT deste cliente.',
      example: 'mqtt publish sensores/temperatura 24',
    },
    {
      command: 'print IP PÁGINAS TEXTO',
      description: 'Envia um trabalho para uma impressora com serviço ativo.',
      example: 'print 192.168.10.50 1 Teste de impressão',
    },
    {
      command: 'show proxy',
      description: 'Consulta destinos e requisições do proxy ou balanceador.',
      example: 'show proxy',
    },
    {
      command: 'show aaa',
      description: 'Consulta configuração, autenticação e autorização de acesso.',
      example: 'show aaa',
    },
    {
      command: 'show management',
      description: 'Consulta os serviços de administração remota representados neste equipamento.',
      example: 'show management',
    },
    {
      command: 'show ntp',
      description: 'Consulta fontes de tempo e estado de sincronização.',
      example: 'show ntp',
    },
    {
      command: 'clock configure JSON',
      description:
        'Define se este equipamento fornece tempo por NTP e a precisão anunciada, em modo de configuração.',
      example: 'clock configure {"offsetMs":0,"server":true,"stratum":1}',
    },
    {
      command: 'show database',
      description:
        'Consulta tabelas, registros e contadores do banco deste equipamento, sem mostrar a chave.',
      example: 'show database',
    },
    {
      command: 'database configure JSON',
      description:
        'Configura o banco de laboratório por HTTP/TCP, em modo de configuração. Não representa um servidor PostgreSQL.',
      example: 'database configure {"enabled":true,"port":8080,"key":"chave-do-lab"}',
    },
    {
      command: 'database query JSON',
      description:
        'Envia uma consulta ao banco pela rede. A chave deve corresponder à configurada no servidor.',
      example:
        'database query {"target":"192.168.10.20","port":8080,"key":"chave-do-lab","query":"SELECT * FROM sensores LIMIT 10"}',
    },
    {
      command: 'database cluster query JSON',
      description:
        'Descobre o líder pelas réplicas configuradas e envia uma consulta uma única vez. Timeout de alteração tem resultado indeterminado.',
      example: 'database cluster query {"query":"SELECT * FROM sensores LIMIT 10"}',
    },
    {
      command: 'show database client',
      description: 'Mostra perfil de descoberta e resultados, sem exibir a chave.',
      example: 'show database client',
    },
    {
      command: 'show running-config',
      description: 'Consulta a configuração aplicada; credenciais são ocultadas.',
      example: 'show running-config',
    },
  ];
  return entries.filter((entry) => commandSupported(d, entry.example, context));
}
