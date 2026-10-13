import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import {
  SimulationEngine,
  addProfile,
  addCanvasItem,
  enterpriseDefaults,
  validateSnapshot,
  preflight,
  ScenarioRunner,
  scenarioSchema,
  vxlanConfig,
  type Device,
  type Snapshot,
} from '../packages/simulation-engine/src';

// Independent audit: expectations are recorded, never changed to match the implementation.
const out = 'artifacts/enterprise-datacenter-audit';
mkdirSync(out, { recursive: true });
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
e.configureDnsRecord(named.DNS.id, { name: 'erp.enterprise.test', type: 'A', value: '10.60.40.10', ttl: 60 });
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
        { sequence: 40, from: 'USERS', to: 'CORP', protocol: 'TCP', destinationPort: 80, action: 'inspect' },
        { sequence: 50, from: 'USERS', to: 'DMZ', protocol: 'UDP', destinationPort: 53, action: 'inspect' },
        { sequence: 60, from: 'USERS', to: 'DMZ', protocol: 'TCP', destinationPort: 80, action: 'inspect' },
        { sequence: 70, from: 'USERS', to: 'WAN', protocol: 'TCP', destinationPort: 80, action: 'inspect' },
        { sequence: 80, from: 'MGMT', to: 'WAN', protocol: 'ip', action: 'inspect' },
        { sequence: 90, from: 'GUEST', to: 'WAN', protocol: 'TCP', destinationPort: 80, action: 'inspect' },
      ],
    },
  });
}
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
  'Auditoria enterprise + datacenter: 5 VLANs campus, VRRP/firewall, RSTP/LACP, RADIUS/EAP-TLS, DNS/DHCP/NTP/syslog, WAN simulada, 2 spines/3 leaves, 2 VNIs com IPs sobrepostos, EVPN e balanceador. Underlay VXLAN preso a p1: redundância física não implica failover do overlay. Sem ESI/MLAG, TLS real ou hardware externo.';
