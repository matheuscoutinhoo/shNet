// Migrated from scripts/audit-enterprise-datacenter.ts; historical expectations are preserved unless explicitly documented.
import { it, expect } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  ScenarioRunner,
  scenarioSchema,
  vxlanConfig,
  wirelessConfig,
  type Snapshot,
} from '../packages/simulation-engine/src';
const initial = makeTemplate('enterprise-datacenter');
const e = new SimulationEngine(initial);
e.advanceTo(35000, 200000);
const base = e.snapshot();
const radio = wirelessConfig(base.devices.find((d) => d.hostname === 'AP-ENTERPRISE')!);
const leaves = base.devices.filter((d) => d.hostname.startsWith('LEAF-'));
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
  _group: string,
  expected: unknown,
  fn: (s: SimulationEngine) => unknown,
  compare = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
  snapshot: Snapshot = base
) {
  it(
    id + ' — ' + name,
    () => {
      const e = new SimulationEngine(snapshot);
      const observed = fn(e);
      validateSnapshot(e.snapshot());
      expect(compare(expected, observed), JSON.stringify({ expected, observed })).toBe(true);
    },
    60000
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
  const nextHop = l.interfaces.find((i) => i.id === p.vxlan!.underlay)!.ip;
  ping(s, 'TENANT-A-CLIENT', '10.80.100.11');
  expect(
    device(s, 'LEAF-1')
      .interfaces.find((i) => i.vxlan?.vni === 10100)!
      .vxlan!.routes.some((r) => r.nextHop === nextHop)
  ).toBe(true);
  s.configureVxlan(l.id, { ...vxlanConfig(p), routeTarget: '65000:999' });
  advance(s, 5000);
  ping(s, 'TENANT-A-CLIENT', '10.80.100.11');
  advance(s, 5000);
  return device(s, 'LEAF-1')
    .interfaces.find((p) => p.vxlan?.vni === 10100)!
    .vxlan!.routes.filter((r) => r.nextHop === nextHop).length;
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
  initial
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
  return report.passed;
});
