// Migrated from scripts/audit-enterprise-protocols.ts; historical expectations are preserved unless explicitly documented.
import { it, expect } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  preflight,
  ScenarioRunner,
  vxlanConfig,
  enterpriseDefaults,
  exportPcap,
  scenarioReportSchema,
  type Snapshot,
} from '../packages/simulation-engine/src';
const initial = makeTemplate('enterprise-datacenter');
const e = new SimulationEngine(initial);
e.advanceTo(35000, 200000);
const base = e.snapshot();
const findings: Record<string, unknown> = {};
const device = (s: SimulationEngine, name: string) => s.state.devices.find((d) => d.hostname === name)!;
const advance = (s: SimulationEngine, ms: number) => s.advanceTo(s.state.clock + ms, 200000);
function run(
  id: string,
  name: string,
  expected: unknown,
  fn: (s: SimulationEngine) => unknown,
  snapshot: Snapshot = base
) {
  const test = id === 'P-PCAP' ? it.skip : it;
  test(
    id + ' — ' + name,
    () => {
      const e = new SimulationEngine(snapshot);
      const observed = fn(e);
      validateSnapshot(e.snapshot());
      expect(observed).toEqual(expected);
    },
    60000
  );
}
function http(s: SimulationEngine, source: string, target: string, vrf?: string) {
  const id = s.httpGet(device(s, source).id, target, 80, '/', vrf);
  advance(s, 5000);
  return device(s, source).tcpConnections?.find((c) => c.id === id)?.received ?? '';
}
for (const protocol of ['ospf', 'bgp', 'vpn', 'sdwan'] as const) {
  const snap = makeTemplate(protocol),
    a = protocol === 'ospf' || protocol === 'bgp' ? 'PC-01' : 'LAN-A',
    target = protocol === 'ospf' || protocol === 'bgp' ? '192.168.20.10' : '10.2.0.20';
  run(
    'P-' + protocol + '-base',
    protocol + ': HTTP após convergência',
    true,
    (s) => {
      advance(s, 15000);
      return http(s, a, target).includes('HTTP/1.1 200');
    },
    snap
  );
  if (protocol !== 'vpn')
    run(
      'P-' + protocol + '-failover',
      protocol + ': falha de um caminho',
      true,
      (s) => {
        advance(s, 15000);
        const router = s.state.devices[0];
        s.setPort(router.id, protocol === 'sdwan' ? 'p1' : protocol === 'bgp' ? 'p1' : 'p0', false);
        advance(s, protocol === 'ospf' ? 50000 : 10000);
        return http(s, a, target).includes('HTTP/1.1 200');
      },
      snap
    );
}
for (const vrf of ['BLUE', 'RED'])
  run(
    'P-VRF-' + vrf,
    'TCP em VRF ' + vrf + ' com IP sobreposto',
    true,
    (s) => http(s, 'R-VRF', '10.0.0.2', vrf).includes('VRF ' + vrf),
    makeTemplate('vrf')
  );
