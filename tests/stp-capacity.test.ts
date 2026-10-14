import { expect, it } from 'vitest';
import { SimulationEngine, validateSnapshot, makeTemplate } from '@shlab/engine';
import { updateSpanningTreePort } from '../packages/simulation-engine/src/protocols/stp';
it('reaprende o caminho após outra mudança dentro de tcWhile, sem esperar expiração MAC', () => {
  const e = new SimulationEngine(makeTemplate('rstp')),
    source = e.state.devices.find((d) => d.hostname === 'PC-01')!,
    access = e.state.devices.find((d) => d.hostname === 'SW-03')!;
  const ping = () => {
    const id = e.ping(source.id, '192.168.10.20');
    let steps = 0;
    while (e.state.probes.find((p) => p.id === id)?.status === 'pending' && steps++ < 64) e.step();
    expect(e.state.probes.find((p) => p.id === id)?.status).toBe('success');
  };
  ping();
  expect(access.spanningTree!.changeUntil).toBeGreaterThan(e.state.clock);
  e.setPort(access.id, 'p1', false);
  ping();
  expect(e.state.clock).toBeLessThan(1000);
  expect(() => validateSnapshot(e.snapshot())).not.toThrow();
});

it('coalesce rajadas BPDU, transmite informação atual e preserva o timer no restore', () => {
  const e = new SimulationEngine(),
    sw = e.addDevice('switch'),
    host = e.addDevice('pc');
  e.connect({ device: sw.id, port: 'p0' }, { device: host.id, port: 'p0' });
  e.configureSpanningTree(sw.id, 'rstp');
  for (let i = 0; i < 20; i++) updateSpanningTreePort(e, sw, sw.interfaces[0]);
  expect(e.state.events.filter((v) => v.type === 'BPDU_SENT')).toHaveLength(6);
  expect(e.state.queue.filter((q) => q.action.kind === 'stp-transmit')).toHaveLength(1);
  sw.spanningTree!.priority = 4096;
  updateSpanningTreePort(e, sw, sw.interfaces[0]);
  const snapshot = e.snapshot(),
    restored = new SimulationEngine(snapshot);
  const bad = structuredClone(snapshot);
  bad.queue = bad.queue.filter((q) => q.action.kind !== 'stp-transmit');
  expect(() => validateSnapshot(bad)).toThrow('Transmissão STP');
  e.advanceTo(1200);
  restored.advanceTo(1200);
  expect(restored.snapshot()).toEqual(e.snapshot());
  const transmitted = e.state.events.filter((v) => v.type === 'BPDU_SENT');
  expect(transmitted).toHaveLength(7);
  expect(transmitted.at(-1)!.frame!.bpdu!.root.priority).toBe(4096);
});

it('mais de 64 bridges convergem sem multiplicar ondas de mudança de topologia', () => {
  const e = new SimulationEngine(),
    switches = Array.from({ length: 70 }, () => e.addDevice('switch'));
  for (let i = 1; i < switches.length; i++) {
    const parent = switches[Math.floor((i - 1) / 2)];
    e.connect({ device: switches[i].id, port: 'p0' }, { device: parent.id, port: i % 2 ? 'p1' : 'p2' });
  }
  for (const [i, d] of switches.entries()) e.configureSpanningTree(d.id, 'rstp', i ? 32768 : 0);
  const processed = e.advanceTo(6000, 30000);
  expect(processed).toBeLessThan(30000);
  expect(switches.every((d) => d.spanningTree!.root.mac === switches[0].interfaces[0].mac)).toBe(true);
  expect(e.state.queue.length).toBeLessThan(1000);
  expect(() => validateSnapshot(e.snapshot())).not.toThrow();
}, 30000);
