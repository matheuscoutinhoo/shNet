import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  evaluateChallenge,
  evaluateTutorial,
  validateChallenge,
  type ChallengeDefinition,
} from '../packages/simulation-engine/src';
describe('Aprendizagem com evidência de rede nova', () => {
  it('pondera objetivos e não usa um ping antigo como evidência', () => {
    const e = new SimulationEngine(makeTemplate('lan')),
      [a, b] = e.state.devices.filter((d) => d.type === 'pc');
    e.ping(a.id, b.interfaces[0].ip!);
    e.advanceTo(1000);
    const definition: ChallengeDefinition = {
      schemaVersion: 1,
      name: 'Conectividade',
      description: 'Repare a LAN.',
      objectives: [
        {
          id: 'pcs',
          label: 'Dois PCs',
          hint: '',
          weight: 1,
          predicate: { kind: 'devices', type: 'pc', minimum: 2 },
        },
        {
          id: 'ping',
          label: 'Ping',
          hint: '',
          weight: 3,
          predicate: { kind: 'ping', device: a.id, target: b.interfaces[0].ip!, expect: 'success' },
        },
      ],
    };
    expect(evaluateChallenge(definition, e.snapshot()).score).toBe(100);
    e.state.links[0].up = false;
    const snapshot = e.snapshot();
    const result = evaluateChallenge(definition, snapshot);
    expect(result.score).toBe(25);
    expect(result.complete).toBe(false);
    expect(e.snapshot()).toEqual(snapshot);
  });
  it('confirma TCP/HTTP e valida referências e vocabulário limitado', () => {
    const e = new SimulationEngine(makeTemplate('lan')),
      [a, b] = e.state.devices.filter((d) => d.type === 'pc');
    e.configureTcpService(b.id, { port: 7, kind: 'echo', enabled: true });
    const definition = {
      schemaVersion: 1,
      name: 'TCP',
      description: 'Transmita dados.',
      objectives: [
        {
          id: 'echo',
          label: 'Echo TCP',
          hint: '',
          weight: 1,
          predicate: {
            kind: 'tcp-echo',
            device: a.id,
            target: b.interfaces[0].ip!,
            destinationPort: 7,
            text: 'Olá rede!',
          },
        },
      ],
    };
    expect(evaluateChallenge(definition, e.snapshot()).complete).toBe(true);
    expect(() =>
      validateChallenge(
        {
          ...definition,
          objectives: [{ ...definition.objectives[0], predicate: { kind: 'script', code: 'return true' } }],
        },
        e.snapshot()
      )
    ).toThrow();
    expect(() =>
      validateChallenge(
        {
          ...definition,
          objectives: [
            {
              ...definition.objectives[0],
              predicate: { ...definition.objectives[0].predicate, device: 'ausente' },
            },
          ],
        },
        e.snapshot()
      )
    ).toThrow('inexistente');
  });
  it('tutorial verifica todas as etapas anteriores e o serviço final', () => {
    const e = new SimulationEngine(makeTemplate('lan')),
      target = e.state.devices.filter((d) => d.type === 'pc')[1];
    expect(evaluateTutorial(makeTemplate('empty'), 0).complete).toBe(false);
    expect(evaluateTutorial(e.snapshot(), 3).complete).toBe(true);
    expect(evaluateTutorial(e.snapshot(), 4).complete).toBe(false);
    e.configureTcpService(target.id, { port: 7, kind: 'echo', enabled: true });
    expect(evaluateTutorial(e.snapshot(), 4).complete).toBe(true);
    e.state.links[0].up = false;
    expect(evaluateTutorial(e.snapshot(), 4).complete).toBe(false);
  });
  it('avalia transporte IPv6 e DHCPv6 preservando a configuração', () => {
    const e = new SimulationEngine(makeTemplate('ipv6-services')),
      client = e.state.devices.find((d) => d.type === 'pc')!;
    const target = e.state.devices
      .find((d) => d.type === 'server')!
      .interfaces[0].ipv6!.addresses.find((a) => a.origin === 'static')!.ip;
    const definition = {
      schemaVersion: 1,
      name: 'IPv6',
      description: 'Verifique o transporte IPv6.',
      objectives: [{ id: 'ping6', label: 'ICMPv6', predicate: { kind: 'ping', device: client.id, target } }],
    };
    expect(evaluateChallenge(definition, e.snapshot()).complete).toBe(true);
  });
});