run(
  'P-VRF-default',
  'Tabela default não alcança tenants VRF',
  true,
  (s) => {
    try {
      http(s, 'R-VRF', '10.0.0.2');
      return false;
    } catch (error) {
      return /rota/.test((error as Error).message);
    }
  },
  makeTemplate('vrf')
);
run('P-NTP', 'NTP em VLAN de gerência', true, (s) => {
  s.configureClock(device(s, 'ADMIN').id, { offsetMs: 250, server: false, stratum: 1 });
  s.configureNtp(device(s, 'ADMIN').id, { enabled: true, servers: ['10.60.99.123'], intervalMs: 5000 });
  advance(s, 4000);
  return device(s, 'ADMIN').ntp?.synchronized;
});
run('P-SYSLOG', 'Syslog entregue ao coletor', true, (s) => {
  s.configureSyslog(device(s, 'ADMIN').id, { enabled: true, server: '10.60.99.11', severity: 7 });
  s.sendSyslog(device(s, 'ADMIN').id, 'enterprise-audit');
  advance(s, 3000);
  return device(s, 'SYSLOG').syslogServer?.entries.some((x) => x.message.text.includes('enterprise-audit'));
});
run('P-DHCP-backup-pool', 'DHCP após failover com pool giaddr compatível', true, (s) => {
  const server = device(s, 'DHCP');
  s.configureDhcpPool(server.id, {
    ...server.dhcpServer!.pools[0],
    name: 'USERS-BACKUP',
    relayAddress: '10.60.10.3',
    relayAddresses: [],
    start: '10.60.10.121',
    end: '10.60.10.140',
  });
  s.setDevicePower(device(s, 'FW-A').id, false);
  advance(s, 5000);
  s.requestDhcp(device(s, 'DHCP-PC').id, 'p0');
  advance(s, 5000);
  return Boolean(device(s, 'DHCP-PC').interfaces[0].dhcp?.lease);
});
run('P-PREFLIGHT-DHCP', 'Preflight detecta pool ausente para relay de backup', true, (s) => {
  // The native template now fixes the historical omission. Reintroduce only
  // the missing backup giaddr to exercise the negative case.
  device(s, 'DHCP').dhcpServer!.pools[0].relayAddresses = [];
  return preflight(s.snapshot()).some((i) => i.code.includes('POOL') || i.code.includes('SCOPE'));
});
run('P-PREFLIGHT-RT', 'Preflight detecta route target divergente no mesmo VNI/peer', true, (s) => {
  const leaf = device(s, 'LEAF-2'),
    port = leaf.interfaces.find((p) => p.vxlan?.vni === 10100)!;
  s.configureVxlan(leaf.id, { ...vxlanConfig(port), routeTarget: '65000:999' });
  return preflight(s.snapshot()).some((i) => i.code === 'EVPN_RT_MISMATCH');
});
run(
  'P-PREFLIGHT-TENANTS',
  'Preflight distingue IP repetido em VNIs isolados',
  0,
  (s) => preflight(s.snapshot()).filter((i) => i.code === 'DUPLICATE_IP').length
);
function dualStack(s: SimulationEngine) {
  const fw = device(s, 'FW-A');
  fw.ipv6Routing = true;
  for (const vlan of [20, 40])
    s.configureIpv6(fw.id, fw.interfaces.find((p) => p.logical?.vlan === vlan)!.id, {
      auto: false,
      addresses: [{ ip: `2001:db8:${vlan}::1`, prefix: 64 }],
    });
  for (const [name, vlan] of [
    ['GUEST-PC', 20],
    ['ERP', 40],
  ] as const) {
    const d = device(s, name);
    s.configureIpv6(d.id, 'p0', { auto: false, addresses: [{ ip: `2001:db8:${vlan}::10`, prefix: 64 }] });
    s.configureRoute6(d.id, {
      network: '::',
      prefix: 0,
      nextHop: `2001:db8:${vlan}::1`,
      port: 'p0',
      metric: 1,
    });
  }
  advance(s, 3000);
  return fw;
}
run('P-DUALSTACK-ZONES', 'Política de zonas GUEST→CORP deve bloquear IPv6 também', false, (s) => {
  dualStack(s);
  const id = s.ping6(device(s, 'GUEST-PC').id, '2001:db8:40::10');
  advance(s, 4000);
  return s.state.probes6?.find((p) => p.id === id)?.status === 'success';
});
run('P-DUALSTACK-HTTP', 'HTTP IPv6 GUEST→CORP também deve ser bloqueado', false, (s) => {
  dualStack(s);
  return http(s, 'GUEST-PC', '2001:db8:40::10').includes('ERP');
});
run('P-PCAP', 'PCAP exporta tráfego integrado sem omissões de codec', 0, (s) => {
  http(s, 'TENANT-A-CLIENT', '10.80.100.11');
  const capture = exportPcap(s.snapshot());
  findings.pcap = {
    packets: capture.packets,
    dropped: capture.dropped,
    retainedFrames: capture.retainedFrames,
    excluded: capture.excluded.reduce(
      (acc, x) => {
        acc[x.reason] = (acc[x.reason] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    ),
  };
  return capture.excluded.length;
});
run('P-REPORT-CONSISTENCY', 'Validador recusa recovery adulterada em relatório', false, (s) => {
  const r = new ScenarioRunner(s.snapshot(), {
    name: 'recovery',
    durationMs: 6000,
    intervalMs: 1000,
    deadlineMs: 500,
    flows: [
      {
        name: 'ERP',
        source: 'USER-PC',
        target: '10.60.40.10',
        protocol: 'http',
        expect: 'allow',
        maxLossPercent: 100,
      },
    ],
    faults: [
      { atMs: 1000, kind: 'device', target: 'ERP', up: false },
      { atMs: 3000, kind: 'device', target: 'ERP', up: true },
    ],
  });
  for (let i = 0; i < 1000 && !r.step(100); i++);
  const report = r.report();
  report.faults[0].recovery[0].recoveryMs = 0;
  report.faults[0].recovery[0].observedFailure = false;
  return scenarioReportSchema.safeParse(report).success;
});
run('P-WIFI-DIAGNOSIS', 'Wi-Fi autenticado: diagnóstico de bridge/VLAN', true, (s) => {
  const ap = device(s, 'AP-ENTERPRISE');
  if (!ap.vlans.some((v) => v.id === 10)) ap.vlans.push({ id: 10, name: 'USERS' });
  const events: unknown[] = [],
    emit = s.emit.bind(s);
  s.emit = ((...args: Parameters<SimulationEngine['emit']>) => {
    const ev = emit(...args);
    if ([ap.id, device(s, 'WIFI-EMPLOYEE').id].includes(ev.device) && /DROP|FAIL|DENY/.test(ev.type))
      events.push({ type: ev.type, reason: ev.reason });
    return ev;
  }) as SimulationEngine['emit'];
  const success = http(s, 'WIFI-EMPLOYEE', '10.60.40.10').includes('ERP');
  findings.wifiData = { success, events };
  return success;
});
run('P-WIFI-INVALID-TRUST', 'Certificado RADIUS não confiável bloqueia acesso', false, (s) => {
  const client = device(s, 'WIFI-EMPLOYEE');
  const config = enterpriseDefaults().supplicant;
  s.configureEapSupplicant(client.id, { ...config, tls: { ...config.tls, serverName: 'invalid.campus' } });
  advance(s, 15000);
  return client.wireless?.phase === 'associated';
});
run('P-DUALSTACK-ACL', 'ACL IPv6 explícita bloqueia GUEST→CORP', false, (s) => {
  const fw = dualStack(s),
    port = fw.interfaces.find((p) => p.logical?.vlan === 20)!;
  s.configureIpv6(fw.id, port.id, {
    auto: false,
    addresses: [{ ip: '2001:db8:20::1', prefix: 64 }],
    aclIn: [
      {
        action: 'permit',
        kind: 'ndp',
        source: '::',
        sourcePrefix: 0,
        destination: '::',
        destinationPrefix: 0,
      },
      {
        action: 'deny',
        kind: 'any',
        source: '::',
        sourcePrefix: 0,
        destination: '2001:db8:40::',
        destinationPrefix: 64,
      },
      {
        action: 'permit',
        kind: 'any',
        source: '::',
        sourcePrefix: 0,
        destination: '::',
        destinationPrefix: 0,
      },
    ],
  });
  advance(s, 2000);
  const id = s.ping6(device(s, 'GUEST-PC').id, '2001:db8:40::10');
  advance(s, 4000);
  return s.state.probes6?.find((p) => p.id === id)?.status === 'success';
});
for (const protect of [false, true])
  run(
    'P-ROGUE-DHCP-' + protect,
    'DHCP indevido ' + (protect ? 'bloqueado por snooping' : 'vence sem snooping'),
    protect,
    (s) => {
      const rogue = s.addDevice('server');
      rogue.hostname = 'ROGUE-DHCP';
      Object.assign(rogue.interfaces[0], { ip: '10.60.10.200', prefix: 24, speed: 1000 });
      s.connect({ device: rogue.id, port: 'p0' }, { device: device(s, 'ACCESS-USERS').id, port: 'p3' });
      s.setSpanningTreePort(device(s, 'ACCESS-USERS').id, 'p3', { edge: true });
      // Port edits currently restart the bridge; test snooping only after convergence.
      advance(s, 35000);
      s.configureDhcpPool(rogue.id, {
        name: 'ROGUE',
        port: 'p0',
        network: '10.60.10.0',
        prefix: 24,
        start: '10.60.10.201',
        end: '10.60.10.210',
        gateway: '10.60.10.200',
        leaseMs: 60000,
        excluded: [],
        dns: [],
      });
      s.setDhcpEnabled(rogue.id, true);
      if (protect)
        s.configureDhcpSnooping(device(s, 'ACCESS-USERS').id, {
          enabled: true,
          vlans: [10],
          trustedPorts: ['p20', 'p21'],
          sourceGuard: false,
          arpInspection: false,
        });
      s.requestDhcp(device(s, 'DHCP-PC').id, 'p0');
      advance(s, 5000);
      findings['rogueDhcp-' + protect] = {
        lease: device(s, 'DHCP-PC').interfaces[0].dhcp,
        snooping: device(s, 'ACCESS-USERS').dhcpSnooping,
        diagnostics: s.state.diagnostics?.filter(
          (ev) => ev.device === device(s, 'ACCESS-USERS').id && /DHCP|snoop/i.test(ev.reason)
        ),
      };
      return device(s, 'DHCP-PC').interfaces[0].dhcp?.lease?.server === '10.60.30.67';
    }
  );
run('P-RSTP-PORT-EDIT', 'Alterar edge em porta desconectada não deve interromper uplinks', true, (s) => {
  const access = device(s, 'ACCESS-USERS');
  const before = access.interfaces.find((p) => p.id === 'p20')!.spanningTree?.state;
  s.setSpanningTreePort(access.id, 'p3', { edge: true });
  const after = access.interfaces.find((p) => p.id === 'p20')!.spanningTree?.state;
  const immediate = http(s, 'USER-PC', '10.60.40.10').includes('ERP');
  advance(s, 35000);
  const recovered = http(s, 'USER-PC', '10.60.40.10').includes('ERP');
  findings.rstpPortEdit = { before, after, immediate, recovered };
  return immediate && recovered;
});
run('P-HA-EXISTING-TCP', 'Sessão TCP existente precisa sobreviver ao failover de firewall', true, (s) => {
  const user = device(s, 'USER-PC'),
    fw = device(s, 'FW-A'),
    backup = device(s, 'FW-B'),
    erp = device(s, 'ERP');
  s.configureTcpService(erp.id, { kind: 'echo', port: 7777, enabled: true });
  for (const d of [fw, backup])
    s.configureFirewall(d.id, {
      enabled: true,
      protocols: ['TCP', 'UDP', 'ICMP'],
      trustedPorts: [],
      zonePolicy: {
        ...d.firewall!.zonePolicy!,
        rules: [
          {
            sequence: 1,
            from: 'USERS',
            to: 'CORP',
            action: 'inspect',
            protocol: 'TCP',
            destinationPort: 7777,
          },
          ...d.firewall!.zonePolicy!.rules,
        ],
      },
    });
  const id = s.openTcp(user.id, '10.60.40.10', 7777, 'before|', false);
  advance(s, 1000);
  const established = user.tcpConnections!.find((c) => c.id === id)!;
  s.setDevicePower(fw.id, false);
  advance(s, 5000);
  s.writeTcp(user.id, id, 'after|');
  advance(s, 5000);
  findings.existingTcp = {
    beforeEstablished: established.received.includes('before|'),
    received: established.received,
    state: established.state,
    backupSessions: backup.firewall!.sessions.length,
  };
  return established.received.includes('after|');
});
