import { describe, it, expect } from 'vitest';
import {
  ScenarioRunner,
  factoryScenarios,
  makeTemplate,
  scenarioSchema,
  scenarioReportSchema,
  validateSnapshot,
} from '../packages/simulation-engine/src';
const run = (snapshot: ReturnType<typeof makeTemplate>, input: unknown) => {
  const runner = new ScenarioRunner(snapshot, input);
  for (let i = 0; i < 3000 && !runner.step(100); i++);
  const report = runner.report();
  scenarioReportSchema.parse(report);
  return { runner, report };
};
describe('Cobertura e assertions do executor industrial', () => {
  it('associa bloqueio ao pacote do ensaio sem atribuir a falha ao fluxo autorizado', () => {
    const snapshot = makeTemplate('factory');
    const { report } = run(snapshot, {
      name: 'Correlação',
      durationMs: 2000,
      intervalMs: 1000,
      deadlineMs: 500,
      flows: [
        {
          name: 'PLC bloqueado',
          source: 'PC-ERP',
          target: '10.20.40.10',
          protocol: 'modbus',
          modbus: { transaction: 1, unit: 1, function: 3, address: 0 },
          expect: 'deny',
        },
        { name: 'MES permitido', source: 'PC-ERP', target: '10.20.20.10', protocol: 'http', expect: 'allow' },
      ],
      faults: [],
    });
    expect(report.passed).toBe(true);
    expect(
      report.samples
        .filter((s) => s.flow === 'PLC bloqueado')
        .every(
          (s) =>
            s.evidence?.cause === 'policy' &&
            s.evidence.events.some((e) => e.type === 'FIREWALL_DENY' || e.type === 'ACL_DENY')
        ),
      JSON.stringify(report.samples)
    ).toBe(true);
    expect(
      report.samples
        .filter((s) => s.flow === 'MES permitido')
        .every((s) => s.status === 'success' && !s.evidence)
    ).toBe(true);
  });
  it.each(['dns', 'dhcp', 'mqtt', 'snmp', 'ntp', 'syslog'] as const)(
    'executa %s sem alterar origem e valida persistência do estado resultante',
    (protocol) => {
      const snapshot = makeTemplate('factory'),
        before = structuredClone(snapshot);
      const scenario = factoryScenarios(snapshot).find((s) => s.flows[0].protocol === protocol)!;
      const { runner, report } = run(snapshot, scenario);
      expect(report.passed, JSON.stringify(report.samples)).toBe(true);
      expect(report.samples.every((s) => s.responseReceived && s.elapsedMs !== undefined)).toBe(true);
      expect(snapshot).toEqual(before);
      validateSnapshot(runner.engine.snapshot());
    },
    60000
  );
  it.each(['dns', 'snmp', 'ntp'] as const)(
    'não aprova deny ao receber resposta %s divergente',
    (protocol) => {
      const snapshot = makeTemplate('factory');
      if (protocol === 'ntp')
        snapshot.devices.find((d) => d.hostname === 'NTP-MGMT')!.networkClock!.offsetMs = 500;
      const scenario = factoryScenarios(snapshot).find((s) => s.flows[0].protocol === protocol)!;
      if (protocol === 'dns') scenario.flows[0].dns!.expectedAnswers = ['192.0.2.111'];
      if (protocol === 'snmp')
        scenario.flows[0].snmp!.expectedVarbinds![0] = {
          oid: '1.3.6.1.2.1.1.5.0',
          type: 'OctetString',
          value: 'Errado',
        };
      scenario.flows[0].expect = 'deny';
      const { report } = run(snapshot, scenario);
      expect(report.passed).toBe(false);
      expect(report.samples.every((s) => s.status === 'failed' && s.responseReceived)).toBe(true);
    }
  );
  it('rejeita sobreposição, parâmetros cruzados, serviços/portas ausentes e aliases do mesmo equipamento', () => {
    const snapshot = makeTemplate('factory');
    const scenario = factoryScenarios(snapshot).find((s) => s.flows[0].protocol === 'mqtt')!;
    expect(() => scenarioSchema.parse({ ...scenario, intervalMs: 100, deadlineMs: 1000 })).toThrow(
      'sobreposição'
    );
    expect(() =>
      scenarioSchema.parse({
        ...scenario,
        flows: [{ ...scenario.flows[0], dns: { name: 'mes.fabrica.test' } }],
      })
    ).toThrow();
    expect(
      () =>
        new ScenarioRunner(snapshot, {
          ...scenario,
          faults: [{ atMs: 0, kind: 'port', target: 'SENSOR-A', port: 'inexistente', up: false }],
        })
    ).toThrow('Porta inexistente');
    expect(
      () =>
        new ScenarioRunner(snapshot, {
          ...scenario,
          faults: [{ atMs: 0, kind: 'service', target: 'SENSOR-A', service: 'dns', up: false }],
        })
    ).toThrow('Serviço ausente');
    expect(
      () =>
        new ScenarioRunner(snapshot, {
          ...scenario,
          flows: [
            scenario.flows[0],
            {
              ...scenario.flows[0],
              name: 'Alias',
              source: snapshot.devices.find((d) => d.hostname === 'SENSOR-A')!.id,
              mqtt: { operation: 'connect' },
            },
          ],
        })
    ).toThrow('mesmo equipamento');
  });
  it('falha de porta isola e restaura um endpoint; métricas não podem ocultar perda', () => {
    const snapshot = makeTemplate('lan'),
      source = snapshot.devices.find((d) => d.interfaces.some((p) => p.ip))!,
      target = snapshot.devices.find((d) => d.id !== source.id && d.interfaces.some((p) => p.ip))!;
    const { report } = run(snapshot, {
      name: 'Porta',
      durationMs: 4000,
      intervalMs: 1000,
      deadlineMs: 500,
      flows: [
        {
          name: 'Ping',
          source: source.id,
          target: target.interfaces.find((p) => p.ip)!.ip,
          protocol: 'icmp',
          expect: 'allow',
          requireFinalSuccess: true,
          maxLossPercent: 50,
        },
      ],
      faults: [
        { atMs: 1000, kind: 'port', target: target.id, port: target.interfaces[0].id, up: false },
        { atMs: 3000, kind: 'port', target: target.id, port: target.interfaces[0].id, up: true },
      ],
    });
    expect(report.passed).toBe(true);
    expect(report.flows[0].lossPercent).toBe(50);
    expect(() =>
      scenarioReportSchema.parse({ ...report, flows: [{ ...report.flows[0], lossPercent: 0 }] })
    ).toThrow();
    expect(() =>
      scenarioReportSchema.parse({ ...report, flows: [{ ...report.flows[0], p95Ms: 999 }] })
    ).toThrow();
    expect(() => scenarioReportSchema.parse({ ...report, samples: report.samples.slice(1) })).toThrow();
  });
});
