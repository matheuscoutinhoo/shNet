import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  SimulationRunner,
  applySimulationDelta,
  makeTemplate,
  validateSnapshot,
} from '../packages/simulation-engine/src';
import {
  findDevice,
  findPort,
  findLink,
  linksAt,
} from '../packages/simulation-engine/src/core/topology-index';
describe('Escala e execução isolada', () => {
  it('deltas do Worker preservam determinismo, timers e objetos que não mudaram', () => {
    const source = new SimulationEngine(makeTemplate('lan'));
    source.addDevice('server');
    source.ping(source.state.devices[0].id, '192.168.10.20');
    const snapshot = source.snapshot(),
      reference = new SimulationEngine(snapshot),
      main = new SimulationEngine(snapshot),
      runner = new SimulationRunner(snapshot),
      idle = main.state.devices.at(-1);
    reference.run();
    let count = 0;
    while (runner.engine.state.queue.length && count++ < 100) {
      const delta = structuredClone(runner.step(2, 100));
      applySimulationDelta(main.state, delta);
      validateSnapshot(main.snapshot());
    }
    expect(main.snapshot()).toEqual(reference.snapshot());
    expect(main.state.devices.at(-1)).toBe(idle);
    expect(() => runner.step(1000)).toThrow(/Orçamento/);
  });
  it('índices acompanham substituições, alteração de IDs/portas, endpoints e arrays de snapshot', () => {
    const e = new SimulationEngine(makeTemplate('lan')),
      s = e.state,
      d = s.devices[0],
      p = d.interfaces[0],
      link = s.links[0];
    expect(findDevice(s, d.id)).toBe(d);
    expect(findPort(d, p.id)).toBe(p);
    expect(findLink(s, link.id)).toBe(link);
    expect(linksAt(s, link.a.device, link.a.port)).toContain(link);
    const clone = structuredClone(d);
    s.devices[0] = clone;
    expect(findDevice(s, d.id)).toBe(clone);
    clone.id = 'replacement';
    expect(findDevice(s, d.id)).toBeUndefined();
    expect(findDevice(s, 'replacement')).toBe(clone);
    clone.interfaces[0] = { ...p, id: 'other' };
    expect(findPort(clone, p.id)).toBeUndefined();
    expect(findPort(clone, 'other')?.id).toBe('other');
    const old = { ...link.a };
    link.a = { device: 'replacement', port: 'other' };
    expect(linksAt(s, old.device, old.port)).not.toContain(link);
    expect(linksAt(s, 'replacement', 'other')).toContain(link);
    s.links = [{ ...link, id: 'new-link' }];
    expect(findLink(s, link.id)).toBeUndefined();
    expect(findLink(s, 'new-link')).toBe(s.links[0]);
  });
  it('aceita 2000 equipamentos, limita excesso e restaura a fila grande em ordem', () => {
    const e = new SimulationEngine();
    for (let i = 0; i < 2000; i++) e.addDevice('pc');
    expect(() => e.addDevice('pc')).toThrow(/2000/);
    e.state.probes.push({
      id: 'unused',
      device: e.state.devices[0].id,
      target: '192.0.2.1',
      start: 0,
      status: 'pending',
      ttl: 64,
    });
    for (let i = 0; i < 12000; i++)
      e.schedule((i * 7919) % 10000, { kind: 'probe-timeout', probeId: 'unused' });
    const restored = validateSnapshot(e.snapshot());
    expect(restored.devices).toHaveLength(2000);
    expect(restored.queue).toHaveLength(12000);
    expect(
      restored.queue.every(
        (q, i) =>
          i === 0 ||
          restored.queue[i - 1].at < q.at ||
          (restored.queue[i - 1].at === q.at && restored.queue[i - 1].order < q.order)
      )
    ).toBe(true);
  });
});
