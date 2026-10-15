import { describe, expect, it } from 'vitest';
import { cloneTopology } from '../apps/web/src/workspace/cloneTopology';
import { ScenarioRunner, industrialProcessScenarios } from '@shlab/engine';
import { configurationDiff, plcProcessConfig } from '@shlab/engine';
import {
  SimulationEngine,
  makeTemplate,
  configureModbus,
  modbusRequest,
  validateSnapshot,
} from '@shlab/engine';
function topology() {
  const e = new SimulationEngine(makeTemplate('dual-access'));
  const plc = e.state.devices.find((d) => d.hostname === 'PLC-DUAL')!;
  const hmi = e.state.devices.find((d) => d.hostname === 'HMI-DUAL')!;
  configureModbus(e, plc, {
    enabled: true,
    registers: [500],
    inputRegisters: [500],
    coils: [false],
    discreteInputs: [false],
  });
  e.configurePlcProcess(plc.id, { enabled: true, initialLevel: 500 });
  e.configureHmiScan(hmi.id, { enabled: true, target: '192.0.2.11' });
  return { e, plc, hmi };
}
describe('Processo PLC e varredura HMI por Modbus TCP', () => {
  it('a evolução do processo, das amostras e do bond não é relatada como mudança de configuração', () => {
    const { e, plc } = topology();
    e.advanceTo(3000, 200000);
    const before = e.snapshot();
    e.advanceTo(5000, 200000);
    expect(configurationDiff(before, e.snapshot())).toEqual([]);
    e.configurePlcProcess(plc.id, { ...plcProcessConfig(plc), fillPerSecond: 130 });
    expect(configurationDiff(before, e.snapshot()).some((c) => c.id === plc.id)).toBe(true);
  });
  it('executa os cinco presets com cargas reais de HMI, SCADA e MES, falhas e assertions de alarme', () => {
    const snapshot = makeTemplate('industrial-process');
    validateSnapshot(snapshot);
    expect(snapshot.devices).toHaveLength(10);
    const scenarios = industrialProcessScenarios(snapshot);
    expect(scenarios).toHaveLength(5);
    for (const scenario of scenarios) {
      const runner = new ScenarioRunner(snapshot, scenario);
      for (let n = 0; n < 3000 && !runner.step(100); n++);
      const report = runner.report();
      expect(
        report.passed,
        JSON.stringify({ name: report.name, flows: report.flows, assertions: report.assertions })
      ).toBe(true);
      validateSnapshot(runner.engine.snapshot());
    }
  });
  it('clona a célula com timers novos e remapeia o destino da HMI para o PLC clonado', () => {
    const { e, hmi } = topology();
    e.advanceTo(3000, 200000);
    const before = e.snapshot();
    const copy = cloneTopology(
      before,
      before.devices.map((d) => d.id)
    );
    const run = new SimulationEngine(copy.snapshot);
    const clonedHmi = run.state.devices.find((d) => d.hmiScan && d.id !== hmi.id)!;
    expect(clonedHmi.hmiScan!.target).not.toBe(hmi.hmiScan!.target);
    run.advanceTo(7000, 200000);
    expect(clonedHmi.hmiScan!.samples).toBeGreaterThan(0);
    expect(clonedHmi.hmiScan!.communicationAlarm).toBe(false);
    validateSnapshot(run.snapshot());
  });
  it('controla o nível por ciclos e transporta amostras binárias sem copiar registradores diretamente para a HMI', () => {
    const { e, plc, hmi } = topology();
    expect(hmi.hmiScan!.values).toEqual([]);
    e.advanceTo(30000, 200000);
    expect(plc.plcProcess!.scans).toBe(300);
    expect(plc.modbus!.inputRegisters![0]).toBeGreaterThanOrEqual(480);
    expect(plc.modbus!.inputRegisters![0]).toBeLessThanOrEqual(520);
    expect(hmi.hmiScan!.samples).toBeGreaterThanOrEqual(25);
    expect(hmi.hmiScan!.missed).toBe(0);
    expect(hmi.hmiScan!.latencyMs).toBeLessThan(800);
    expect(hmi.tcpConnections!.some((c) => c.service === 'modbus' && c.encoding === 'binary')).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('a escrita Modbus de coil controla o atuador manual e muda a leitura do processo', () => {
    const { e, plc, hmi } = topology();
    e.configurePlcProcess(plc.id, { enabled: true, control: 'manual', initialLevel: 400 });
    modbusRequest(e, hmi, '192.0.2.11', { transaction: 222, unit: 1, function: 5, address: 0, values: [1] });
    e.advanceTo(2000, 200000);
    expect(plc.modbus!.coils![0]).toBe(true);
    expect(plc.plcProcess!.lastPump).toBe(true);
    expect(plc.modbus!.inputRegisters![0]).toBeGreaterThan(480);
    expect(hmi.hmiScan!.values[0]).toBeGreaterThan(400);
  });
  it('serviço Modbus parado gera alarme de comunicação enquanto o ciclo PLC continua', () => {
    const { e, plc, hmi } = topology();
    e.advanceTo(3000, 200000);
    const scans = plc.plcProcess!.scans;
    configureModbus(e, plc, { ...plc.modbus!, enabled: false });
    e.advanceTo(6500, 200000);
    expect(plc.power).toBe(true);
    expect(plc.plcProcess!.scans).toBeGreaterThan(scans);
    expect(hmi.hmiScan!.communicationAlarm).toBe(true);
    expect(hmi.hmiScan!.consecutiveMisses).toBeGreaterThanOrEqual(3);
    configureModbus(e, plc, { ...plc.modbus!, enabled: true });
    e.advanceTo(8500, 200000);
    expect(hmi.hmiScan!.communicationAlarm).toBe(false);
    expect(hmi.hmiScan!.consecutiveMisses).toBe(0);
    validateSnapshot(e.snapshot());
  });
  it('a falta de energia para os scans e o bombeamento, mas conserva drenagem física', () => {
    const { e, plc, hmi } = topology();
    e.advanceTo(3000, 200000);
    const scans = plc.plcProcess!.scans,
      level = plc.plcProcess!.levelMilli;
    e.setDevicePower(plc.id, false);
    e.advanceTo(7000, 200000);
    expect(plc.plcProcess!.scans).toBe(scans);
    expect(plc.plcProcess!.levelMilli).toBeLessThan(level);
    expect(plc.plcProcess!.lastPump).toBe(false);
    expect(hmi.hmiScan!.communicationAlarm).toBe(true);
    e.setDevicePower(plc.id, true);
    e.advanceTo(9000, 200000);
    expect(hmi.hmiScan!.communicationAlarm).toBe(false);
    validateSnapshot(e.snapshot());
  });
  it('mantém alarme de processo retido após a condição limpar e exige reconhecimento', () => {
    const { e, plc } = topology();
    e.configurePlcProcess(plc.id, {
      enabled: true,
      control: 'manual',
      initialLevel: 950,
      fillPerSecond: 0,
      drainPerSecond: 100,
    });
    e.advanceTo(100, 200000);
    expect(plc.plcProcess!.alarms.high).toBe(true);
    expect(plc.modbus!.discreteInputs![0]).toBe(true);
    e.advanceTo(2000, 200000);
    expect(plc.plcProcess!.alarms.high).toBe(false);
    expect(plc.plcProcess!.alarms.latched).toBe(true);
    e.acknowledgeProcessAlarm(plc.id);
    expect(plc.plcProcess!.alarms.latched).toBe(false);
    expect(plc.modbus!.discreteInputs![0]).toBe(false);
  });
  it('a HMI alarma pelo valor recebido e o PLC recusa um setpoint fora da faixa de controle', () => {
    const { e, plc, hmi } = topology();
    e.configurePlcProcess(plc.id, { enabled: true, control: 'manual', initialLevel: 950, drainPerSecond: 0 });
    e.configureHmiScan(hmi.id, { enabled: true, target: '192.0.2.11', highAlarm: 900 });
    e.advanceTo(1000, 200000);
    expect(hmi.hmiScan!.values[0]).toBe(950);
    expect(hmi.hmiScan!.processAlarm).toBe(true);
    plc.modbus!.registers[0] = 2000;
    e.configurePlcProcess(plc.id, { enabled: true, control: 'automatic', initialLevel: 500 });
    e.advanceTo(2500, 200000);
    expect(plc.plcProcess!.alarms.invalidSetpoint).toBe(true);
    expect(plc.plcProcess!.lastPump).toBe(false);
    expect(hmi.hmiScan!.processAlarm).toBe(false);
    const before = e.snapshot();
    expect(() =>
      e.configurePlcProcess(plc.id, { enabled: true, lowAlarm: 450, highAlarm: 550, hysteresis: 100 })
    ).toThrow();
    expect(e.snapshot()).toEqual(before);
    const alarm = e.snapshot();
    alarm.devices.find((d) => d.id === hmi.id)!.hmiScan!.communicationAlarm = true;
    expect(() => validateSnapshot(alarm)).toThrow('HMI');
  });
  it('restaura scans e leitura em trânsito deterministicamente e recusa timers e bancos órfãos', () => {
    const { e, plc, hmi } = topology();
    e.advanceTo(100.5, 200000);
    expect(hmi.hmiScan!.pending).toBeDefined();
    const checkpoint = e.snapshot(),
      restored = new SimulationEngine(checkpoint);
    e.advanceTo(10000, 200000);
    restored.advanceTo(10000, 200000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    const invalid = structuredClone(checkpoint);
    invalid.queue = invalid.queue.filter((q) => q.action.kind !== 'plc-process-tick');
    expect(() => validateSnapshot(invalid)).toThrow('Timer PLC');
    const before = e.snapshot();
    expect(() => configureModbus(e, plc, { ...plc.modbus!, inputRegisters: [] })).toThrow('referenciados');
    expect(e.snapshot()).toEqual(before);
  });
  it('a retenção TCP preserva a leitura HMI abortada até o ciclo registrar a falha', () => {
    const { e, hmi } = topology();
    e.advanceTo(5100, 200000);
    const pending = hmi.hmiScan!.pending!.connection;
    e.closeTcp(hmi.id, pending, true);
    for (let n = 0; n < 150; n++) {
      const id = e.openTcp(hmi.id, '192.0.2.11', 7);
      e.closeTcp(hmi.id, id, true);
    }
    expect(hmi.tcpConnections!.some((c) => c.id === pending)).toBe(true);
    validateSnapshot(e.snapshot());
    e.advanceTo(5300, 200000);
    expect(hmi.hmiScan!.pending).toBeUndefined();
    expect(hmi.hmiScan!.missed).toBe(1);
    validateSnapshot(e.snapshot());
  });
});
