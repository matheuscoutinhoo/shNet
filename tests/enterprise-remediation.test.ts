import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  ScenarioRunner,
  makeTemplate,
  scenarioReportSchema,
  scenarioSchema,
  validateSnapshot,
  preflight,
  vxlanConfig,
  addProfile,
  exportPcap,
  decodePcap,
  configureModbus,
  modbusRequest,
  decodeModbus,
  enterpriseScenarios,
} from '../packages/simulation-engine/src';
import { mkdir, writeFile } from 'node:fs/promises';
import { encodeModbusRequest } from '../packages/simulation-engine/src/protocols/modbus';
import { openTcp, writeTcp } from '../packages/simulation-engine/src/protocols/tcp';

function dualStack() {
  const e = new SimulationEngine(),
    a = e.addDevice('pc'),
    r = e.addDevice('router'),
    b = e.addDevice('server');
  r.ipv6Routing = true;
  for (const [i, host] of [a, b].entries()) {
    e.connect({ device: host.id, port: 'p0' }, { device: r.id, port: 'p' + i });
    Object.assign(host.interfaces[0], { ip: `10.${i + 1}.0.10`, prefix: 24, gateway: `10.${i + 1}.0.1` });
    Object.assign(r.interfaces[i], { ip: `10.${i + 1}.0.1`, prefix: 24 });
    e.configureIpv6(r.id, 'p' + i, { auto: false, addresses: [{ ip: `2001:db8:${i + 1}::1`, prefix: 64 }] });
    e.configureIpv6(host.id, 'p0', { auto: false, addresses: [{ ip: `2001:db8:${i + 1}::10`, prefix: 64 }] });
    e.configureRoute6(host.id, {
      network: '::',
      prefix: 0,
      nextHop: `2001:db8:${i + 1}::1`,
      port: 'p0',
      metric: 1,
    });
  }
  e.configureTcpService(b.id, { port: 80, kind: 'http', enabled: true, body: 'ERP' });
  e.configureUdp6Service(b.id, { port: 7, kind: 'echo', enabled: true });
  e.advanceTo(3000);
  return { e, a, r, b };
}
function run(r: ScenarioRunner) {
  for (let i = 0; i < 3000 && !r.step(100); i++);
  const report = r.report();
  scenarioReportSchema.parse(report);
  return report;
}
describe('Correções enterprise/datacenter', () => {
  it('presets continuam válidos após avanço realtime com relógio fracionário', () => {
    const s = makeTemplate('enterprise-datacenter');
    s.clock = 1234.567;
    expect(enterpriseScenarios(s)).toHaveLength(30);
    expect(enterpriseScenarios(s)[0].warmupMs).toBe(33766);
  });
  it('remover equipamentos opcionais e BGP do modelo não fecha o catálogo de cenários', () => {
    const s = makeTemplate('enterprise-datacenter');
    s.devices = s.devices.filter((d) => !['TENANT-B-SERVER', 'NTP', 'APP-1'].includes(d.hostname));
    delete s.devices.find((d) => d.hostname === 'LEAF-1')!.bgp;
    const scenarios = enterpriseScenarios(s);
    expect(scenarios.some((x) => x.name === 'Enterprise/DC — baseline de aplicações')).toBe(true);
    expect(scenarios.find((x) => x.assertions)?.assertions?.some((a) => a.kind === 'bgp')).toBe(false);
  });
  it('ensaios concorrentes de campus/LB produzem relatório idêntico com fatias de 1 e 100 ms', () => {
    const e = new SimulationEngine(makeTemplate('enterprise-datacenter'));
    e.advanceTo(35000, 200000);
    const scenario = {
      name: 'Determinismo entre cliente e servidor',
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
        {
          name: 'LB',
          source: 'TENANT-A-CLIENT',
          target: '10.80.100.100',
          protocol: 'http',
          expect: 'allow',
          maxLossPercent: 100,
        },
      ],
      faults: [
        { atMs: 1000, kind: 'device', target: 'FW-A', up: false },
        { atMs: 4000, kind: 'device', target: 'FW-A', up: true },
      ],
    };
    const source = e.snapshot(),
      fast = new ScenarioRunner(source, scenario),
      slow = new ScenarioRunner(source, scenario);
    const report = run(fast);
    for (let i = 0; i < 30000 && !slow.step(1); i++);
    expect(slow.report()).toEqual(report);
    expect(slow.engine.snapshot()).toEqual(fast.engine.snapshot());
    scenarioReportSchema.parse(report);
  }, 60000);
  it('assertions nativas verificam BGP/IMET/EAP/LB/MTU/energia e divergência afeta aprovação', () => {
    const s = makeTemplate('enterprise-datacenter'),
      scenario = enterpriseScenarios(s).find((s) => s.assertions)!;
    const report = run(new ScenarioRunner(s, scenario));
    expect(report.passed, JSON.stringify(report.assertions)).toBe(true);
    expect(report.assertions!.length).toBe(9);
    const bad = structuredClone(report);
    bad.assertions![0].observed = 'Idle';
    expect(scenarioReportSchema.safeParse(bad).success).toBe(false);
    const e = new SimulationEngine(makeTemplate('routed')),
      a = e.state.devices.find((d) => d.type === 'pc')!,
      b = e.state.devices.find((d) => d.type === 'server')!;
    const denied = run(
      new ScenarioRunner(e.snapshot(), {
        name: 'Estado negativo',
        durationMs: 1000,
        intervalMs: 1000,
        deadlineMs: 500,
        flows: [
          { name: 'Ping', source: a.id, target: b.interfaces[0].ip!, protocol: 'icmp', expect: 'allow' },
        ],
        faults: [],
        assertions: [{ name: 'Energia falsa', atMs: 999, kind: 'power', target: b.id, expected: false }],
      })
    );
    expect(denied.flows[0].passed).toBe(true);
    expect(denied.passed).toBe(false);
  }, 60000);
  it('relay VRRP backup concede lease novo e renova o existente usando giaddr alternativo do mesmo pool', () => {
    const e = new SimulationEngine(makeTemplate('enterprise-datacenter')),
      client = e.state.devices.find((d) => d.hostname === 'USER-PC')!,
      sw = e.state.devices.find((d) => d.hostname === 'ACCESS-USERS')!,
      other = e.addDevice('pc');
    e.state.devices.find((d) => d.hostname === 'DHCP')!.dhcpServer!.pools[0].leaseMs = 12000;
    sw.interfaces[2].accessVlan = 10;
    e.setSpanningTreePort(sw.id, 'p2', { edge: true });
    e.connect({ device: sw.id, port: 'p2' }, { device: other.id, port: 'p0' });
    e.advanceTo(35000, 200000);
    e.requestDhcp(client.id, 'p0');
    e.advanceTo(36000, 200000);
    const lease = structuredClone(client.interfaces[0].dhcp!.lease!);
    expect(client.interfaces[0].dhcp!.status).toBe('bound');
    const primary = e.state.devices.find((d) => d.hostname === 'FW-A')!;
    e.setDevicePower(primary.id, false);
    e.advanceTo(41000, 200000);
    e.requestDhcp(other.id, 'p0');
    e.advanceTo(42000, 200000);
    expect(other.interfaces[0].dhcp!.status).toBe('bound');
    expect(other.interfaces[0].ip).not.toBe(lease.address);
    e.advanceTo(43000, 200000);
    expect(client.interfaces[0].dhcp!.lease!.expiresAt).toBeGreaterThan(lease.expiresAt);
    const renewed = structuredClone(client.interfaces[0].dhcp!.lease!);
    const backup = e.state.devices.find((d) => d.hostname === 'FW-B')!;
    e.configureFirewall(backup.id, {
      ...backup.firewall,
      zonePolicy: {
        ...backup.firewall!.zonePolicy!,
        rules: backup.firewall!.zonePolicy!.rules.filter((r) => r.sequence !== 55),
      },
    });
    e.advanceTo(56000, 200000);
    expect(client.interfaces[0].dhcp!.lease!.expiresAt).toBeGreaterThan(renewed.expiresAt);
    expect(client.interfaces[0].ip).toBe(lease.address);
    const server = e.state.devices.find((d) => d.hostname === 'DHCP')!;
    expect(server.dhcpServer!.bindings.map((b) => b.address)).toEqual(
      expect.arrayContaining([lease.address, other.interfaces[0].ip])
    );
    validateSnapshot(e.snapshot());
  }, 60000);
  it('executor mantém origens e IPs sobrepostos isolados em VRFs', () => {
    const e = new SimulationEngine(),
      router = e.addDevice('router');
    for (const [i, vrf] of ['BLUE', 'RED'].entries()) {
      e.configureVrf(router.id, vrf);
      e.setInterfaceVrf(router.id, 'p' + i, vrf);
      Object.assign(router.interfaces[i], { ip: '10.0.0.1', prefix: 24 });
      const host = e.addDevice('server');
      Object.assign(host.interfaces[0], { ip: '10.0.0.2', prefix: 24 });
      e.connect({ device: router.id, port: 'p' + i }, { device: host.id, port: 'p0' });
      e.configureTcpService(host.id, { port: 80, kind: 'http', enabled: true, body: vrf });
    }
    const runner = new ScenarioRunner(e.snapshot(), {
      name: 'VRFs',
      durationMs: 1000,
      intervalMs: 1000,
      deadlineMs: 500,
      flows: ['BLUE', 'RED'].map((vrf) => ({
        name: vrf,
        source: router.id,
        target: '10.0.0.2',
        protocol: 'http',
        expect: 'allow',
        vrf,
      })),
      faults: [],
    });
    expect(run(runner).passed).toBe(true);
    for (const vrf of ['BLUE', 'RED'])
      expect(runner.engine.device(router.id).tcpConnections!.find((c) => c.vrf === vrf)!.received).toContain(
        vrf
      );
    validateSnapshot(runner.engine.snapshot());
  });
  it('checkpoint durante Modbus/TCP restaura timers/filas e distingue épocas sem alterar a origem', () => {
    const e = new SimulationEngine(makeTemplate('routed')),
      a = e.state.devices.find((d) => d.type === 'pc')!,
      b = e.state.devices.find((d) => d.type === 'server')!;
    configureModbus(e, b, { enabled: true, registers: [65535] });
    const source = e.snapshot(),
      scenario = {
        name: 'Restore em trânsito',
        durationMs: 500,
        intervalMs: 100,
        deadlineMs: 100,
        flows: [
          {
            name: 'Modbus',
            source: a.id,
            target: b.interfaces[0].ip!,
            protocol: 'modbus',
            expect: 'allow',
            maxLossPercent: 100,
            requireFinalSuccess: true,
            modbus: { transaction: 1, unit: 1, function: 3, address: 0 },
            expectedRegisters: [65535],
          },
        ],
        actions: [
          { atMs: 1, kind: 'checkpoint', checkpoint: 'live' },
          { atMs: 300, kind: 'restore', checkpoint: 'live' },
        ],
        faults: [{ atMs: 100, kind: 'device', target: b.id, up: false }],
      };
    const first = new ScenarioRunner(source, scenario),
      second = new ScenarioRunner(source, scenario);
    const report = run(first);
    for (let i = 0; i < 30000 && !second.step(1); i++);
    expect(second.report()).toEqual(report);
    expect(first.engine.snapshot()).toEqual(second.engine.snapshot());
    expect(report.actions![1]).toMatchObject({
      afterClock: 1,
      epoch: 1,
      snapshotHash: report.actions![0].snapshotHash,
    });
    expect(report.samples.at(-1)).toMatchObject({ epoch: 1, status: 'success' });
    expect(e.snapshot()).toEqual(source);
    validateSnapshot(first.engine.snapshot());
    const bad = structuredClone(report);
    bad.samples.at(-1)!.epoch = 0;
    expect(scenarioReportSchema.safeParse(bad).success).toBe(false);
    expect(
      () =>
        new ScenarioRunner(source, {
          ...scenario,
          actions: [{ atMs: 0, kind: 'restore', checkpoint: 'missing' }],
        })
    ).toThrow(/checkpoint/);
  });
  it('Modbus separa coils, entradas discretas e input registers; executa ciclos e valida bits no cenário', () => {
    const e = new SimulationEngine(makeTemplate('routed')),
      a = e.state.devices.find((d) => d.type === 'pc')!,
      b = e.state.devices.find((d) => d.type === 'server')!,
      ip = b.interfaces[0].ip!;
    configureModbus(e, b, {
      enabled: true,
      registers: [10],
      inputRegisters: [65535, 7],
      coils: [false, false, false, false, false, false, false, false, false],
      discreteInputs: [true, false, true],
    });
    modbusRequest(e, a, ip, {
      transaction: 1,
      unit: 1,
      function: 15,
      address: 0,
      quantity: 9,
      values: [1, 0, 1, 0, 1, 0, 1, 0, 1],
    });
    e.advanceTo(1000);
    expect(b.modbus!.coils).toEqual([true, false, true, false, true, false, true, false, true]);
    modbusRequest(e, a, ip, { transaction: 2, unit: 1, function: 5, address: 1, values: [1] });
    e.advanceTo(2000);
    expect(b.modbus!.coils![1]).toBe(true);
    expect(b.modbus!.discreteInputs).toEqual([true, false, true]);
    const report = run(
      new ScenarioRunner(e.snapshot(), {
        name: 'Ciclo HMI',
        durationMs: 3000,
        intervalMs: 1000,
        deadlineMs: 500,
        flows: [
          {
            name: 'Entradas',
            source: a.id,
            target: ip,
            protocol: 'modbus',
            expect: 'allow',
            modbus: { transaction: 3, unit: 1, function: 2, address: 0, quantity: 3 },
            expectedBits: [true, false, true],
          },
          {
            name: 'Coils',
            source: a.id,
            target: ip,
            protocol: 'modbus',
            expect: 'allow',
            modbus: { transaction: 4, unit: 1, function: 1, address: 0, quantity: 9 },
            expectedBits: [true, true, true, false, true, false, true, false, true],
          },
          {
            name: 'Input registers',
            source: a.id,
            target: ip,
            protocol: 'modbus',
            expect: 'allow',
            modbus: { transaction: 5, unit: 1, function: 4, address: 0, quantity: 2 },
            expectedRegisters: [65535, 7],
          },
        ],
        faults: [],
      })
    );
    expect(report.passed, JSON.stringify(report.samples)).toBe(true);
    expect(report.samples).toHaveLength(9);
    validateSnapshot(e.snapshot());
  });
  it('fontes UPS A/B mantêm carga com uma falha e desligam apenas quando ambas falham', () => {
    const e = new SimulationEngine(),
      host = e.addDevice('server');
    const supplies = [addProfile(e, 'ups'), addProfile(e, 'ups')];
    for (const ups of supplies)
      e.configureInfrastructure(ups.id, {
        kind: 'ups',
        mains: true,
        capacityWh: 10,
        remainingWh: 0,
        maxWatts: 100,
        chargeWatts: 0,
        efficiency: 1,
        loads: [{ device: host.id, watts: 20, requested: true }],
        lastAt: 0,
        output: true,
      });
    e.setDevicePower(supplies[0].id, false);
    expect(host.power).toBe(true);
    validateSnapshot(e.snapshot());
    e.setDevicePower(supplies[1].id, false);
    expect(host.power).toBe(false);
    const restored = new SimulationEngine(e.snapshot());
    restored.setDevicePower(supplies[0].id, true);
    expect(restored.device(host.id).power).toBe(true);
    restored.setDevicePower(host.id, false);
    restored.setDevicePower(supplies[1].id, true);
    expect(restored.device(host.id).power).toBe(false);
    validateSnapshot(restored.snapshot());
  });
  it('Modbus binário reconstitui ADUs segmentadas/coalescidas e exporta MBAP/PDU e exceção sem UTF-8', async () => {
    const e = new SimulationEngine(),
      a = e.addDevice('pc'),
      b = e.addDevice('server');
    Object.assign(a.interfaces[0], { ip: '10.0.0.1', prefix: 24 });
    Object.assign(b.interfaces[0], { ip: '10.0.0.2', prefix: 24 });
    e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
    configureModbus(e, b, { enabled: true, registers: [65535, 32768, 10] });
    const request = encodeModbusRequest({
      transaction: 0x80ff,
      unit: 1,
      function: 6,
      address: 2,
      values: [0xfefe],
    });
    expect(Buffer.from(request, 'latin1').toString('hex')).toBe('80ff0000000601060002fefe');
    const id = openTcp(e, a, '10.0.0.2', 502, request.slice(0, 5), false, (c) => {
      c.service = 'modbus';
      c.encoding = 'binary';
      c.stream = { readBytes: 0, writtenBytes: 0 };
    });
    e.advanceTo(50);
    expect(b.modbus!.registers[2]).toBe(10);
    const bad = encodeModbusRequest({ transaction: 2, unit: 1, function: 3, address: 99 });
    writeTcp(e, a, id, request.slice(5) + bad);
    e.advanceTo(100);
    expect(b.modbus!.registers[2]).toBe(0xfefe);
    const data = a.tcpConnections!.find((c) => c.id === id)!.received;
    expect(data.length).toBe(21);
    expect(decodeModbus(data.slice(0, 12)).transaction).toBe(0x80ff);
    expect(decodeModbus(data.slice(12)).exception).toBe(2);
    const read = modbusRequest(e, a, '10.0.0.2', {
      transaction: 3,
      unit: 1,
      function: 3,
      address: 0,
      quantity: 2,
    });
    e.advanceTo(200);
    expect(decodeModbus(a.tcpConnections!.find((c) => c.id === read)!.received).pdu).toEqual(
      Uint8Array.from([3, 4, 255, 255, 128, 0])
    );
    const multiple = modbusRequest(e, a, '10.0.0.2', {
      transaction: 4,
      unit: 1,
      function: 16,
      address: 0,
      quantity: 2,
      values: [0xabcd, 0x80ff],
    });
    e.advanceTo(300);
    expect(b.modbus!.registers.slice(0, 2)).toEqual([0xabcd, 0x80ff]);
    expect(decodeModbus(a.tcpConnections!.find((c) => c.id === multiple)!.received).pdu).toEqual(
      Uint8Array.from([16, 0, 0, 0, 2])
    );
    const capture = exportPcap(e.snapshot());
    expect(capture.excluded).toEqual([]);
    expect(
      decodePcap(capture.bytes).some(
        (r) => Buffer.from(r.frame.transport?.payload ?? []).toString('hex') === '000300000007010304ffff8000'
      )
    ).toBe(true);
    validateSnapshot(e.snapshot());
    expect(new SimulationEngine(e.snapshot()).snapshot()).toEqual(e.snapshot());
    await mkdir('.data/captures', { recursive: true });
    await writeFile('.data/captures/modbus.pcap', capture.bytes);
  });
  it('VXLAN PCAP contém header I/VNI, Ethernet interna e checksums válidos', async () => {
    const e = new SimulationEngine(makeTemplate('evpn'));
    e.advanceTo(5000);
    const a = e.state.devices.find((d) => d.hostname === 'VM-A')!;
    const id = e.ping(a.id, '10.50.0.20');
    e.advanceTo(7000);
    expect(e.state.probes.find((p) => p.id === id)!.status).toBe('success');
    const capture = exportPcap(e.snapshot()),
      packets = decodePcap(capture.bytes);
    const overlays = packets.filter((r) => r.frame.transport?.vxlan);
    expect(overlays.length).toBeGreaterThan(0);
    expect(overlays.every((r) => r.frame.transport!.vxlan!.vni === 10010)).toBe(true);
    expect(overlays.some((r) => r.frame.transport!.vxlan!.inner.arp)).toBe(true);
    expect(capture.excluded.every((x) => x.reason.includes('didático'))).toBe(true);
    await mkdir('.data/captures', { recursive: true });
    await writeFile('.data/captures/vxlan.pcap', capture.bytes);
  });
  it('timeout por equipamento desligado não comprova bloqueio de política', () => {
    const s = makeTemplate('lan'),
      a = s.devices.find((d) => d.interfaces.some((p) => p.ip))!,
      b = s.devices.find((d) => d.id !== a.id && d.interfaces.some((p) => p.ip))!;
    b.power = false;
    const report = run(
      new ScenarioRunner(s, {
        name: 'Negativo',
        durationMs: 1000,
        intervalMs: 1000,
        deadlineMs: 500,
        flows: [
          {
            name: 'Política',
            source: a.id,
            target: b.interfaces[0].ip!,
            protocol: 'icmp',
            expect: 'deny',
            denyEvidence: 'policy',
          },
        ],
        faults: [],
      })
    );
    expect(report.passed).toBe(false);
    expect(report.samples[0].evidence?.cause).not.toBe('policy');
  });
  it('template completo mantém HTTP/EVPN com SPINE-1 fora usando loopbacks e preserva isolamento de tenants', () => {
    const e = new SimulationEngine(makeTemplate('enterprise-datacenter'));
    expect(e.state.devices).toHaveLength(38);
    expect(e.state.devices.flatMap((d) => d.interfaces).filter((p) => p.loopback)).toHaveLength(3);
    validateSnapshot(e.snapshot());
    e.advanceTo(35000, 200000);
    const client = e.state.devices.find((d) => d.hostname === 'TENANT-A-CLIENT')!;
    const tenantB = e.state.devices.find((d) => d.hostname === 'TENANT-B-CLIENT')!;
    const leaf = e.state.devices.find((d) => d.hostname === 'LEAF-1')!;
    expect(leaf.interfaces.find((p) => p.vxlan?.vni === 10100)!.vxlan!.members).toHaveLength(2);
    const http = e.httpGet(client.id, '10.80.100.100');
    const other = e.httpGet(tenantB.id, '10.80.100.11');
    e.advanceTo(37000, 200000);
    expect(client.tcpConnections!.find((c) => c.id === http)!.received).toContain('APP-');
    expect(tenantB.tcpConnections!.find((c) => c.id === other)!.received).toContain('TENANT-B-SERVER');
    e.setDevicePower(e.state.devices.find((d) => d.hostname === 'SPINE-1')!.id, false);
    const after = e.httpGet(client.id, '10.80.100.100');
    e.advanceTo(40000, 200000);
    expect(client.tcpConnections!.find((c) => c.id === after)!.received).toContain('APP-');
    validateSnapshot(e.snapshot());
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(41000, 200000);
    restored.advanceTo(41000, 200000);
    expect(restored.snapshot()).toEqual(e.snapshot());
  }, 60000);
  it('modo EVPN estrito retira membros com RT divergente e não permite fallback por peers/learning', () => {
    const e = new SimulationEngine(makeTemplate('evpn'));
    for (const d of e.state.devices)
      for (const p of [...d.interfaces].filter((p) => p.vxlan))
        e.configureVxlan(d.id, { ...vxlanConfig(p), peerPolicy: 'evpn' });
    e.advanceTo(5000);
    const a = e.state.devices.find((d) => d.hostname === 'VM-A')!,
      b = e.state.devices.find((d) => d.hostname === 'VTEP-B')!,
      v = b.interfaces.find((p) => p.vxlan)!;
    const ping = e.ping(a.id, '10.50.0.20');
    e.advanceTo(7000);
    expect(e.state.probes.find((p) => p.id === ping)!.status).toBe('success');
    e.configureVxlan(b.id, { ...vxlanConfig(v), routeTarget: '65000:9999' });
    e.advanceTo(12000);
    expect(v.vxlan!.members ?? []).toHaveLength(0);
    expect(preflight(e.state).some((i) => i.code === 'EVPN_RT_MISMATCH')).toBe(true);
    const blocked = e.httpGet(a.id, '10.50.0.20');
    e.advanceTo(77000);
    expect(a.tcpConnections!.find((c) => c.id === blocked)!.received).toBe('');
    validateSnapshot(e.snapshot());
  });
  it('preflight separa VNIs e identifica giaddr sem escopo e duplicação real na mesma VLAN', () => {
    const s = makeTemplate('enterprise-datacenter');
    expect(preflight(s).filter((i) => i.code === 'DUPLICATE_IP')).toEqual([]);
    expect(preflight(s).filter((i) => i.code === 'RELAY_SCOPE_MISSING')).toEqual([]);
    const server = s.devices.find((d) => d.dhcpServer)!;
    for (const p of server.dhcpServer!.pools) delete p.relayAddresses;
    expect(
      preflight(s).some(
        (i) =>
          i.code === 'RELAY_SCOPE_MISSING' &&
          i.devices.includes(s.devices.find((d) => d.hostname === 'FW-B')!.id)
      )
    ).toBe(true);
    s.devices.find((d) => d.hostname === 'APP-2')!.interfaces[0].ip = '10.80.100.11';
    const duplicates = preflight(s).filter((i) => i.code === 'DUPLICATE_IP');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].devices).toHaveLength(2);
  });
  it.each(['deny', 'inspect'] as const)(
    'aplica zonas %s a ICMP/TCP IPv4 e IPv6, com retorno e snapshot',
    (action) => {
      const { e, a, r } = dualStack();
      e.configureFirewall(r.id, {
        enabled: true,
        zonePolicy: {
          zones: [
            { name: 'GUEST', ports: ['p0'] },
            { name: 'ERP', ports: ['p1'] },
          ],
          rules: [{ sequence: 10, from: 'GUEST', to: 'ERP', protocol: 'ip', action }],
        },
      });
      const runner = new ScenarioRunner(e.snapshot(), {
        name: 'Dual stack',
        durationMs: 2000,
        intervalMs: 1000,
        deadlineMs: 500,
        flows: ['10.2.0.10', '2001:db8:2::10'].flatMap((target) =>
          ['icmp', 'http'].map((protocol) => ({
            name: target + protocol,
            source: a.id,
            target,
            protocol,
            expect: action === 'deny' ? 'deny' : 'allow',
          }))
        ),
        faults: [],
      });
      const report = run(runner);
      expect(report.passed, JSON.stringify(report.samples)).toBe(true);
      if (action === 'deny') expect(report.samples.every((s) => s.evidence?.cause === 'policy')).toBe(true);
      else
        expect(runner.engine.device(r.id).firewall!.sessions.some((s) => s.clientIp.includes(':'))).toBe(
          true
        );
      validateSnapshot(runner.engine.snapshot());
      const restored = new SimulationEngine(runner.engine.snapshot());
      restored.advanceTo(restored.state.clock + 1000);
      validateSnapshot(restored.snapshot());
    }
  );
  it('correlaciona retorno UDP IPv6 e recusa retorno sem sessão', () => {
    const { e, a, r, b } = dualStack();
    e.configureFirewall(r.id, {
      enabled: true,
      zonePolicy: {
        zones: [
          { name: 'CLIENT', ports: ['p0'] },
          { name: 'ERP', ports: ['p1'] },
        ],
        rules: [
          { sequence: 10, from: 'CLIENT', to: 'ERP', protocol: 'UDP', destinationPort: 7, action: 'inspect' },
        ],
      },
    });
    const id = e.sendUdp6(a.id, '2001:db8:2::10', 7, 'UDP');
    e.sendUdp6(b.id, '2001:db8:1::10', 7, 'unsolicited');
    e.advanceTo(4500);
    expect(a.udp6Records?.find((q) => q.id === id)?.reply).toBe(true);
    expect(r.firewall!.dropped).toBeGreaterThan(0);
    validateSnapshot(e.snapshot());
  });
  it('recalcula recuperação por fluxo e rejeita adulteração de valor, null, observação e resolução', () => {
    const s = makeTemplate('lan'),
      a = s.devices.find((d) => d.interfaces.some((p) => p.ip))!,
      b = s.devices.find((d) => d.id !== a.id && d.interfaces.some((p) => p.ip))!;
    const report = run(
      new ScenarioRunner(s, {
        name: 'Recuperação',
        durationMs: 4000,
        intervalMs: 1000,
        deadlineMs: 500,
        flows: [
          {
            name: 'Ping',
            source: a.id,
            target: b.interfaces[0].ip,
            protocol: 'icmp',
            expect: 'allow',
            maxLossPercent: 50,
          },
        ],
        faults: [
          { atMs: 1000, kind: 'device', target: b.id, up: false },
          { atMs: 3000, kind: 'device', target: b.id, up: true },
        ],
      })
    );
    expect(report.faults[0].recovery[0].observedFailure).toBe(true);
    expect(report.faults[0].recovery[0].recoveryMs).toBeGreaterThan(2000);
    expect(report.faults[1].recovery[0].observedFailure).toBe(false);
    for (const patch of [
      { recoveryMs: 0 },
      { recoveryMs: null },
      { observedFailure: false },
      { resolutionMs: 1 },
    ]) {
      const bad = structuredClone(report);
      Object.assign(bad.faults[0].recovery[0], patch);
      expect(scenarioReportSchema.safeParse(bad).success).toBe(false);
    }
    const bad = structuredClone(report);
    bad.faults[1].recovery[0].recoveryMs = 0;
    expect(scenarioReportSchema.safeParse(bad).success).toBe(false);
  });
  it('edição de edge desconectada preserva eleição, timers e tráfego das portas convergidas', () => {
    const e = new SimulationEngine(makeTemplate('rstp'));
    e.advanceTo(35000);
    const d = e.state.devices.find((d) => d.hostname === 'SW-03')!,
      p = d.interfaces.find(
        (p) => !e.state.links.some((l) => [l.a, l.b].some((x) => x.device === d.id && x.port === p.id))
      )!;
    const before = d.interfaces.filter((x) => x.id !== p.id).map((x) => structuredClone(x.spanningTree));
    const tree = structuredClone(d.spanningTree);
    e.setSpanningTreePort(d.id, p.id, { edge: true });
    expect(d.interfaces.filter((x) => x.id !== p.id).map((x) => x.spanningTree)).toEqual(before);
    expect(d.spanningTree).toEqual(tree);
    validateSnapshot(e.snapshot());
  });
  it('recusa IPv6/VRF em adaptadores ainda limitados e link-local sem scope', () => {
    expect(
      scenarioSchema.safeParse({
        name: 'IPv6',
        durationMs: 1000,
        intervalMs: 1000,
        deadlineMs: 500,
        flows: [{ name: 'Ping', source: 'a', target: 'fe80::1', protocol: 'icmp', expect: 'allow' }],
        faults: [],
      }).success
    ).toBe(false);
    expect(
      scenarioSchema.safeParse({
        name: 'IPv6',
        durationMs: 1000,
        intervalMs: 1000,
        deadlineMs: 500,
        flows: [
          {
            name: 'DNS',
            source: 'a',
            target: '2001:db8::1',
            protocol: 'dns',
            dns: { name: 'a.test' },
            expect: 'allow',
          },
        ],
        faults: [],
      }).success
    ).toBe(false);
  });
});
