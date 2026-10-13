import type { Snapshot } from './model';
import { scenarioSchema, type Scenario } from './scenarios-model';
export function factoryScenarios(snapshot: Snapshot): Scenario[] {
  const flows = ['A', 'B'].flatMap((cell) => {
    const hmi = snapshot.devices.find((d) => d.hostname === 'HMI-' + cell);
    const plc = snapshot.devices.find((d) => d.hostname === 'PLC-' + cell && d.modbus?.enabled);
    const ip = plc?.interfaces.find((p) => p.ip)?.ip;
    return hmi && plc?.modbus && ip
      ? [
          {
            name: 'HMI-' + cell + ' → PLC-' + cell,
            source: hmi.hostname,
            target: ip,
            protocol: 'modbus',
            expect: 'allow',
            maxLossPercent: 0,
            modbus: {
              transaction: cell === 'A' ? 1 : 2,
              unit: plc.modbus.unit,
              function: 3,
              address: 0,
              quantity: 1,
            },
            expectedRegisters: [plc.modbus.registers[0]],
          },
        ]
      : [];
  });
  if (!flows.length) return [];
  const scada = snapshot.devices.find((d) => d.hostname === 'SCADA');
  if (scada)
    flows.push(
      ...flows.map((flow) => ({
        ...flow,
        name: 'SCADA → ' + flow.name.split(' → ')[1],
        source: scada.hostname,
      }))
    );
  const base = { durationMs: 10000, intervalMs: 1000, deadlineMs: 1000, flows, faults: [] };
  const scenarios: Scenario[] = [scenarioSchema.parse({ ...base, name: 'PLC/HMI — baseline Modbus' })];
  for (const [target, name, loss] of [
    ['FW-A', 'Perda do firewall primário', 50],
    ['DIST-A', 'Perda da distribuição primária', 50],
    ['SW-A', 'Isolamento da célula A', 50],
    ['PLC-A', 'PLC A indisponível', 50],
    ['SCADA', 'SCADA indisponível: HMI local independente', 0],
  ] as const) {
    if (!snapshot.devices.some((d) => d.hostname === target)) continue;
    scenarios.push(
      scenarioSchema.parse({
        ...base,
        name,
        flows: flows.map((f) => ({
          ...f,
          maxLossPercent: target === 'SCADA' && f.source === 'SCADA' ? 50 : loss,
          requireFinalSuccess: true,
        })),
        faults: [
          { atMs: 2000, kind: 'device', target, up: false },
          { atMs: 6000, kind: 'device', target, up: true },
        ],
      })
    );
  }
  const visitor = snapshot.devices.find((d) => d.hostname === 'NOTEBOOK-VISITANTE');
  const mes = snapshot.devices.find((d) => d.hostname === 'MES-DMZ');
  const mesIp = mes?.interfaces.find((p) => p.ip)?.ip;
  if (visitor && mesIp)
    scenarios.push(
      scenarioSchema.parse({
        ...base,
        name: 'Segmentação de visitantes',
        flows: [
          {
            name: 'Visitante → MES bloqueado',
            source: visitor.hostname,
            target: mesIp,
            protocol: 'http',
            expect: 'deny',
          },
          {
            name: 'Visitante → PLC bloqueado',
            source: visitor.hostname,
            target: flows[0].target,
            protocol: 'modbus',
            modbus: flows[0].modbus,
            expect: 'deny',
          },
        ],
      })
    );
  return scenarios;
}
