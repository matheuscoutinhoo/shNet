import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  configureModbus,
  modbusRequest,
  decodeModbus,
  encodeModbusRequest,
  ScenarioRunner,
  preflight,
  wirelessMetrics,
  configurationDiff,
  scenarioSchema,
  factoryScenarios,
} from '../packages/simulation-engine/src';

describe('Transações industriais e cenários', () => {
  it('lê, escreve e restaura holding registers; responde a endereço inválido', () => {
    const e = new SimulationEngine(makeTemplate('routed')),
      pc = e.state.devices.find((d) => d.type === 'pc')!,
      server = e.state.devices.find((d) => d.type === 'server')!;
    configureModbus(e, server, { enabled: true, registers: [10, 20, 30, 40] });
    const read = modbusRequest(e, pc, server.interfaces[0].ip!, {
      transaction: 1,
      unit: 1,
      function: 3,
      address: 0,
      quantity: 2,
    });
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(1000);
    restored.advanceTo(1000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    const response = decodeModbus(pc.tcpConnections!.find((c) => c.id === read)!.received);
    expect(Array.from(response.pdu)).toEqual([3, 4, 0, 10, 0, 20]);
    modbusRequest(e, pc, server.interfaces[0].ip!, {
      transaction: 2,
      unit: 1,
      function: 16,
      address: 1,
      quantity: 2,
      values: [65000, 99],
    });
    e.advanceTo(2000);
    expect(server.modbus?.registers).toEqual([10, 65000, 99, 40]);
    const bad = modbusRequest(e, pc, server.interfaces[0].ip!, {
      transaction: 3,
      unit: 1,
      function: 3,
      address: 4,
      quantity: 1,
    });
    e.advanceTo(3000);
    expect(decodeModbus(pc.tcpConnections!.find((c) => c.id === bad)!.received).exception).toBe(2);
    expect(() =>
      encodeModbusRequest({ transaction: 4, unit: 1, function: 16, address: 0, quantity: 2, values: [1] })
    ).toThrow();
    validateSnapshot(e.snapshot());
  });
  it('executa baseline e falha/restauração com métricas sem alterar a topologia original', () => {
    const e = new SimulationEngine(makeTemplate('lan')),
      before = e.snapshot(),
      source = e.state.devices[0],
      target = e.state.devices.find((d) => d.id !== source.id && d.interfaces.some((p) => p.ip))!;
    const input = {
      name: 'Continuidade',
      durationMs: 4000,
      intervalMs: 1000,
      deadlineMs: 500,
      flows: [
        {
          name: 'Ping',
          source: source.id,
          target: target.interfaces[0].ip!,
          protocol: 'icmp',
          expect: 'allow',
          maxLossPercent: 0,
        },
      ],
      faults: [],
    };
    const baseline = new ScenarioRunner(before, input);
    for (let i = 0; i < 1000 && !baseline.step(100); i++);
    expect(baseline.report().passed).toBe(true);
    const failed = new ScenarioRunner(before, {
      ...input,
      faults: [
        { atMs: 1000, kind: 'device', target: target.id, up: false },
        { atMs: 3000, kind: 'device', target: target.id, up: true },
      ],
    });
    for (let i = 0; i < 1000 && !failed.step(100); i++);
    expect(failed.report().passed).toBe(false);
    expect(failed.report().flows[0].lossPercent).toBe(50);
    expect(failed.report().faults[0].recovery[0].recoveryMs).toBeGreaterThan(2000);
    expect(e.snapshot()).toEqual(before);
  });
  it('valida leitura Modbus periódica, valores esperados e exceções nos cenários salvos', () => {
    const e = new SimulationEngine(makeTemplate('routed'));
    const source = e.state.devices.find((d) => d.type === 'pc')!;
    const plc = e.state.devices.find((d) => d.type === 'server')!;
    configureModbus(e, plc, { enabled: true, registers: [725, 1] });
    const scenario = scenarioSchema.parse({
      name: 'Ciclo Modbus',
      durationMs: 3000,
      intervalMs: 1000,
      deadlineMs: 500,
      flows: [
        {
          name: 'Leitura',
          source: source.id,
          target: plc.interfaces[0].ip,
          protocol: 'modbus',
          expect: 'allow',
          modbus: { transaction: 1, unit: 1, function: 3, address: 0, quantity: 2 },
          expectedRegisters: [725, 1],
        },
      ],
      faults: [],
    });
    e.state.scenarios = [scenario];
    const restored = validateSnapshot(e.snapshot());
    expect(restored.scenarios).toEqual([scenario]);
    const run = new ScenarioRunner(restored, scenario);
    for (let i = 0; i < 1000 && !run.step(100); i++);
    expect(run.report().passed).toBe(true);
    expect(run.report().flows[0].received).toBe(3);
    const bad = new ScenarioRunner(restored, {
      ...scenario,
      flows: [{ ...scenario.flows[0], expectedRegisters: [0, 0] }],
    });
    for (let i = 0; i < 1000 && !bad.step(100); i++);
    expect(bad.report().passed).toBe(false);
    expect(bad.report().samples.every((s) => s.reason === 'Resposta Modbus divergente')).toBe(true);
    expect(() =>
      scenarioSchema.parse({ ...scenario, flows: [{ ...scenario.flows[0], modbus: undefined }] })
    ).toThrow();
  });
  it('oferece e executa os sete cenários nativos da fábrica', () => {
    const snapshot = makeTemplate('factory');
    const presets = factoryScenarios(snapshot);
    expect(presets).toHaveLength(7);
    for (const scenario of presets) {
      const run = new ScenarioRunner(snapshot, scenario);
      for (let i = 0; i < 2000 && !run.step(100); i++);
      expect(run.report().passed, JSON.stringify(run.report().flows)).toBe(true);
      if (scenario.name === 'Isolamento da célula A')
        expect(run.report().flows[0].lossPercent).toBeGreaterThan(0);
    }
  }, 60000);
  it('detecta VLAN nativa diferente e rota física em participante VRRP', () => {
    const e = new SimulationEngine(makeTemplate('vrrp'));
    const virtual = e.state.devices.find((d) => d.vrrp)!;
    const other = e.state.devices.find((d) => d.id !== virtual.id)!;
    other.routes.push({
      network: '198.51.100.0',
      prefix: 24,
      nextHop: virtual.interfaces.find((p) => p.id === virtual.vrrp!.groups[0].port)!.ip!,
      metric: 1,
    });
    expect(preflight(e.state).some((i) => i.code === 'PHYSICAL_HA_NEXT_HOP')).toBe(true);
  });
  it('mantém RF estável ao mover o desenho com posições físicas configuradas', () => {
    const e = new SimulationEngine(makeTemplate('wireless'));
    const link = e.state.links.find((l) => l.cable === 'wireless')!;
    const a = e.device(link.a.device),
      b = e.device(link.b.device);
    a.physicalPosition = { x: 0, y: 0 };
    b.physicalPosition = { x: 10, y: 0 };
    const before = wirelessMetrics(e.state, link);
    b.position = { x: 5000, y: 4000 };
    expect(wirelessMetrics(e.state, link)).toEqual(before);
    e.state.rfObstacles = [
      { name: 'Parede', material: 'metal', a: { x: 5, y: -5 }, b: { x: 5, y: 5 }, lossDb: 15 },
    ];
    expect(wirelessMetrics(e.state, link).rssi).toBe(before.rssi - 15);
    e.state.rfObstacles[0].a.x = 50;
    e.state.rfObstacles[0].b.x = 50;
    expect(wirelessMetrics(e.state, link).rssi).toBe(before.rssi);
  });
  it('diff ignora contadores, porém mostra endereço e configuração STP', () => {
    const e = new SimulationEngine(makeTemplate('lan')),
      before = e.snapshot();
    e.state.devices[0].interfaces[0].rx += 5;
    expect(configurationDiff(before, e.snapshot())).toHaveLength(0);
    e.state.devices[0].interfaces[0].ip = '192.168.10.15';
    expect(configurationDiff(before, e.snapshot()).map((c) => c.name)).toContain(e.state.devices[0].hostname);
    const sw = e.state.devices.find((d) => d.type === 'switch')!;
    e.configureSpanningTree(sw.id, 'rstp', 4096);
    expect(configurationDiff(before, e.snapshot()).map((c) => c.name)).toContain(sw.hostname);
  });
});
