import { describe, expect, it } from 'vitest';
import { SimulationEngine, TerminalSession, validateSnapshot } from '../packages/simulation-engine/src';
import { resolveRoute } from '../packages/simulation-engine/src/protocols/ipv4';

function fixture(profile = 'router') {
  const e = new SimulationEngine(),
    d = e.addProfile(profile),
    cli = new TerminalSession(e, d.id);
  return { e, id: d.id, cli };
}
function run(cli: TerminalSession, commands: string[]) {
  for (const command of commands) expect(cli.execute(command), command).not.toMatch(/^%/);
}
describe('Cisco CLI behavior', () => {
  it('preserves initial offline provisioning and uses startup semantics on subsequent power cycles', () => {
    const e = new SimulationEngine(),
      d = e.addFactoryProfile('switch-l2'),
      name = d.hostname;
    Object.assign(d.interfaces[0], { description: 'offline provisioning' });
    e.setDevicePower(d.id, true);
    expect(e.device(d.id).hostname).toBe(name);
    expect(e.device(d.id).interfaces[0].description).toBe('offline provisioning');
    e.setDevicePower(d.id, false);
    e.setDevicePower(d.id, true);
    expect(e.device(d.id).hostname).toBe('Switch');
    expect(e.device(d.id).interfaces[0].description).toBe('');
    const erased = e.addFactoryProfile('router'),
      cli = new TerminalSession(e, erased.id);
    run(cli, ['en', 'erase startup-config']);
    e.setDevicePower(erased.id, true);
    expect(e.device(erased.id).hostname).toBe('Router');
    validateSnapshot(e.snapshot());
  });
  it('bounds cyclic recursive graphs and prefers resolved connected next hops', () => {
    const { e, id } = fixture(),
      d = e.device(id),
      peer = e.addDevice('pc');
    Object.assign(d.interfaces[0], { ip: '10.0.0.1', prefix: 24 });
    e.connect({ device: id, port: 'p0' }, { device: peer.id, port: 'p0' });
    d.routes = Array.from({ length: 64 }, (_, i) => ({
      network: '10.0.0.0',
      prefix: 8,
      nextHop: '10.0.0.' + (i + 2),
      metric: 1,
    }));
    d.routes.unshift({ network: '203.0.113.0', prefix: 24, nextHop: '10.0.0.2', metric: 1 });
    expect(resolveRoute(d, '203.0.113.10', undefined, e.state)).toMatchObject({
      port: { id: 'p0' },
      nextHop: '10.0.0.2',
    });
    Object.assign(d.interfaces[0], { ip: '192.0.2.1', prefix: 24 });
    d.routes.push({ network: '203.0.113.0', prefix: 24, nextHop: '192.0.2.2', distance: 200, metric: 1 });
    expect(resolveRoute(d, '203.0.113.10', undefined, e.state)).toMatchObject({
      port: { id: 'p0' },
      nextHop: '192.0.2.2',
    });
  });
  it('persists exit-interface routes and empty trunk VLAN lists without changing forwarding', () => {
    const { e, id, cli } = fixture(),
      peer = e.addDevice('pc');
    e.connect({ device: id, port: 'p0' }, { device: peer.id, port: 'p0' });
    run(cli, [
      'en',
      'conf t',
      'interface Gi0/1',
      'ip address 192.0.2.1 255.255.255.0',
      'exit',
      'ip route 203.0.113.0 255.255.255.0 Gi0/1 200',
      'end',
      'write memory',
      'reload',
      '',
      'en',
    ]);
    const d = e.device(id);
    expect(resolveRoute(d, '203.0.113.10', undefined, e.state)).toMatchObject({
      port: { id: 'p0' },
      nextHop: '203.0.113.10',
    });
    expect(cli.execute('show ip route')).toMatch(
      /^S\s+203\.0\.113\.0\/24 is directly connected, GigabitEthernet0\/1$/m
    );
    const sw = e.addProfile('switch-l2'),
      scli = new TerminalSession(e, sw.id);
    run(scli, [
      'en',
      'conf t',
      'interface Gi0/1',
      'switchport mode trunk',
      'switchport trunk allowed vlan none',
      'end',
      'write memory',
      'reload',
      '',
    ]);
    expect(e.device(sw.id).interfaces[0].allowedVlans).toEqual([]);
    validateSnapshot(e.snapshot());
  });
  it('negotiates Rapid PVST and err-disables a guarded port on received BPDUs', () => {
    const { e, id, cli } = fixture('switch-l2');
    const peer = e.addProfile('switch-l2'),
      peerCli = new TerminalSession(e, peer.id);
    run(cli, [
      'en',
      'conf t',
      'spanning-tree mode rapid-pvst',
      'spanning-tree vlan 1 priority 4096',
      'interface Gi0/1',
      'spanning-tree portfast',
      'spanning-tree bpduguard enable',
      'end',
    ]);
    run(peerCli, ['en', 'conf t', 'spanning-tree mode rapid-pvst', 'end']);
    const link = e.connect({ device: id, port: 'p0' }, { device: peer.id, port: 'p0' });
    e.advanceTo(100);
    expect(e.device(id).interfaces[0].errDisabled?.reason).toBe('bpduguard');
    expect(cli.execute('show interfaces Gi0/1')).toContain('err-disabled');
    e.removeLink(link.id);
    run(cli, ['conf t', 'interface Gi0/1', 'shutdown', 'no shutdown', 'end']);
    expect(e.device(id).interfaces[0].errDisabled).toBeUndefined();
    validateSnapshot(e.snapshot());
  });
  it('uses saved configuration on power cycles and drops unsaved factory configuration', () => {
    const e = new SimulationEngine(),
      d = e.addFactoryProfile('router');
    e.setDevicePower(d.id, true);
    const cli = new TerminalSession(e, d.id);
    run(cli, ['en', 'conf t', 'hostname SAVED', 'end', 'write memory', 'conf t', 'hostname UNSAVED', 'end']);
    e.setDevicePower(d.id, false);
    e.setDevicePower(d.id, true);
    expect(e.device(d.id).hostname).toBe('SAVED');
    validateSnapshot(e.snapshot());
  });
  it('classifies real traffic with native named ACLs and non-contiguous wildcard masks', () => {
    const { e, id, cli } = fixture();
    const a = e.addDevice('pc'),
      b = e.addDevice('pc');
    Object.assign(a.interfaces[0], { ip: '192.0.2.10', prefix: 24 });
    a.gateway = '192.0.2.1';
    Object.assign(b.interfaces[0], { ip: '198.51.100.20', prefix: 24 });
    b.gateway = '198.51.100.1';
    e.connect({ device: a.id, port: 'p0' }, { device: id, port: 'p0' });
    e.connect({ device: b.id, port: 'p0' }, { device: id, port: 'p1' });
    run(cli, [
      'en',
      'conf t',
      'interface Gi0/1',
      'ip address 192.0.2.1 255.255.255.0',
      'exit',
      'interface Gi0/2',
      'ip address 198.51.100.1 255.255.255.0',
      'exit',
      'ip access-list extended FILTER',
      '10 deny icmp 192.0.2.0 0.0.0.254 any',
      '20 permit ip any any',
      'exit',
      'interface Gi0/1',
      'ip access-group FILTER in',
      'end',
    ]);
    e.ping(a.id, '198.51.100.20');
    e.advanceTo(5000);
    expect(e.state.events.some((event) => event.type === 'ACL_DENY')).toBe(true);
    const denied = e.device(id).accessLists![0].rules[0].hits;
    a.interfaces[0].ip = '192.0.2.11';
    e.ping(a.id, '198.51.100.20');
    e.advanceTo(10000);
    expect(e.device(id).accessLists![0].rules[0].hits).toBe(denied);
    expect(e.device(id).accessLists![0].rules[1].hits).toBeGreaterThan(0);
    validateSnapshot(e.snapshot());
  });
  it('accepts native static NAT before interfaces are addressed and translates actual return traffic', () => {
    const { e, id, cli } = fixture();
    const a = e.addDevice('pc'),
      b = e.addDevice('pc');
    Object.assign(a.interfaces[0], { ip: '192.0.2.10', prefix: 24 });
    a.gateway = '192.0.2.1';
    Object.assign(b.interfaces[0], { ip: '198.51.100.20', prefix: 24 });
    b.gateway = '198.51.100.1';
    e.connect({ device: a.id, port: 'p0' }, { device: id, port: 'p0' });
    e.connect({ device: b.id, port: 'p0' }, { device: id, port: 'p1' });
    run(cli, [
      'en',
      'conf t',
      'ip nat inside source static 192.0.2.10 198.51.100.10',
      'interface Gi0/1',
      'ip address 192.0.2.1 255.255.255.0',
      'ip nat inside',
      'exit',
      'interface Gi0/2',
      'ip address 198.51.100.1 255.255.255.0',
      'ip nat outside',
      'end',
    ]);
    const probe = e.ping(a.id, '198.51.100.20');
    e.advanceTo(5000);
    expect(e.state.probes.find((p) => p.id === probe)?.status).toBe('success');
    expect(e.state.events.some((event) => event.type === 'NAT_TRANSLATED')).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('separates running/startup, restores after snapshot and erases only the saved configuration', () => {
    const { e, id, cli } = fixture();
    run(cli, [
      'en',
      'conf t',
      'hostname SAVED',
      'interface Gi0/1',
      'ip address 192.0.2.1 255.255.255.0',
      'description saved uplink',
      'mtu 1400',
      'end',
      'copy running-config startup-config',
    ]);
    run(cli, ['conf t', 'hostname UNSAVED', 'interface Gi0/1', 'ip address 192.0.2.9 255.255.255.0', 'end']);
    expect(cli.execute('show startup-config')).toContain('hostname SAVED');
    expect(cli.execute('show running-config')).toContain('hostname UNSAVED');
    const restored = new SimulationEngine(e.snapshot()),
      rcli = new TerminalSession(restored, id);
    run(rcli, ['enable', 'reload']);
    expect(rcli.prompt).toBe('System configuration has been modified. Save? [yes/no]:');
    run(rcli, ['no', '']);
    expect(restored.device(id).hostname).toBe('SAVED');
    expect(restored.device(id).interfaces[0].ip).toBe('192.0.2.1');
    expect(restored.device(id).interfaces[0].mtu).toBe(1400);
    expect(rcli.prompt).toBe('SAVED>');
    run(rcli, ['enable', 'erase startup-config']);
    expect(restored.device(id).hostname).toBe('SAVED');
    run(rcli, ['reload', 'no', '']);
    expect(restored.device(id).interfaces[0].ip).toBeUndefined();
    expect(restored.device(id).hostname).toBe('Router');
    validateSnapshot(restored.snapshot());
  });
  it('resolves abbreviations in mode, contextual help, completion, do and output filters', () => {
    const { cli } = fixture();
    expect(cli.execute('en')).toBe('');
    expect(cli.complete('sh')).toBe('show ');
    expect(cli.execute('show ip ?')).toContain('interface');
    expect(cli.execute('sh ip int br')).toContain('IP-Address');
    run(cli, ['conf t', 'hostname LAB', 'interface GigabitEthernet0/1', 'description uplink', 'mtu 1400']);
    expect(cli.execute('show ip interface brief')).toMatch(/^%/);
    expect(cli.execute('do sh ip int br')).toContain('Gi0/1');
    expect(cli.prompt).toBe('LAB(config-if)#');
    run(cli, ['no description', 'end']);
    expect(cli.execute('show running-config | include mtu')).toBe(' mtu 1400');
    expect(cli.execute('disable')).toBe('');
    expect(cli.execute('show running-config')).toMatch(/^%/);
  });
  it('applies interface ranges atomically, adds and removes trunk VLANs', () => {
    const { e, id, cli } = fixture('switch-l2');
    run(cli, [
      'en',
      'conf t',
      'interface range Gi0/1 - 2',
      'shutdown',
      'switchport mode trunk',
      'switchport trunk allowed vlan 10,20',
      'switchport trunk allowed vlan add 30',
      'switchport trunk allowed vlan remove 20',
    ]);
    expect(
      e
        .device(id)
        .interfaces.slice(0, 2)
        .map((p) => [p.adminUp, p.allowedVlans])
    ).toEqual([
      [false, [10, 30]],
      [false, [10, 30]],
    ]);
    const before = e.snapshot();
    expect(cli.execute('interface range Gi0/1 - 99')).toMatch(/^%/);
    expect(e.snapshot()).toEqual(before);
  });
  it('reports carrier and installed routes from the forwarding state', () => {
    const { e, id, cli } = fixture();
    const peer = e.addDevice('router');
    e.connect({ device: id, port: 'p0' }, { device: peer.id, port: 'p0' });
    run(cli, ['en', 'conf t', 'interface Gi0/1', 'ip address 192.0.2.1 255.255.255.0', 'end']);
    expect(cli.execute('show ip route')).toMatch(/^C\s+192\.0\.2\.0\/24 is directly connected, GigabitEthernet0\/1$/m);
    expect(cli.execute('show interfaces Gi0/1')).toContain('line protocol is up');
    run(cli, ['conf t', 'interface Gi0/1', 'shutdown', 'end']);
    expect(cli.execute('show ip route')).not.toContain('192.0.2.0/24');
    expect(cli.execute('show interfaces Gi0/1')).toContain('administratively down');
  });
  it('resolves recursive next hops, rejects recursion loops and uses floating distance', () => {
    const { e, id, cli } = fixture();
    const peer = e.addDevice('router');
    e.connect({ device: id, port: 'p0' }, { device: peer.id, port: 'p0' });
    run(cli, [
      'en',
      'conf t',
      'interface Gi0/1',
      'ip address 192.0.2.1 255.255.255.0',
      'exit',
      'ip route 10.0.0.0 255.255.255.0 192.0.2.2',
      'ip route 203.0.113.0 255.255.255.0 10.0.0.1 200',
      'ip route 203.0.113.0 255.255.255.0 192.0.2.3 20',
      'end',
    ]);
    expect(resolveRoute(e.device(id), '203.0.113.10', undefined, e.state)?.nextHop).toBe('192.0.2.3');
    run(cli, ['conf t', 'no ip route 203.0.113.0 255.255.255.0 192.0.2.3', 'end']);
    expect(resolveRoute(e.device(id), '203.0.113.10', undefined, e.state)?.nextHop).toBe('192.0.2.2');
    run(cli, [
      'conf t',
      'ip route 198.51.100.0 255.255.255.0 198.18.0.1',
      'ip route 198.18.0.0 255.255.255.0 198.51.100.1',
      'end',
    ]);
    expect(resolveRoute(e.device(id), '198.51.100.2', undefined, e.state)).toBeUndefined();
    validateSnapshot(e.snapshot());
  });
  it('enters native routing submodes and supports OSPF on multilayer switches', () => {
    const { e, id, cli } = fixture('switch-l3');
    run(cli, ['en', 'conf t', 'router ospf 10', 'router-id 10.255.0.1']);
    expect(cli.prompt).toContain('(config-router)#');
    run(cli, [
      'exit',
      'interface Gi0/1',
      'no switchport',
      'ip address 192.0.2.1 255.255.255.0',
      'ip ospf 10 area 0',
      'end',
    ]);
    expect(e.device(id).ospf?.interfaces[0].area).toBe(0);
    run(cli, ['conf t', 'router bgp 65001', 'address-family ipv4 unicast']);
    expect(cli.prompt).toContain('(config-router-af)#');
    run(cli, [
      'network 192.0.2.0 mask 255.255.255.0',
      'exit-address-family',
      'exit',
      'router rip',
      'version 2',
      'end',
    ]);
    validateSnapshot(e.snapshot());
  });
});
