import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  importIosConfig,
  validateSnapshot,
} from '../packages/simulation-engine/src';

const CONFIG = `Building configuration...

Current configuration : 1200 bytes
!
version 15.9
service timestamps debug datetime msec
!
hostname BR-RTR-01
!
interface GigabitEthernet0/1
 description LAN
 ip address 10.1.1.1 255.255.255.0
 no shutdown
!
interface GigabitEthernet0/0/0
 description WAN ISR4K
!
interface Loopback0
 ip address 1.1.1.1 255.255.255.255
!
router ospf 1
 router-id 1.1.1.1
 network 10.1.1.0 0.0.0.255 area 0
!
ip route 0.0.0.0 0.0.0.0 10.1.1.254
call-home
write memory
!
line vty 0 4
 login local
 transport input ssh
!
end`;

describe('Importing a real IOS configuration', () => {
  it('boots from the text and reports applied, ignored and rejected lines', () => {
    const e = new SimulationEngine(),
      r = e.addDevice('router');
    const report = importIosConfig(e, r.id, CONFIG);
    expect(report.hostname).toBe('BR-RTR-01');
    const lineOf = (text: string) => CONFIG.split('\n').findIndex((l) => l === text) + 1;
    expect(report.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ number: lineOf('interface GigabitEthernet0/0/0') }),
        expect.objectContaining({ number: lineOf('call-home'), line: 'call-home' }),
      ])
    );
    expect(report.ignored).toEqual([
      expect.objectContaining({ number: lineOf('write memory'), line: 'write memory' }),
    ]);
    expect(report.lines).toBe(
      CONFIG.split('\n').filter(
        (l) => l.trim() && !l.startsWith('!') && !/^(version|end|Building|Current configuration)/.test(l)
      ).length
    );
    expect(report.applied).toBe(report.lines - report.rejected.length - report.ignored.length);
    expect(report.applied).toBeGreaterThan(10);
    const t = new TerminalSession(e, r.id);
    t.execute('enable');
    const running = t.execute('show running-config');
    expect(running).toMatch(
      /interface GigabitEthernet0\/1\n description LAN\n ip address 10\.1\.1\.1 255\.255\.255\.0/
    );
    expect(running).toContain('router ospf 1\n router-id 1.1.1.1\n network 10.1.1.0 0.0.0.255 area 0');
    expect(running).toContain('ip route 0.0.0.0 0.0.0.0 10.1.1.254');
    expect(running).toMatch(/line vty 0 4\n login local\n transport input ssh/);
    // NVRAM holds the imported configuration: reload does not ask to save.
    t.execute('reload');
    expect(t.prompt).toBe('Proceed with reload? [confirm]');
    validateSnapshot(e.snapshot());
  });

  it('reports interfaces missing from the simulated hardware and their sub-commands', () => {
    const e = new SimulationEngine(),
      r = e.addFactoryProfile('router', { x: 0, y: 0 });
    e.setDevicePower(r.id, true);
    const report = importIosConfig(
      e,
      r.id,
      'version 15.9\n!\nhostname BR-R2\n!\ninterface GigabitEthernet0/0/0\n description ISR4K\n!\nntp server 10.0.0.9\nwrite memory\nend'
    );
    expect(report).toMatchObject({ hostname: 'BR-R2', lines: 5, applied: 2 });
    expect(report.ignored.map((i) => i.number)).toEqual([9]);
    expect(report.rejected.map((i) => i.number)).toEqual([5, 6]);
  });

  it('replaces the previous configuration and refuses devices without IOS', () => {
    const e = new SimulationEngine(),
      r = e.addDevice('router'),
      pc = e.addDevice('pc');
    const t = new TerminalSession(e, r.id);
    for (const line of ['enable', 'configure terminal', 'ip route 192.0.2.0 255.255.255.0 Null0', 'end'])
      t.execute(line);
    importIosConfig(e, r.id, 'hostname EDGE\n!\nend');
    const after = new TerminalSession(e, r.id);
    after.execute('enable');
    expect(after.execute('show running-config')).not.toContain('192.0.2.0');
    expect(e.device(r.id).hostname).toBe('EDGE');
    expect(() => importIosConfig(e, pc.id, 'hostname X')).toThrow();
    expect(() => importIosConfig(e, r.id, '!\n\n')).toThrow();
  });
});
