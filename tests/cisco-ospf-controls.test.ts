import { it, expect } from 'vitest';
import { SimulationEngine, TerminalSession, validateSnapshot } from '../packages/simulation-engine/src';
const run = (t: TerminalSession, commands: string[]) => {
  for (const c of commands) expect(t.execute(c), c).not.toMatch(/^%/);
};
it('native passive defaults suppress Hellos while exceptions and reference bandwidth affect real adjacencies', () => {
  const e = new SimulationEngine(),
    a = e.addProfile('router'),
    left = e.addProfile('router'),
    right = e.addProfile('router'),
    t = new TerminalSession(e, a.id);
  for (const [i, b] of [left, right].entries()) {
    Object.assign(b.interfaces[0], { ip: `192.0.${i + 1}.2`, prefix: 30 });
    e.connect({ device: a.id, port: 'p' + i }, { device: b.id, port: 'p0' });
    e.configureOspf(b.id, {
      enabled: true,
      routerId: `${i + 2}.2.2.2`,
      interfaces: [{ port: 'p0', area: 0, networkType: 'point-to-point' }],
    });
  }
  run(t, [
    'en',
    'conf t',
    'interface Gi0/1',
    'ip address 192.0.1.1 255.255.255.252',
    'ip ospf 1 area 0',
    'ip ospf network point-to-point',
    'exit',
    'interface Gi0/2',
    'ip address 192.0.2.1 255.255.255.252',
    'ip ospf 1 area 0',
    'ip ospf network point-to-point',
    'exit',
    'router ospf 1',
    'auto-cost reference-bandwidth 10000',
    'passive-interface default',
    'no passive-interface Gi0/2',
    'end',
  ]);
  e.advanceTo(15000);
  expect(a.ospf?.neighbors.map((n) => n.ip)).toEqual(['192.0.2.2']);
  expect(a.ospf?.interfaces.map((i) => i.cost)).toEqual([10, 10]);
  expect(left.ospf?.neighbors).toEqual([]);
  run(t, ['conf t', 'router ospf 1', 'no passive-interface default', 'end']);
  e.advanceTo(30000);
  expect(a.ospf?.neighbors.filter((n) => n.state === 'Full')).toHaveLength(2);
  validateSnapshot(e.snapshot());
  run(t, ['write memory', 'reload', '']);
  validateSnapshot(e.snapshot());
});
it('native area range emits one aggregate and withdraws it when the source area is lost', () => {
  const e = new SimulationEngine(),
    r = [0, 1, 2].map(() => e.addProfile('router'));
  for (const [a, ap, b, bp, net] of [
    [0, 0, 1, 0, '10.10.250'],
    [1, 1, 2, 0, '192.0.2'],
  ] as const) {
    Object.assign(r[a].interfaces[ap], { ip: net + '.1', prefix: 30 });
    Object.assign(r[b].interfaces[bp], { ip: net + '.2', prefix: 30 });
    e.connect({ device: r[a].id, port: 'p' + ap }, { device: r[b].id, port: 'p' + bp });
  }
  const host = e.addDevice('pc');
  Object.assign(r[0].interfaces[2], { ip: '10.10.1.1', prefix: 24 });
  Object.assign(host.interfaces[0], { ip: '10.10.1.10', prefix: 24 });
  e.connect({ device: r[0].id, port: 'p2' }, { device: host.id, port: 'p0' });
  r.forEach((d, i) =>
    e.configureOspf(d.id, {
      enabled: true,
      routerId: `${i + 1}.1.1.1`,
      interfaces: d.interfaces
        .filter((p) => p.ip)
        .map((p) => ({
          port: p.id,
          area: i === 0 || (i === 1 && p.id === 'p0') ? 10 : 0,
          networkType: 'point-to-point',
          passive: p.id === 'p2',
        })),
    })
  );
  const t = new TerminalSession(e, r[1].id);
  run(t, ['en', 'conf t', 'router ospf 1', 'area 10 range 10.10.0.0 255.255.0.0 cost 25', 'end']);
  e.advanceTo(15000);
  expect(r[2].ospf?.routes).toContainEqual(
    expect.objectContaining({ network: '10.10.0.0', prefix: 16, pathType: 'inter', metric: 26 })
  );
  expect(r[2].ospf?.routes.some((p) => p.network === '10.10.1.0')).toBe(false);
  e.setPort(r[1].id, 'p0', false);
  e.advanceTo(18000);
  expect(r[2].ospf?.routes.some((p) => p.network === '10.10.0.0')).toBe(false);
  validateSnapshot(e.snapshot());
});
it('conditional default origination follows the installed static default route', () => {
  const e = new SimulationEngine(),
    a = e.addProfile('router'),
    b = e.addProfile('router'),
    isp = e.addDevice('pc');
  Object.assign(isp.interfaces[0], { ip: '198.51.100.2', prefix: 30 });
  Object.assign(a.interfaces[1], { ip: '198.51.100.1', prefix: 30 });
  e.connect({ device: a.id, port: 'p1' }, { device: isp.id, port: 'p0' });
  e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
  for (const [i, d] of [a, b].entries()) {
    Object.assign(d.interfaces[0], { ip: `192.0.2.${i + 1}`, prefix: 30 });
    e.configureOspf(d.id, {
      enabled: true,
      routerId: `${i + 1}.1.1.1`,
      interfaces: [{ port: 'p0', area: 0, networkType: 'point-to-point' }],
    });
  }
  const t = new TerminalSession(e, a.id);
  run(t, ['en', 'conf t', 'router ospf 1', 'default-information originate metric 20 metric-type 2', 'end']);
  e.advanceTo(15000);
  expect(b.ospf?.routes.some((p) => p.prefix === 0)).toBe(false);
  run(t, ['conf t', 'ip route 0.0.0.0 0.0.0.0 198.51.100.2', 'end']);
  e.advanceTo(18000);
  expect(b.ospf?.routes).toContainEqual(
    expect.objectContaining({ network: '0.0.0.0', prefix: 0, pathType: 'E2', metric: 20 })
  );
  run(t, ['conf t', 'no ip route 0.0.0.0 0.0.0.0 198.51.100.2', 'end']);
  e.advanceTo(21000);
  expect(b.ospf?.routes.some((p) => p.prefix === 0)).toBe(false);
  validateSnapshot(e.snapshot());
});
