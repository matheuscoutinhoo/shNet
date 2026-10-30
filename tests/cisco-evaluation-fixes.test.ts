import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  linkOperational,
  preflight,
  validateSnapshot,
  type Device,
} from '../packages/simulation-engine/src';

const run = (t: TerminalSession, lines: string[]) => {
  for (const line of lines) expect(t.execute(line), line).not.toMatch(/^%/);
};
function factory(profile: string) {
  const e = new SimulationEngine(),
    d = e.addFactoryProfile(profile);
  e.setDevicePower(d.id, true);
  const t = new TerminalSession(e, d.id);
  run(t, ['enable', 'configure terminal']);
  return { e, d: e.device(d.id), t };
}

describe('common IOS commands that were rejected or misread', () => {
  it('interface range accepts full names and multi-digit range ends', () => {
    const { e, d, t } = factory('access');
    run(t, ['interface range GigabitEthernet0/1 - 20', 'description USER-PORTS', 'exit']);
    expect(e.device(d.id).interfaces.filter((p) => p.description === 'USER-PORTS')).toHaveLength(20);
    run(t, [
      'interface range Gi0/25 - 26',
      'description UPLINKS',
      'exit',
      'interface range Gi0/21-Gi0/22',
      'exit',
    ]);
    expect(
      e
        .device(d.id)
        .interfaces.filter((p) => p.description === 'UPLINKS')
        .map((p) => p.name)
    ).toEqual(['Gi0/25', 'Gi0/26']);
    expect(t.execute('interface range Gi0/5 - 3')).toMatch(/^% Invalid interface range/);
  });

  it('ip name-server is a global command on network devices', () => {
    const { e, d, t } = factory('router');
    run(t, ['ip name-server 10.2.50.53 10.3.50.53']);
    expect(e.device(d.id).nameServers).toEqual(['10.2.50.53', '10.3.50.53']);
    run(t, ['end']);
    expect(t.execute('show running-config')).toContain('ip name-server 10.2.50.53 10.3.50.53');
    run(t, ['configure terminal', 'no ip name-server 10.3.50.53']);
    expect(e.device(d.id).nameServers).toEqual(['10.2.50.53']);
    run(t, ['no ip name-server']);
    expect(e.device(d.id).nameServers).toBeUndefined();
  });

  it('ipv6 route accepts the IOS next-hop-only and interface-only forms', () => {
    const { e, d, t } = factory('router');
    run(t, [
      'ipv6 unicast-routing',
      'interface Gi0/1',
      'ipv6 address 2001:db8:12::1/64',
      'no shutdown',
      'exit',
    ]);
    run(t, ['ipv6 route 2001:db8:20::/64 2001:db8:12::2', 'ipv6 route 2001:db8:30::/64 Gi0/1']);
    const routes = e.device(d.id).routes6!;
    const gi = e.device(d.id).interfaces.find((p) => p.name === 'Gi0/1')!.id;
    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          network: '2001:db8:20::',
          prefix: 64,
          port: gi,
          nextHop: '2001:db8:12::2',
        }),
        expect.objectContaining({ network: '2001:db8:30::', prefix: 64, port: gi, nextHop: '::' }),
      ])
    );
    expect(t.execute('ipv6 route ::/0 fe80::2')).toMatch(/link-local nexthop/);
  });

  it('show interfaces status and description use the IOS layouts', () => {
    const { t } = factory('access');
    run(t, [
      'vlan 10',
      'exit',
      'interface Gi0/1',
      'description USER-01',
      'switchport mode access',
      'switchport access vlan 10',
      'exit',
      'interface Gi0/2',
      'shutdown',
      'end',
    ]);
    const status = t.execute('show interfaces status');
    expect(status.split('\n')[0]).toBe(
      'Port       Name               Status       Vlan       Duplex  Speed Type'
    );
    expect(status).toMatch(/^Gi0\/1\s+USER-01\s+notconnect\s+10\s+auto\s+auto 10\/100\/1000BaseTX$/m);
    expect(status).toMatch(/^Gi0\/2\s+disabled\s+1\s/m);
    expect(status).toMatch(/^Gi0\/25 .*1000BaseLX SFP$/m);
    expect(t.execute('show interfaces Gi0/1 status').split('\n')).toHaveLength(2);
    const description = t.execute('show interfaces description');
    expect(description.split('\n')[0]).toBe(
      'Interface                      Status         Protocol Description'
    );
    expect(description).toMatch(/^Gi0\/1\s+down\s+down\s+USER-01$/m);
    expect(description).toMatch(/^Gi0\/2\s+admin down\s+down$/m);
  });
});

