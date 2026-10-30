import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  makeTemplate,
  validateSnapshot,
  exportPcap,
  decodePcap,
} from '../packages/simulation-engine/src';
const run = (t: TerminalSession, lines: string[]) => {
  for (const line of lines) expect(t.execute(line), line).not.toMatch(/^%/);
};
describe('native BGP policy and transport authentication', () => {
  it('peer-group changes preserve member overrides and native startup inheritance', () => {
    const e = new SimulationEngine(),
      d = e.addProfile('router'),
      t = new TerminalSession(e, d.id);
    run(t, [
      'en',
      'conf t',
      'interface Gi0/1',
      'ip address 192.0.2.1 255.255.255.0',
      'exit',
      'router bgp 65001',
      'neighbor WAN peer-group',
      'neighbor WAN remote-as 65002',
      'neighbor WAN password group-key',
      'neighbor WAN maximum-prefix 30',
      'neighbor 192.0.2.2 peer-group WAN',
      'neighbor 192.0.2.3 peer-group WAN',
      'neighbor 192.0.2.2 maximum-prefix 10',
      'neighbor WAN maximum-prefix 50',
      'end',
    ]);
    expect(d.bgp?.neighbors.map((n) => n.maximumPrefix)).toEqual([10, 50]);
    expect(t.execute('show running-config')).toContain('neighbor WAN password 0 group-key');
    run(t, [
      'write memory',
      'reload',
      '',
      'en',
      'conf t',
      'router bgp 65001',
      'neighbor WAN maximum-prefix 60',
      'end',
    ]);
    expect(e.device(d.id).bgp?.neighbors.map((n) => n.maximumPrefix)).toEqual([10, 60]);
    validateSnapshot(e.snapshot());
  });
  it('applies native prefix-list/route-map local preference to real learned routes', () => {
    const e = new SimulationEngine(makeTemplate('bgp')),
      [a] = e.state.devices,
      t = new TerminalSession(e, a.id);
    run(t, [
      'en',
      'conf t',
      'ip prefix-list DC seq 10 permit 192.168.20.0/24',
      'route-map PREFER permit 10',
      'match ip address prefix-list DC',
      'set local-preference 200',
      'exit',
      'router bgp 65001',
      'neighbor 10.0.12.2 route-map PREFER in',
      'end',
    ]);
    e.advanceTo(20000);
    expect(a.bgp?.routes.find((r) => r.network === '192.168.20.0')?.nextHop).toBe('10.0.12.2');
    validateSnapshot(e.snapshot());
    run(t, ['write memory', 'reload', '', 'en']);
    e.advanceTo(40000);
    expect(e.device(a.id).bgp?.routes.find((r) => r.network === '192.168.20.0')?.nextHop).toBe('10.0.12.2');
  });
  it('peer groups inherit remote AS and maximum-prefix shuts down the offending peer', () => {
    const e = new SimulationEngine(makeTemplate('bgp')),
      [a, , c] = e.state.devices,
      t = new TerminalSession(e, a.id);
    run(t, [
      'en',
      'conf t',
      'router bgp 65001',
      'neighbor DIRECT peer-group',
      'neighbor DIRECT remote-as 65003',
      'neighbor 10.0.13.3 peer-group DIRECT',
      'neighbor 10.0.13.3 maximum-prefix 1',
      'end',
    ]);
    Object.assign(c.interfaces[3], { ip: '10.99.0.1', prefix: 24 });
    const ccli = new TerminalSession(e, c.id);
    run(ccli, ['en', 'conf t', 'router bgp 65003', 'network 10.99.0.0 mask 255.255.255.0', 'end']);
    e.advanceTo(20000);
    const peer = a.bgp?.peers.find((p) => p.ip === '10.0.13.3');
    expect(peer?.maximumPrefixExceeded).toBe(true);
    expect(peer?.state).toBe('Idle');
    expect(a.bgp?.rib.some((p) => p.peer === '10.0.13.3')).toBe(false);
    validateSnapshot(e.snapshot());
  });
  it.each([true, false])('TCP MD5 permits matching keys: %s', (matching) => {
    const e = new SimulationEngine(),
      a = e.addProfile('router'),
      b = e.addProfile('router');
    for (const [i, d] of [a, b].entries()) {
      const t = new TerminalSession(e, d.id);
      run(t, [
        'en',
        'conf t',
        'interface Gi0/1',
        `ip address 192.0.2.${i + 1} 255.255.255.0`,
        'exit',
        `router bgp ${65001 + i}`,
        `bgp router-id ${i + 1}.${i + 1}.${i + 1}.${i + 1}`,
        `neighbor 192.0.2.${i ? 1 : 2} remote-as ${i ? 65001 : 65002}`,
        `neighbor 192.0.2.${i ? 1 : 2} password ${i && !matching ? 'different' : 'shared-secret'}`,
        'end',
      ]);
      expect(t.history.join('\n')).not.toContain('shared-secret');
    }
    e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
    e.advanceTo(12000);
    expect(a.bgp?.peers[0].state === 'Established').toBe(matching);
    expect(b.bgp?.peers[0].state === 'Established').toBe(matching);
    validateSnapshot(e.snapshot());
    const capture = exportPcap(e.snapshot());
    expect(capture.excluded).toEqual([]);
    expect(
      decodePcap(capture.bytes).some((p) =>
        p.frame.transport?.options?.some((o) => o.kind === 19 && o.data.length === 16)
      )
    ).toBe(true);
  });
});
