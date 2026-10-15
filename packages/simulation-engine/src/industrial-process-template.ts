import { SimulationEngine } from './core/engine';
import { dualAccessTemplate } from './dual-access-template';
import { configureModbus } from './protocols/modbus';
import type { Snapshot } from './model';
import { scenarioSchema, type Scenario } from './scenarios-model';
export function industrialProcessTemplate(): Snapshot {
  const e = new SimulationEngine(dualAccessTemplate());
  const plc = e.state.devices.find((d) => d.hostname === 'PLC-DUAL')!;
  const hmi = e.state.devices.find((d) => d.hostname === 'HMI-DUAL')!;
  plc.hostname = 'PLC-PROCESS';
  hmi.hostname = 'HMI-PROCESS';
  configureModbus(e, plc, {
    enabled: true,
    registers: [500],
    inputRegisters: [300],
    coils: [false],
    discreteInputs: [false],
  });
  e.configurePlcProcess(plc.id, { enabled: true, initialLevel: 300, fillPerSecond: 120, drainPerSecond: 30 });
  const clients = [hmi];
  for (const [i, name] of ['SCADA-PROCESS', 'MES-PROCESS'].entries()) {
    const client = e.addDevice('server', { x: 180 + i * 500, y: 660 });
    client.hostname = name;
    const spare = e.installNic(client.id);
    Object.assign(client.interfaces[0], { ip: '192.0.2.' + (12 + i), prefix: 24 });
    for (const [n, port] of ['p0', spare.id].entries()) {
      const sw = e.state.devices.find((d) => d.hostname === 'ACCESS-DUAL-' + (n ? 'B' : 'A'))!;
      e.connect({ device: client.id, port }, { device: sw.id, port: 'p' + (3 + i) });
    }
    e.configureBond(client.id, 1, ['p0', spare.id], 'p0', { target: '192.0.2.11' });
    clients.push(client);
    for (const ups of e.state.devices.filter((d) => d.infrastructure?.kind === 'ups'))
      if (ups.infrastructure?.kind === 'ups')
        e.configureInfrastructure(ups.id, {
          ...ups.infrastructure,
          loads: [...ups.infrastructure.loads, { device: client.id, watts: 50, requested: true }],
        });
  }
  for (const [i, client] of clients.entries())
    e.configureHmiScan(client.id, {
      enabled: true,
      target: '192.0.2.11',
      intervalMs: i === 2 ? 2000 : 1000,
      deadlineMs: 800,
      missedBeforeAlarm: i === 2 ? 2 : 3,
      lowAlarm: 100,
      highAlarm: 900,
    });
  e.state.notes =
    'Tanque simplificado, nível 0–1000. PLC: scan 100 ms, holding 0=setpoint, input 0=nível, coil 0=bomba, discrete 0=alarme retido. HMI/SCADA leem a cada 1 s; MES a cada 2 s, por Modbus TCP binário, deadline 800 ms. Bombear para ao desligar o PLC; a drenagem continua nos limites de resolução do scan. Rede e alimentação A/B não replicam o PLC. Não executa ladder, firmware, segurança funcional ou física certificada.';
  return e.snapshot();
}
export function industrialProcessScenarios(s: Snapshot): Scenario[] {
  const plc = s.devices.find((d) => d.hostname === 'PLC-PROCESS' && d.plcProcess);
  const clients = s.devices.filter((d) => /^(HMI|SCADA|MES)-PROCESS$/.test(d.hostname) && d.hmiScan);
  if (!plc || clients.length !== 3) return [];
  const flows = clients.map((d) => ({
    name: d.hostname + ' → sensor',
    source: d.id,
    target: '192.0.2.11',
    protocol: 'modbus',
    expect: 'allow',
    maxLossPercent: 0,
    requireFinalSuccess: true,
    modbus: { transaction: 1, unit: 1, function: 4, address: 0, quantity: 1 },
  }));
  const base = { warmupMs: 5000, durationMs: 14000, intervalMs: 1000, deadlineMs: 800, flows };
  const baseline = clients.map((d) => ({
    name: d.hostname + ' comunicando',
    atMs: 12000,
    kind: 'hmi-alarm',
    target: d.id,
    alarm: 'communication',
    expected: false,
  }));
  const scenarios = [
    scenarioSchema.parse({
      ...base,
      name: 'Processo PLC/HMI/SCADA/MES — baseline',
      faults: [],
      assertions: baseline,
    }),
  ];
  for (const kind of ['device', 'service'] as const)
    scenarios.push(
      scenarioSchema.parse({
        ...base,
        name:
          kind === 'device'
            ? 'Processo — desligamento e retorno do PLC'
            : 'Processo — falha só do serviço Modbus',
        flows: flows.map((f) => ({ ...f, maxLossPercent: 50 })),
        faults: [false, true].map((up) => ({
          atMs: up ? 8000 : 2000,
          kind,
          target: plc.id,
          up,
          ...(kind === 'service' ? { service: 'modbus' } : {}),
        })),
        assertions: [
          ...clients.map((d) => ({
            name: d.hostname + ' detecta falha',
            atMs: 6000,
            kind: 'hmi-alarm',
            target: d.id,
            alarm: 'communication',
            expected: true,
          })),
          ...baseline,
        ],
      })
    );
  const access = s.devices.find((d) => d.hostname === 'ACCESS-DUAL-A');
  if (access)
    scenarios.push(
      scenarioSchema.parse({
        ...base,
        name: 'Processo — perda do acesso A',
        faults: [{ atMs: 2000, kind: 'device', target: access.id, up: false }],
        assertions: baseline,
      })
    );
  scenarios.push(
    scenarioSchema.parse({
      ...base,
      name: 'Processo — MES altera setpoint pela rede',
      faults: [],
      flows: [
        ...flows,
        {
          name: 'MES → setpoint',
          source: clients.find((d) => d.hostname === 'MES-PROCESS')!.id,
          target: '192.0.2.11',
          protocol: 'modbus',
          expect: 'allow',
          modbus: { transaction: 2, unit: 1, function: 6, address: 0, values: [300] },
        },
      ],
      assertions: [
        ...baseline,
        {
          name: 'Setpoint recebido',
          atMs: 12000,
          kind: 'modbus',
          target: plc.id,
          bank: 'registers',
          address: 0,
          expected: 300,
        },
      ],
    })
  );
  return scenarios;
}