validateSnapshot(e.snapshot());
writeFileSync(out + '/enterprise-datacenter.shlab.json', JSON.stringify(e.snapshot()));
e.advanceTo(35000, 200000);
validateSnapshot(e.snapshot());
const base = e.snapshot();
writeFileSync(
  out + '/inventory.json',
  JSON.stringify(
    {
      devices: base.devices.length,
      links: base.links.length,
      vlans: segments,
      vnis: [10100, 10200],
      items: Object.values(named).map((d) => ({
        name: d.hostname,
        profile: d.profile,
        id: d.id,
        interfaces: d.interfaces
          .filter((p) => p.ip || p.vxlan || p.aggregate)
          .map((p) => ({ id: p.id, ip: p.ip, vni: p.vxlan?.vni, aggregate: p.aggregate?.members })),
      })),
    },
    null,
    2
  )
);
writeFileSync(out + '/preflight.json', JSON.stringify(preflight(base), null, 2));
type Result = {
  id: string;
  name: string;
  group: string;
  expected: unknown;
  observed?: unknown;
  passed: boolean;
  error?: string;
  wallMs: number;
  events?: unknown[];
};
const results: Result[] = [];
const device = (s: SimulationEngine, name: string) => s.state.devices.find((d) => d.hostname === name)!;
const advance = (s: SimulationEngine, ms: number) => s.advanceTo(s.state.clock + ms, 200000);
function ping(s: SimulationEngine, source: string, target: string, bytes = 84, df = false) {
  const id = s.ping(device(s, source).id, target, 64, undefined, bytes, df);
  advance(s, 4000);
  return s.state.probes.find((p) => p.id === id)?.status;
}
function http(s: SimulationEngine, source: string, target: string, port = 80) {
  const id = s.httpGet(device(s, source).id, target, port);
  advance(s, 5000);
  const c = device(s, source).tcpConnections?.find((c) => c.id === id);
  return { state: c?.state, received: c?.received ?? '' };
}
function run(
  id: string,
  name: string,
  group: string,
  expected: unknown,
  fn: (s: SimulationEngine) => unknown,
  compare = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
  snapshot: Snapshot = base
) {
  const s = new SimulationEngine(snapshot),
    started = performance.now();
  const observedEvents: unknown[] = [];
  const emit = s.emit.bind(s);
  s.emit = ((...args: Parameters<SimulationEngine['emit']>) => {
    const ev = emit(...args);
    if (
      /DENY|DROPPED|TIMEOUT|FAILED|EVPN_WITHDRAW|BGP_SESSION_CLOSED|VRRP_STATE|DHCP_BOUND|EAP/.test(ev.type)
    ) {
      observedEvents.push({
        at: ev.time,
        device: s.state.devices.find((d) => d.id === ev.device)?.hostname,
        type: ev.type,
        reason: ev.reason,
      });
      if (observedEvents.length > 40) observedEvents.shift();
    }
    return ev;
  }) as SimulationEngine['emit'];
  try {
    const observed = fn(s);
    validateSnapshot(s.snapshot());
    results.push({
      id,
      name,
      group,
      expected,
      observed,
      passed: compare(observed, expected),
      wallMs: Math.round(performance.now() - started),
      events: observedEvents,
    });
  } catch (error) {
    results.push({
      id,
      name,
      group,
      expected,
      passed: false,
      error: (error as Error).message,
      wallMs: Math.round(performance.now() - started),
      events: observedEvents,
    });
  }
  console.log(
    id +
      ' ' +
      (results.at(-1)!.passed ? 'PASS' : 'FINDING') +
      ' ' +
      JSON.stringify(results.at(-1)!.observed ?? results.at(-1)!.error)
  );
}
run('E01', 'Usuário acessa ERP', 'campus', true, (s) =>
  http(s, 'USER-PC', '10.60.40.10').received.includes('ERP')
);
run('E02', 'Visitante não acessa ERP', 'segurança', false, (s) =>
  http(s, 'GUEST-PC', '10.60.40.10').received.includes('ERP')
);
run('E03', 'Visitante não acessa portal DMZ', 'segurança', false, (s) =>
  http(s, 'GUEST-PC', '10.60.30.10').received.includes('PORTAL')
);
run('E04', 'Visitante acessa WAN simulada', 'campus', true, (s) =>
  http(s, 'GUEST-PC', '198.51.100.10').received.includes('external')
);
run('E05', 'Administrador acessa ERP', 'campus', true, (s) =>
  http(s, 'ADMIN', '10.60.40.10').received.includes('ERP')
);
run(
  'E06',
  'Usuário não inicia ICMP para ERP',
  'segurança',
  false,
  (s) => ping(s, 'USER-PC', '10.60.40.10') === 'success'
);
run('E07', 'DNS por firewall', 'serviços', 'success', (s) => {
  s.lookupDns(device(s, 'USER-PC').id, 'erp.enterprise.test');
  advance(s, 4000);
  return device(s, 'USER-PC').dnsQueries?.at(-1)?.status;
});
run('E08', 'DHCP por relay ativo', 'serviços', true, (s) => {
  s.requestDhcp(device(s, 'DHCP-PC').id, 'p0');
  advance(s, 5000);
  return Boolean(device(s, 'DHCP-PC').interfaces[0].dhcp?.lease);
});
run(
  'E09',
  'EAP-TLS campus integrado',
  'autenticação',
  'associated',
  (s) => device(s, 'WIFI-EMPLOYEE').wireless?.phase
);
run('E10', 'Wi-Fi autenticado acessa ERP', 'autenticação', true, (s) =>
  http(s, 'WIFI-EMPLOYEE', '10.60.40.10').received.includes('ERP')
);
run('E11', 'RADIUS indisponível nega nova autenticação', 'autenticação', false, (s) => {
  s.setDevicePower(device(s, 'RADIUS').id, false);
  s.configureWireless(device(s, 'WIFI-EMPLOYEE').id, { ...radio, role: 'client' });
  advance(s, 10000);
  return device(s, 'WIFI-EMPLOYEE').wireless?.phase === 'associated';
});
run('E12', 'VRRP falha FW-A preserva novas sessões ERP', 'HA', true, (s) => {
  s.setDevicePower(device(s, 'FW-A').id, false);
  advance(s, 5000);
  return http(s, 'USER-PC', '10.60.40.10').received.includes('ERP');
});
run('E13', 'VRRP failover preserva WAN/retorno VIP', 'HA', true, (s) => {
  s.setDevicePower(device(s, 'FW-A').id, false);
  advance(s, 5000);
  return http(s, 'USER-PC', '198.51.100.10').received.includes('external');
});
run('E14', 'DHCP após failover', 'HA', true, (s) => {
  s.setDevicePower(device(s, 'FW-A').id, false);
  advance(s, 5000);
  s.requestDhcp(device(s, 'DHCP-PC').id, 'p0');
  advance(s, 5000);
  return Boolean(device(s, 'DHCP-PC').interfaces[0].dhcp?.lease);
});
run('E15', 'Perda CORE-A com RSTP e VRRP', 'HA', true, (s) => {
  s.setDevicePower(device(s, 'CORE-A').id, false);
  advance(s, 5000);
  return http(s, 'USER-PC', '10.60.40.10').received.includes('ERP');
});
run('E16', 'Perda uplink primário de acesso', 'HA', true, (s) => {
  s.setPort(device(s, 'ACCESS-USERS').id, 'p20', false);
  advance(s, 5000);
  return http(s, 'USER-PC', '10.60.40.10').received.includes('ERP');
});
run('E17', 'LACP com um membro', 'HA', true, (s) => {
  s.setPort(device(s, 'CORE-A').id, 'p17', false);
  advance(s, 3000);
  return (
    device(s, 'CORE-A').interfaces.find((p) => p.aggregate)?.aggregate?.selected.length === 1 &&
    http(s, 'USER-PC', '10.60.40.10').received.includes('ERP')
  );
});
run('E18', 'Perda switch de usuários demonstra domínio de falha', 'desenho', false, (s) => {
  s.setDevicePower(device(s, 'ACCESS-USERS').id, false);
  return http(s, 'USER-PC', '10.60.40.10').received.includes('ERP');
});
run('E19', 'DNS sem HA interrompe novas consultas', 'desenho', false, (s) => {
  s.setDevicePower(device(s, 'DNS').id, false);
  s.clearDnsCache(device(s, 'USER-PC').id);
  s.lookupDns(device(s, 'USER-PC').id, 'erp.enterprise.test');
  advance(s, 11000);
  return device(s, 'USER-PC').dnsQueries?.at(-1)?.status === 'success';
});
run('E20', 'SNMP no gateway', 'gerência', 'success', (s) => {
  s.querySnmp(device(s, 'ADMIN').id, '10.60.99.2', 'enterprise-test', ['1.3.6.1.2.1.1.5.0']);
  advance(s, 4000);
  return device(s, 'ADMIN').snmpQueries?.at(-1)?.status;
});
run('E21', 'SNMP comunidade inválida', 'segurança', false, (s) => {
  s.querySnmp(device(s, 'ADMIN').id, '10.60.99.2', 'wrong', ['1.3.6.1.2.1.1.5.0']);
  advance(s, 11000);
  return device(s, 'ADMIN').snmpQueries?.at(-1)?.status === 'success';
});
run('D01', 'EVPN três folhas negociam BGP', 'datacenter', true, (s) =>
  leaves.every((l) => device(s, l.hostname).bgp?.peers.every((p) => p.state === 'Established'))
);
run('D02', 'HTTP leste-oeste tenant A', 'datacenter', true, (s) =>
  http(s, 'TENANT-A-CLIENT', '10.80.100.11').received.includes('APP-1')
);
run('D03', 'HTTP leste-oeste tenant B com IP sobreposto', 'datacenter', true, (s) =>
  http(s, 'TENANT-B-CLIENT', '10.80.100.11').received.includes('TENANT-B-SERVER')
);
run('D04', 'Tenant B não alcança backend exclusivo de A', 'segurança', false, (s) =>
  http(s, 'TENANT-B-CLIENT', '10.80.100.12').received.includes('APP-2')
);
run('D05', 'HTTP campus → VIP balanceador', 'integração', true, (s) =>
  /APP-[12]/.test(http(s, 'USER-PC', '10.80.100.100').received)
);
run('D06', 'Balanceador distribui entre dois backends', 'datacenter', true, (s) => {
  const a = http(s, 'TENANT-A-CLIENT', '10.80.100.100').received,
    b = http(s, 'TENANT-A-CLIENT', '10.80.100.100').received;
  return a.includes('APP-1') !== b.includes('APP-1') && /APP-[12]/.test(a) && /APP-[12]/.test(b);
});
run('D07', 'Balanceador após perda APP-1', 'HA', true, (s) => {
  s.setDevicePower(device(s, 'APP-1').id, false);
  advance(s, 5000);
  return http(s, 'TENANT-A-CLIENT', '10.80.100.100').received.includes('APP-2');
});
run('D08', 'Balanceador após retorno APP-1', 'HA', true, (s) => {
  s.setDevicePower(device(s, 'APP-1').id, false);
  advance(s, 5000);
  s.setDevicePower(device(s, 'APP-1').id, true);
  advance(s, 5000);
  return device(s, 'LB').proxy?.health.every((h) => h.state === 'up');
});
run('D09', 'Dois backends indisponíveis', 'HA', false, (s) => {
  for (const name of ['APP-1', 'APP-2']) s.setDevicePower(device(s, name).id, false);
  advance(s, 5000);
  return /APP-[12]/.test(http(s, 'TENANT-A-CLIENT', '10.80.100.100').received);
});
run('D10', 'SPOF balanceador interrompe VIP', 'desenho', false, (s) => {
  s.setDevicePower(device(s, 'LB').id, false);
  return /APP-[12]/.test(http(s, 'TENANT-A-CLIENT', '10.80.100.100').received);
});
run('D11', 'Perda SPINE-2 mantém overlay no SPINE-1', 'HA', true, (s) => {
  s.setDevicePower(device(s, 'SPINE-2').id, false);
  return http(s, 'TENANT-A-CLIENT', '10.80.100.11').received.includes('APP-1');
});
run('D12', 'Perda SPINE-1 deveria usar caminho secundário', 'HA', true, (s) => {
  s.setDevicePower(device(s, 'SPINE-1').id, false);
  advance(s, 5000);
  return http(s, 'TENANT-A-CLIENT', '10.80.100.11').received.includes('APP-1');
});
run('D13', 'Retorno SPINE-1 recupera overlay', 'HA', true, (s) => {
  s.setDevicePower(device(s, 'SPINE-1').id, false);
  advance(s, 5000);
  s.setDevicePower(device(s, 'SPINE-1').id, true);
  advance(s, 15000);
  return http(s, 'TENANT-A-CLIENT', '10.80.100.11').received.includes('APP-1');
});
run('D14', 'MTU overlay 1450 permite ping 1400', 'MTU', 'success', (s) =>
  ping(s, 'TENANT-A-CLIENT', '10.80.100.11', 1400, true)
);
run(
  'D15',
  'MTU overlay 1450 rejeita ping 1500',
  'MTU',
  false,
  (s) => ping(s, 'TENANT-A-CLIENT', '10.80.100.11', 1500, true) === 'success'
);
run('D16', 'EVPN route target diferente retira importação', 'EVPN', 0, (s) => {
  const l = device(s, 'LEAF-2'),
    p = l.interfaces.find((p) => p.vxlan?.vni === 10100)!;
  s.configureVxlan(l.id, { ...vxlanConfig(p), routeTarget: '65000:999' });
  advance(s, 5000);
  ping(s, 'TENANT-A-CLIENT', '10.80.100.11');
  advance(s, 5000);
  return device(s, 'LEAF-1')
    .interfaces.find((p) => p.vxlan?.vni === 10100)!
    .vxlan!.routes.filter((r) => r.nextHop === l.interfaces[1].ip).length;
});
run('D17', 'RT divergente não deve ser tratado como isolamento de dados', 'segurança', false, (s) => {
  const l = device(s, 'LEAF-2'),
    p = l.interfaces.find((p) => p.vxlan?.vni === 10100)!;
  s.configureVxlan(l.id, { ...vxlanConfig(p), routeTarget: '65000:999' });
  advance(s, 5000);
  return http(s, 'TENANT-A-CLIENT', '10.80.100.11').received.includes('APP-1');
});
run('D18', 'Movimento VM de LEAF-2 para LEAF-3', 'EVPN', true, (s) => {
  ping(s, 'TENANT-A-CLIENT', '10.80.100.11');
  const app = device(s, 'APP-1'),
    leaf = device(s, 'LEAF-3');
  s.removeLink(s.state.links.find((l) => l.a.device === app.id || l.b.device === app.id)!.id);
  Object.assign(leaf.interfaces[5], { accessVlan: 100, speed: 1000 });
  s.connect({ device: app.id, port: 'p0' }, { device: leaf.id, port: 'p5' });
  ping(s, 'APP-1', '10.80.100.10');
  advance(s, 10000);
  return http(s, 'TENANT-A-CLIENT', '10.80.100.11').received.includes('APP-1');
});
run('D19', 'UPS sustenta LB durante breve falta de energia', 'energia', true, (s) => {
  const u = device(s, 'UPS-DC');
  s.configureInfrastructure(u.id, { ...u.infrastructure, mains: false });
  advance(s, 5000);
  return device(s, 'LB').power;
});
run('D20', 'UPS esgotada interrompe LB', 'energia', false, (s) => {
  const u = device(s, 'UPS-DC');
  s.configureInfrastructure(u.id, { ...u.infrastructure, mains: false });
  advance(s, 25000);
  return device(s, 'LB').power;
});
run('D21', 'Persistência com TCP/EVPN pendentes determinística', 'persistência', true, (s) => {
  s.httpGet(device(s, 'USER-PC').id, '10.80.100.100');
  s.step();
  const restored = new SimulationEngine(JSON.parse(JSON.stringify(s.snapshot())));
  advance(s, 5000);
  restored.advanceTo(s.state.clock, 200000);
  return isDeepStrictEqual(
    JSON.parse(JSON.stringify(restored.snapshot())),
    JSON.parse(JSON.stringify(s.snapshot()))
  );
});
run(
  'D22',
  'Checkpoint de BGP em convergência determinístico',
  'persistência',
  true,
  (s) => {
    s.advanceTo(40, 200000);
    const restored = new SimulationEngine(s.snapshot());
    s.advanceTo(5000, 200000);
    restored.advanceTo(5000, 200000);
    return isDeepStrictEqual(restored.snapshot(), s.snapshot());
  },
  undefined,
  JSON.parse(String((await import('node:fs')).readFileSync(out + '/enterprise-datacenter.shlab.json')))
);
run(
  'U01',
  'Executor aceita alvo IPv6',
  'executor',
  true,
  () =>
    scenarioSchema.safeParse({
      name: 'IPv6',
      durationMs: 1000,
      intervalMs: 1000,
      deadlineMs: 500,
      flows: [{ name: 'v6', source: 'ADMIN', target: '2001:db8::1', protocol: 'icmp', expect: 'allow' }],
      faults: [],
    }).success
);
run(
  'U02',
  'Executor aceita seleção de VRF',
  'executor',
  true,
  () =>
    scenarioSchema.safeParse({
      name: 'VRF',
      durationMs: 1000,
      intervalMs: 1000,
      deadlineMs: 500,
      flows: [
        {
          name: 'vrf',
          source: 'ADMIN',
          target: '10.60.40.10',
          protocol: 'icmp',
          vrf: 'TENANT-A',
          expect: 'allow',
        },
      ],
      faults: [],
    }).success
);
run('U03', 'Executor nativo comprova campus/tenant isolado', 'executor', true, (s) => {
  const runner = new ScenarioRunner(s.snapshot(), {
    name: 'Enterprise e DC baseline',
    durationMs: 5000,
    intervalMs: 1000,
    deadlineMs: 500,
    flows: [
      { name: 'ERP autorizado', source: 'USER-PC', target: '10.60.40.10', protocol: 'http', expect: 'allow' },
      {
        name: 'Visitante bloqueado',
        source: 'GUEST-PC',
        target: '10.60.40.10',
        protocol: 'http',
        expect: 'deny',
      },
      {
        name: 'Tenant A → APP-1',
        source: 'TENANT-A-CLIENT',
        target: '10.80.100.11',
        protocol: 'http',
        expect: 'allow',
      },
    ],
    faults: [],
  });
  for (let i = 0; i < 1000 && !runner.step(100); i++);
  const report = runner.report();
  writeFileSync(out + '/native-baseline.json', JSON.stringify(report, null, 2));
  return report.passed;
});
writeFileSync(
  out + '/scenario-results.json',
  JSON.stringify(
    {
      date: '2026-10-13',
      topology: { devices: base.devices.length, links: base.links.length },
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      findings: results.filter((r) => !r.passed).length,
      results,
    },
    null,
    2
  )
);
console.log(
  JSON.stringify({
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    findings: results.filter((r) => !r.passed).map((r) => r.id),
  })
);
