import type { Device, NetworkInterface } from '../model';
import type { SimulationEngine } from '../core/engine';
import { wirelessConfig } from '../protocols/wireless';
export interface DeviceProfile {
  id: string;
  type: Device['type'];
  name: string;
  category: string;
  model: string;
  role: string;
  layer: string;
  description: string;
  ports?: number;
  uplinks?: 'sfp' | 'qsfp';
  speed?: NetworkInterface['speed'];
  feature?:
    | 'wireless-client'
    | 'ap'
    | 'l3'
    | 'firewall'
    | 'inspection'
    | 'sdwan'
    | 'controller'
    | 'dns'
    | 'dhcp'
    | 'ntp'
    | 'aaa'
    | 'radius'
    | 'tacacs'
    | 'web'
    | 'syslog'
    | 'snmp'
    | 'remote'
    | 'phone'
    | 'printer'
    | 'broker'
    | 'proxy'
    | 'load-balancer'
    | 'wlc'
    | 'mesh'
    | 'ids'
    | 'ips'
    | 'rack'
    | 'patch-panel'
    | 'ups'
    | 'database';
}
const p = (
  id: string,
  type: Device['type'],
  name: string,
  category: string,
  role: string,
  description: string,
  extra: Partial<DeviceProfile> = {}
): DeviceProfile => ({
  id,
  type,
  name,
  category,
  role,
  description,
  model: 'NL ' + name,
  layer: type === 'switch' ? (extra.feature === 'l3' ? 'L2/L3' : 'L2') : 'L3',
  ...extra,
});
export const deviceProfiles: DeviceProfile[] = [
  p(
    'database',
    'server',
    'Banco de dados',
    'Serviços',
    'Dados pela rede',
    'Tabelas e consultas SQL limitadas por HTTP/TCP, com chave de acesso.',
    { feature: 'database' }
  ),
  p(
    'rack',
    'server',
    'Rack',
    'Infraestrutura',
    'Montagem física',
    'Unidades de rack, montagem e ventilação influenciam a temperatura.',
    { feature: 'rack', ports: 1 }
  ),
  p(
    'patch-panel',
    'server',
    'Patch panel',
    'Infraestrutura',
    'Passagem passiva',
    '24 portas com jumpers transparentes; não aprende MAC nem altera VLAN.',
    { feature: 'patch-panel', ports: 24 }
  ),
  p(
    'ups',
    'server',
    'UPS',
    'Infraestrutura',
    'Alimentação',
    'Bateria, potência, eficiência, recarga e cargas ligadas ao equipamento.',
    { feature: 'ups', ports: 1 }
  ),
  p(
    'wlc',
    'switch',
    'Wireless Controller',
    'Wireless',
    'CAPWAP centralizado',
    'Configure IPv4 no underlay e os perfis WLAN antes de habilitar.',
    { feature: 'wlc' }
  ),
  p(
    'mesh',
    'switch',
    'Mesh AP',
    'Wireless',
    'Mesh',
    'AP com rádio e vizinhança mesh; configure identidade, raiz e chave.',
    { feature: 'mesh' }
  ),
  p(
    'ids',
    'router',
    'IDS',
    'Segurança',
    'Detecção de intrusão',
    'Inspeção por assinatura/taxa com alertas.',
    { feature: 'ids' }
  ),
  p(
    'ips',
    'router',
    'IPS',
    'Segurança',
    'Prevenção de intrusão',
    'Inspeção por assinatura/taxa com bloqueio.',
    { feature: 'ips' }
  ),
  p(
    'proxy',
    'server',
    'Proxy HTTP',
    'Serviços',
    'Proxy',
    'Encaminhamento HTTP por duas conexões TCP; destinos permitidos.',
    { feature: 'proxy' }
  ),
  p(
    'load-balancer',
    'server',
    'Balanceador HTTP',
    'Serviços',
    'Balanceamento',
    'Round-robin/least-connections, health checks HTTP e failover.',
    { feature: 'load-balancer' }
  ),
  p(
    'mqtt',
    'server',
    'Broker MQTT',
    'Serviços',
    'IoT',
    'MQTT 3.1.1, tópicos, wildcards, retained e keepalive.',
    { feature: 'broker' }
  ),
  p('desktop', 'pc', 'Computador', 'Endpoints', 'Host', 'IPv4/IPv6, ARP/NDP e tráfego de aplicação.'),
  p('laptop', 'pc', 'Notebook', 'Endpoints', 'Cliente Wi-Fi', 'Host Ethernet e rádio Wi-Fi.', {
    feature: 'wireless-client',
  }),
  p(
    'smartphone',
    'pc',
    'Smartphone',
    'Endpoints',
    'Cliente Wi-Fi',
    'Endpoint IP pelo rádio; sem aplicações de telefonia.',
    { feature: 'wireless-client' }
  ),
  p(
    'printer',
    'server',
    'Impressora IP',
    'Endpoints',
    'Endpoint IP',
    'IPP/HTTP, spool de páginas, consulta, cancelamento e papel.',
    { feature: 'printer' }
  ),
  p('phone', 'pc', 'Telefone IP', 'Endpoints', 'Endpoint IP', 'Chamadas SIP/SDP e áudio RTP/PCMU.', {
    feature: 'phone',
  }),
  p(
    'iot',
    'pc',
    'Dispositivo IoT',
    'Endpoints',
    'Endpoint IP',
    'Cliente MQTT: sensores, tópicos, assinaturas e retained.'
  ),
  p('switch-l2', 'switch', 'Switch L2', 'Switching', 'Bridge Ethernet', 'MAC/VLAN, STP/RSTP e LACP.'),
  p(
    'switch-l3',
    'switch',
    'Switch L3',
    'Switching',
    'Roteamento inter-VLAN',
    'Switching e roteamento IP; configure portas routed ou SVI.',
    { feature: 'l3' }
  ),
  p('access', 'switch', 'Switch de acesso', 'Switching', 'Acesso', '24 portas Ethernet e 2 uplinks SFP.', {
    ports: 26,
  }),
  p(
    'distribution',
    'switch',
    'Switch de distribuição',
    'Switching',
    'Distribuição L3',
    '24 portas 10G e 4 uplinks QSFP; VLAN, rotas e agregação.',
    { ports: 28, uplinks: 'qsfp', speed: 10000, feature: 'l3' }
  ),
  p(
    'core',
    'switch',
    'Switch de core',
    'Switching',
    'Core L3',
    '8 portas QSFP 40G; MTU e capacidade afetam transmissão.',
    { ports: 8, uplinks: 'qsfp', speed: 40000, feature: 'l3' }
  ),
  p(
    'industrial',
    'switch',
    'Switch industrial',
    'Switching',
    'Bridge Ethernet',
    'Encaminhamento L2 com métricas de recursos; tolerância elétrica não modelada.'
  ),
  p(
    'router',
    'router',
    'Roteador',
    'Routing',
    'Roteamento IP',
    'Rotas conectadas, estáticas, OSPF, RIP, BGP e VRF.'
  ),
  p(
    'edge',
    'router',
    'Roteador de borda',
    'Routing',
    'Borda IP',
    'Roteamento, NAT, ACL e políticas de rede.'
  ),
  p(
    'branch',
    'router',
    'Roteador de filial',
    'Routing',
    'Filial',
    'Rotas, serviços e conectividade com a matriz.'
  ),
  p(
    'virtual-router',
    'router',
    'Roteador virtual',
    'Routing',
    'Roteamento virtual',
    'Mesmo encaminhamento IP do motor, sem hypervisor externo.'
  ),
  p(
    'ap',
    'switch',
    'Access point',
    'Wireless',
    'Bridge com rádio',
    'SSID, associação, WPA2/WPA3 didáticos e rádio.',
    { feature: 'ap' }
  ),
  p(
    'sdwan-edge',
    'router',
    'SD-WAN Edge',
    'SD-WAN',
    'Seleção por SLA',
    'Políticas por aplicação e túneis; configure underlay e peers.',
    { feature: 'sdwan' }
  ),
  p(
    'sdwan-controller',
    'server',
    'SD-WAN Controller',
    'SD-WAN',
    'Distribuição de políticas',
    'Publica políticas para sites por UDP autenticado no modelo.',
    { feature: 'controller' }
  ),
  p(
    'sdwan-gateway',
    'router',
    'SD-WAN Gateway',
    'SD-WAN',
    'Gateway de overlay',
    'Encaminhamento e seleção de túnel por SLA.',
    { feature: 'sdwan' }
  ),
  p(
    'firewall',
    'router',
    'Firewall',
    'Segurança',
    'Inspeção stateful',
    'Eth/Gi0/1 confiável; demais interfaces externas. Inspeciona TCP/UDP/ICMP.',
    { feature: 'firewall' }
  ),
  p(
    'ngfw',
    'router',
    'Firewall de aplicação',
    'Segurança',
    'Inspeção HTTP/DNS',
    'Firewall stateful com regras de Host/path HTTP e nome DNS em claro.',
    { feature: 'inspection' }
  ),
  p(
    'vpn-gateway',
    'router',
    'VPN Gateway',
    'Segurança',
    'Encapsulamento IP',
    'Configure túnel e underlay; negociação e proteção são didáticas.'
  ),
  p(
    'server',
    'server',
    'Servidor',
    'Serviços',
    'Endpoint de serviços',
    'IPv4/IPv6 e serviços configuráveis.'
  ),
  p(
    'dns',
    'server',
    'DNS Server',
    'Serviços',
    'Resolução de nomes',
    'Agente DNS UDP/TCP habilitado; adicione registros.',
    { feature: 'dns' }
  ),
  p(
    'dhcp',
    'server',
    'DHCP Server',
    'Serviços',
    'Concessões IP',
    'Servidor habilitado; configure IP estático e pool antes de usar.',
    { feature: 'dhcp' }
  ),
  p(
    'ntp',
    'server',
    'NTP Server',
    'Serviços',
    'Sincronização de relógio',
    'UDP/123, stratum 1 e offset inicial zero.',
    { feature: 'ntp' }
  ),
  p(
    'aaa',
    'server',
    'AAA Server',
    'Serviços',
    'Autenticação de rede',
    'RADIUS e TACACS+; configure usuários e chave.',
    { feature: 'aaa' }
  ),
  p(
    'radius',
    'server',
    'RADIUS Server',
    'Serviços',
    'Autenticação de rede',
    'UDP/1812 e atribuição de VLAN.',
    { feature: 'radius' }
  ),
  p(
    'tacacs',
    'server',
    'TACACS+ Server',
    'Serviços',
    'Autorização de terminal',
    'TCP/49 e privilégio do usuário.',
    { feature: 'tacacs' }
  ),
  p('web', 'server', 'Web Server', 'Serviços', 'Aplicação HTTP', 'Serviço HTTP TCP/80 habilitado.', {
    feature: 'web',
  }),
  p('syslog', 'server', 'Syslog Server', 'Serviços', 'Coleta de eventos', 'Coletor UDP/514 habilitado.', {
    feature: 'syslog',
  }),
  p(
    'snmp',
    'server',
    'SNMP Manager',
    'Serviços',
    'Monitoramento',
    'Consultas SNMP e coletor de telemetria.',
    { feature: 'snmp' }
  ),
  p(
    'remote',
    'server',
    'Servidor de automação',
    'Serviços',
    'Gerenciamento remoto',
    'NETCONF/RESTCONF e jobs; credencial de exemplo admin/rede-admin e chave remote-key.',
    { feature: 'remote' }
  ),
  p(
    'isp',
    'router',
    'ISP',
    'Redes virtuais',
    'Underlay IP',
    'Roteador IP para compor uma rede de provedor; configure rotas/BGP.'
  ),
  p(
    'nat-gateway',
    'router',
    'NAT Gateway',
    'Redes virtuais',
    'Tradução IP',
    'Configure inside/outside, pool/PAT e rotas no painel de políticas.'
  ),
];
export function deviceProfile(d: Device) {
  return deviceProfiles.find((p) => p.id === d.profile);
}
export function addProfile(e: SimulationEngine, id: string, position = { x: 100, y: 100 }) {
  const spec = deviceProfiles.find((p) => p.id === id);
  if (!spec) throw new Error('Perfil de equipamento inexistente.');
  const d = e.addDevice(spec.type, position);
  d.profile = spec.id;
  if (spec.ports || spec.speed || spec.uplinks) {
    const count = spec.ports ?? d.interfaces.length,
      seed = d.interfaces[0];
    d.interfaces = Array.from({ length: count }, (_, n) => {
      const optical = spec.id === 'core' || n >= count - (spec.uplinks === 'qsfp' ? 4 : 2),
        media = optical ? (spec.uplinks ?? 'sfp') : 'rj45';
      return {
        ...structuredClone(seed),
        id: 'p' + n,
        name: (media === 'qsfp' ? 'Fo' : media === 'sfp' ? 'Te' : 'Gi') + '0/' + (n + 1),
        mac: seed.mac.slice(0, -2) + n.toString(16).padStart(2, '0'),
        media,
        speed: media === 'qsfp' ? 40000 : (spec.speed ?? 1000),
        ...(optical ? { transceiver: 'single-mode' as const } : {}),
      };
    });
  }
  const f = spec.feature;
  if (f === 'rack' || f === 'ups') {
    d.interfaces[0].media = 'console';
    d.interfaces[0].adminUp = false;
    d.interfaces[0].console = { baud: '9600' };
    delete d.interfaces[0].transceiver;
  }
  if (f === 'rack')
    e.configureInfrastructure(d.id, { kind: 'rack', units: 42, ambientC: 22, ventilation: 1, slots: [] });
  if (f === 'patch-panel') {
    d.interfaces.forEach((p) => {
      p.media = 'rj45';
      delete p.transceiver;
    });
    e.configureInfrastructure(d.id, {
      kind: 'patch-panel',
      pairs: Array.from({ length: 12 }, (_, i) => ({ a: 'p' + i, b: 'p' + (i + 12) })),
    });
  }
  if (f === 'ups')
    e.configureInfrastructure(d.id, {
      kind: 'ups',
      mains: true,
      capacityWh: 1000,
      remainingWh: 1000,
      maxWatts: 1500,
      chargeWatts: 100,
      efficiency: 0.9,
      loads: [],
      lastAt: e.state.clock,
      output: true,
    });
  if (f === 'wlc') {
    d.interfaces[0].mode = 'routed';
    e.configureWlc(d.id, {
      enabled: false,
      underlay: 'p0',
      key: 'controller-network-key',
      allowedWtps: [],
      profiles: [
        {
          name: 'campus',
          vlan: 1,
          wireless: { ...wirelessConfig(d), role: 'ap', ssid: 'Campus', enabled: true },
        },
      ],
    });
  }
  if (f === 'mesh') {
    e.configureWireless(d.id, { ...wirelessConfig(d), role: 'ap', ssid: 'Mesh', enabled: true });
    e.configureMesh(d.id, {
      enabled: false,
      meshId: 'campus-mesh',
      key: 'mesh-network-key',
      root: false,
      priority: 100,
      maxDistance: 100,
    });
  }
  if (f === 'ids' || f === 'ips')
    e.configureIds(d.id, {
      enabled: true,
      mode: f,
      rules: [
        {
          id: 'syn-rate',
          name: 'Taxa SYN elevada',
          protocol: 'TCP',
          synOnly: true,
          threshold: 100,
          windowMs: 1000,
          action: f === 'ips' ? 'drop' : 'alert',
        },
      ],
    });
  if (f === 'database') e.configureDatabase(d.id, { enabled: true, port: 8080, key: 'database-key' });
  if (!['rack', 'ups', 'patch-panel'].includes(f ?? ''))
    e.configureSystem(d.id, {
      enabled: true,
      capacityPps: 100000,
      memoryLimitKiB: 65536,
      ambientC: 22,
      thermalLimitC: 85,
    });
  if (f === 'phone')
    e.configurePhone(d.id, { enabled: true, number: d.id, sipPort: 5060, rtpPort: 20000, autoAnswer: true });
  if (f === 'printer') e.configurePrinter(d.id, { enabled: true, port: 631, pagesPerMinute: 30, paper: 100 });
  if (f === 'broker') e.configureBroker(d.id, { enabled: true, port: 1883 });
  if (f === 'proxy' || f === 'load-balancer')
    e.configureProxy(d.id, {
      enabled: false,
      kind: f,
      port: f === 'proxy' ? 3128 : 80,
      algorithm: 'round-robin',
      backends: [],
      allowedNetworks: [],
      healthIntervalMs: 5000,
    });
  if (f === 'l3') {
    d.ipRouting = true;
    d.ipv6Routing = true;
  }
  if (f === 'ap' || f === 'wireless-client') e.configureWireless(d.id, wirelessConfig(d));
  if (f === 'firewall' || f === 'inspection') {
    e.configureFirewall(d.id, { enabled: true, trustedPorts: ['p0'], protocols: ['TCP', 'UDP', 'ICMP'] });
    if (f === 'inspection')
      e.configureInspection(d.id, { enabled: true, defaultAction: 'permit', rules: [] });
  }
  if (f === 'sdwan') e.configureSdwan(d.id, { enabled: true, site: d.id, policies: [] });
  if (f === 'controller')
    e.configureSdwanController(d.id, { enabled: true, key: 'controller-key', sites: [] });
  if (f === 'dns') d.dnsServer = { enabled: true, records: [] };
  if (f === 'dhcp') d.dhcpServer = { enabled: true, pools: [], bindings: [] };
  if (f === 'ntp') e.configureClock(d.id, { offsetMs: 0, server: true, stratum: 1 });
  if (['aaa', 'radius', 'tacacs'].includes(f ?? ''))
    e.configureAaaServer(d.id, {
      enabled: true,
      radius: f !== 'tacacs',
      tacacs: f !== 'radius',
      key: 'network-key',
      clients: [],
      users: [],
    });
  if (f === 'web')
    e.configureTcpService(d.id, {
      enabled: true,
      kind: 'http',
      port: 80,
      body: 'Resposta do servidor HTTP do laboratório.\n',
    });
  if (f === 'syslog') e.setSyslogEnabled(d.id, true);
  if (f === 'snmp') e.configureCollector(d.id, { enabled: true, key: 'telemetry-key' });
  if (f === 'remote')
    e.configureRemote(d.id, {
      enabled: true,
      netconf: true,
      restconf: true,
      key: 'remote-key',
      clients: [],
      users: [{ username: 'admin', password: 'rede-admin', privilege: 15 }],
    });
  if (spec.feature || spec.ports || spec.speed || spec.uplinks)
    e.emit('CONFIG_CHANGED', d.id, 'Perfil ' + spec.name + ' aplicado: ' + spec.description);
  return d;
}
