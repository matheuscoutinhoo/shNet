import { describe, expect, it } from 'vitest';
import { SimulationEngine, TerminalSession, validateSnapshot } from '../packages/simulation-engine/src';

const ok = (t: TerminalSession, lines: string[]) => {
  for (const line of lines) expect(t.execute(line), line).not.toMatch(/^%/m);
};

describe('IOS configuration accepted as written by engineers', () => {
  it('trusts DHCP snooping and DAI on EtherChannel members, and applies switchport host', () => {
    const e = new SimulationEngine(),
      sw = e.addDevice('switch'),
      t = new TerminalSession(e, sw.id);
    ok(t, [
      'enable',
      'configure terminal',
      'ip dhcp snooping',
      'ip dhcp snooping vlan 10',
      'vlan 10',
      'interface range Gi0/3 - 4',
      'switchport mode trunk',
      'channel-group 1 mode active',
      'ip dhcp snooping trust',
      'ip arp inspection trust',
      'interface Gi0/5',
      'channel-group 2 mode active',
      'interface Gi0/1',
    ]);
    expect(t.execute('switchport host')).toBe(
      'switchport mode will be set to access\nspanning-tree portfast will be enabled\nchannel group will be disabled'
    );
    // On an EtherChannel member the macro also removes the port from the bundle.
    t.execute('interface Gi0/5');
    t.execute('switchport host');
    t.execute('end');
    const config = t.execute('show running-config');
    expect(config).toMatch(/interface GigabitEthernet0\/3\n(?: .*\n)* ip dhcp snooping trust\n/);
    expect(config).toMatch(
      /interface GigabitEthernet0\/1\n(?: .*\n)* switchport mode access\n(?: .*\n)* spanning-tree portfast\n/
    );
    expect(config).not.toContain('channel-group 2');
    expect(t.execute('show ip dhcp snooping')).toMatch(/^GigabitEthernet0\/3 +yes +yes +unlimited$/m);
    validateSnapshot(e.snapshot());
  });

  it('accepts OSPFv3 on an interface before IPv6 and fair-queue in a policy-map class', () => {
    const e = new SimulationEngine(),
      r = e.addFactoryProfile('router', { x: 0, y: 0 });
    e.setDevicePower(r.id, true);
    const t = new TerminalSession(e, r.id);
    ok(t, [
      'enable',
      'configure terminal',
      'ipv6 unicast-routing',
      'interface g0/1',
      'ipv6 ospf 1 area 0',
      'ipv6 address 2001:db8:1::1/64',
      'exit',
      'policy-map WAN-OUT',
      'class class-default',
      'fair-queue',
      'end',
    ]);
    const config = t.execute('show running-config');
    expect(config).toMatch(/interface GigabitEthernet0\/1\n(?: .*\n)* ipv6 ospf 1 area 0\n/);
    expect(config).toContain('policy-map WAN-OUT\n class class-default\n  fair-queue\n');
    expect(t.execute('show ipv6 ospf interface brief')).toMatch(/^Gi0\/1 +1 +0 /m);
    validateSnapshot(e.snapshot());
  });
});
