import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  ScenarioRunner,
  SimulationRunner,
  makeTemplate,
  applyConfigurationPatch,
  configurationDiff,
  scenarioReportSchema,
  scenarioSchema,
  validateSnapshot,
  layoutTopology,
  groupDevices,
  applySimulationDelta,
  preflight,
} from '../packages/simulation-engine/src';
import { SnapshotHistory } from '../apps/web/src/workspace/snapshot-history';
import { duplicateDevice } from '../apps/web/src/workspace/duplicateDevice';
import { scenarioEvidence } from '../packages/simulation-engine/src/scenario-evidence';
import { normalizeBulkConfiguration } from '../apps/web/src/workspace/configuration-bulk';
const complete = (runner: ScenarioRunner, slice = 100) => {
  for (let i = 0; i < 20000 && !runner.step(slice); i++);
  return scenarioReportSchema.parse(runner.report());
};
const definition = {
  name: 'Patch e reversão',
  durationMs: 4000,
  intervalMs: 1000,
  deadlineMs: 500,
  flows: [
    {
      name: 'Ping',
      source: 'PC-A',
      target: '192.168.10.20',
      protocol: 'icmp',
      expect: 'allow',
      maxLossPercent: 100,
    },
  ],
  faults: [],
};
describe('Confiabilidade e operação da aplicação', () => {
  it('normaliza formatos anteriores e novos em um único lote e rejeita aliases repetidos', () => {
    const e = new SimulationEngine(makeTemplate('lan')),
      sw = e.state.devices.find((d) => d.type === 'switch')!;
    const patch = normalizeBulkConfiguration(
      [
        { hostname: sw.hostname, port: 'p0', description: 'Primeira' },
        { device: sw.id, ports: [{ port: 'p1', description: 'Segunda', accessVlan: 1 }] },
      ],
      e.snapshot()
    );
    expect(patch).toHaveLength(1);
    expect(patch[0].ports).toHaveLength(2);
    applyConfigurationPatch(e, patch);
    validateSnapshot(e.snapshot());
    expect(() =>
      normalizeBulkConfiguration(
        [
          { hostname: sw.hostname, port: 'p0', description: 'a' },
          { device: sw.id, ports: [{ port: 'p0', description: 'b' }] },
        ],
        e.snapshot()
      )
    ).toThrow('Interface repetida');
    expect(() =>
      normalizeBulkConfiguration([{ hostname: sw.hostname, port: 'p0', injected: true }], e.snapshot())
    ).toThrow();
  });
  it('valida o lote inteiro antes de alterar o motor e reverte somente campos explícitos', () => {
    const e = new SimulationEngine(makeTemplate('lan')),
      host = e.state.devices.find((d) => d.type === 'pc')!;
    const before = e.snapshot();
    expect(() =>
      applyConfigurationPatch(e, [
        { device: host.id, ports: [{ port: 'p0', ip: '192.168.10.99', prefix: 24 }] },
        { device: 'inexistente', routes: [] },
      ])
    ).toThrow();
    expect(e.snapshot()).toEqual(before);
    const { rollback } = applyConfigurationPatch(e, [
      {
        device: host.hostname,
        ports: [{ port: 'p0', ip: '192.168.10.99', prefix: 24, description: 'Revisado' }],
        routes: [{ network: '203.0.113.0', prefix: 24, nextHop: '192.168.10.1', metric: 5 }],
      },
    ]);
    validateSnapshot(e.snapshot());
    e.advanceTo(2000);
    applyConfigurationPatch(e, rollback);
    expect(e.state.clock).toBe(2000);
    expect(configurationDiff(before, e.snapshot())).toEqual([]);
  });
  it('patch/rollback agendados conservam relógio e produzem os mesmos resultados em fatias distintas', () => {
    const snapshot = makeTemplate('lan'),
      host = snapshot.devices.find((d) => d.interfaces.some((p) => p.ip === '192.168.10.20'))!;
    const scenario = {
      ...definition,
      flows: [{ ...definition.flows[0], source: snapshot.devices.find((d) => d.type === 'pc')!.id }],
      actions: [
        {
          kind: 'configure',
          checkpoint: 'maintenance',
          atMs: 1000,
          changes: [{ device: host.id, ports: [{ port: 'p0', adminUp: false }] }],
        },
        { kind: 'rollback', checkpoint: 'maintenance', atMs: 3000 },
      ],
    };
    const a = new ScenarioRunner(snapshot, scenario),
      b = new ScenarioRunner(snapshot, scenario),
      report = complete(a);
    expect(complete(b, 1)).toEqual(report);
    expect(b.engine.snapshot()).toEqual(a.engine.snapshot());
    expect(report.samples.map((s) => s.status)).toEqual(['success', 'failed', 'failed', 'success']);
    expect(report.actions!.map((a) => a.epoch)).toEqual([0, 0]);
    expect(report.actions![0].snapshotHash).toBe(report.actions![1].configurationHash);
    expect(report.actions!.every((a) => a.beforeClock === a.afterClock)).toBe(true);
    const tampered = structuredClone(report);
    tampered.actions![1].configurationHash = '0'.repeat(64);
    expect(scenarioReportSchema.safeParse(tampered).success).toBe(false);
  });
  it('rejeita reversão sem proposta e campos de configuração fora da ação correspondente', () => {
    for (const actions of [
      [{ kind: 'rollback', checkpoint: 'a', atMs: 1000 }],
      [{ kind: 'configure', checkpoint: 'a', atMs: 1000 }],
      [{ kind: 'checkpoint', checkpoint: 'a', atMs: 1000, changes: [{ device: 'a', routes: [] }] }],
    ])
      expect(scenarioSchema.safeParse({ ...definition, actions }).success).toBe(false);
  });
  it.each(['dhcp', 'bgp'] as const)(
    'checkpoint/restore conserva %s em andamento sob falha e retomada',
    (template) => {
      const e = new SimulationEngine(makeTemplate(template)),
        host = e.state.devices.find((d) => d.type === 'pc')!;
      const service = e.state.devices.find((d) => (template === 'dhcp' ? d.dhcpServer : d.bgp))!;
      if (template === 'dhcp') e.requestDhcp(host.id, 'p0');
      const scenario = {
        ...definition,
        flows: [
          { ...definition.flows[0], source: host.id, target: service.interfaces.find((p) => p.ip)!.ip! },
        ],
        actions: [
          { kind: 'checkpoint', checkpoint: 'pending', atMs: 0 },
          { kind: 'restore', checkpoint: 'pending', atMs: 2500 },
        ],
        faults: [
          { kind: 'device', target: service.id, up: false, atMs: 500 },
          { kind: 'device', target: service.id, up: true, atMs: 2000 },
        ],
      };
      const a = new ScenarioRunner(e.snapshot(), scenario),
        b = new ScenarioRunner(e.snapshot(), scenario),
        report = complete(a);
      expect(complete(b, 1)).toEqual(report);
      expect(a.engine.snapshot()).toEqual(b.engine.snapshot());
      expect(report.actions!.map((a) => a.epoch)).toEqual([0, 1]);
      validateSnapshot(a.engine.snapshot());
      const restored = new SimulationEngine(a.engine.snapshot()),
        next = a.engine.state.clock + 1000;
      restored.advanceTo(next);
      a.engine.advanceTo(next);
      expect(restored.snapshot()).toEqual(a.engine.snapshot());
    }
  );
  it('revisão distingue rotas sem interface e regras IPv4/IPv6 totalmente cobertas', () => {
    const e = new SimulationEngine(),
      router = e.addDevice('router');
    Object.assign(router.interfaces[0], { ip: '192.0.2.1', prefix: 24 });
    router.routes = [{ network: '203.0.113.0', prefix: 24, nextHop: '198.51.100.1', metric: 1 }];
    e.configureAcl(router.id, {
      name: 'edge',
      rules: [
        {
          sequence: 10,
          action: 'permit',
          protocol: 'ip',
          source: { network: '0.0.0.0', prefix: 0 },
          destination: { network: '0.0.0.0', prefix: 0 },
        },
        {
          sequence: 20,
          action: 'deny',
          protocol: 'tcp',
          source: { network: '192.0.2.0', prefix: 24 },
          destination: { network: '203.0.113.0', prefix: 24 },
          destinationPort: 80,
        },
      ],
    });
    e.configureIpv6(router.id, 'p0', {
      auto: false,
      addresses: [{ ip: '2001:db8:1::1', prefix: 64 }],
      aclOut: [
        {
          action: 'permit',
          kind: 'any',
          source: '::',
          sourcePrefix: 0,
          destination: '::',
          destinationPrefix: 0,
        },
        {
          action: 'deny',
          kind: 'tcp',
          source: '2001:db8:1::',
          sourcePrefix: 64,
          destination: '2001:db8:2::',
          destinationPrefix: 64,
        },
      ],
    });
    const offLink = { network: '2001:db8:2::', prefix: 64, nextHop: '2001:db8:3::1', port: 'p0', metric: 1 };
    expect(() => e.configureRoute6(router.id, offLink)).toThrow();
    router.routes6 = [offLink];
    const codes = preflight(e.snapshot()).map((p) => p.code);
    expect(codes).toContain('ROUTE_UNRESOLVED_NEXT_HOP');
    expect(codes).toContain('ROUTE6_OFF_LINK_NEXT_HOP');
    expect(codes).toContain('ACL_SHADOWED_RULE');
    expect(codes).toContain('ACL6_SHADOWED_RULE');
  });
  it('histórico respeita orçamento de bytes e preserva redo se um checkpoint excessivo falhar', () => {
    const a = makeTemplate('lan'),
      b = structuredClone(a),
      size = new TextEncoder().encode(JSON.stringify(a)).length;
    b.notes = 'b';
    const history = new SnapshotHistory(30, size * 2 + 10);
    for (let i = 0; i < 40; i++) history.checkpoint(a);
    expect(history.bytes).toBeLessThanOrEqual(size * 2 + 10);
    expect(history.restore('undo', b)).toEqual(a);
    expect(history.canRedo).toBe(true);
    expect(() => history.checkpoint({ ...a, notes: 'x'.repeat(size * 3) })).toThrow();
    expect(history.canRedo).toBe(true);
    expect(history.restore('redo', a)).toEqual(b);
  });
  it('organização é determinística e preserva grupos e posição dos rádios sem coordenadas físicas', () => {
    const e = new SimulationEngine(makeTemplate('factory')),
      group = groupDevices(
        e,
        e.state.devices.slice(0, 2).map((d) => d.id)
      );
    const radio = e.state.devices.find((d) => d.wireless)!;
    delete radio.physicalPosition;
    const before = e.snapshot(),
      after = layoutTopology(before);
    expect(layoutTopology(before)).toEqual(after);
    expect(e.snapshot()).toEqual(before);
    for (const id of [...group.members!, radio.id])
      expect(after.snapshot.devices.find((d) => d.id === id)!.position).toEqual(
        before.devices.find((d) => d.id === id)!.position
      );
    expect(after.moved).toBeGreaterThan(0);
    validateSnapshot(after.snapshot);
  });
  it('clones de VTEP e firewall HA não carregam identidade operacional inválida', () => {
    const e = new SimulationEngine(makeTemplate('enterprise-datacenter'));
    const original = e.state.devices.find((d) => d.hostname === 'LEAF-1')!,
      firewall = e.state.devices.find((d) => d.stateSync)!;
    duplicateDevice(e, original);
    const clone = duplicateDevice(e, firewall).device;
    expect(clone.stateSync).toBeUndefined();
    expect(firewall.stateSync).toBeDefined();
    validateSnapshot(e.snapshot());
  });
  it('fatias realtime incompletas mantêm deltas idênticos ao motor sem reexecutar convergência', () => {
    const e = new SimulationEngine(makeTemplate('enterprise-datacenter'));
    e.advanceTo(35000, 200000);
    const r = new SimulationRunner(e.snapshot()),
      main = new SimulationEngine(e.snapshot()),
      reference = new SimulationEngine(e.snapshot()),
      target = e.state.clock + 1500;
    reference.advanceTo(target, 200000);
    for (
      let i = 0;
      i < 20000 && (r.engine.state.clock < target || (r.engine.state.queue[0]?.at ?? Infinity) <= target);
      i++
    )
      applySimulationDelta(main.state, structuredClone(r.advanceUntil(target, 1)));
    expect(main.snapshot()).toEqual(reference.snapshot());
    expect(r.engine.snapshot()).toEqual(reference.snapshot());
  }, 60000);
  it('overlay correlaciona quadros internos e evidencia retenção sem atribuir tráfego estranho', () => {
    const e = new SimulationEngine(makeTemplate('enterprise-datacenter'));
    e.advanceTo(35000, 200000);
    const host = e.state.devices.find((d) => d.hostname === 'TENANT-A-CLIENT')!,
      at = e.state.clock;
    const id = e.ping(host.id, '10.80.100.11');
    e.advanceTo(at + 500, 200000);
    const flow = scenarioSchema.parse({
      ...definition,
      flows: [{ ...definition.flows[0], source: host.id, target: '10.80.100.11' }],
    }).flows[0];
    const evidence = scenarioEvidence(e, e.device(host.id), flow, id, at, at + 500, true);
    expect(evidence.path).toContain('SPINE-1');
    expect(evidence.path).toContain('LEAF-2');
    expect(evidence.path).not.toContain('USER-PC');
    if (e.state.capture) e.state.capture.dropped++;
    expect(scenarioEvidence(e, e.device(host.id), flow, id, at, at + 500, true).truncated).toBe(true);
  }, 60000);
  it('correlaciona frontend/LB/backend sem confundir health checks ou uma requisição permitida', () => {
    const e = new SimulationEngine(),
      client = e.addDevice('pc'),
      lb = e.addDevice('server'),
      backend = e.addDevice('server'),
      sw = e.addDevice('switch'),
      router = e.addDevice('router');
    Object.assign(client.interfaces[0], { ip: '10.1.0.10', prefix: 24 });
    client.gateway = '10.1.0.1';
    Object.assign(lb.interfaces[0], { ip: '10.1.0.20', prefix: 24 });
    lb.gateway = '10.1.0.1';
    Object.assign(backend.interfaces[0], { ip: '10.2.0.30', prefix: 24 });
    backend.gateway = '10.2.0.1';
    Object.assign(router.interfaces[0], { ip: '10.1.0.1', prefix: 24 });
    Object.assign(router.interfaces[1], { ip: '10.2.0.1', prefix: 24 });
    for (const [i, d] of [client, lb, router].entries())
      e.connect({ device: d.id, port: 'p0' }, { device: sw.id, port: 'p' + i });
    e.connect({ device: router.id, port: 'p1' }, { device: backend.id, port: 'p0' });
    e.configureAcl(router.id, {
      name: 'backend',
      rules: [
        {
          sequence: 10,
          action: 'deny',
          protocol: 'tcp',
          source: { network: '0.0.0.0', prefix: 0 },
          destination: { network: '0.0.0.0', prefix: 0 },
          destinationPort: 80,
        },
        {
          sequence: 20,
          action: 'permit',
          protocol: 'ip',
          source: { network: '0.0.0.0', prefix: 0 },
          destination: { network: '0.0.0.0', prefix: 0 },
        },
      ],
    });
    router.interfaces[1].aclOut = 'backend';
    e.configureTcpService(backend.id, { port: 8080, kind: 'http', enabled: true, body: 'Permitido' });
    e.configureProxy(lb.id, {
      enabled: true,
      port: 80,
      kind: 'load-balancer',
      algorithm: 'round-robin',
      backends: [{ address: '10.2.0.30', port: 80 }],
      allowedNetworks: [],
      healthIntervalMs: 1000,
    });
    const report = complete(
      new ScenarioRunner(e.snapshot(), {
        ...definition,
        durationMs: 1000,
        flows: [
          {
            name: 'Backend negado',
            source: client.id,
            target: '10.1.0.20',
            protocol: 'http',
            expect: 'deny',
            denyEvidence: 'policy',
          },
          {
            name: 'Direto permitido',
            source: client.id,
            target: '10.2.0.30',
            port: 8080,
            protocol: 'http',
            expect: 'allow',
          },
        ],
      })
    );
    expect(report.passed, JSON.stringify(report.samples)).toBe(true);
    const denied = report.samples.find((s) => s.flow === 'Backend negado')!;
    expect(
      denied.evidence!.events.some((event) => event.type === 'ACL_DENY' && event.device === router.hostname)
    ).toBe(true);
    expect(denied.evidence!.path).toContain(lb.hostname);
    expect(report.samples.find((s) => s.flow === 'Direto permitido')!.evidence).toBeUndefined();
  });
});
