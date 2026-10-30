import { describe, expect, it } from 'vitest';
import { SimulationEngine, TerminalSession, validateSnapshot } from '../packages/simulation-engine/src';
import { DHCP_LIMITS, LIMITS } from '../packages/simulation-engine/src/model';

const run = (t: TerminalSession, lines: string[]) => {
  for (const line of lines) expect(t.execute(line), line).not.toMatch(/^%/);
};
function router(e: SimulationEngine, x = 0) {
  const r = e.addFactoryProfile('router', { x, y: 0 });
  e.setDevicePower(r.id, true);
  const t = new TerminalSession(e, r.id);
  run(t, ['enable', 'configure terminal']);
  return { r: e.device(r.id), t };
}

describe('scale limits for enterprise labs', () => {
  it('a central DHCP server holds more than 16 relayed scopes', () => {
    const e = new SimulationEngine();
    const { r, t } = router(e);
    run(t, ['interface Gi0/1', 'ip address 10.255.0.1 255.255.255.0', 'exit']);
    for (let n = 1; n <= 40; n++) run(t, [`ip dhcp pool SITE${n}`, `network 10.${n}.10.0 255.255.255.0`]);
    expect(e.device(r.id).dhcpServer!.pools).toHaveLength(40);
    expect(DHCP_LIMITS.pools).toBeGreaterThanOrEqual(64);
    validateSnapshot(e.snapshot());
  });

  it('factory routers have eight ports: six copper and two SFP', () => {
    const { r } = router(new SimulationEngine());
    expect(r.interfaces.map((p) => p.media)).toEqual([
      'rj45',
      'rj45',
      'rj45',
      'rj45',
      'rj45',
      'rj45',
      'sfp',
      'sfp',
    ]);
    expect(r.interfaces.map((p) => p.name)).toEqual([
      'Gi0/1',
      'Gi0/2',
      'Gi0/3',
      'Gi0/4',
      'Gi0/5',
      'Gi0/6',
      'Gi0/7',
      'Gi0/8',
    ]);
  });

  it('loopbacks accept any mask; OSPF advertises them as host routes unless point-to-point', () => {
    const e = new SimulationEngine();
    const a = router(e),
      b = router(e, 200);
    e.connect({ device: a.r.id, port: 'p0' }, { device: b.r.id, port: 'p0' });
    run(a.t, [
      'interface Gi0/1',
      'ip address 10.0.12.1 255.255.255.252',
      'interface Loopback0',
      'ip address 172.16.1.1 255.255.255.0',
      'interface Loopback1',
      'ip address 172.16.2.1 255.255.255.0',
      'ip ospf network point-to-point',
      'router ospf 1',
      'network 0.0.0.0 255.255.255.255 area 0',
      'end',
    ]);
    run(b.t, [
      'interface Gi0/1',
      'ip address 10.0.12.2 255.255.255.252',
      'router ospf 1',
      'network 0.0.0.0 255.255.255.255 area 0',
      'end',
    ]);
    e.advanceTo(80000, 2_000_000);
    const routes = e.device(b.r.id).ospf!.routes.map((r) => r.network + '/' + r.prefix);
    expect(routes).toContain('172.16.1.1/32');
    expect(routes).toContain('172.16.2.0/24');
    expect(a.t.execute('show ip route')).toMatch(/^C\s+172\.16\.1\.0\/24 is directly connected, Loopback0$/m);
    validateSnapshot(e.snapshot());
  });

  it('keeps more events and in-flight pings', () => {
    expect(LIMITS.events).toBeGreaterThanOrEqual(5000);
    expect(LIMITS.probes).toBeGreaterThanOrEqual(1000);
  });
});
