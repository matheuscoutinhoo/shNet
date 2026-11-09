import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  validateSnapshot,
  type Device,
} from '../packages/simulation-engine/src';

const ok = (t: TerminalSession, lines: string[]) => {
  for (const line of lines) expect(t.execute(line), line).not.toMatch(/^%/m);
};
/** R2 (Loopback0 2.2.2.2) - R1 Gi0/1; R1 Gi0/2 (10.0.1.1) faces a LAN. R2 pings R1's LAN address from 2.2.2.2. */
function lab() {
  const e = new SimulationEngine();
  const [r1, r2] = [0, 1].map((i) => {
    const d = e.addFactoryProfile('router', { x: i * 200, y: 0 });
    e.setDevicePower(d.id, true);
    return d;
  });
  const pc = e.addDevice('pc');
  const port = (d: Device, name: string) => e.device(d.id).interfaces.find((p) => p.name === name)!.id;
  e.connect({ device: r1.id, port: port(r1, 'Gi0/1') }, { device: r2.id, port: port(r2, 'Gi0/1') });
  e.connect({ device: r1.id, port: port(r1, 'Gi0/2') }, { device: pc.id, port: pc.interfaces[0].id });
  const [t1, t2] = [r1, r2].map((d) => {
    const t = new TerminalSession(e, d.id);
    ok(t, ['enable', 'configure terminal']);
    return t;
  });
  ok(t1, [
    'hostname R1',
    'interface g0/1',
    'ip address 10.0.12.1 255.255.255.0',
    'ip verify unicast source reachable-via rx',
    'interface g0/2',
    'ip address 10.0.1.1 255.255.255.0',
    'end',
  ]);
  ok(t2, [
    'hostname R2',
    'interface Loopback0',
    'ip address 2.2.2.2 255.255.255.255',
    'interface g0/1',
    'ip address 10.0.12.2 255.255.255.0',
    'exit',
    'ip route 10.0.1.0 255.255.255.0 10.0.12.1',
    'end',
  ]);
  e.advanceTo(e.state.clock + 3_000, 1_000_000);
  const drops = () => e.device(r1.id).interfaces.find((p) => p.name === 'Gi0/1')!.urpfDrops ?? 0;
  const ping = () =>
    t2
      .execute('ping 10.0.1.1 source Loopback0')
      .split('\n')
      .find((l) => /^[!.U]+$/.test(l));
  return { e, t1, t2, drops, ping };
}

describe('Unicast RPF', () => {
  it('strict mode accepts sources routed back through the arrival interface only', () => {
    const { e, t1, drops, ping } = lab();
    // No route back to 2.2.2.2: every echo is dropped by uRPF.
    expect(ping()).toBe('.....');
    expect(drops()).toBe(5);
    ok(t1, ['configure terminal', 'ip route 2.2.2.2 255.255.255.255 10.0.12.2', 'end']);
    expect(ping()).toBe('!!!!!');
    expect(drops()).toBe(5);
    // The route back now leaves through Gi0/2: strict uRPF drops, loose uRPF accepts.
    ok(t1, [
      'configure terminal',
      'no ip route 2.2.2.2 255.255.255.255 10.0.12.2',
      'ip route 2.2.2.2 255.255.255.255 10.0.1.50',
      'end',
    ]);
    ping();
    expect(drops()).toBe(10);
    ok(t1, ['configure terminal', 'interface g0/1', 'ip verify unicast source reachable-via any', 'end']);
    ping();
    expect(drops()).toBe(10);
    const show = t1.execute('show ip interface g0/1');
    expect(show).toMatch(
      /^GigabitEthernet0\/1 is up, line protocol is up\n {2}Internet address is 10\.0\.12\.1\/24\n/
    );
    expect(show).toContain('  Inbound  access list is not set');
    expect(show).toContain('  Input features: Verify Unicast Reverse-Path, MCI Check');
    expect(show).toContain('  IP verify source reachable-via ANY\n   10 verification drops');
    expect(t1.execute('show running-config')).toContain(' ip verify unicast source reachable-via any\n');
    validateSnapshot(e.snapshot());
  });

  it('counts a default route only with allow-default', () => {
    const { t1, drops, ping } = lab();
    ok(t1, ['configure terminal', 'ip route 0.0.0.0 0.0.0.0 10.0.12.2', 'end']);
    expect(ping()).toBe('.....');
    expect(drops()).toBe(5);
    ok(t1, [
      'configure terminal',
      'interface g0/1',
      'ip verify unicast source reachable-via rx allow-default',
      'end',
    ]);
    expect(ping()).toBe('!!!!!');
    expect(t1.execute('show ip interface g0/1')).toContain(
      'IP verify source reachable-via RX, allow default'
    );
    expect(t1.execute('show ip interface g0/2')).not.toContain('verify');
  });
});
