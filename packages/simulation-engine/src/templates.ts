import { enterpriseDefaults } from './protocols/enterprise-defaults';
import { SimulationEngine } from './core/engine';
import type { Device, Snapshot } from './model';
import { vrrpConfigGroups } from './protocols/vrrp';
function address(d: Device, port: number, ip: string, prefix = 24) {
  Object.assign(d.interfaces[port], { ip, prefix });
}
export const templates = [
  {
    id: 'enterprise',
    name: 'Campus com autenticação empresarial',
    description: 'EAP-TLS, RADIUS, certificados, Wi-Fi AES-GCM e HTTP pela rede.',
    level: 'Wireless / TLS / AAA',
    devices: 4,
  },
  {
    id: 'ipv6-services',
    name: 'Serviços em uma rede IPv6',
    description: 'DHCPv6, RA, NUD, HTTP/TCP e echo UDP entre duas redes.',
    level: 'IPv6 / DHCPv6 / TCP',
    devices: 3,
  },
  {
    id: 'automation',
    name: 'A configuração chega pela rede',
    description: 'NETCONF/RESTCONF, candidate/commit, automação, telemetria e NTP com tráfego real.',
    level: 'Automação / Monitoramento',
    devices: 5,
  },
  {
    id: 'inspection',
    name: 'O firewall lê a aplicação',
    description: 'HTTP Host/caminho e DNS sob inspeção de aplicação, com TCP, PAT e regras.',
    level: 'Firewall / HTTP / DNS',
    devices: 5,
  },
  {
    id: 'aaa',
    name: 'A porta espera autorização',
    description: '802.1X, EAPOL, RADIUS, VLAN autorizada e login TACACS+ sobre a rede.',
    level: '802.1X / AAA',
    devices: 3,
  },
  {
    id: 'vxlan',
    name: 'Ethernet atravessa uma rede IP',
    description: 'VTEPs, VNI, VLANs locais e transporte UDP4789 com ARP e HTTP.',
    level: 'VXLAN / Overlay L2',
    devices: 5,
  },
  {
    id: 'evpn',
    name: 'O BGP anuncia onde está o MAC',
    description: 'EVPN educacional com MAC routes, route target e VXLAN pelo underlay.',
    level: 'EVPN / BGP',
    devices: 5,
  },
  {
    id: 'mpls',
    name: 'O pacote segue os labels',
    description: 'FEC, LFIB, push/swap/pop, pilha, TTL e tráfego HTTP.',
    level: 'MPLS conceitual',
    devices: 5,
  },
  {
    id: 'qos',
    name: 'Quem passa primeiro na fila',
    description: 'Congestionamento, DSCP, shaping, prioridade e descarte de frames.',
    level: 'QoS / Filas',
    devices: 3,
  },
  {
    id: 'vpn',
    name: 'Duas LANs por uma VPN',
    description: 'Túnel autenticado sobre UDP, rotas, HTTP e falha do underlay.',
    level: 'VPN / Underlay',
    devices: 4,
  },
  {
    id: 'sdwan',
    name: 'A aplicação escolhe o caminho',
    description: 'Dois transportes, controller e seleção por RTT/perda com failover.',
    level: 'SD-WAN / SLA',
    devices: 5,
  },
  {
    id: 'wireless',
    name: 'Do rádio à resposta HTTP',
    description: 'AP, associação WPA2, ponte para Ethernet e efeito de canal/sinal.',
    level: 'Wireless / WPA2',
    devices: 3,
  },
  {
    id: 'ipv6',
    name: 'Endereços que chegam pela rede',
    description: 'IPv6, DAD, SLAAC, Router Advertisements e ping roteado com NDP.',
    level: 'IPv6 / SLAAC',
    devices: 3,
  },
  {
    id: 'lacp',
    name: 'Dois cabos, um enlace',
    description: 'LACP active/passive, EtherChannel, STP e HTTP com um membro após falha.',
    level: 'LACP / EtherChannel',
    devices: 4,
  },
  {
    id: 'vrrp-track',
    name: 'Gateway atento ao uplink',
    description: 'Tracking de interface reduz a prioridade VRRP; o backup assume com o primário ligado.',
    level: 'VRRP / Tracking',
    devices: 6,
  },
  {
    id: 'subinterfaces',
    name: 'Um trunk, duas redes',
    description: 'Roteamento entre VLANs por subinterfaces 802.1Q, ARP e HTTP.',
    level: 'VLAN / Subinterfaces',
    devices: 4,
  },
  {
    id: 'svi',
    name: 'VLANs com gateway no switch',
    description: 'SVIs e roteamento no switch L3, com hosts em VLANs distintas.',
    level: 'Switch L3 / SVI',
    devices: 3,
  },
  {
    id: 'vrf',
    name: 'Mesmo endereço, redes separadas',
    description: 'Duas VRFs, IPs sobrepostos e conexões HTTP isoladas por tabela.',
    level: 'Virtualização / VRF',
    devices: 3,
  },
  {
    id: 'bgp',
    name: 'Três sistemas autônomos',
    description: 'eBGP sobre TCP, AS_PATH, políticas e caminho alternativo após falha.',
    level: 'BGP / Sistemas autônomos',
    devices: 5,
  },
  {
    id: 'vrrp',
    name: 'Um gateway, dois roteadores',
    description: 'VRRP IPv4, eleição e continuidade de ping e HTTP após falha do gateway ativo.',
    level: 'Redundância / VRRP',
    devices: 6,
  },
  {
    id: 'firewall-zones',
    name: 'Três zonas, caminhos controlados',
    description: 'LAN, DMZ e WAN com regras por serviço, PAT e erros ICMP relacionados.',
    level: 'Firewall / Zonas',
    devices: 5,
  },
  {
    id: 'dhcp-relay',
    name: 'Um servidor, duas redes',
    description: 'DHCP central, relay no roteador e endereços reservados por MAC.',
    level: 'DHCP relay',
    devices: 6,
  },
  {
    id: 'management',
    name: 'Rede sob observação',
    description: 'Objetos SNMP e eventos syslog atravessam os enlaces do laboratório.',
    level: 'SNMP / Syslog',
    devices: 5,
  },
  {
    id: 'rip',
    name: 'Rotas por distância',
    description: 'RIPv2, anúncios periódicos e retirada de rotas com poison reverse.',
    level: 'RIP',
    devices: 5,
  },
  {
    id: 'ospf',
    name: 'Rotas que se adaptam',
    description: 'Três roteadores OSPF, menor custo e reconvergência após falhas.',
    level: 'OSPF',
    devices: 5,
  },
  {
    id: 'tcp',
    name: 'Da conexão à resposta',
    description: 'HTTP e echo sobre TCP, com PAT e firewall de retorno.',
    level: 'TCP / HTTP',
    devices: 5,
  },
  {
    id: 'nat',
    name: 'Além da rede privada',
    description: 'NAT, tradução de endereços e controle por ACL.',
    level: 'Segurança',
    devices: 5,
  },
  {
    id: 'empty',
    name: 'Laboratório em branco',
    description: 'Comece do zero. Cada porta e cada pacote, sob seu controle.',
    level: 'Livre',
    devices: 0,
  },
  {
    id: 'lan',
    name: 'Sua primeira LAN',
    description: 'Dois hosts, um switch. Acompanhe ARP e o aprendizado de MAC.',
    level: 'Fundamentos',
    devices: 3,
  },
  {
    id: 'routed',
    name: 'Entre duas redes',
    description: 'Duas sub-redes conectadas por um roteador. Explore o caminho completo.',
    level: 'Roteamento',
    devices: 5,
  },
  {
    id: 'dhcp',
    name: 'Endereços automáticos',
    description: 'Dois clientes e um servidor no mesmo domínio de broadcast.',
    level: 'DHCP',
    devices: 4,
  },
  {
    id: 'dns',
    name: 'Nomes na rede',
    description: 'DHCP configurado e DNS local com registros A, AAAA e CNAME.',
    level: 'DNS',
    devices: 4,
  },
  {
    id: 'vlan',
    name: 'Domínios de broadcast',
    description: 'Dois switches conectados por trunk e hosts na VLAN 10.',
    level: 'Switching',
    devices: 4,
  },
  {
    id: 'static',
    name: 'Rotas estáticas',
    description: 'Dois roteadores e uma rede de trânsito. Valide as rotas de ida e volta.',
    level: 'Intermediário',
    devices: 4,
  },
  {
    id: 'broken',
    name: 'O pacote não chegou',
    description: 'Uma interface está desligada. Descubra onde e restaure a comunicação.',
    level: 'Desafio',
    devices: 5,
  },
  {
    id: 'rstp',
    name: 'Redundância sem loops',
    description: 'Três switches, uma árvore comum e um caminho alternativo.',
    level: 'STP / RSTP',
    devices: 5,
  },
] as const;
export type TemplateId = (typeof templates)[number]['id'];
export function makeTemplate(template: TemplateId = 'empty'): Snapshot {
  if (template === 'enterprise') {
    const e = new SimulationEngine(),
      ap = e.addDevice('switch', { x: 380, y: 180 }),
      client = e.addDevice('pc', { x: 430, y: 235 }),
      radius = e.addDevice('server', { x: 80, y: 180 }),
      web = e.addDevice('server', { x: 670, y: 180 }),
      defaults = enterpriseDefaults();
    ap.hostname = 'AP-CAMPUS';
    client.hostname = 'CLIENT-CAMPUS';
    radius.hostname = 'RADIUS-CAMPUS';
    web.hostname = 'WEB-CAMPUS';
    const wireless = {
      ssid: 'Campus',
      security: 'wpa2-enterprise',
      band: '2.4',
      channel: 1,
      txPower: 20,
      noise: -110,
      attenuation: 0,
      enabled: true,
    };
    e.configureWireless(ap.id, { ...wireless, role: 'ap' });
    e.configureWireless(client.id, { ...wireless, role: 'client' });
    Object.assign(ap.interfaces[0], { mode: 'routed', ip: '192.0.2.1', prefix: 24 });
    address(radius, 0, '192.0.2.2');
    address(web, 0, '10.0.0.20');
    Object.assign(
      client.interfaces.find((p) => p.id === 'wlan0')!,
      { ip: '10.0.0.10', prefix: 24 }
    );
    e.connect({ device: ap.id, port: 'p0' }, { device: radius.id, port: 'p0' });
    e.connect({ device: ap.id, port: 'p1' }, { device: web.id, port: 'p0' });
    e.configureEapServer(radius.id, { ...defaults.server, clients: ['192.0.2.1'] });
    e.configureEapAuthenticator(ap.id, {
      enabled: true,
      server: '192.0.2.2',
      key: defaults.server.key,
      underlay: 'p0',
      reauthMs: 60000,
    });
    e.configureEapSupplicant(client.id, defaults.supplicant);
    e.configureTcpService(web.id, {
      enabled: true,
      kind: 'http',
      port: 80,
      body: 'HTTP empresarial com EAP-TLS',
    });
    return e.snapshot();
  }
  if (template === 'ipv6-services') {
    const e = new SimulationEngine(),
      r = e.addDevice('router', { x: 480, y: 250 }),
      pc = e.addDevice('pc', { x: 230, y: 250 }),
      srv = e.addDevice('server', { x: 730, y: 250 });
    r.hostname = 'R-V6-SERVICES';
    pc.hostname = 'PC-DHCP6';
    srv.hostname = 'WEB-V6';
    r.ipv6Routing = true;
    for (const [i, d] of [pc, srv].entries()) {
      e.connect({ device: r.id, port: 'p' + i }, { device: d.id, port: 'p0' });
      e.configureIpv6(r.id, 'p' + i, {
        auto: false,
        addresses: [{ ip: `2001:db8:${i + 1}::1`, prefix: 64 }],
        ra: {
          intervalMs: 3000,
          lifetimeMs: 9000,
          prefixes: [
            {
              network: `2001:db8:${i + 1}::`,
              prefix: 64,
              onLink: true,
              autonomous: false,
              validMs: 60000,
              preferredMs: 30000,
            },
          ],
        },
      });
    }
    e.configureIpv6(pc.id, 'p0', { auto: false, addresses: [] });
    e.configureIpv6(srv.id, 'p0', { auto: true, addresses: [{ ip: '2001:db8:2::10', prefix: 64 }] });
    e.configureDhcp6Server(r.id, {
      enabled: true,
      pools: [
        {
          name: 'LAN6',
          port: 'p0',
          addresses: { start: '2001:db8:1::100', end: '2001:db8:1::10f' },
          validMs: 60000,
          preferredMs: 45000,
          t1Ms: 20000,
          t2Ms: 40000,
          dns: [],
        },
      ],
    });
    e.configureDhcp6Client(pc.id, 'p0', { enabled: true, requestAddress: true, requestPrefix: false });
    e.configureTcpService(srv.id, {
      enabled: true,
      kind: 'http',
      port: 80,
      body: 'HTTP sobre IPv6 após DHCPv6.',
    });
    e.configureTcpService(srv.id, { enabled: true, kind: 'echo', port: 7 });
    e.configureUdp6Service(srv.id, { enabled: true, kind: 'echo', port: 7 });
    e.state.notes =
      'Avance DAD/DHCPv6 e os RAs. Em PC-DHCP6, gere HTTP/TCP ou UDP para 2001:db8:2::10. Inspecione CWND/RTO e os estados NUD. DHCPv6 não fornece gateway: RA instala a rota default.';
    return e.snapshot();
  }
  if (template === 'automation') {
    const e = new SimulationEngine(makeTemplate('routed')),
      pc = e.state.devices[0],
      r = e.state.devices.find((d) => d.type === 'router')!,
      server = e.state.devices.find((d) => d.type === 'server')!;
    e.configureRemote(r.id, {
      enabled: true,
      netconf: true,
      restconf: true,
      key: 'remote-key',
      clients: [],
      users: [
        { username: 'admin', password: 'rede-admin', privilege: 15 },
        { username: 'reader', password: 'rede-read', privilege: 1 },
      ],
    });
    e.configureCollector(server.id, { enabled: true, key: 'telemetry-key' });
    e.configureTelemetry(r.id, {
      enabled: true,
      collector: server.interfaces[0].ip!,
      key: 'telemetry-key',
      intervalMs: 1000,
      sensors: ['interfaces', 'routes', 'tcp', 'qos', 'aaa'],
    });
    e.configureClock(server.id, { offsetMs: 0, server: true, stratum: 1 });
    e.configureClock(pc.id, { offsetMs: 300, server: false, stratum: 1 });
    e.configureNtp(pc.id, { enabled: true, servers: [server.interfaces[0].ip!], intervalMs: 5000 });
    e.configureTcpService(server.id, {
      kind: 'http',
      port: 80,
      enabled: true,
      body: 'HTTP pela rede configurada remotamente.\n',
    });
    return e.snapshot();
  }
  if (template === 'inspection') {
    const e = new SimulationEngine(makeTemplate('tcp')),
      r = e.state.devices.find((d) => d.type === 'router')!,
      server = e.state.devices.find((d) => d.type === 'server')!;
    e.configureInspection(r.id, {
      enabled: true,
      defaultAction: 'permit',
      rules: [
        { sequence: 10, application: 'http', action: 'deny', host: 'blocked.lab' },
        { sequence: 20, application: 'http', action: 'deny', pathPrefix: '/admin' },
        { sequence: 30, application: 'dns', action: 'deny', nameSuffix: 'blocked.lab' },
      ],
    });
    for (const name of ['allowed.lab', 'blocked.lab'])
      e.configureDnsRecord(server.id, { name, type: 'A', value: '192.168.20.10', ttl: 0 });
    return e.snapshot();
  }
  if (template === 'aaa') {
    const e = new SimulationEngine(),
      pc = e.addDevice('pc', { x: 130, y: 220 }),
      sw = e.addDevice('switch', { x: 350, y: 220 }),
      server = e.addDevice('server', { x: 580, y: 220 });
    pc.hostname = 'PC-8021X';
    sw.hostname = 'SW-AUTH';
    server.hostname = 'RADIUS-HTTP';
    sw.ipRouting = true;
    sw.vlans.push({ id: 20, name: 'Autorizados' });
    Object.assign(sw.interfaces[1], { mode: 'routed', ip: '192.0.2.1', prefix: 24 });
    sw.interfaces[2].accessVlan = 20;
    address(pc, 0, '10.20.0.10');
    address(server, 0, '192.0.2.2');
    address(server, 1, '10.20.0.20');
    e.connect({ device: pc.id, port: 'p0' }, { device: sw.id, port: 'p0' });
    e.connect({ device: sw.id, port: 'p1' }, { device: server.id, port: 'p0' });
    e.connect({ device: sw.id, port: 'p2' }, { device: server.id, port: 'p1' });
    e.configureAaaServer(server.id, {
      enabled: true,
      radius: true,
      tacacs: true,
      key: 'rede-demo',
      clients: ['192.0.2.1'],
      users: [
        { username: 'aluno', password: 'rede123', privilege: 1, vlan: 20, sessionMs: 60000 },
        { username: 'admin', password: 'rede-admin', privilege: 15, sessionMs: 60000 },
      ],
    });
    e.configureDot1x(sw.id, 'p0', {
      enabled: true,
      server: '192.0.2.2',
      key: 'rede-demo',
      underlay: 'p1',
      reauthMs: 60000,
    });
    e.configureSupplicant(pc.id, 'p0', { enabled: true, username: 'aluno', password: 'rede123' });
    e.configureAaaClient(sw.id, {
      server: '192.0.2.2',
      key: 'rede-demo',
      method: 'tacacs',
      enforceCli: false,
    });
    e.configureTcpService(server.id, {
      kind: 'http',
      port: 80,
      enabled: true,
      body: 'HTTP após autorização 802.1X.\n',
    });
    return e.snapshot();
  }
  if (template === 'vxlan' || template === 'evpn') {
    const e = new SimulationEngine(),
      pc = e.addDevice('pc', { x: 130, y: 220 }),
      a = e.addDevice('switch', { x: 340, y: 220 }),
      r = e.addDevice('router', { x: 560, y: 220 }),
      b = e.addDevice('switch', { x: 780, y: 220 }),
      srv = e.addDevice('server', { x: 980, y: 220 });
    pc.hostname = 'VM-A';
    a.hostname = 'VTEP-A';
    r.hostname = 'IP-UNDERLAY';
    b.hostname = 'VTEP-B';
    srv.hostname = 'VM-B';
    address(pc, 0, '10.50.0.10');
    address(srv, 0, '10.50.0.20');
    a.ipRouting = b.ipRouting = true;
    a.interfaces[1].mode = b.interfaces[1].mode = 'routed';
    address(a, 1, '192.0.2.1', 30);
    address(r, 0, '192.0.2.2', 30);
    address(r, 1, '198.51.100.1', 30);
    address(b, 1, '198.51.100.2', 30);
    e.connect({ device: pc.id, port: 'p0' }, { device: a.id, port: 'p0' });
    e.connect({ device: a.id, port: 'p1' }, { device: r.id, port: 'p0' });
    e.connect({ device: r.id, port: 'p1' }, { device: b.id, port: 'p1' });
    e.connect({ device: b.id, port: 'p0' }, { device: srv.id, port: 'p0' });
    a.routes = [{ network: '198.51.100.0', prefix: 30, nextHop: '192.0.2.2', metric: 1 }];
    b.routes = [{ network: '192.0.2.0', prefix: 30, nextHop: '198.51.100.1', metric: 1 }];
    a.interfaces[0].accessVlan = 10;
    b.interfaces[0].accessVlan = 20;
    const base = {
      vni: 10010,
      enabled: true,
      underlay: 'p1',
      evpn: template === 'evpn',
      routeTarget: '65000:10010',
      mtu: 1450,
    };
    e.configureVxlan(a.id, { ...base, vlan: 10, peers: ['198.51.100.2'] });
    e.configureVxlan(b.id, { ...base, vlan: 20, peers: ['192.0.2.1'] });
    if (template === 'evpn') {
      e.configureBgp(a.id, {
        enabled: true,
        asn: 65001,
        routerId: '192.0.2.1',
        networks: [],
        neighbors: [{ ip: '198.51.100.2', remoteAs: 65002 }],
      });
      e.configureBgp(b.id, {
        enabled: true,
        asn: 65002,
        routerId: '198.51.100.2',
        networks: [],
        neighbors: [{ ip: '192.0.2.1', remoteAs: 65001 }],
      });
    }
    e.configureTcpService(srv.id, { kind: 'http', port: 80, enabled: true, body: 'HTTP pelo overlay VXLAN' });
    return e.snapshot();
  }
  if (template === 'mpls') {
    const e = new SimulationEngine(),
      pc = e.addDevice('pc', { x: 100, y: 240 }),
      r1 = e.addDevice('router', { x: 290, y: 240 }),
      r2 = e.addDevice('router', { x: 480, y: 240 }),
      r3 = e.addDevice('router', { x: 670, y: 240 }),
      srv = e.addDevice('server', { x: 860, y: 240 });
    pc.hostname = 'CE-A';
    r1.hostname = 'PE-A';
    r2.hostname = 'P-CORE';
    r3.hostname = 'PE-B';
    srv.hostname = 'CE-B';
    address(pc, 0, '10.1.0.10');
    pc.interfaces[0].gateway = '10.1.0.1';
    address(r1, 0, '10.1.0.1');
    address(r1, 1, '192.0.2.1', 30);
    address(r2, 0, '192.0.2.2', 30);
    address(r2, 1, '198.51.100.1', 30);
    address(r3, 1, '198.51.100.2', 30);
    address(r3, 0, '10.2.0.1');
    address(srv, 0, '10.2.0.20');
    srv.interfaces[0].gateway = '10.2.0.1';
    e.connect({ device: pc.id, port: 'p0' }, { device: r1.id, port: 'p0' });
    e.connect({ device: r1.id, port: 'p1' }, { device: r2.id, port: 'p0' });
    e.connect({ device: r2.id, port: 'p1' }, { device: r3.id, port: 'p1' });
    e.connect({ device: r3.id, port: 'p0' }, { device: srv.id, port: 'p0' });
    r1.routes = [{ network: '10.2.0.0', prefix: 24, nextHop: '192.0.2.2', metric: 1 }];
    r2.routes = [
      { network: '10.1.0.0', prefix: 24, nextHop: '192.0.2.1', metric: 1 },
      { network: '10.2.0.0', prefix: 24, nextHop: '198.51.100.2', metric: 1 },
    ];
    r3.routes = [{ network: '10.1.0.0', prefix: 24, nextHop: '198.51.100.1', metric: 1 }];
    e.configureMpls(r1.id, {
      enabled: true,
      ingress: [{ network: '10.2.0.0', prefix: 24, port: 'p1', nextHop: '192.0.2.2', labels: [100] }],
      lfib: [{ incoming: 400, operation: 'pop' }],
    });
    e.configureMpls(r2.id, {
      enabled: true,
      ingress: [],
      lfib: [
        { incoming: 100, operation: 'swap', outgoing: [200], port: 'p1', nextHop: '198.51.100.2' },
        { incoming: 300, operation: 'swap', outgoing: [400], port: 'p0', nextHop: '192.0.2.1' },
      ],
    });
    e.configureMpls(r3.id, {
      enabled: true,
      ingress: [{ network: '10.1.0.0', prefix: 24, port: 'p1', nextHop: '198.51.100.1', labels: [300] }],
      lfib: [{ incoming: 200, operation: 'pop' }],
    });
    e.configureTcpService(srv.id, {
      kind: 'http',
      port: 80,
      enabled: true,
      body: 'HTTP atravessou labels MPLS',
    });
    return e.snapshot();
  }
  if (template === 'qos') {
    const e = new SimulationEngine(),
      pc = e.addDevice('pc', { x: 180, y: 220 }),
      r = e.addDevice('router', { x: 450, y: 220 }),
      srv = e.addDevice('server', { x: 720, y: 220 });
    pc.hostname = 'QOS-CLIENT';
    r.hostname = 'QOS-EDGE';
    srv.hostname = 'QOS-WEB';
    address(pc, 0, '10.1.0.10');
    pc.interfaces[0].gateway = '10.1.0.1';
    address(r, 0, '10.1.0.1');
    address(r, 1, '10.2.0.1');
    address(srv, 0, '10.2.0.20');
    srv.interfaces[0].gateway = '10.2.0.1';
    e.connect({ device: pc.id, port: 'p0' }, { device: r.id, port: 'p0' });
    e.connect({ device: r.id, port: 'p1' }, { device: srv.id, port: 'p0' });
    e.configureQos(r.id, 'p1', {
      enabled: true,
      rateMbps: 0.01,
      queueLimit: 8,
      scheduler: 'priority',
      classes: [
        { name: 'WEB', protocol: 'tcp', destinationPort: 80, priority: 7, weight: 3, mark: 46 },
        { name: 'PING', protocol: 'icmp', priority: 1, weight: 1 },
      ],
    });
    e.configureTcpService(srv.id, {
      kind: 'http',
      port: 80,
      enabled: true,
      body: 'HTTP compartilha a fila QoS',
    });
    return e.snapshot();
  }
  if (template === 'vpn' || template === 'sdwan') {
    const e = new SimulationEngine(),
      a = e.addDevice('router', { x: 320, y: 200 }),
      b = e.addDevice('router', { x: 570, y: 200 }),
      pc = e.addDevice('pc', { x: 130, y: 200 }),
      srv = e.addDevice('server', { x: 760, y: 200 });
    a.hostname = 'WAN-A';
    b.hostname = 'WAN-B';
    pc.hostname = 'LAN-A';
    srv.hostname = 'WEB-B';
    address(a, 0, '10.1.0.1');
    address(b, 0, '10.2.0.1');
    address(pc, 0, '10.1.0.10');
    pc.interfaces[0].gateway = '10.1.0.1';
    address(srv, 0, '10.2.0.20');
    srv.interfaces[0].gateway = '10.2.0.1';
    e.connect({ device: pc.id, port: 'p0' }, { device: a.id, port: 'p0' });
    e.connect({ device: srv.id, port: 'p0' }, { device: b.id, port: 'p0' });
    for (let n = 1; n <= (template === 'sdwan' ? 2 : 1); n++) {
      const network = n === 1 ? '192.0.2.' : '198.51.100.';
      address(a, n, network + '1', 30);
      address(b, n, network + '2', 30);
      e.connect({ device: a.id, port: 'p' + n }, { device: b.id, port: 'p' + n }, 'copper', {
        latency: n === 1 ? 3 : 20,
        jitter: 0,
        loss: 0,
      });
      const base = {
        number: n,
        enabled: true,
        mode: template === 'sdwan' ? 'sdwan' : 'ipsec',
        channel: 10 + n,
        underlay: 'p' + n,
        key: 'Tunnel-Key-123',
        prefix: 30,
        transport: n === 1 ? 'internet' : 'mpls',
        mtu: 1400,
      };
      e.configureTunnel(a.id, {
        ...base,
        remote: network + '2',
        ip: '172.16.' + n + '.1',
        peerIp: '172.16.' + n + '.2',
        advertise: [{ network: '10.1.0.0', prefix: 24 }],
      });
      e.configureTunnel(b.id, {
        ...base,
        remote: network + '1',
        ip: '172.16.' + n + '.2',
        peerIp: '172.16.' + n + '.1',
        advertise: [{ network: '10.2.0.0', prefix: 24 }],
      });
    }
    e.configureTcpService(srv.id, {
      kind: 'http',
      port: 80,
      enabled: true,
      body: 'HTTP pelo overlay ' + template,
    });
    if (template === 'sdwan') {
      const controller = e.addDevice('server', { x: 320, y: 380 });
      controller.hostname = 'WAN-CONTROLLER';
      address(a, 3, '203.0.113.1');
      address(controller, 0, '203.0.113.10');
      e.connect({ device: a.id, port: 'p3' }, { device: controller.id, port: 'p0' });
      const policy = {
        name: 'WEB',
        match: { destination: { network: '10.2.0.0', prefix: 24 }, protocol: 'tcp', destinationPort: 80 },
        prefer: ['internet', 'mpls', 'lte'],
        maxRtt: 100,
        maxLoss: 20,
        fallback: true,
      };
      e.configureSdwanController(controller.id, {
        enabled: true,
        key: 'Controller-Key-123',
        sites: [{ site: 'Site-A', policies: [policy] }],
      });
      e.configureSdwan(a.id, {
        enabled: true,
        site: 'Site-A',
        controller: '203.0.113.10',
        underlay: 'p3',
        key: 'Controller-Key-123',
        policies: [],
      });
    }
    return e.snapshot();
  }
  if (template === 'wireless') {
    const e = new SimulationEngine(),
      ap = e.addDevice('switch', { x: 480, y: 220 }),
      pc = e.addDevice('pc', { x: 400, y: 360 }),
      srv = e.addDevice('server', { x: 200, y: 220 });
    ap.hostname = 'AP-CAMPUS';
    pc.hostname = 'NOTEBOOK';
    srv.hostname = 'WEB-CAMPUS';
    const base = {
      ssid: 'Campus',
      security: 'wpa2-psk',
      key: 'Wireless-123',
      band: '2.4',
      channel: 1,
      txPower: 20,
      noise: -95,
      attenuation: 0,
      enabled: true,
    };
    e.configureWireless(ap.id, { ...base, role: 'ap' });
    e.configureWireless(pc.id, { ...base, role: 'client' });
    Object.assign(
      pc.interfaces.find((p) => p.id === 'wlan0')!,
      { ip: '192.168.50.10', prefix: 24 }
    );
    address(srv, 0, '192.168.50.20');
    e.connect({ device: ap.id, port: 'p0' }, { device: srv.id, port: 'p0' });
    e.configureTcpService(srv.id, {
      kind: 'http',
      port: 80,
      enabled: true,
      body: 'HTTP atravessou o rádio e a bridge do AP.',
    });
    e.state.notes =
      'Rádio 2.4 GHz, canal 1, SSID Campus, chave Wireless-123. Avance os eventos para observar beacon, associação e key1–key4. Abra Wireless no NOTEBOOK e TCP/HTTP para consultar 192.168.50.20. Canal diferente, chave incorreta ou distância alta impedem comunicação. Um AP adicional em canal sobreposto aumenta interferência. A criptografia é conceitual.';
    return e.snapshot();
  }
  if (template === 'ipv6') {
    const e = new SimulationEngine();
    const r = e.addDevice('router', { x: 480, y: 250 }),
      a = e.addDevice('pc', { x: 230, y: 250 }),
      b = e.addDevice('pc', { x: 730, y: 250 });
    r.hostname = 'R-IPV6';
    a.hostname = 'PC-V6-A';
    b.hostname = 'PC-V6-B';
    r.ipv6Routing = true;
    for (const [i, pc] of [a, b].entries()) {
      const network = '2001:db8:' + (i + 1) + '::';
      e.connect({ device: r.id, port: 'p' + i }, { device: pc.id, port: 'p0' });
      e.configureIpv6(r.id, 'p' + i, {
        auto: false,
        addresses: [{ ip: network + '1', prefix: 64 }],
        ra: {
          intervalMs: 3000,
          lifetimeMs: 9000,
          prefixes: [
            { network, prefix: 64, autonomous: true, onLink: true, validMs: 60000, preferredMs: 30000 },
          ],
        },
      });
      e.configureIpv6(pc.id, 'p0', { auto: true, addresses: [] });
    }
    e.state.notes =
      'Inicie a simulação para concluir DAD e SLAAC. Em IPv6, copie o endereço de PC-V6-B e envie ping de PC-V6-A. Hop Limit 1 revela R-IPV6. Reduza a MTU de saída para 1280 e envie 1400 bytes para observar Packet Too Big. RA e NDP usam multicast no próprio enlace.';
    return e.snapshot();
  }
  if (template === 'lacp') {
    const e = new SimulationEngine(),
      a = e.addDevice('switch', { x: 300, y: 210 }),
      b = e.addDevice('switch', { x: 650, y: 210 });
    a.hostname = 'SW-A';
    b.hostname = 'SW-B';
    const pc = e.addDevice('pc', { x: 50, y: 210 }),
      server = e.addDevice('server', { x: 900, y: 210 });
    pc.hostname = 'PC-LACP';
    server.hostname = 'WEB-LACP';
    address(pc, 0, '192.168.10.10');
    address(server, 0, '192.168.10.20');
    e.connect({ device: pc.id, port: 'p0' }, { device: a.id, port: 'p2' });
    e.connect({ device: server.id, port: 'p0' }, { device: b.id, port: 'p2' });
    for (const index of [0, 1])
      e.connect({ device: a.id, port: 'p' + index }, { device: b.id, port: 'p' + index });
    e.configureLacp(a.id, 1, 'active', ['p0', 'p1']);
    e.configureLacp(b.id, 1, 'passive', ['p0', 'p1']);
    e.configureSpanningTree(a.id, 'rstp');
    e.configureSpanningTree(b.id, 'rstp');
    e.configureTcpService(server.id, {
      kind: 'http',
      port: 80,
      enabled: true,
      body: 'HTTP pelo EtherChannel LACP',
    });
    e.state.notes =
      'Avance para negociar LACP e convergir RSTP. SW-A active inicia a troca; SW-B passive responde. STP enxerga Port-channel1 como um enlace. Desligue Gi0/1 de SW-A e repita ping/HTTP com Gi0/2 restante. Configure min-links 2 para suspender o grupo se houver só um membro.';
    return e.snapshot();
  }
  if (template === 'vrrp-track') {
    const engine = new SimulationEngine(makeTemplate('vrrp')),
      primary = engine.state.devices.find((d) => d.hostname === 'R-PRIMARY')!;
    engine.configureVrrp(primary.id, {
      enabled: true,
      groups: vrrpConfigGroups(primary).map((g) => ({ ...g, track: [{ port: 'p1', decrement: 80 }] })),
    });
    engine.advanceTo(engine.state.clock + 5000);
    engine.state.notes =
      'Desligue Gi0/2 ou seu cabo em R-PRIMARY. A prioridade efetiva cai de 150 para 70, abaixo dos 100 de R-BACKUP. Avance a simulação e repita ping/HTTP. R-PRIMARY permanece ligado. Ao recuperar o uplink, preempt devolve a função ao primário.';
    return engine.snapshot();
  }
  if (template === 'vrf') {
    const engine = new SimulationEngine(),
      router = engine.addDevice('router', { x: 280, y: 160 });
    router.hostname = 'R-VRF';
    for (const [index, vrf] of ['BLUE', 'RED'].entries()) {
      engine.configureVrf(router.id, vrf);
      engine.setInterfaceVrf(router.id, 'p' + index, vrf);
      address(router, index, '10.0.0.1');
      const server = engine.addDevice('server', { x: 620, y: 60 + index * 230 });
      server.hostname = 'WEB-' + vrf;
      address(server, 0, '10.0.0.2');
      engine.connect({ device: router.id, port: 'p' + index }, { device: server.id, port: 'p0' });
      engine.configureTcpService(server.id, {
        kind: 'http',
        port: 80,
        enabled: true,
        body: 'Resposta da VRF ' + vrf,
      });
    }
    return engine.snapshot();
  }
  if (template === 'subinterfaces' || template === 'svi') {
    const engine = new SimulationEngine(),
      sw = engine.addDevice('switch', { x: 440, y: 190 });
    sw.hostname = template === 'svi' ? 'SW-L3' : 'SW-ACCESS';
    const router = template === 'svi' ? sw : engine.addDevice('router', { x: 440, y: 20 });
    if (template === 'svi') sw.ipRouting = true;
    else router.hostname = 'R-VLAN';
    sw.vlans.push({ id: 10, name: 'Users' }, { id: 20, name: 'Servers' });
    sw.interfaces[0].accessVlan = 10;
    sw.interfaces[1].accessVlan = 20;
    const client = engine.addDevice('pc', { x: 150, y: 330 }),
      server = engine.addDevice('server', { x: 760, y: 330 });
    client.hostname = 'PC-USERS';
    server.hostname = 'WEB-SERVERS';
    engine.connect({ device: sw.id, port: 'p0' }, { device: client.id, port: 'p0' });
    engine.connect({ device: sw.id, port: 'p1' }, { device: server.id, port: 'p0' });
    if (template === 'subinterfaces') {
      Object.assign(sw.interfaces[2], { mode: 'trunk', allowedVlans: [1, 10, 20] });
      engine.connect({ device: sw.id, port: 'p2' }, { device: router.id, port: 'p0' });
    }
    for (const vlan of [10, 20]) {
      const port =
        template === 'svi' ? engine.addSvi(sw.id, vlan) : engine.addSubinterface(router.id, 'p0', vlan);
      Object.assign(port, { ip: `192.168.${vlan}.1`, prefix: 24 });
    }
    address(client, 0, '192.168.10.10');
    client.gateway = '192.168.10.1';
    address(server, 0, '192.168.20.10');
    server.gateway = '192.168.20.1';
    engine.configureTcpService(server.id, {
      kind: 'http',
      port: 80,
      enabled: true,
      body: 'HTTP entre VLANs por ' + template,
    });
    return engine.snapshot();
  }
  if (template === 'bgp') {
    const engine = new SimulationEngine(makeTemplate('ospf'));
    const [a, b, c] = engine.state.devices.filter((device) => device.type === 'router');
    for (const router of [a, b, c]) {
      const ospf = router.ospf!;
      engine.configureOspf(router.id, {
        enabled: false,
        routerId: ospf.routerId,
        interfaces: ospf.interfaces,
      });
      delete router.ospf;
    }
    for (const [i, router] of [a, b, c].entries()) {
      const neighbors =
        i === 0
          ? [
              { ip: '10.0.12.2', remoteAs: 65002 },
              { ip: '10.0.13.3', remoteAs: 65003 },
            ]
          : i === 1
            ? [
                { ip: '10.0.12.1', remoteAs: 65001 },
                { ip: '10.0.23.3', remoteAs: 65003 },
              ]
            : [
                { ip: '10.0.13.1', remoteAs: 65001 },
                { ip: '10.0.23.2', remoteAs: 65002 },
              ];
      engine.configureBgp(router.id, {
        enabled: true,
        asn: 65001 + i,
        routerId: i + 1 + '.' + (i + 1) + '.' + (i + 1) + '.' + (i + 1),
        holdMs: 9000,
        networks: i === 1 ? [] : [{ network: i === 0 ? '192.168.10.0' : '192.168.20.0', prefix: 24 }],
        neighbors,
      });
    }
    engine.configureTcpService(engine.state.devices.find((device) => device.type === 'server')!.id, {
      kind: 'http',
      port: 80,
      enabled: true,
      body: 'Resposta encaminhada pelo BGP.\n',
    });
    engine.state.notes =
      'R-01/02/03 pertencem aos AS 65001/65002/65003. Avance para estabelecer BGP sobre TCP/179. R-01 prefere AS_PATH 65003; shutdown de Gi0/2 força o caminho via 65002 65003. Ajuste LOCAL_PREF para aplicar política, inspecione OPEN/UPDATE e valide ping/HTTP. Hold de 9 s é escolhido para o laboratório; padrão do motor: 90 s.';
    engine.state.events = [];
    return engine.snapshot();
  }
  if (template === 'vrrp') {
    const engine = new SimulationEngine();
    const client = engine.addDevice('pc', { x: 40, y: 215 });
    const lan = engine.addDevice('switch', { x: 260, y: 215 });
    const a = engine.addDevice('router', { x: 495, y: 65 });
    const b = engine.addDevice('router', { x: 495, y: 365 });
    const wan = engine.addDevice('switch', { x: 750, y: 215 });
    const server = engine.addDevice('server', { x: 1000, y: 215 });
    [client, lan, a, b, wan, server].forEach(
      (device, i) => (device.hostname = ['PC-01', 'SW-LAN', 'R-PRIMARY', 'R-BACKUP', 'SW-WAN', 'WEB-01'][i])
    );
    address(client, 0, '192.168.10.10');
    client.gateway = '192.168.10.1';
    address(server, 0, '192.168.20.10');
    server.gateway = '192.168.20.1';
    for (const [i, router] of [a, b].entries()) {
      address(router, 0, '192.168.10.' + (i + 2));
      address(router, 1, '192.168.20.' + (i + 2));
      engine.connect({ device: router.id, port: 'p0' }, { device: lan.id, port: 'p' + (i + 1) });
      engine.connect({ device: router.id, port: 'p1' }, { device: wan.id, port: 'p' + (i + 1) });
      // Rotas de apoio permitem retorno pelo peer se apenas uma interface cair.
      router.routes.push({
        network: '192.168.10.0',
        prefix: 24,
        nextHop: '192.168.20.' + (i ? 2 : 3),
        metric: 10,
      });
      router.routes.push({
        network: '192.168.20.0',
        prefix: 24,
        nextHop: '192.168.10.' + (i ? 2 : 3),
        metric: 10,
      });
      engine.configureVrrp(router.id, {
        enabled: true,
        groups: [
          { port: 'p0', vrid: 10, vip: '192.168.10.1', priority: i ? 100 : 150 },
          { port: 'p1', vrid: 20, vip: '192.168.20.1', priority: i ? 100 : 150 },
        ],
      });
    }
    engine.connect({ device: client.id, port: 'p0' }, { device: lan.id, port: 'p0' });
    engine.connect({ device: server.id, port: 'p0' }, { device: wan.id, port: 'p0' });
    engine.configureTcpService(server.id, {
      kind: 'http',
      port: 80,
      enabled: true,
      body: 'HTTP pelo gateway VRRP',
    });
    engine.state.notes =
      'Os gateways virtuais são 192.168.10.1 e 192.168.20.1. R-PRIMARY começa ACTIVE (150); R-BACKUP fica BACKUP (100). Faça ping/HTTP de PC-01 para WEB-01, desligue R-PRIMARY e avance 4 s. Repita o tráfego e confira o MAC virtual no ARP. Ao religar, preempt devolve a função ao primário. Rotas estáticas de apoio atendem shutdown administrativo de apenas uma porta. Sessões NAT/firewall não são replicadas.';
    engine.advanceTo(4500);
    engine.state.events = [];
    for (const device of engine.state.devices) device.logs = [];
    return engine.snapshot();
  }
  if (template === 'firewall-zones') {
    const engine = new SimulationEngine();
    const client = engine.addDevice('pc', { x: 40, y: 120 });
    const edge = engine.addDevice('router', { x: 300, y: 120 });
    const upstream = engine.addDevice('router', { x: 580, y: 120 });
    const wan = engine.addDevice('server', { x: 850, y: 120 });
    client.hostname = 'PC-01';
    edge.hostname = 'FW-EDGE';
    upstream.hostname = 'R-WAN';
    wan.hostname = 'WAN-CLIENT';
    address(client, 0, '192.168.10.10');
    address(edge, 0, '192.168.10.1');
    address(edge, 1, '10.0.0.1', 30);
    address(upstream, 0, '10.0.0.2', 30);
    address(upstream, 1, '192.168.20.1');
    address(wan, 0, '192.168.20.10');
    client.gateway = '192.168.10.1';
    wan.gateway = '192.168.20.1';
    edge.routes.push({ network: '192.168.20.0', prefix: 24, nextHop: '10.0.0.2', metric: 1 });
    upstream.routes.push({ network: '192.168.10.0', prefix: 24, nextHop: '10.0.0.1', metric: 1 });
    engine.connect({ device: client.id, port: 'p0' }, { device: edge.id, port: 'p0' });
    engine.connect({ device: edge.id, port: 'p1' }, { device: upstream.id, port: 'p0' });
    engine.connect({ device: upstream.id, port: 'p1' }, { device: wan.id, port: 'p0' });
    const dmz = engine.addDevice('server', { x: 300, y: 370 });
    dmz.hostname = 'DMZ-WEB';
    address(edge, 2, '192.168.30.1');
    address(dmz, 0, '192.168.30.10');
    dmz.gateway = '192.168.30.1';
    upstream.routes.push({ network: '192.168.30.0', prefix: 24, nextHop: '10.0.0.1', metric: 1 });
    engine.connect({ device: edge.id, port: 'p2' }, { device: dmz.id, port: 'p0' });
    edge.interfaces[0].natRole = 'inside';
    edge.interfaces[1].natRole = 'outside';
    engine.configureNat(edge.id, {
      enabled: true,
      statics: [],
      pools: [
        {
          name: 'LAN',
          source: { network: '192.168.10.0', prefix: 24 },
          outside: 'p1',
          start: '10.0.0.1',
          end: '10.0.0.1',
          overload: true,
        },
      ],
    });
    engine.configureFirewall(edge.id, {
      enabled: true,
      zonePolicy: {
        zones: [
          { name: 'LAN', ports: ['p0'] },
          { name: 'WAN', ports: ['p1'] },
          { name: 'DMZ', ports: ['p2'] },
        ],
        rules: [
          { sequence: 10, from: 'LAN', to: 'WAN', protocol: 'ip', action: 'inspect' },
          { sequence: 20, from: 'LAN', to: 'DMZ', protocol: 'TCP', destinationPort: 80, action: 'inspect' },
          { sequence: 30, from: 'WAN', to: 'DMZ', protocol: 'TCP', destinationPort: 80, action: 'inspect' },
        ],
      },
    });
    for (const server of [wan, dmz])
      engine.configureTcpService(server.id, {
        kind: 'http',
        port: 80,
        enabled: true,
        body: server.hostname + ': serviço disponível pela política.\n',
      });
    engine.configureTcpService(dmz.id, { kind: 'echo', port: 7, enabled: true });
    engine.state.notes =
      'PC-01 pode acessar HTTP na WAN (192.168.20.10) e na DMZ (192.168.30.10). WAN-CLIENT pode acessar somente HTTP/80 na DMZ; ping e echo/7 são bloqueados, assim como conexões para a LAN. No PC-01, traceroute 192.168.20.10 mostra o erro de TTL atravessando PAT e firewall. Inspecione as citações ICMP e altere regras em Políticas.';
    engine.state.events = [];
    return engine.snapshot();
  }
  if (template === 'dhcp-relay') {
    const engine = new SimulationEngine(makeTemplate('routed'));
    const client = engine.state.devices[0],
      router = engine.state.devices.find((device) => device.type === 'router')!;
    const server = engine.state.devices.find((device) => device.type === 'server')!;
    server.hostname = 'DHCP-CENTRAL';
    const other = engine.addDevice('pc', { x: 40, y: 420 });
    other.hostname = 'PC-02';
    const networkSwitch = engine.state.devices.find((device) => device.hostname === 'SW-ACCESS-01')!;
    engine.connect({ device: other.id, port: 'p0' }, { device: networkSwitch.id, port: 'p2' });
    engine.configureDhcpRelay(router.id, 'p0', ['192.168.20.10']);
    engine.configureDhcpPool(server.id, {
      name: 'USERS',
      port: 'p0',
      network: '192.168.10.0',
      prefix: 24,
      start: '192.168.10.50',
      end: '192.168.10.70',
      relayAddress: '192.168.10.1',
      gateway: '192.168.10.1',
      dns: ['192.168.20.10'],
      leaseMs: 3600000,
      excluded: [],
      reservations: [{ clientMac: client.interfaces[0].mac, address: '192.168.10.60' }],
    });
    engine.configureDnsRecord(server.id, { name: 'central.lab', type: 'A', value: '192.168.20.10', ttl: 60 });
    engine.configureTcpService(server.id, {
      kind: 'http',
      port: 80,
      enabled: true,
      body: 'Serviços centrais alcançados pela concessão DHCP.\n',
    });
    delete client.gateway;
    engine.requestDhcp(client.id, 'p0');
    engine.requestDhcp(other.id, 'p0');
    engine.state.events = [];
    engine.state.notes =
      'Avance a simulação: R-EDGE-01 envia os broadcasts ao DHCP-CENTRAL com giaddr 192.168.10.1. PC-01 recebe a reserva .60; PC-02 recebe .50. Abra DHCP para editar relay e reservas. A renovação T1 e o release seguem unicast por roteamento. No PC-01: ping central.lab ou http get 192.168.20.10. Remova o helper-address e observe a descoberta falhar.';
    return engine.snapshot();
  }
  if (template === 'management') {
    const engine = new SimulationEngine(makeTemplate('routed'));
    const client = engine.state.devices[0];
    const router = engine.state.devices.find((device) => device.type === 'router')!;
    const server = engine.state.devices.find((device) => device.type === 'server')!;
    for (const device of [router, server])
      engine.configureSnmpAgent(device.id, { enabled: true, community: 'public' });
    engine.setSyslogEnabled(server.id, true);
    engine.configureSyslog(router.id, { enabled: true, server: server.interfaces[0].ip!, automatic: true });
    engine.configureSyslog(client.id, { enabled: true, server: server.interfaces[0].ip!, automatic: false });
    engine.state.notes =
      'No PC-01, abra Gerenciamento: consulte SNMP GET 1.3.6.1.2.1.1.5.0 no servidor 192.168.20.10, community public. GETNEXT percorre a MIB. Envie uma mensagem syslog e inspecione os registros em SERVER-01. Shutdown/no shutdown em uma interface de R-EDGE-01 gera eventos enviados ao coletor; ACL, perda e rota afetam a entrega.';
    engine.state.events = [];
    return engine.snapshot();
  }
  if (template === 'rip') {
    const engine = new SimulationEngine(makeTemplate('ospf'));
    for (const router of engine.state.devices.filter((device) => device.type === 'router')) {
      const ospf = router.ospf!;
      engine.configureOspf(router.id, {
        enabled: false,
        routerId: ospf.routerId,
        interfaces: ospf.interfaces,
      });
      delete router.ospf;
      engine.configureRip(router.id, {
        enabled: true,
        interfaces: ospf.interfaces.map((entry) => ({ port: entry.port, passive: entry.passive })),
      });
    }
    engine.configureTcpService(engine.state.devices.find((device) => device.type === 'server')!.id, {
      kind: 'http',
      port: 80,
      enabled: true,
      body: 'Resposta encaminhada pelas rotas RIP.\n',
    });
    engine.state.notes =
      'Avance a simulação e consulte show ip rip ou o painel RIP. R-01 aprende 192.168.20.0/24 pelo enlace direto, métrica 2 (rede conectada custa 1). Desligue Gi0/2 em R-01 e acompanhe a troca para R-02, métrica 3. Sem anúncios, rotas expiram em 180 s virtuais.';
    engine.state.events = [];
    return engine.snapshot();
  }
  if (template === 'ospf') {
    const engine = new SimulationEngine();
    const a = engine.addDevice('router', { x: 250, y: 220 }),
      b = engine.addDevice('router', { x: 480, y: 20 }),
      c = engine.addDevice('router', { x: 700, y: 220 });
    const client = engine.addDevice('pc', { x: 0, y: 240 }),
      server = engine.addDevice('server', { x: 940, y: 240 });
    a.hostname = 'R-01';
    b.hostname = 'R-02';
    c.hostname = 'R-03';
    client.hostname = 'PC-01';
    server.hostname = 'SERVER-01';
    address(a, 0, '10.0.12.1');
    address(b, 0, '10.0.12.2');
    address(b, 1, '10.0.23.2');
    address(c, 0, '10.0.23.3');
    address(a, 1, '10.0.13.1');
    address(c, 1, '10.0.13.3');
    address(a, 2, '192.168.10.1');
    address(c, 2, '192.168.20.1');
    address(client, 0, '192.168.10.10');
    address(server, 0, '192.168.20.10');
    client.gateway = '192.168.10.1';
    server.gateway = '192.168.20.1';
    engine.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
    engine.connect({ device: b.id, port: 'p1' }, { device: c.id, port: 'p0' });
    engine.connect({ device: a.id, port: 'p1' }, { device: c.id, port: 'p1' });
    engine.connect({ device: a.id, port: 'p2' }, { device: client.id, port: 'p0' });
    engine.connect({ device: c.id, port: 'p2' }, { device: server.id, port: 'p0' });
    [a, b, c].forEach((router, index) =>
      engine.configureOspf(router.id, {
        enabled: true,
        routerId: `${index + 1}.${index + 1}.${index + 1}.${index + 1}`,
        interfaces: router.interfaces
          .filter((port) => port.ip)
          .map((port) => ({
            port: port.id,
            area: 0,
            cost: port.id === 'p2' ? 1 : router !== b && port.id === 'p1' ? 30 : 10,
            passive: port.id === 'p2',
          })),
      })
    );
    engine.configureTcpService(server.id, {
      kind: 'http',
      port: 80,
      enabled: true,
      body: 'Resposta encaminhada pelas rotas OSPF.\n',
    });
    engine.state.notes =
      'Avance a simulação até Full nos painéis OSPF. Em R-01, show ip route mostra a rede 192.168.20.0/24 via R-02 (custo 21). Desligue Gi0/1 de R-01 e observe o caminho direto de custo 31. No PC-01: ping 192.168.20.10 ou http get 192.168.20.10.';
    engine.state.events = [];
    return engine.snapshot();
  }
  if (template === 'tcp') {
    const engine = new SimulationEngine(makeTemplate('nat'));
    const router = engine.state.devices.find((device) => device.type === 'router')!;
    const server = engine.state.devices.find((device) => device.type === 'server')!;
    engine.configureNat(router.id, {
      enabled: true,
      statics: [],
      pools: [
        {
          name: 'WEB',
          source: { network: '192.168.10.0', prefix: 24 },
          outside: 'p1',
          start: '192.168.20.1',
          end: '192.168.20.1',
          overload: true,
        },
      ],
    });
    engine.configureFirewall(router.id, { enabled: true, trustedPorts: ['p0'] });
    engine.configureTcpService(server.id, {
      kind: 'http',
      port: 80,
      enabled: true,
      body: 'Olá da rede simulada!\n',
    });
    engine.configureTcpService(server.id, { kind: 'echo', port: 7, enabled: true });
    engine.state.notes =
      'No PC-01, abra TCP / HTTP e envie HTTP GET para 192.168.20.10. Avance os eventos para observar handshake, PAT, firewall, resposta e FIN. Na CLI: http get 192.168.20.10. Desative HTTP no servidor para observar RST.';
    engine.state.events = [];
    return engine.snapshot();
  }
  if (template === 'nat') {
    const engine = new SimulationEngine(makeTemplate('routed'));
    const router = engine.state.devices.find((device) => device.type === 'router')!;
    const server = engine.state.devices.at(-1)!;
    delete server.gateway;
    router.interfaces[0].natRole = 'inside';
    router.interfaces[1].natRole = 'outside';
    engine.state.notes =
      'O destino não possui rota para a rede interna. Configure NAT e valide a tradução de ida e retorno.';
    return engine.snapshot();
  }
  const e = new SimulationEngine();
  if (template === 'empty') return e.snapshot();
  const a = e.addDevice('pc', { x: 40, y: 220 });
  a.hostname = 'PC-01';
  address(a, 0, '192.168.10.10');
  if (template === 'lan') {
    const s = e.addDevice('switch', { x: 310, y: 170 });
    s.hostname = 'SW-01';
    const b = e.addDevice('pc', { x: 600, y: 220 });
    b.hostname = 'PC-02';
    address(b, 0, '192.168.10.20');
    e.connect({ device: a.id, port: 'p0' }, { device: s.id, port: 'p0' });
    e.connect({ device: s.id, port: 'p1' }, { device: b.id, port: 'p0' });
  } else if (template === 'rstp') {
    a.position = { x: 40, y: 10 };
    const root = e.addDevice('switch', { x: 350, y: 20 });
    const middle = e.addDevice('switch', { x: 100, y: 240 });
    const access = e.addDevice('switch', { x: 650, y: 240 });
    const target = e.addDevice('pc', { x: 650, y: 450 });
    root.hostname = 'SW-ROOT';
    middle.hostname = 'SW-02';
    access.hostname = 'SW-03';
    target.hostname = 'PC-02';
    address(target, 0, '192.168.10.20');
    e.connect({ device: a.id, port: 'p0' }, { device: root.id, port: 'p0' });
    e.connect({ device: target.id, port: 'p0' }, { device: access.id, port: 'p0' });
    e.connect({ device: root.id, port: 'p1' }, { device: middle.id, port: 'p1' });
    e.connect({ device: root.id, port: 'p2' }, { device: access.id, port: 'p1' });
    e.connect({ device: middle.id, port: 'p2' }, { device: access.id, port: 'p2' });
    root.interfaces[0].stpEdge = true;
    access.interfaces[0].stpEdge = true;
    for (const networkSwitch of [root, middle, access]) e.configureSpanningTree(networkSwitch.id, 'rstp');
    e.advanceTo(100);
  } else if (template === 'dhcp' || template === 'dns') {
    delete a.interfaces[0].ip;
    delete a.interfaces[0].prefix;
    a.position = { x: 40, y: 110 };
    const networkSwitch = e.addDevice('switch', { x: 340, y: 220 });
    const server = e.addDevice('server', { x: 650, y: 220 });
    const other = e.addDevice('pc', { x: 40, y: 350 });
    networkSwitch.hostname = 'SW-01';
    server.hostname = 'DHCP-01';
    other.hostname = 'PC-02';
    address(server, 0, '192.168.50.2');
    e.connect({ device: a.id, port: 'p0' }, { device: networkSwitch.id, port: 'p0' });
    e.connect({ device: other.id, port: 'p0' }, { device: networkSwitch.id, port: 'p1' });
    e.connect({ device: server.id, port: 'p0' }, { device: networkSwitch.id, port: 'p2' });
    e.configureDhcpPool(server.id, {
      name: 'LAN',
      port: 'p0',
      network: '192.168.50.0',
      prefix: 24,
      start: '192.168.50.10',
      end: '192.168.50.20',
      dns: template === 'dns' ? ['192.168.50.2'] : [],
      leaseMs: 3600000,
      excluded: ['192.168.50.11'],
    });
    if (template === 'dns') {
      server.hostname = 'DNS-01';
      e.configureDnsRecord(server.id, { name: 'server.lab', type: 'A', value: '192.168.50.2', ttl: 60 });
      e.configureDnsRecord(server.id, { name: 'server.lab', type: 'AAAA', value: '2001:db8::2', ttl: 60 });
      e.configureDnsRecord(server.id, { name: 'web.lab', type: 'CNAME', value: 'server.lab', ttl: 30 });
      e.requestDhcp(a.id, 'p0');
      e.requestDhcp(other.id, 'p0');
      e.advanceTo(100);
    }
  } else if (template === 'static') {
    const r1 = e.addDevice('router', { x: 280, y: 150 }),
      r2 = e.addDevice('router', { x: 530, y: 150 }),
      b = e.addDevice('pc', { x: 780, y: 220 });
    r1.hostname = 'R-01';
    r2.hostname = 'R-02';
    b.hostname = 'PC-02';
    address(b, 0, '192.168.20.10');
    a.gateway = '192.168.10.1';
    b.gateway = '192.168.20.1';
    address(r1, 0, '192.168.10.1');
    address(r1, 1, '10.0.0.1', 30);
    address(r2, 0, '10.0.0.2', 30);
    address(r2, 1, '192.168.20.1');
    r1.routes.push({ network: '192.168.20.0', prefix: 24, nextHop: '10.0.0.2', metric: 1 });
    r2.routes.push({ network: '192.168.10.0', prefix: 24, nextHop: '10.0.0.1', metric: 1 });
    e.connect({ device: a.id, port: 'p0' }, { device: r1.id, port: 'p0' });
    e.connect({ device: r1.id, port: 'p1' }, { device: r2.id, port: 'p0' });
    e.connect({ device: r2.id, port: 'p1' }, { device: b.id, port: 'p0' });
  } else if (template === 'vlan') {
    const s1 = e.addDevice('switch', { x: 260, y: 160 }),
      s2 = e.addDevice('switch', { x: 530, y: 160 }),
      b = e.addDevice('pc', { x: 790, y: 220 });
    s1.hostname = 'SW-01';
    s2.hostname = 'SW-02';
    b.hostname = 'PC-02';
    address(b, 0, '192.168.10.20');
    for (const s of [s1, s2]) {
      s.vlans.push({ id: 10, name: 'USERS' });
      s.interfaces[0].accessVlan = 10;
      Object.assign(s.interfaces[1], { mode: 'trunk', allowedVlans: [1, 10] });
    }
    e.connect({ device: a.id, port: 'p0' }, { device: s1.id, port: 'p0' });
    e.connect({ device: s1.id, port: 'p1' }, { device: s2.id, port: 'p1' });
    e.connect({ device: s2.id, port: 'p0' }, { device: b.id, port: 'p0' });
  } else {
    const s1 = e.addDevice('switch', { x: 280, y: 120 }),
      r = e.addDevice('router', { x: 520, y: 120 }),
      s2 = e.addDevice('switch', { x: 760, y: 120 }),
      b = e.addDevice('server', { x: 990, y: 220 });
    s1.hostname = 'SW-ACCESS-01';
    r.hostname = 'R-EDGE-01';
    s2.hostname = 'SW-ACCESS-02';
    b.hostname = 'SERVER-01';
    address(r, 0, '192.168.10.1');
    address(r, 1, '192.168.20.1');
    address(b, 0, '192.168.20.10');
    a.gateway = '192.168.10.1';
    b.gateway = '192.168.20.1';
    e.connect({ device: a.id, port: 'p0' }, { device: s1.id, port: 'p0' });
    e.connect({ device: s1.id, port: 'p1' }, { device: r.id, port: 'p0' });
    e.connect({ device: r.id, port: 'p1' }, { device: s2.id, port: 'p0' });
    e.connect({ device: s2.id, port: 'p1' }, { device: b.id, port: 'p0' });
    if (template === 'broken') {
      e.setPort(r.id, 'p1', false);
      e.state.notes =
        'Objetivo: PC-01 deve alcançar SERVER-01. Investigue interfaces e tabelas. Corrija a falha e valide com ping.';
    }
  }
  e.state.events = [];
  return e.snapshot();
}