describe('IOS implicit sub-mode exit', () => {
  it('a running-config style paste without exit lines is accepted', () => {
    const { e, d, t } = factory('router');
    const pasted = `ip access-list extended NAT-USERS
 permit ip 10.0.0.0 0.255.255.255 any
ip prefix-list SITE-OUT seq 5 permit 10.1.0.0/16
route-map MPLS-IN permit 10
 set local-preference 200
ip sla 10
 icmp-echo 8.8.8.8
 frequency 10
ip sla schedule 10 life forever start-time now
track 10 ip sla 10 reachability
class-map match-any VOICE
 match dscp ef
class-map match-any CRITICAL
 match dscp af31
policy-map WAN-QOS
 class VOICE
  priority percent 20
 class CRITICAL
  bandwidth percent 30
interface Gi0/1
 service-policy output WAN-QOS
archive
 path flash:archive
hostname R-PASTED`;
    for (const line of pasted.split('\n')) expect(t.execute(line.trim()), line).not.toMatch(/^%/);
    expect(t.prompt).toBe('R-PASTED(config)#');
    run(t, ['end']);
    const config = t.execute('show running-config');
    for (const expected of [
      'ip prefix-list SITE-OUT',
      'route-map MPLS-IN permit 10',
      'track 10 ip sla 10 reachability',
      ' service-policy output WAN-QOS',
    ])
      expect(config).toContain(expected);
    const policy = e.device(d.id).mqc!.policyMaps.find((p) => p.name === 'WAN-QOS')!;
    expect(policy.classes.map((c) => c.name)).toEqual(['VOICE', 'CRITICAL']);
  });

  it('mode-changing commands leave interface range mode', () => {
    const { t } = factory('distribution');
    run(t, ['interface range Gi0/1 - 2', 'description RANGE', 'exit']);
    expect(t.prompt).toMatch(/\(config\)#$/);
    run(t, ['ip routing', 'interface range Gi0/3 - 4', 'router ospf 1']);
    expect(t.prompt).toMatch(/\(config-router\)#$/);
    run(t, ['interface range Gi0/5 - 6', 'end']);
    expect(t.prompt).toMatch(/#$/);
    expect(t.prompt).not.toContain('config');
  });

  it('commands that exist in no parent mode are still rejected', () => {
    const { t } = factory('router');
    run(t, ['interface Gi0/1']);
    expect(t.execute('write memory')).toMatch(/^%/);
    expect(t.execute('frequency 10')).toMatch(/^%/);
    expect(t.prompt).toMatch(/\(config-if\)#$/);
  });
});

describe('configuration order independence', () => {
  it('interface OSPF settings may precede router ospf and ip ospf area', () => {
    const { e, d, t } = factory('router');
    run(t, [
      'interface Gi0/1',
      'ip address 10.0.0.1 255.255.255.252',
      'ip ospf network point-to-point',
      'ip ospf cost 25',
      'ip ospf hello-interval 5',
      'ip ospf 1 area 0',
      'exit',
      'interface Gi0/2',
      'ip address 10.0.1.1 255.255.255.0',
      'ip ospf priority 0',
      'exit',
      'router ospf 1',
      'network 10.0.1.0 0.0.0.255 area 0',
    ]);
    const ospf = e.device(d.id).ospf!;
    const gi1 = ospf.interfaces.find((i) => i.port === e.device(d.id).interfaces[0].id)!;
    expect(gi1).toMatchObject({
      networkType: 'point-to-point',
      cost: 25,
      autoCost: false,
      helloMs: 5000,
      deadMs: 20000,
    });
    const gi2 = ospf.interfaces.find((i) => i.port === e.device(d.id).interfaces[1].id)!;
    expect(gi2).toMatchObject({ networkType: 'broadcast', priority: 0, networkManaged: true });
    run(t, ['end']);
    const config = t.execute('show running-config');
    expect(config).toContain(' ip ospf network point-to-point');
    expect(config).toContain(' ip ospf cost 25');
    expect(config).not.toContain(' ip ospf network broadcast');
    expect(config).not.toMatch(/ip ospf 1 area 0\n(?:.*\n)*?exit\ninterface Gi0\/2\n ip ospf 1 area/);
    expect(config.match(/ ip ospf 1 area 0/g)).toHaveLength(1);
  });

  it('OSPF on Ethernet defaults to broadcast with DR/BDR election (IOS default)', () => {
    const e = new SimulationEngine();
    const sw = e.addFactoryProfile('switch-l2');
    e.setDevicePower(sw.id, true);
    const routers = [1, 2, 3].map((i) => {
      const r = e.addFactoryProfile('router', { x: i * 100, y: 0 });
      e.setDevicePower(r.id, true);
      e.connect({ device: r.id, port: r.interfaces[0].id }, { device: sw.id, port: sw.interfaces[i - 1].id });
      run(new TerminalSession(e, r.id), [
        'enable',
        'configure terminal',
        'interface Gi0/1',
        `ip address 10.0.0.${i} 255.255.255.0`,
        ...(i === 3 ? ['ip ospf priority 50'] : []),
        'ip ospf 1 area 0',
        'end',
      ]);
      return r;
    });
    e.advanceTo(80000, 2_000_000);
    const r3 = e.device(routers[2].id).ospf!;
    expect(r3.interfaces[0].networkType).toBe('broadcast');
    expect(r3.ports[0].dr).toBe('10.0.0.3');
    expect(r3.neighbors.filter((n) => n.state === 'Full')).toHaveLength(2);
  });

  it('ip access-group may reference an ACL defined later; undefined ACLs permit traffic', () => {
    const { e, d, t } = factory('router');
    run(t, ['interface Gi0/1', 'ip address 10.0.0.1 255.255.255.0', 'ip access-group EDGE-IN in', 'exit']);
    expect(e.device(d.id).interfaces[0].aclIn).toBe('EDGE-IN');
    run(t, [
      'ip access-list extended EDGE-IN',
      'deny ip any any',
      'exit',
      'no ip access-list extended EDGE-IN',
    ]);
    expect(e.device(d.id).interfaces[0].aclIn).toBe('EDGE-IN');
    expect(() => validateSnapshot(e.snapshot())).not.toThrow();
  });

  it('logging and SNMP may be configured before a switch has a management address', () => {
    for (const profile of ['access', 'distribution']) {
      const { e, d, t } = factory(profile);
      run(t, ['logging host 10.2.50.14', 'snmp-server community ACME-RO RO']);
      expect(e.device(d.id).syslogClient?.server).toBe('10.2.50.14');
      expect(e.device(d.id).snmpAgent).toMatchObject({ community: 'ACME-RO', enabled: true });
    }
  });
});

describe('PVST/Rapid-PVST VLAN database changes', () => {
  for (const profile of ['access', 'switch-l2', 'distribution', 'switch-l3']) {
    it(`${profile}: VLANs and SVIs can be added and removed after Rapid-PVST is enabled`, () => {
      const { e, d, t } = factory(profile);
      run(t, [
        'vlan 10',
        'exit',
        'spanning-tree mode rapid-pvst',
        'vlan 20',
        'name VOICE',
        'exit',
        'interface Vlan99',
        'exit',
      ]);
      const tree = e.device(d.id).multiSpanningTree!;
      expect(tree.mode).toBe('pvst');
      expect(tree.instances.map((i) => i.id).sort((a, b) => a - b)).toEqual([1, 10, 20, 99]);
      const svi = e.device(d.id).interfaces.find((p) => p.name === 'Vlan99')!;
      expect(svi.spanningInstances ?? []).toEqual([]);
      run(t, ['no vlan 20']);
      expect(
        e
          .device(d.id)
          .multiSpanningTree!.instances.map((i) => i.id)
          .sort((a, b) => a - b)
      ).toEqual([1, 10, 99]);
      expect(e.device(d.id).interfaces.every((p) => !p.spanningInstances?.some((i) => i.id === 20))).toBe(
        true
      );
      expect(() => validateSnapshot(e.snapshot())).not.toThrow();
    });
  }

  it('adding a VLAN keeps the existing VLAN trees converged', () => {
    const e = new SimulationEngine();
    const [a, b] = ['access', 'access'].map((p, i) => {
      const d = e.addFactoryProfile(p, { x: i * 100, y: 0 });
      e.setDevicePower(d.id, true);
      return d;
    });
    e.connect({ device: a.id, port: a.interfaces[22].id }, { device: b.id, port: b.interfaces[22].id });
    for (const d of [a, b])
      run(new TerminalSession(e, d.id), [
        'enable',
        'configure terminal',
        'vlan 10',
        'exit',
        'spanning-tree mode rapid-pvst',
        'interface Gi0/23',
        'switchport mode trunk',
        'switchport trunk allowed vlan 1,10,30',
        'end',
      ]);
    e.advanceTo(40000, 2_000_000);
    const before = e.device(a.id).interfaces[22].spanningInstances!.find((i) => i.id === 10)!.state;
    expect(before.state).toBe('forwarding');
    run(new TerminalSession(e, a.id), ['enable', 'configure terminal', 'vlan 30', 'end']);
    const after = e.device(a.id).interfaces[22].spanningInstances!.find((i) => i.id === 10)!.state;
    expect(after.state).toBe('forwarding');
    expect(after.token).toBe(before.token);
    expect(e.device(a.id).interfaces[22].spanningInstances!.some((i) => i.id === 30)).toBe(true);
  });

  it('per-VLAN priority may precede the VLAN definition, as in IOS running-config order', () => {
    const { e, d, t } = factory('distribution');
    run(t, [
      'spanning-tree mode rapid-pvst',
      'spanning-tree vlan 10,20 priority 4096',
      'vlan 10',
      'exit',
      'vlan 20',
      'exit',
    ]);
    const c = e.device(d.id).multiSpanningTree!;
    expect(c.priorities).toEqual(expect.arrayContaining([{ instance: 10, priority: 4096 }]));
    expect(c.instances.find((i) => i.id === 10)!.tree.priority).toBe(4096);
    expect(c.instances.find((i) => i.id === 20)!.tree.priority).toBe(4096);
  });
});

describe('Cisco factory defaults', () => {
  it('factory switches boot with Rapid PVST+ and block a redundant triangle', () => {
    const e = new SimulationEngine();
    const switches = [0, 1, 2].map((i) => {
      const s = e.addFactoryProfile('switch-l2', { x: i * 100, y: 0 });
      e.setDevicePower(s.id, true);
      return e.device(s.id);
    });
    for (const s of switches) expect(s.multiSpanningTree).toMatchObject({ mode: 'pvst', protocol: 'rstp' });
    const port = (s: Device, n: number) => s.interfaces[n].id;
    e.connect(
      { device: switches[0].id, port: port(switches[0], 0) },
      { device: switches[1].id, port: port(switches[1], 0) }
    );
    e.connect(
      { device: switches[1].id, port: port(switches[1], 1) },
      { device: switches[2].id, port: port(switches[2], 0) }
    );
    e.connect(
      { device: switches[2].id, port: port(switches[2], 1) },
      { device: switches[0].id, port: port(switches[0], 1) }
    );
    e.advanceTo(40000, 2_000_000);
    const states = switches.flatMap((s) =>
      s.interfaces.slice(0, 2).map((p) => p.spanningInstances!.find((i) => i.id === 1)!.state.state)
    );
    expect(states.filter((s) => s === 'discarding')).toHaveLength(1);
    expect(states.filter((s) => s === 'forwarding')).toHaveLength(5);
    const t = new TerminalSession(e, switches[0].id);
    run(t, ['enable']);
    expect(t.execute('show running-config')).toContain('spanning-tree mode rapid-pvst');
    run(t, ['configure terminal', 'no spanning-tree vlan 1-4094', 'end']);
    expect(e.device(switches[0].id).spanningTree).toBeUndefined();
    expect(t.execute('show running-config')).toContain('no spanning-tree vlan 1-4094');
  });

  it('copper ports auto-negotiate the highest common speed and follow fixed peers', () => {
    const e = new SimulationEngine();
    const dist = e.addFactoryProfile('distribution'),
      acc = e.addFactoryProfile('access', { x: 200, y: 0 });
    for (const d of [dist, acc]) e.setDevicePower(d.id, true);
    expect(e.device(dist.id).interfaces[0]).toMatchObject({ media: 'rj45', speed: 10000 });
    const link = e.connect({ device: dist.id, port: 'p0' }, { device: acc.id, port: 'p0' });
    expect(e.device(dist.id).interfaces[0]).toMatchObject({ speed: 1000, maxSpeed: 10000 });
    expect(linkOperational(e.state, link)).toBe(true);
    const t = new TerminalSession(e, dist.id);
    run(t, ['enable']);
    expect(t.execute('show interfaces Gi0/1 status')).toMatch(/connected\s+1\s+a-full\s+a-1000 /);
    run(t, ['configure terminal', 'interface Gi0/1', 'speed 100']);
    expect([e.device(dist.id).interfaces[0].speed, e.device(acc.id).interfaces[0].speed]).toEqual([100, 100]);
    expect(t.execute('do show running-config')).toContain(' speed 100');
    run(t, ['speed auto', 'end']);
    expect([e.device(dist.id).interfaces[0].speed, e.device(acc.id).interfaces[0].speed]).toEqual([
      1000, 1000,
    ]);
    expect(t.execute('show running-config')).not.toMatch(/^ speed /m);
    e.removeLink(link.id);
    expect(e.device(dist.id).interfaces[0].speed).toBe(10000);
    expect(e.device(dist.id).interfaces[0].maxSpeed).toBeUndefined();
    validateSnapshot(e.snapshot());
  });

  it('reload keeps native port speeds and renegotiates attached copper links', () => {
    const { e, d, t } = factory('distribution');
    const acc = e.addFactoryProfile('access', { x: 200, y: 0 });
    e.setDevicePower(acc.id, true);
    e.connect({ device: d.id, port: 'p0' }, { device: acc.id, port: 'p0' });
    run(t, ['end', 'write memory', 'reload', '']);
    expect(e.device(d.id).interfaces[0]).toMatchObject({ speed: 1000, maxSpeed: 10000 });
    expect(e.device(d.id).interfaces[5].speed).toBe(10000);
    expect(e.device(d.id).multiSpanningTree).toMatchObject({ mode: 'pvst', protocol: 'rstp' });
  });

  it('loopbacks have no phantom description, MTU, speed or duplex lines', () => {
    const { t } = factory('router');
    run(t, ['interface Loopback0', 'ip address 10.255.0.1 255.255.255.255', 'end']);
    const block = t.execute('show running-config').split('interface Loopback0\n')[1].split('\nexit')[0];
    expect(block).toBe(' no shutdown\n ip address 10.255.0.1 255.255.255.255');
  });
});

describe('IOS output fidelity and preflight signal', () => {
  it('IOS configuration commands print nothing, including enable before Password:', () => {
    const { t } = factory('router');
    expect(t.execute('hostname R1')).toBe('');
    expect(t.execute('enable secret Lab-Secret-1')).toBe('');
    run(t, ['end', 'disable']);
    expect(t.execute('enable')).toBe('');
    expect(t.prompt).toBe('Password:');
    expect(t.execute('Lab-Secret-1')).toBe('');
    expect(t.prompt).toBe('R1#');
  });

  it('parser errors use IOS wording on IOS devices and the host language on hosts', () => {
    const { e, t } = factory('router');
    expect(t.execute('frobnicate the network')).toMatch(/^% Invalid input detected at/);
    expect(t.execute('ip frobnicate 1')).toMatch(/^% Invalid input detected at/);
    const pc = new TerminalSession(e, e.addProfile('desktop').id);
    expect(pc.execute('frobnicate')).toBe('% Comando não reconhecido. Digite help.');
  });

  it('environment and IP SLA statistics are shown as whole numbers', () => {
    const { e, d, t } = factory('router');
    e.device(d.id).system = { ...e.device(d.id).system!, temperatureC: 41.73, cpuPercent: 12.4 };
    const environment = t.execute('do show environment');
    expect(environment).toContain('Temperature: 42 C');
    expect(environment).toContain('CPU: 12%');
    run(t, ['ip sla 1', 'icmp-echo 192.0.2.1', 'exit']);
    e.device(d.id).monitoring!.operations[0].rtt = 0.137;
    expect(t.execute('do show ip sla statistics')).toContain('RTT 1 ms');
  });

  it('preflight accepts split DHCP scopes and aggregates L3-switch capability notes', () => {
    const e = new SimulationEngine();
    const relay = e.addDevice('router'),
      a = e.addDevice('server'),
      b = e.addDevice('server'),
      l3 = [e.addProfile('switch-l3'), e.addProfile('switch-l3')];
    Object.assign(relay.interfaces[0], {
      ip: '10.1.10.2',
      prefix: 24,
      dhcpRelay: ['10.2.50.10', '10.2.50.11'],
    });
    Object.assign(a.interfaces[0], { ip: '10.2.50.10', prefix: 24 });
    Object.assign(b.interfaces[0], { ip: '10.2.50.11', prefix: 24 });
    for (const d of l3) e.device(d.id).ipRouting = true;
    run(new TerminalSession(e, a.id), [
      'enable',
      'configure terminal',
      'ip dhcp pool USERS',
      'network 10.1.10.0 255.255.255.0',
    ]);
    // Server B has no scope for this relay: one scoped server is enough, so this is only a redundancy note.
    run(new TerminalSession(e, b.id), ['enable', 'configure terminal', 'service dhcp']);
    const issues = preflight(e.snapshot());
    expect(issues.filter((i) => i.code === 'RELAY_SCOPE_MISSING')).toEqual([]);
    expect(issues.find((i) => i.code === 'RELAY_SINGLE_SERVER')?.message).toContain('somente');
    const capability = issues.filter((i) => i.code === 'FIREWALL_CAPABILITY');
    expect(capability).toHaveLength(1);
    expect(capability[0].devices).toHaveLength(2);
  });
});

describe('startup-config persistence and the IOS reload dialog', () => {
  const reload = (t: TerminalSession, ...answers: string[]) => {
    expect(t.execute('reload')).toBe('');
    return answers.map((answer) => t.execute(answer));
  };

  it('access switches with NTP and management save and reload their configuration', () => {
    const { e, d, t } = factory('access');
    run(t, [
      'hostname ACC-1',
      'vlan 10',
      'name USERS',
      'exit',
      'interface Gi0/1',
      'switchport mode access',
      'switchport access vlan 10',
      'exit',
      'interface Vlan99',
      'ip address 10.99.0.11 255.255.255.0',
      'exit',
      'ip default-gateway 10.99.0.1',
      'ntp server 10.2.50.123',
      'logging host 10.2.50.14',
      'end',
    ]);
    expect(t.execute('write memory')).toBe('Building configuration...\n[OK]');
    const running = t.execute('show running-config');
    expect(running).not.toContain('clock configure');
    expect(reload(t, '')).toEqual(['Reload complete.']);
    run(t, ['enable']);
    expect(t.execute('show running-config')).toBe(running);
    expect(e.device(d.id).hostname).toBe('ACC-1');
  });

  it('EtherChannel trunks survive write memory and reload', () => {
    const { e, d, t } = factory('distribution');
    run(t, [
      'vlan 10',
      'exit',
      'vlan 20',
      'exit',
      'interface range Gi0/21 - 22',
      'switchport mode trunk',
      'channel-group 1 mode active',
      'exit',
      'interface Port-channel1',
      'switchport mode trunk',
      'switchport trunk allowed vlan 1,10,20',
      'exit',
      'interface Vlan10',
      'ip address 10.1.10.2 255.255.255.0',
      'end',
    ]);
    expect(t.execute('write memory')).toBe('Building configuration...\n[OK]');
    const running = t.execute('show running-config');
    reload(t, '');
    run(t, ['enable']);
    expect(t.execute('show running-config')).toBe(running);
    const po = e.device(d.id).interfaces.find((p) => p.name === 'Port-channel1')!;
    expect(
      po.aggregate!.members.map((id) => e.device(d.id).interfaces.find((p) => p.id === id)!.name)
    ).toEqual(['Gi0/21', 'Gi0/22']);
    validateSnapshot(e.snapshot());
  });

  it('routers with IOS DHCP pools save and reload them', () => {
    const { e, d, t } = factory('router');
    run(t, [
      'ip dhcp excluded-address 10.10.10.1 10.10.10.20',
      'ip dhcp pool USERS',
      'network 10.10.10.0 255.255.255.0',
      'default-router 10.10.10.1',
      'lease 2',
      'interface Gi0/1',
      'ip address 10.10.10.1 255.255.255.0',
      'end',
    ]);
    expect(t.execute('write memory')).toBe('Building configuration...\n[OK]');
    const running = t.execute('show running-config');
    reload(t, '');
    run(t, ['enable']);
    expect(t.execute('show running-config')).toBe(running);
    expect(e.device(d.id).dhcpServer!.pools[0]).toMatchObject({
      name: 'USERS',
      ios: true,
      leaseMs: 2 * 86400000,
    });
  });

  it('reload asks to save unsaved changes and then for confirmation', () => {
    const { e, d, t } = factory('router');
    run(t, ['hostname SAVED', 'end', 'write memory', 'configure terminal', 'hostname UNSAVED', 'end']);
    expect(t.execute('reload')).toBe('');
    expect(t.prompt).toBe('System configuration has been modified. Save? [yes/no]:');
    expect(t.execute('maybe')).toBe("% Please answer 'yes' or 'no'.");
    expect(t.execute('no')).toBe('');
    expect(t.prompt).toBe('Proceed with reload? [confirm]');
    t.cancel();
    expect(t.prompt).toBe('UNSAVED#');
    expect(e.device(d.id).hostname).toBe('UNSAVED');
    expect(reload(t, 'no', '')).toEqual(['', 'Reload complete.']);
    expect(e.device(d.id).hostname).toBe('SAVED');
    expect(t.prompt).toBe('SAVED>');
    run(t, ['enable', 'configure terminal', 'hostname KEEP', 'end']);
    expect(reload(t, 'yes', 'y')).toEqual(['Building configuration...\n[OK]', 'Reload complete.']);
    expect(e.device(d.id).hostname).toBe('KEEP');
    run(t, ['enable']);
    expect(reload(t, 'n')).toEqual(['']);
    expect(t.prompt).toBe('KEEP#');
  });
});

describe('IOS DHCP server pools', () => {
  it('pools may precede their interfaces, coexist on one router and honor global exclusions', () => {
    const { e, d, t } = factory('router');
    run(t, [
      'ip dhcp excluded-address 10.10.10.1 10.10.10.20',
      'ip dhcp excluded-address 10.10.20.1',
      'ip dhcp pool USERS',
      'network 10.10.10.0 255.255.255.0',
      'default-router 10.10.10.1',
      'dns-server 10.2.50.53',
      'domain-name acme.corp',
      'lease 1',
      'ip dhcp pool VOICE',
      'network 10.10.20.0 /24',
      'default-router 10.10.20.1',
      'lease 0 8',
    ]);
    expect(t.execute('do show ip dhcp pool')).toContain('USERS 10.10.10.0/24 inactive');
    run(t, [
      'interface Gi0/1.10',
      'encapsulation dot1Q 10',
      'ip address 10.10.10.1 255.255.255.0',
      'interface Gi0/1.20',
      'encapsulation dot1Q 20',
      'ip address 10.10.20.1 255.255.255.0',
      'end',
    ]);
    const server = e.device(d.id).dhcpServer!;
    const port = (name: string) => e.device(d.id).interfaces.find((p) => p.name === name)!.id;
    expect(server.pendingPools).toBeUndefined();
    expect(server.pools.map((p) => [p.name, p.port, p.leaseMs, p.relayAddress])).toEqual([
      ['USERS', port('Gi0/1.10'), 86400000, undefined],
      ['VOICE', port('Gi0/1.20'), 8 * 3600000, undefined],
    ]);
    const config = t.execute('show running-config');
    expect(config).toContain(
      'ip dhcp excluded-address 10.10.10.1 10.10.10.20\nip dhcp excluded-address 10.10.20.1\n'
    );
    expect(config).toContain(
      'ip dhcp pool USERS\n network 10.10.10.0 255.255.255.0\n default-router 10.10.10.1\n dns-server 10.2.50.53\n domain-name acme.corp\n exit'
    );
    expect(config).toContain(
      'ip dhcp pool VOICE\n network 10.10.20.0 255.255.255.0\n default-router 10.10.20.1\n lease 0 8\n exit'
    );
    validateSnapshot(e.snapshot());
  });

  it('a directly attached client receives the first non-excluded address with a one-day lease', () => {
    const { e, d, t } = factory('router');
    run(t, [
      'ip dhcp excluded-address 10.10.10.1 10.10.10.20',
      'ip dhcp pool USERS',
      'network 10.10.10.0 255.255.255.0',
      'default-router 10.10.10.1',
      'dns-server 10.2.50.53',
      'interface Gi0/1',
      'ip address 10.10.10.1 255.255.255.0',
      'no shutdown',
      'end',
    ]);
    const pc = e.addDevice('pc');
    e.connect({ device: pc.id, port: 'p0' }, { device: d.id, port: 'p0' });
    e.advanceTo(e.state.clock + 5000, 2_000_000);
    e.requestDhcp(pc.id, 'p0');
    e.advanceTo(e.state.clock + 2000, 2_000_000);
    expect(e.device(pc.id).interfaces[0]).toMatchObject({
      ip: '10.10.10.21',
      gateway: '10.10.10.1',
      dns: ['10.2.50.53'],
    });
    const lease = e.device(pc.id).interfaces[0].dhcp!.lease!;
    expect(lease.expiresAt - lease.acquiredAt).toBe(86400000);
    expect(t.execute('show ip dhcp binding')).toContain('10.10.10.21');
  });

  it('a central server selects the relayed pool by the giaddr subnet', () => {
    const engine = new SimulationEngine();
    const client = engine.addDevice('pc'),
      sw = engine.addDevice('switch'),
      relay = engine.addDevice('router'),
      core = engine.addDevice('router'),
      server = engine.addDevice('server');
    const ip = (device: Device, index: number, address: string, prefix = 24) =>
      Object.assign(device.interfaces[index], { ip: address, prefix });
    ip(relay, 0, '192.168.10.3');
    ip(relay, 1, '10.0.0.1', 30);
    ip(core, 0, '10.0.0.2', 30);
    ip(core, 1, '192.168.20.1');
    ip(server, 0, '192.168.20.10');
    server.gateway = '192.168.20.1';
    relay.routes.push({ network: '192.168.20.0', prefix: 24, nextHop: '10.0.0.2', metric: 1 });
    core.routes.push({ network: '192.168.10.0', prefix: 24, nextHop: '10.0.0.1', metric: 1 });
    for (const [a, ap, b, bp] of [
      [client, 'p0', sw, 'p0'],
      [sw, 'p1', relay, 'p0'],
      [relay, 'p1', core, 'p0'],
      [core, 'p1', server, 'p0'],
    ] as const)
      engine.connect({ device: a.id, port: ap }, { device: b.id, port: bp });
    run(new TerminalSession(engine, relay.id), [
      'enable',
      'configure terminal',
      'interface ' + relay.interfaces[0].name,
      'ip helper-address 192.168.20.10',
      'end',
    ]);
    // The pool gateway is the HSRP VIP (.1); the relay answering is the standby router (.3).
    run(new TerminalSession(engine, server.id), [
      'enable',
      'configure terminal',
      'ip dhcp excluded-address 192.168.10.1 192.168.10.10',
      'ip dhcp pool USERS',
      'network 192.168.10.0 255.255.255.0',
      'default-router 192.168.10.1',
      'dns-server 192.168.20.10',
      'end',
    ]);
    const pool = engine.device(server.id).dhcpServer!.pools[0];
    expect(pool).toMatchObject({
      name: 'USERS',
      ios: true,
      relayAddress: '192.168.10.1',
      network: '192.168.10.0',
    });
    engine.requestDhcp(client.id, 'p0');
    engine.advanceTo(engine.state.clock + 500);
    expect(engine.device(client.id).interfaces[0]).toMatchObject({
      ip: '192.168.10.11',
      gateway: '192.168.10.1',
    });
    validateSnapshot(engine.snapshot());
  });

  it('lease uses IOS days/hours/minutes and errors are readable', () => {
    const { e, d, t } = factory('router');
    run(t, [
      'interface Gi0/1',
      'ip address 10.1.1.1 255.255.255.0',
      'exit',
      'ip dhcp pool LAN',
      'network 10.1.1.0 255.255.255.0',
    ]);
    const lease = () => e.device(d.id).dhcpServer!.pools[0].leaseMs;
    run(t, ['lease 0 0 30']);
    expect(lease()).toBe(1800000);
    run(t, ['lease infinite']);
    expect(lease()).toBe(365 * 86400000);
    expect(t.execute('do show running-config')).toContain(' lease infinite');
    run(t, ['lease seconds 30']);
    expect(lease()).toBe(30000);
    expect(t.execute('do show running-config')).toContain(' lease seconds 30');
    expect(t.execute('lease 400')).toMatch(/^% .*365/);
    const tooMany = t.execute(
      'dns-server 1.1.1.1 1.1.1.2 1.1.1.3 1.1.1.4 1.1.1.5 1.1.1.6 1.1.1.7 1.1.1.8 1.1.1.9'
    );
    expect(tooMany).toMatch(/^% Valor inválido: dns/);
    expect(tooMany).not.toContain('[');
    expect(t.execute('ip dhcp pool OTHER')).not.toMatch(/^%/);
    expect(t.execute('network 10.1.1.0 255.255.255.0')).toMatch(/overlaps with pool: LAN/);
  });
});
