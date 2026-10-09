import { it, expect } from 'vitest';
import { SimulationEngine, makeTemplate } from '@shlab/engine';
it('rede com 78 hosts em estrela processa broadcast sem explosão', () => {
  const e = new SimulationEngine();
  const switches = Array.from({ length: 13 }, (_, i) => e.addDevice('switch', { x: i * 100, y: 0 }));
  for (let i = 1; i < 13; i++)
    e.connect({ device: switches[i - 1].id, port: 'p7' }, { device: switches[i].id, port: 'p6' });
  const hosts = [];
  for (let i = 0; i < 78; i++) {
    const h = e.addDevice('pc');
    Object.assign(h.interfaces[0], { ip: '10.1.0.' + (i + 1), prefix: 24 });
    e.connect({ device: h.id, port: 'p0' }, { device: switches[Math.floor(i / 6)].id, port: 'p' + (i % 6) });
    hosts.push(h);
  }
  e.ping(hosts[0].id, hosts.at(-1)!.interfaces[0].ip!);
  const count = e.run();
  expect(e.state.probes[0].status).toBe('success');
  expect(count).toBeLessThan(1000);
  expect(e.state.events.length).toBeLessThanOrEqual(1500);
});
it('seed fixa reproduz perda e jitter', () => {
  const state = makeTemplate('routed');
  state.links[0].loss = 0.2;
  state.links[1].jitter = 3;
  const a = new SimulationEngine(state),
    b = new SimulationEngine(state);
  for (const e of [a, b]) {
    for (let n = 0; n < 5; n++) e.ping(e.state.devices[0].id, '192.168.20.10');
    e.run();
  }
  expect(a.snapshot()).toEqual(b.snapshot());
});
