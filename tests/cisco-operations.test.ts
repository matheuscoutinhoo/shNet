import { it, expect } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  resolveRoute,
  validateSnapshot,
} from '../packages/simulation-engine/src';
const run = (t: TerminalSession, lines: string[]) => {
  for (const line of lines) expect(t.execute(line), line).not.toMatch(/^%/);
};
it('IP SLA observes actual ICMP, drives HSRP priority and withdraws a tracked static route', () => {
  const e = new SimulationEngine(),
    r = e.addProfile('router'),
    target = e.addDevice('pc'),
    sw = e.addDevice('switch'),
    t = new TerminalSession(e, r.id);
  e.configureSpanningTree(sw.id, 'off');
  Object.assign(target.interfaces[0], { ip: '192.0.2.2', prefix: 24 });
  e.connect({ device: r.id, port: 'p0' }, { device: sw.id, port: 'p0' });
  e.connect({ device: sw.id, port: 'p1' }, { device: target.id, port: 'p0' });
  run(t, [
    'en',
    'conf t',
    'interface Gi0/1',
    'ip address 192.0.2.1 255.255.255.0',
    'standby 10 ip 192.0.2.254',
    'standby 10 priority 120',
    'standby 10 track 10 decrement 30',
    'exit',
    'ip sla 10',
    'icmp-echo 192.0.2.2 source-interface Gi0/1',
    'timeout 500',
    'frequency 1',
    'exit',
    'ip sla schedule 10 life forever start-time now',
    'track 10 ip sla 10 reachability',
    'ip route 198.51.100.0 255.255.255.0 192.0.2.2 track 10',
    'end',
  ]);
  e.advanceTo(3000);
  expect(r.monitoring?.tracks[0].state).toBe(true);
  expect(r.hsrp?.groups[0].effectivePriority).toBe(120);
  expect(resolveRoute(r, '198.51.100.10')).toBeDefined();
  e.setDevicePower(target.id, false);
  e.advanceTo(6000);
  expect(r.monitoring?.tracks[0].state).toBe(false);
  expect(r.hsrp?.groups[0].effectivePriority).toBe(90);
  expect(resolveRoute(r, '198.51.100.10')).toBeUndefined();
  e.setDevicePower(target.id, true);
  e.advanceTo(9000);
  expect(r.monitoring?.tracks[0].state).toBe(true);
  expect(resolveRoute(r, '198.51.100.10')).toBeDefined();
  validateSnapshot(e.snapshot());
  run(t, ['write memory', 'reload', '', 'en']);
  e.advanceTo(12000);
  expect(e.device(r.id).monitoring?.tracks[0].state).toBe(true);
  validateSnapshot(e.snapshot());
});
it('archive records configuration revisions and operational displays use live model counters', () => {
  const e = new SimulationEngine(),
    d = e.addProfile('router'),
    t = new TerminalSession(e, d.id);
  run(t, [
    'en',
    'conf t',
    'clock timezone BRT -3',
    'archive',
    'path flash:/configs',
    'maximum 2',
    'write-memory',
    'exit',
    'end',
    'write memory',
  ]);
  expect(d.iosSystem?.archive?.copies).toHaveLength(1);
  run(t, ['conf t', 'hostname BRANCH', 'end', 'archive config']);
  expect(d.iosSystem?.archive?.copies[1].configuration).toContain('hostname BRANCH');
  run(t, ['archive config']);
  expect(d.iosSystem?.archive?.copies).toHaveLength(2);
  d.interfaces[0].errors = 7;
  expect(t.execute('show interfaces counters errors')).toContain('Gi0/1 0 0 7');
  expect(t.execute('show inventory')).toContain(d.id);
  expect(t.execute('show clock')).toContain('BRT');
  expect(t.execute('show ip cef')).toContain('Virtual forwarding table');
  validateSnapshot(e.snapshot());
});
it('native NTP server activates real synchronization rather than storing a command string', () => {
  const e = new SimulationEngine(),
    d = e.addProfile('router'),
    server = e.addProfile('ntp'),
    t = new TerminalSession(e, d.id);
  Object.assign(d.interfaces[0], { ip: '192.0.2.1', prefix: 24 });
  Object.assign(server.interfaces[0], { ip: '192.0.2.2', prefix: 24 });
  e.connect({ device: d.id, port: 'p0' }, { device: server.id, port: 'p0' });
  e.configureClock(d.id, { offsetMs: 1000, server: false, stratum: 1 });
  run(t, ['en', 'conf t', 'ntp server 192.0.2.2', 'end']);
  e.advanceTo(3000);
  expect(d.ntp?.synchronized).toBe(true);
  expect(Math.abs(d.networkClock!.offsetMs)).toBeLessThan(1);
  run(t, ['write memory', 'reload', '', 'en']);
  expect(e.device(d.id).ntp?.servers).toEqual(['192.0.2.2']);
  validateSnapshot(e.snapshot());
});
