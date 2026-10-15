import { SimulationEngine } from './core/engine';
import { addProfile } from './devices/profiles';
import { configureModbus } from './protocols/modbus';
import { scenarioSchema, type Scenario } from './scenarios-model';
import type { Snapshot } from './model';

export function dualAccessTemplate(): Snapshot {
  const e = new SimulationEngine();
  const hmi = addProfile(e, 'hmi', { x: 150, y: 270 });
  const plc = addProfile(e, 'plc', { x: 750, y: 270 });
  hmi.hostname = 'HMI-DUAL';
  plc.hostname = 'PLC-DUAL';
  const switches = ['A', 'B'].map((side, i) => {
    const sw = e.addDevice('switch', { x: 450, y: 120 + 300 * i });
    sw.hostname = 'ACCESS-DUAL-' + side;
    return sw;
  });
  e.connect({ device: switches[0].id, port: 'p2' }, { device: switches[1].id, port: 'p2' });
  for (const [i, host] of [hmi, plc].entries()) {
    const spare = e.installNic(host.id);
    for (const [n, port] of ['p0', spare.id].entries())
      e.connect({ device: host.id, port }, { device: switches[n].id, port: 'p' + i });
    Object.assign(host.interfaces[0], { ip: '192.0.2.' + (10 + i), prefix: 24 });
    e.configureBond(host.id, 1, ['p0', spare.id], 'p0', { target: '192.0.2.' + (11 - i) });
  }
  configureModbus(e, plc, { enabled: true, registers: [1234, 65535] });
  for (const [i, side] of ['A', 'B'].entries()) {
    const ups = addProfile(e, 'ups', { x: 100 + i * 700, y: 500 });
    ups.hostname = 'UPS-DUAL-' + side;
    e.setDevicePower(ups.id, true);
    if (ups.infrastructure?.kind !== 'ups') throw new Error('Perfil UPS inválido.');
    e.configureInfrastructure(ups.id, {
      ...ups.infrastructure,
      loads: [hmi, plc, switches[i]].map((d) => ({ device: d.id, watts: 50, requested: true })),
    });
    const rack = addProfile(e, 'rack', { x: 50 + i * 800, y: 90 });
    rack.hostname = 'RACK-DUAL-' + side;
    e.configureInfrastructure(rack.id, {
      kind: 'rack',
      units: 42,
      ambientC: 22,
      ventilation: 1,
      slots: [
        { device: switches[i].id, unit: 1, units: 1 },
        { device: ups.id, unit: 40, units: 2 },
      ],
    });
  }
  e.state.notes =
    'Dois acessos e bonds ativo/backup com monitor ARP de 1 s/timeout de 3 s. HMI e PLC recebem alimentação A/B; cada acesso depende de sua UPS. Perda de rack é ensaiada desligando sua UPS e seu switch: desligar a estrutura de rack não simula incêndio. Perda dos dois acessos ou do próprio endpoint interrompe o fluxo. Não há réplica do processo PLC.';
  return e.snapshot();
}

export function dualAccessScenarios(s: Snapshot): Scenario[] {
  const hmi = s.devices.find((d) => d.hostname === 'HMI-DUAL');
  const plc = s.devices.find((d) => d.hostname === 'PLC-DUAL');
  const address = plc?.interfaces.find((p) => p.bond)?.ip;
  if (!hmi?.interfaces.some((p) => p.bond) || !address) return [];
  const base = {
    warmupMs: 4000,
    durationMs: 10000,
    intervalMs: 1000,
    deadlineMs: 800,
    flows: [
      {
        name: 'HMI → PLC redundante',
        source: hmi.id,
        target: address,
        protocol: 'modbus',
        expect: 'allow',
        requireFinalSuccess: true,
        maxLatencyMs: 800,
        modbus: { transaction: 1, unit: 1, function: 3, address: 0, quantity: 2 },
        expectedRegisters: [1234, 65535],
      },
    ],
  };
  const scenarios = [scenarioSchema.parse({ ...base, name: 'Acesso dual — baseline', faults: [] })];
  for (const side of ['A', 'B']) {
    const sw = s.devices.find((d) => d.hostname === 'ACCESS-DUAL-' + side);
    const ups = s.devices.find((d) => d.hostname === 'UPS-DUAL-' + side);
    if (!sw || !ups) continue;
    scenarios.push(
      scenarioSchema.parse({
        ...base,
        name: 'Perda e retorno do rack ' + side,
        faults: [
          { atMs: 2000, kind: 'device', target: ups.id, up: false },
          { atMs: 2000, kind: 'device', target: sw.id, up: false },
          { atMs: 7000, kind: 'device', target: ups.id, up: true },
          { atMs: 7000, kind: 'device', target: sw.id, up: true },
        ],
      })
    );
  }
  return scenarios;
}
