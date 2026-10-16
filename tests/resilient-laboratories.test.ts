import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  ScenarioRunner,
  makeTemplate,
  resilientScenarios,
  templates,
  validateSnapshot,
  scenarioReportSchema,
} from '../packages/simulation-engine/src';

const advance = (e: SimulationEngine, ms: number) => {
  const until = e.state.clock + ms;
  e.advanceTo(until, 500000);
  expect(e.state.clock).toBe(until);
};
function topology() {
  const e = new SimulationEngine(makeTemplate('enterprise-resilient'));
  const find = (name: string) => e.state.devices.find((d) => d.hostname === name)!;
  advance(e, 12000);
  return { e, find, client: find('HA-CLIENT') };
}

describe('Laboratórios de disponibilidade integrada', () => {
  it.each(['enterprise-resilient', 'factory-resilient'] as const)(
    '%s publica contagem correta, duas NICs e alimentação independente para os endpoints',
    (id) => {
      const s = makeTemplate(id);
      validateSnapshot(s);
      expect(s.devices.length).toBe(templates.find((t) => t.id === id)!.devices);
      expect(resilientScenarios(s)).toHaveLength(13);
      const ups = s.devices.filter((d) => d.infrastructure?.kind === 'ups');
      expect(ups).toHaveLength(2);
      for (const d of s.devices.filter((d) => ['server', 'pc'].includes(d.type) && !d.infrastructure)) {
        expect(d.interfaces.find((p) => p.bond)?.bond?.members, d.hostname).toHaveLength(2);
        for (const u of ups)
          expect(
            u.infrastructure?.kind === 'ups' && u.infrastructure.loads.some((l) => l.device === d.id),
            d.hostname
          ).toBe(true);
      }
    }
  );
  it.each(['HA-FW-A', 'HA-WAN-GW-A', 'HA-DC-GW-A'])(
    'mantém a mesma sessão TCP através da perda e retorno de %s',
    (name) => {
      const { e, find, client } = topology();
      const target = name.includes('DC-') ? '10.80.100.10' : '198.51.100.10';
      const id = e.openTcp(client.id, target, 7777, 'before|', false);
      advance(e, 1000);
      const connection = () => client.tcpConnections!.find((c) => c.id === id)!;
      expect(connection().received).toBe('before|');
      e.setDevicePower(find(name).id, false);
      advance(e, 5000);
      e.writeTcp(client.id, id, 'after|');
      advance(e, 1000);
      expect(connection().received).toBe('before|after|');
      e.setDevicePower(find(name).id, true);
      advance(e, 5000);
      e.writeTcp(client.id, id, 'return|');
      advance(e, 1000);
      expect(connection().received).toBe('before|after|return|');
      validateSnapshot(e.snapshot());
    },
    60000
  );
  it('DHCP usa relay alternativo, preserva lease em T2 após fencing e sincroniza o retorno', () => {
    const { e, find } = topology();
    const client = find('HA-DHCP-CLIENT'),
      bond = client.interfaces.find((p) => p.bond)!;
    e.requestDhcp(client.id, bond.id);
    advance(e, 3000);
    const leased = bond.ip;
    expect(bond.dhcp?.status).toBe('bound');
    expect(leased).toMatch(/^10\.70\.10\.2\d\d$/);
    e.setDevicePower(find('HA-FW-A').id, false);
    e.promoteDhcpHa(find('HA-DHCP-B').id);
    advance(e, 16000);
    expect(bond.dhcp?.status).toBe('bound');
    expect(bond.ip).toBe(leased);
    expect(bond.dhcp?.lease?.server).toBe('10.70.30.68');
    e.setDevicePower(find('HA-DHCP-A').id, true);
    advance(e, 2000);
    const a = find('HA-DHCP-A'),
      b = find('HA-DHCP-B');
    expect(a.dhcpHa!.role).toBe('standby');
    expect(a.dhcpServer!.bindings).toEqual(b.dhcpServer!.bindings);
    validateSnapshot(e.snapshot());
  }, 60000);
  it('restaura deterministicamente a recuperação do core e não inventa caminho com as duas vias desligadas', () => {
    const { e, find, client } = topology();
    e.setDevicePower(find('HA-CORE-A').id, false);
    const restored = new SimulationEngine(e.snapshot());
    advance(e, 5000);
    advance(restored, 5000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    e.setDevicePower(find('HA-CORE-B').id, false);
    const id = e.httpGet(client.id, '198.51.100.10');
    advance(e, 1000);
    expect(client.tcpConnections!.find((c) => c.id === id)!.received).toBe('');
    validateSnapshot(e.snapshot());
  }, 60000);
});

describe('Sucesso final em ensaios de bloqueio', () => {
  it.each([false, true])('conserva a exigência de evidência de política com interrupção=%s', (cut) => {
    const e = new SimulationEngine(makeTemplate('routed'));
    const client = e.state.devices.find((d) => d.type === 'pc')!;
    const router = e.state.devices.find((d) => d.type === 'router')!;
    const server = e.state.devices.find((d) => d.type === 'server')!;
    e.configureFirewall(router.id, { enabled: true, trustedPorts: ['p1'], protocols: ['TCP'] });
    if (cut) e.setDevicePower(router.id, false);
    const runner = new ScenarioRunner(e.snapshot(), {
      name: 'Bloqueio com última amostra',
      durationMs: 2000,
      intervalMs: 1000,
      deadlineMs: 500,
      flows: [
        {
          name: 'Negado',
          source: client.id,
          target: server.interfaces[0].ip!,
          protocol: 'http',
          expect: 'deny',
          denyEvidence: 'policy',
          requireFinalSuccess: true,
        },
      ],
      faults: [],
    });
    for (let n = 0; n < 1000 && !runner.step(100); n++);
    const report = scenarioReportSchema.parse(runner.report());
    expect(report.passed).toBe(!cut);
    expect(report.samples.every((s) => s.evidence?.cause === 'policy')).toBe(!cut);
    if (!cut) {
      const historical = structuredClone(report);
      historical.engineContract = '2026.10.15.8';
      historical.passed = historical.flows[0].passed = false;
      expect(() => scenarioReportSchema.parse(historical)).not.toThrow();
      const forged = structuredClone(report);
      forged.samples.at(-1)!.evidence!.cause = 'timeout';
      expect(() => scenarioReportSchema.parse(forged)).toThrow();
    }
  });
});
