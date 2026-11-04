import { interfaceSchema, type Device, type NetworkInterface } from '../model';
import type { SimulationEngine } from '../core/engine';
import { wirelessConfig } from '../protocols/wireless';
import { configureModbus } from '../protocols/modbus';
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
    'plc',
    'server',
    'PLC Modbus',
    'Industrial',
    'Controle industrial',
    'Registradores de 16 bits; Modbus funções 03/06/16 no modelo educacional.'
  ),
  p(
    'hmi',
    'pc',
    'HMI',
    'Industrial',
    'Operação industrial',
    'Cliente para supervisão e operações Modbus; configure os fluxos da fábrica.'
  ),
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
    { feature: 'rack', ports: 1, layer: 'Estrutura física' }
  ),
  p(
    'patch-panel',
    'server',
    'Patch panel',
    'Infraestrutura',
    'Passagem passiva',
    '24 portas com jumpers transparentes; não aprende MAC nem altera VLAN.',
    { feature: 'patch-panel', ports: 24, layer: 'L1' }
  ),
  p(
    'ups',
    'server',
    'UPS',
    'Infraestrutura',
    'Alimentação',
    'Bateria, potência, eficiência, recarga e cargas ligadas ao equipamento.',
    { feature: 'ups', ports: 1, layer: 'Alimentação' }
  ),
  p(
    'wlc',
    'switch',
    'Wireless Controller',
    'Wireless',
    'CAPWAP centralizado',
    'Configure IPv4 no underlay e os perfis WLAN antes de habilitar.',
    { feature: 'wlc', ports: 2, layer: 'Controle WLAN / bridge L2' }
  ),
  p(
    'mesh',
    'switch',
    'Mesh AP',
    'Wireless',
    'Mesh',
    'AP com rádio e vizinhança mesh; configure identidade, raiz e chave.',
    { feature: 'mesh', ports: 2, layer: 'L2 / rádio 802.11' }
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
    { feature: 'printer', ports: 1 }
  ),
  p('phone', 'pc', 'Telefone IP', 'Endpoints', 'Endpoint IP', 'Chamadas SIP/SDP e áudio RTP/PCMU.', {
    feature: 'phone',
    ports: 1,
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
    uplinks: 'sfp',
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
    'Rotas conectadas, estáticas, OSPF, RIP, BGP e VRF.',
    { ports: 8, uplinks: 'sfp' }
  ),
  p(
    'edge',
    'router',
    'Roteador de borda',
    'Routing',
    'Borda IP',
    'Roteamento, NAT, ACL e políticas de rede.',
    { ports: 12, uplinks: 'sfp' }
  ),
  p(
    'branch',
    'router',
    'Roteador de filial',
    'Routing',
    'Filial',
    'Rotas, serviços e conectividade com a matriz.',
    { ports: 8, uplinks: 'sfp' }
  ),
  p(
    'virtual-router',
    'router',
    'Roteador virtual',
    'Routing',
    'Roteamento virtual',
    'Mesmo encaminhamento IP do motor, sem hypervisor externo.',
    { ports: 8 }
  ),
  p(
    'ap',
    'switch',
    'Access point',
    'Wireless',
    'Bridge com rádio',
    'SSID, associação, WPA2/WPA3 didáticos e rádio.',
    { feature: 'ap', ports: 2, layer: 'L2 / rádio 802.11' }
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
    'DNS UDP/TCP; configure o endereço, os registros e habilite o serviço.',
    { feature: 'dns' }
  ),
  p(
    'dhcp',
    'server',
    'DHCP Server',
    'Serviços',
    'Concessões IP',
    'Configure IP estático e pool de concessões antes de habilitar o serviço.',
    { feature: 'dhcp' }
  ),
  p(
    'ntp',
    'server',
    'NTP Server',
    'Serviços',
    'Sincronização de relógio',
    'NTP UDP/123; configure o relógio e habilite o servidor.',
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
  p(
    'web',
    'server',
    'Web Server',
    'Serviços',
    'Aplicação HTTP',
    'Configure o endereço e o serviço HTTP/TCP.',
    {
      feature: 'web',
    }
  ),
  p(
    'syslog',
    'server',
    'Syslog Server',
    'Serviços',
    'Coleta de eventos',
    'Configure e habilite o coletor UDP/514.',
    {
      feature: 'syslog',
    }
  ),
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
    'NETCONF/RESTCONF e jobs; configure usuários, credenciais e acesso remoto.',
    { feature: 'remote' }
  ),
  p(
    'isp',
    'router',
    'ISP',
    'Redes virtuais',
    'Underlay IP',
    'Roteador IP para compor uma rede de provedor; configure rotas/BGP.',
    { ports: 16, uplinks: 'sfp' }
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
function createProfileHardware(e: SimulationEngine, id: string, position: { x: number; y: number }) {
  const spec = deviceProfiles.find((p) => p.id === id);
  if (!spec) throw new Error('Perfil de equipamento inexistente.');
  const d = e.addDevice(spec.type, position);
  d.profile = spec.id;
  const prefix: Record<string, string> = {
    ap: 'AP',
    mesh: 'MESH',
    wlc: 'WLC',
    smartphone: 'MOBILE',
    laptop: 'LAP',
    phone: 'PHONE',
    printer: 'PRN',
    iot: 'IOT',
    rack: 'RACK',
    ups: 'UPS',
    'patch-panel': 'PATCH',
    firewall: 'FW',
    ngfw: 'FW',
    ids: 'IDS',
    ips: 'IPS',
  };
  if (prefix[spec.id]) d.hostname = d.hostname.replace(/^[A-Z]+-/, prefix[spec.id] + '-');
  if (spec.ports || spec.speed || spec.uplinks) {
    const count = spec.ports ?? d.interfaces.length,
      seed = d.interfaces[0];
    d.interfaces = Array.from({ length: count }, (_, n) => {
      const optical =
          spec.id === 'core' || (!!spec.uplinks && n >= count - (spec.uplinks === 'qsfp' ? 4 : 2)),
        media = optical ? (spec.uplinks ?? 'sfp') : 'rj45';
      return {
        ...structuredClone(seed),
        id: 'p' + n,
        name:
          spec.type === 'pc' || spec.type === 'server'
            ? 'Eth' + n
            : (media === 'qsfp' ? 'Fo' : media === 'sfp' && spec.speed === 10000 ? 'Te' : 'Gi') +
              '0/' +
              (n + 1),
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
  return { device: d, spec, feature: f };
}

/** Factory hardware for the equipment catalog. Provisioning belongs to the user. */
export function addFactoryProfile(e: SimulationEngine, id: string, position = { x: 100, y: 100 }) {
  const { device: d, feature: f } = createProfileHardware(e, id, position);
  if (
    [
      'switch-l2',
      'switch-l3',
      'access',
      'distribution',
      'core',
      'industrial',
      'router',
      'edge',
      'branch',
      'virtual-router',
      'isp',
      'nat-gateway',
      'vpn-gateway',
    ].includes(id)
  ) {
    d.bootManaged = true;
    d.operatingSystem = { family: 'ios-xe', release: '17.12', subset: 'shlab-core-v1' };
    d.discovery = {
      cdp: true,
      lldp: false,
      cdpTimer: 60,
      cdpHoldtime: 180,
      lldpTimer: 30,
      lldpHoldtime: 120,
      token: e.id('discovery'),
      nextCdp: e.state.clock,
      nextLldp: e.state.clock,
      neighbors: [],
    };
  }
  d.power = f === 'rack' || f === 'patch-panel';
  if (f === 'rack') d.infrastructure = { kind: 'rack', units: 42, ambientC: 22, ventilation: 1, slots: [] };
  else if (f === 'patch-panel') d.infrastructure = { kind: 'patch-panel', pairs: [] };
  else if (f === 'ups')
    d.infrastructure = {
      kind: 'ups',
      mains: true,
      capacityWh: 1000,
      remainingWh: 1000,
      maxWatts: 1500,
      chargeWatts: 100,
      efficiency: 0.9,
      loads: [],
      lastAt: e.state.clock,
      output: false,
    };
  else
    d.system = {
      enabled: true,
      capacityPps: 100000,
      memoryLimitKiB: 65536,
      ambientC: 22,
      thermalLimitC: 85,
      windowAt: e.state.clock,
      work: 0,
      processed: 0,
      nextReadyAt: e.state.clock,
      lastAt: e.state.clock,
      cpuPercent: 0,
      memoryKiB: 64,
      temperatureC: 22,
      throttled: false,
    };
  if (f === 'ap' || f === 'mesh' || f === 'wireless-client') {
    const base = d.interfaces[0];
    d.interfaces.push(
      interfaceSchema.parse({
        ...base,
        id: 'wlan0',
        name: 'Wlan0',
        mac: base.mac.split(':').slice(0, 4).join(':') + ':03:00',
        media: 'wifi',
        transceiver: undefined,
        mode: f === 'wireless-client' ? 'routed' : 'access',
        stpEdge: true,
      })
    );
  }
  if (id === 'smartphone') d.interfaces = d.interfaces.filter((p) => p.media === 'wifi');
  if (f === 'wlc') d.interfaces[0].mode = 'routed';
  return d;
}

/** Provisioned profiles retained for explicit demonstrations and prepared lab fixtures. */
export function addProfile(e: SimulationEngine, id: string, position = { x: 100, y: 100 }) {
  const { device: d, spec, feature: f } = createProfileHardware(e, id, position);
  if (id === 'plc')
    configureModbus(e, d, { enabled: true, port: 502, unit: 1, registers: Array(128).fill(0) });
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
  if (spec.id === 'smartphone') d.interfaces = d.interfaces.filter((p) => p.media === 'wifi');
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
