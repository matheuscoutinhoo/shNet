import { it, expect } from 'vitest';
import {
  SimulationEngine,
  resolveRoute,
  TerminalSession,
  validateSnapshot,
} from '../packages/simulation-engine/src';
it('installs equal-cost OSPF next hops, hashes flows consistently and removes a failed path', () => {
  const e = new SimulationEngine(),
    routers = [0, 1, 2, 3].map(() => e.addProfile('router'));
  for (const [a, ap, b, bp, n] of [
    [0, 0, 1, 0, 1],
    [0, 1, 2, 0, 2],
    [1, 1, 3, 0, 3],
    [2, 1, 3, 1, 4],
  ]) {
    Object.assign(routers[a].interfaces[ap], { ip: `192.0.${n}.1`, prefix: 30 });
    Object.assign(routers[b].interfaces[bp], { ip: `192.0.${n}.2`, prefix: 30 });
    e.connect({ device: routers[a].id, port: 'p' + ap }, { device: routers[b].id, port: 'p' + bp });
  }
  const host = e.addDevice('pc');
  Object.assign(host.interfaces[0], { ip: '10.100.0.10', prefix: 24 });
  host.gateway = '10.100.0.1';
  Object.assign(routers[3].interfaces[2], { ip: '10.100.0.1', prefix: 24 });
  e.connect({ device: routers[3].id, port: 'p2' }, { device: host.id, port: 'p0' });
  routers.forEach((d, i) =>
    e.configureOspf(d.id, {
      enabled: true,
      routerId: `${i + 1}.${i + 1}.${i + 1}.${i + 1}`,
      interfaces: d.interfaces
        .filter((p) => p.ip)
        .map((p) => ({
          port: p.id,
          area: 0,
          cost: 10,
          networkType: 'point-to-point',
          passive: d === routers[3] && p.id === 'p2',
        })),
    })
  );
  e.advanceTo(15000);
  const routes = routers[0].ospf!.routes.filter((r) => r.network === '10.100.0.0');
  expect(routes.map((r) => r.nextHop).sort()).toEqual(['192.0.1.2', '192.0.2.2']);
  const selected = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const flow = `10.1.0.${i}|10.100.0.10|TCP|12345|443`,
      a = resolveRoute(routers[0], '10.100.0.10', undefined, e.state, new Set(), flow),
      b = resolveRoute(routers[0], '10.100.0.10', undefined, e.state, new Set(), flow);
    expect(a).toEqual(b);
    selected.add(a!.nextHop);
  }
  expect(selected.size).toBe(2);
  const restored = new SimulationEngine(e.snapshot());
  validateSnapshot(restored.snapshot());
  e.setPort(routers[0].id, 'p0', false);
  e.advanceTo(20000);
  expect(routers[0].ospf!.routes.filter((r) => r.network === '10.100.0.0').map((r) => r.nextHop)).toEqual([
    '192.0.2.2',
  ]);
  const t = new TerminalSession(restored, routers[0].id);
  for (const c of ['en', 'conf t', 'router ospf 1', 'maximum-paths 1', 'end'])
    expect(t.execute(c), c).not.toMatch(/^%/);
  restored.advanceTo(30000);
  expect(restored.device(routers[0].id).ospf!.routes.filter((r) => r.network === '10.100.0.0')).toHaveLength(
    1
  );
  validateSnapshot(restored.snapshot());
});
