import { SimulationEngine } from './core/engine';
import { addProfile } from './devices/profiles';
import { addCanvasItem } from './canvas';
import { enterpriseDefaults } from './protocols/enterprise-defaults';
import { vxlanConfig } from './protocols/vxlan';
import type { Device } from './model';
export function enterpriseDatacenterTemplate() {
  const e = new SimulationEngine();
  const named: Record<string, Device> = {};
  function dev(profile: string, name: string, x: number, y: number) {
    const d = addProfile(e, profile, { x, y });
    d.hostname = name;
    named[name] = d;
    return d;
  }
  function addr(d: Device, port: string, ip: string, prefix = 24) {
    Object.assign(
      d.interfaces.find((p) => p.id === port)!,
      { ip, prefix }
    );
  }
  function cable(a: Device, ap: string, b: Device, bp: string) {
    for (const [d, id] of [
      [a, ap],
      [b, bp],
    ] as const) {
      const p = d.interfaces.find((p) => p.id === id)!;
      Object.assign(p, { media: 'rj45', transceiver: undefined, speed: 1000 });
    }
    return e.connect({ device: a.id, port: ap }, { device: b.id, port: bp });
  }
  const segments = [
    { vlan: 10, name: 'USERS' },
    { vlan: 20, name: 'GUEST' },
    { vlan: 30, name: 'DMZ' },
    { vlan: 40, name: 'CORP' },
    { vlan: 99, name: 'MGMT' },
  ];
  const cores = [dev('distribution', 'CORE-A', 650, 270), dev('distribution', 'CORE-B', 1000, 270)];
  const fws = [dev('firewall', 'FW-A', 650, 80), dev('firewall', 'FW-B', 1000, 80)];
  const access: Record<string, Device> = {};
  const allowed = [1, ...segments.map((s) => s.vlan)];
  const trunk = (d: Device, id: string) =>
    Object.assign(
      d.interfaces.find((p) => p.id === id)!,
      {
        mode: 'trunk',
        nativeVlan: 1,
        allowedVlans: allowed,
      }
    );
  for (const [i, s] of segments.entries()) {
    const sw = dev('access', 'ACCESS-' + s.name, i * 360, 550);
    access[s.name] = sw;
    addCanvasItem(e, {
      kind: 'region',
      text: `${s.name} / VLAN ${s.vlan}`,
      position: { x: i * 360 - 40, y: 490 },
      width: 350,
      height: 530,
      color: 'cyan',
    });
    for (const d of [sw, ...cores]) d.vlans = segments.map((s) => ({ id: s.vlan, name: s.name }));
    for (const p of sw.interfaces) p.accessVlan = s.vlan;
    for (const [n, core] of cores.entries()) {
      trunk(sw, 'p' + (20 + n));
      trunk(core, 'p' + i);
      cable(sw, 'p' + (20 + n), core, 'p' + i);
    }
    e.configureSpanningTree(sw.id, 'rstp', 32768);
  }
  for (const [n, core] of cores.entries()) {
    e.configureSpanningTree(core.id, 'rstp', n ? 4096 : 0);
    cable(core, 'p19', fws[n], 'p0');
    trunk(core, 'p19');
    e.setSpanningTreePort(core.id, 'p19', { edge: true });
    for (const s of segments) {
      const p = e.addSubinterface(fws[n].id, 'p0', s.vlan);
      addr(fws[n], p.id, `10.60.${s.vlan}.${n + 2}`);
    }
    e.configureVrrp(fws[n].id, {
      enabled: true,
      groups: segments.map((s) => ({
        port: fws[n].interfaces.find((p) => p.logical?.vlan === s.vlan)!.id,
        vip: `10.60.${s.vlan}.1`,
        vrid: s.vlan,
        priority: n ? 100 : 150,
        advertMs: 1000,
      })),
    });
  }
  for (const i of [17, 18]) cable(cores[0], 'p' + i, cores[1], 'p' + i);
  for (const d of cores) {
    const p = e.configureLacp(d.id, 1, 'active', ['p17', 'p18']);
    trunk(d, p.id);
  }
  const ports: Record<string, number> = {};
  function host(profile: string, name: string, segment: string, suffix: number) {
    const s = segments.find((s) => s.name === segment)!,
      index = ports[segment] ?? 0;
    const d = dev(
      profile,
      name,
      segments.indexOf(s) * 360 + (index % 2) * 150,
      700 + Math.floor(index / 2) * 120
    );
    addr(d, 'p0', `10.60.${s.vlan}.${suffix}`);
    d.gateway = `10.60.${s.vlan}.1`;
    cable(d, 'p0', access[segment], 'p' + index);
    e.setSpanningTreePort(access[segment].id, 'p' + index, { edge: true });
    ports[segment] = index + 1;
    return d;
  }
  host('desktop', 'USER-PC', 'USERS', 10);
  host('desktop', 'DHCP-PC', 'USERS', 11);
  host('desktop', 'GUEST-PC', 'GUEST', 10);
  host('web', 'PORTAL-DMZ', 'DMZ', 10);
  host('dns', 'DNS', 'DMZ', 53);
  host('dhcp', 'DHCP', 'DMZ', 67);
  host('server', 'RADIUS', 'DMZ', 181);
  host('web', 'ERP', 'CORP', 10);
  host('desktop', 'ADMIN', 'MGMT', 10);
  host('ntp', 'NTP', 'MGMT', 123);
  host('syslog', 'SYSLOG', 'MGMT', 11);
  const ap = dev('ap', 'AP-ENTERPRISE', 170, 1050),
    wifi = dev('laptop', 'WIFI-EMPLOYEE', 170, 1160);
  addr(ap, 'p0', '10.60.99.20');
  ap.interfaces[0].mode = 'routed';
  ap.gateway = '10.60.99.1';
  ap.interfaces[0].gateway = '10.60.99.1';
  cable(ap, 'p0', access.MGMT, 'p10');
  cable(ap, 'p1', access.USERS, 'p10');
  ap.interfaces[1].accessVlan = 10;
  e.setSpanningTreePort(access.USERS.id, 'p10', { edge: true });
  ap.vlans.push({ id: 10, name: 'USERS' });
  e.setSpanningTreePort(access.MGMT.id, 'p10', { edge: true });
  const radio = {
    ssid: 'Enterprise',
    security: 'wpa2-enterprise',
    band: '2.4',
    channel: 1,
    txPower: 20,
    noise: -110,
    attenuation: 0,
    enabled: true,
  };
  e.configureWireless(ap.id, { ...radio, role: 'ap' });
  e.configureWireless(wifi.id, { ...radio, role: 'client' });
  ap.interfaces.find((p) => p.id === 'wlan0')!.accessVlan = 10;
  addr(wifi, 'wlan0', '10.60.10.12');
  wifi.gateway = '10.60.10.1';
  const defaults = enterpriseDefaults();
  e.configureEapServer(named.RADIUS.id, { ...defaults.server, clients: ['10.60.99.20'] });
  e.configureEapAuthenticator(ap.id, {
    enabled: true,
    server: '10.60.30.181',
    key: defaults.server.key,
    underlay: 'p0',
    reauthMs: 60000,
  });
  e.configureEapSupplicant(wifi.id, defaults.supplicant);
  e.configureDnsRecord(named.DNS.id, {
    name: 'erp.enterprise.test',
    type: 'A',
    value: '10.60.40.10',
    ttl: 60,
  });
  e.setDnsEnabled(named.DNS.id, true);
  for (const name of ['USER-PC', 'ADMIN', 'GUEST-PC']) e.setDnsServers(named[name].id, 'p0', ['10.60.30.53']);
  e.configureDhcpPool(named.DHCP.id, {
    name: 'USERS',
    port: 'p0',
    network: '10.60.10.0',
    prefix: 24,
    start: '10.60.10.100',
    end: '10.60.10.120',
    gateway: '10.60.10.1',
    relayAddress: '10.60.10.2',
    dns: ['10.60.30.53'],
    leaseMs: 60000,
    excluded: [],
  });
  e.setDhcpEnabled(named.DHCP.id, true);
  for (const fw of fws)
    e.configureDhcpRelay(fw.id, fw.interfaces.find((p) => p.logical?.vlan === 10)!.id, ['10.60.30.67']);
  for (const name of ['ERP', 'PORTAL-DMZ'])
    e.configureTcpService(named[name].id, { kind: 'http', port: 80, enabled: true, body: name });
  for (const fw of fws) e.configureSnmpAgent(fw.id, { enabled: true, community: 'enterprise-test' });
  const wan = dev('edge', 'EDGE-WAN', 2300, 80),
    wanSw = dev('switch-l2', 'TRANSIT-WAN', 1500, 80),
    internet = dev('web', 'EXTERNAL-WEB', 2800, 80);
  addr(wan, 'p0', '172.31.0.1');
  addr(wan, 'p1', '198.51.100.1');
  addr(internet, 'p0', '198.51.100.10');
  internet.gateway = '198.51.100.1';
  cable(wan, 'p0', wanSw, 'p2');
  cable(wan, 'p1', internet, 'p0');
  e.configureTcpService(internet.id, { kind: 'http', port: 80, enabled: true, body: 'external simulated' });
  for (const [n, fw] of fws.entries()) {
    addr(fw, 'p1', `172.31.0.${n + 2}`);
    cable(fw, 'p1', wanSw, 'p' + n);
    const groups = fw.vrrp!.groups.map((g) => ({
      port: g.port,
      vrid: g.vrid,
      vip: g.vip,
      priority: g.priority,
      advertMs: 1000,
    }));
    e.configureVrrp(fw.id, {
      enabled: true,
      groups: [
        ...groups,
        { port: 'p1', vrid: 200, vip: '172.31.0.254', priority: n ? 100 : 150, advertMs: 1000 },
      ],
    });
    fw.routes.push({ network: '0.0.0.0', prefix: 0, nextHop: '172.31.0.1', metric: 1 });
    const zones = segments.map((s) => ({
      name: s.name,
      ports: [fw.interfaces.find((p) => p.logical?.vlan === s.vlan)!.id],
    }));
    zones.push({ name: 'WAN', ports: ['p1'] });
    e.configureFirewall(fw.id, {
      enabled: true,
      protocols: ['TCP', 'UDP', 'ICMP'],
      trustedPorts: [],
      zonePolicy: {
        zones,
        rules: [
          { sequence: 10, from: 'MGMT', to: 'DMZ', protocol: 'ip', action: 'inspect' },
          { sequence: 20, from: 'MGMT', to: 'CORP', protocol: 'ip', action: 'inspect' },
          { sequence: 30, from: 'MGMT', to: 'USERS', protocol: 'ip', action: 'inspect' },
          {
            sequence: 40,
            from: 'USERS',
            to: 'CORP',
            protocol: 'TCP',
            destinationPort: 80,
            action: 'inspect',
          },
          { sequence: 50, from: 'USERS', to: 'DMZ', protocol: 'UDP', destinationPort: 53, action: 'inspect' },
          { sequence: 55, from: 'USERS', to: 'DMZ', protocol: 'UDP', destinationPort: 67, action: 'inspect' },
          { sequence: 60, from: 'USERS', to: 'DMZ', protocol: 'TCP', destinationPort: 80, action: 'inspect' },
          { sequence: 70, from: 'USERS', to: 'WAN', protocol: 'TCP', destinationPort: 80, action: 'inspect' },
          { sequence: 80, from: 'MGMT', to: 'WAN', protocol: 'ip', action: 'inspect' },
          { sequence: 90, from: 'GUEST', to: 'WAN', protocol: 'TCP', destinationPort: 80, action: 'inspect' },
        ],
      },
    });
  }
  cable(fws[0], 'p2', fws[1], 'p2');
  e.configureStateSyncPair(fws[0].id, fws[1].id, {
    portA: 'p2',
    portB: 'p2',
    mappings: [
      { a: 'p1', b: 'p1' },
      ...segments.map((s) => ({
        a: fws[0].interfaces.find((p) => p.logical?.vlan === s.vlan)!.id,
        b: fws[1].interfaces.find((p) => p.logical?.vlan === s.vlan)!.id,
      })),
    ],
  });
  wan.routes.push({ network: '10.60.0.0', prefix: 16, nextHop: '172.31.0.254', metric: 1 });
  // Three-leaf, two-spine DC. Every leaf has a physical path to each spine.
  const spines = [dev('edge', 'SPINE-1', 2350, 450), dev('edge', 'SPINE-2', 2800, 450)];
  const leaves = [0, 1, 2].map((i) => dev('distribution', 'LEAF-' + (i + 1), 2100 + i * 370, 700));
  for (const [i, leaf] of leaves.entries()) {
    leaf.ipRouting = true;
    for (const [j, spine] of spines.entries()) {
      leaf.interfaces[j + 1].mode = 'routed';
      addr(leaf, 'p' + (j + 1), `172.16.${j + 1}.${i * 4 + 1}`, 30);
      addr(spine, 'p' + i, `172.16.${j + 1}.${i * 4 + 2}`, 30);
      cable(leaf, 'p' + (j + 1), spine, 'p' + i);
    }
  }
  for (const [i, leaf] of leaves.entries()) {
    for (const [k, remote] of leaves.entries())
      if (k !== i) {
        leaf.routes.push({
          network: remote.interfaces[1].ip!,
          prefix: 32,
          nextHop: spines[0].interfaces[i].ip!,
          metric: 1,
        });
        leaf.routes.push({
          network: remote.interfaces[1].ip!,
          prefix: 32,
          nextHop: spines[1].interfaces[i].ip!,
          metric: 2,
        });
        spines[1].routes.push({
          network: remote.interfaces[1].ip!,
          prefix: 32,
          nextHop: remote.interfaces[2].ip!,
          metric: 1,
        });
      }
    leaf.interfaces[0].accessVlan = 100;
    leaf.interfaces[3].accessVlan = 200;
    for (const [vlan, vni] of [
      [100, 10100],
      [200, 10200],
    ])
      e.configureVxlan(leaf.id, {
        vlan,
        vni,
        enabled: true,
        evpn: true,
        underlay: 'p1',
        routeTarget: `65000:${vni}`,
        mtu: 1450,
        peers: leaves.filter((d) => d !== leaf).map((d) => d.interfaces[1].ip!),
      });
    e.configureBgp(leaf.id, {
      enabled: true,
      asn: 65100 + i,
      routerId: leaf.interfaces[1].ip!,
      networks: [],
      neighbors: leaves
        .filter((d) => d !== leaf)
        .map((d) => ({ ip: d.interfaces[1].ip!, remoteAs: 65100 + leaves.indexOf(d) })),
    });
  }
  const dcgw = dev('edge', 'DC-GW', 1920, 700);
  addr(dcgw, 'p0', '10.80.100.1');
  addr(dcgw, 'p1', '172.31.10.2', 30);
  leaves[0].interfaces[4].accessVlan = 100;
  cable(dcgw, 'p0', leaves[0], 'p4');
  addr(wan, 'p2', '172.31.10.1', 30);
  cable(wan, 'p2', dcgw, 'p1');
  wan.routes.push({ network: '10.80.100.0', prefix: 24, nextHop: '172.31.10.2', metric: 1 });
  dcgw.routes.push({ network: '10.60.0.0', prefix: 16, nextHop: '172.31.10.1', metric: 1 });
  const dcHosts = [
    ['desktop', 'TENANT-A-CLIENT', 0, 'p0', '10.80.100.10'],
    ['web', 'APP-1', 1, 'p0', '10.80.100.11'],
    ['web', 'APP-2', 2, 'p0', '10.80.100.12'],
    ['desktop', 'TENANT-B-CLIENT', 0, 'p3', '10.80.100.10'],
    ['web', 'TENANT-B-SERVER', 1, 'p3', '10.80.100.11'],
  ] as const;
  for (const [profile, name, index, port, ip] of dcHosts) {
    const d = dev(profile, name, 2100 + index * 370, port === 'p0' ? 950 : 1110);
    addr(d, 'p0', ip);
    if (port === 'p0') d.gateway = '10.80.100.1';
    cable(d, 'p0', leaves[index], port);
    if (profile === 'web') e.configureTcpService(d.id, { kind: 'http', port: 80, enabled: true, body: name });
  }
  const lb = dev('load-balancer', 'LB', 2900, 880);
  addr(lb, 'p0', '10.80.100.100');
  lb.gateway = '10.80.100.1';
  leaves[2].interfaces[4].accessVlan = 100;
  cable(lb, 'p0', leaves[2], 'p4');
  e.configureProxy(lb.id, {
    kind: 'load-balancer',
    enabled: true,
    port: 80,
    algorithm: 'round-robin',
    backends: [
      { address: '10.80.100.11', port: 80 },
      { address: '10.80.100.12', port: 80 },
    ],
    allowedNetworks: [],
    healthIntervalMs: 1000,
  });
  const ups = dev('ups', 'UPS-DC', 2900, 1240);
  e.configureInfrastructure(ups.id, {
    kind: 'ups',
    mains: true,
    capacityWh: 1,
    remainingWh: 1,
    maxWatts: 500,
    chargeWatts: 20,
    efficiency: 1,
    loads: [{ device: lb.id, watts: 200, requested: true }],
    lastAt: 0,
    output: true,
  });
  e.state.notes =
    'Campus/datacenter: VLANs, VRRP, EAP-TLS, serviços e fabric 2 spines/3 leaves. VTEPs em loopback, IMET e RT no plano de dados. Serviços/gateway/WAN ainda possuem pontos únicos: consulte preflight e teste seus SLAs.';
  // Pool único por subnet compartilha concessões entre os giaddrs dos dois relays.
  for (const d of e.state.devices)
    for (const pool of d.dhcpServer?.pools ?? []) {
      if (pool.relayAddress)
        pool.relayAddresses = [pool.relayAddress.replace(/\.2$/, '.3')].filter(
          (ip) => ip !== pool.relayAddress
        );
    }
  for (const [i, leaf] of leaves.entries()) {
    const lo = e.addLoopback(leaf.id);
    Object.assign(lo, { ip: `192.0.2.${i + 1}`, prefix: 32 });
  }
  for (const [i, leaf] of leaves.entries()) {
    const lo = leaf.interfaces.find((p) => p.loopback)!;
    for (const [k, remote] of leaves.entries())
      if (k !== i) {
        const dst = remote.interfaces.find((p) => p.loopback)!.ip!;
        for (const [j, spine] of spines.entries()) {
          leaf.routes.push({ network: dst, prefix: 32, nextHop: spine.interfaces[i].ip!, metric: j + 1 });
          if (!spine.routes.some((r) => r.network === dst))
            spine.routes.push({ network: dst, prefix: 32, nextHop: remote.interfaces[j + 1].ip!, metric: 1 });
        }
      }
    for (const p of [...leaf.interfaces].filter((p) => p.vxlan))
      e.configureVxlan(leaf.id, { ...vxlanConfig(p), underlay: lo.id, peers: [], peerPolicy: 'evpn' });
    e.configureBgp(leaf.id, {
      enabled: true,
      asn: 65100 + i,
      routerId: lo.ip!,
      networks: [],
      neighbors: leaves
        .filter((d) => d !== leaf)
        .map((d) => ({
          ip: d.interfaces.find((p) => p.loopback)!.ip!,
          remoteAs: 65100 + leaves.indexOf(d),
          updateSource: lo.id,
        })),
    });
  }
  return e.snapshot();
}
