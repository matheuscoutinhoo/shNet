import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  validateSnapshot,
  type Frame,
} from '../packages/simulation-engine/src';
import { permitPacket } from '../packages/simulation-engine/src/protocols/acl';
import { permitDhcpSnooping } from '../packages/simulation-engine/src/protocols/dhcp-snooping';
import { permitPortSecurity } from '../packages/simulation-engine/src/protocols/port-security';
const run = (t: TerminalSession, lines: string[]) => {
  for (const line of lines) expect(t.execute(line), line).not.toMatch(/^%/);
};
const arp = (src = '02:00:00:00:00:01', ip = '192.0.2.10'): Frame => ({
  src,
  dst: 'ff:ff:ff:ff:ff:ff',
  etherType: 'ARP',
  hops: 10,
  arp: { kind: 'request', senderMac: src, senderIp: ip, targetIp: '192.0.2.1' },
});
describe('native Cisco campus and policy workflows', () => {
  it('numbered ACLs and established require TCP ACK or RST', () => {
    const e = new SimulationEngine(),
      d = e.addProfile('router'),
      t = new TerminalSession(e, d.id);
    run(t, [
      'en',
      'conf t',
      'access-list 101 permit tcp any any established',
      'interface Gi0/1',
      'ip access-group 101 in',
      'end',
    ]);
    const packet = {
      protocol: 'TCP' as const,
      src: '192.0.2.10',
      dst: '198.51.100.10',
      ttl: 64,
      sourcePort: 12345,
      destinationPort: 443,
      sequence: 0,
      acknowledgment: 0,
      window: 65535,
      data: '',
      bytes: 40,
      flags: ['SYN' as const],
    };
    expect(permitPacket(e, d, d.interfaces[0], 'in', packet)).toBe(false);
    expect(permitPacket(e, d, d.interfaces[0], 'in', { ...packet, flags: ['ACK'] })).toBe(true);
    run(t, ['write memory', 'reload', '', 'en']);
    expect(e.device(d.id).accessLists?.[0].rules[0].established).toBe(true);
  });
  it('native PAT may be configured before addressing and translates real return traffic', () => {
    const e = new SimulationEngine(),
      r = e.addProfile('router'),
      pc = e.addDevice('pc'),
      web = e.addProfile('web'),
      t = new TerminalSession(e, r.id);
    run(t, [
      'en',
      'conf t',
      'ip nat inside source list 1 interface Gi0/2 overload',
      'access-list 1 permit 10.0.0.0 0.0.0.255',
      'interface Gi0/1',
      'ip address 10.0.0.1 255.255.255.0',
      'ip nat inside',
      'exit',
      'interface Gi0/2',
      'ip address 203.0.113.1 255.255.255.0',
      'ip nat outside',
      'end',
    ]);
    Object.assign(pc.interfaces[0], { ip: '10.0.0.10', prefix: 24 });
    pc.gateway = '10.0.0.1';
    Object.assign(web.interfaces[0], { ip: '203.0.113.10', prefix: 24 });
    web.gateway = '203.0.113.1';
    e.connect({ device: r.id, port: 'p0' }, { device: pc.id, port: 'p0' });
    e.connect({ device: r.id, port: 'p1' }, { device: web.id, port: 'p0' });
    const id = e.httpGet(pc.id, '203.0.113.10');
    e.advanceTo(3000);
    expect(pc.tcpConnections?.find((c) => c.id === id)?.received).toContain('HTTP/1.1 200');
    expect(r.nat?.bindings[0].global).toBe('203.0.113.1');
    validateSnapshot(e.snapshot());
    run(t, ['conf t', 'interface Gi0/2', 'ip address 203.0.113.2 255.255.255.0', 'end']);
    expect(r.nat?.bindings).toEqual([]);
    expect(e.state.queue.some((q) => q.action.kind === 'nat-expire' && q.action.device === r.id)).toBe(false);
    run(t, ['write memory', 'reload', '', 'en']);
    expect(e.device(r.id).nat?.interfaceRules).toHaveLength(1);
  });
  it('native snooping, DAI and per-port source guard enforce bindings', () => {
    const e = new SimulationEngine(),
      sw = e.addProfile('switch-l3'),
      t = new TerminalSession(e, sw.id);
    run(t, [
      'en',
      'conf t',
      'vlan 10',
      'exit',
      'interface range Gi0/1 - 3',
      'switchport mode access',
      'switchport access vlan 10',
      'exit',
      'ip dhcp snooping',
      'ip dhcp snooping vlan 10',
      'ip arp inspection vlan 10',
      'interface Gi0/2',
      'ip dhcp snooping trust',
      'ip arp inspection trust',
      'exit',
      'interface Gi0/1',
      'ip verify source',
      'exit',
      'ip source binding 0200.0000.0001 vlan 10 192.0.2.10 interface Gi0/1',
      'end',
    ]);
    expect(permitDhcpSnooping(e, sw, sw.interfaces[0], arp(), 10)).toBe(true);
    expect(permitDhcpSnooping(e, sw, sw.interfaces[0], arp(undefined, '192.0.2.66'), 10)).toBe(false);
    const packet: Frame = {
      src: '02:00:00:00:00:01',
      dst: 'ff:ff:ff:ff:ff:ff',
      etherType: 'IPv4',
      hops: 10,
      packet: {
        protocol: 'ICMP',
        src: '192.0.2.66',
        dst: '192.0.2.1',
        ttl: 64,
        kind: 'echo-request',
        probeId: 'test',
        bytes: 84,
      },
    };
    expect(permitDhcpSnooping(e, sw, sw.interfaces[0], packet, 10)).toBe(false);
    expect(permitDhcpSnooping(e, sw, sw.interfaces[2], packet, 10)).toBe(true);
    validateSnapshot(e.snapshot());
    run(t, ['write memory', 'reload', '', 'en']);
    expect(e.device(sw.id).dhcpSnooping?.sourceGuardPorts).toEqual(['p0']);
  });
  it('port security learns the allowed MAC and shuts down a violating port', () => {
    const e = new SimulationEngine(),
      sw = e.addProfile('switch-l3'),
      t = new TerminalSession(e, sw.id);
    run(t, ['en', 'conf t', 'interface Gi0/1', 'switchport port-security', 'end']);
    expect(permitPortSecurity(e, sw, sw.interfaces[0], arp())).toBe(true);
    expect(permitPortSecurity(e, sw, sw.interfaces[0], arp('02:00:00:00:00:02'))).toBe(false);
    expect(sw.interfaces[0].errDisabled?.reason).toBe('psecure-violation');
    run(t, ['conf t', 'interface Gi0/1', 'shutdown', 'no shutdown', 'end']);
    expect(sw.interfaces[0].errDisabled).toBeUndefined();
  });
  it('root guard blocks a superior bridge instead of accepting its root', () => {
    const e = new SimulationEngine(),
      a = e.addDevice('switch'),
      b = e.addDevice('switch'),
      t = new TerminalSession(e, a.id);
    e.configureSpanningTree(a.id, 'rstp', 32768);
    e.configureSpanningTree(b.id, 'rstp', 0);
    run(t, ['en', 'conf t', 'interface Gi0/1', 'spanning-tree guard root', 'end']);
    e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
    e.advanceTo(5000);
    expect(a.spanningTree?.rootPort).toBeUndefined();
    expect(a.interfaces[0].spanningTree?.guardInconsistent).toBe('root');
    expect(a.interfaces[0].spanningTree?.state).toBe('discarding');
    validateSnapshot(e.snapshot());
  });
  it('loop guard blocks a silent former root port and recovers when BPDUs resume', () => {
    const e = new SimulationEngine(),
      a = e.addDevice('switch'),
      b = e.addDevice('switch'),
      t = new TerminalSession(e, a.id);
    e.configureSpanningTree(a.id, 'rstp', 32768);
    e.configureSpanningTree(b.id, 'rstp', 0);
    run(t, ['en', 'conf t', 'spanning-tree loopguard default', 'end']);
    e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
    e.advanceTo(5000);
    expect(a.spanningTree?.rootPort).toBe('p0');
    while (e.state.queue[0]?.at <= 15000) {
      e.state.queue = e.state.queue.filter(
        (q) => !(q.action.kind === 'deliver' && q.action.from === b.id && q.action.frame.bpdu)
      );
      e.step();
    }
    expect(a.interfaces[0].spanningTree?.guardInconsistent).toBe('loop');
    expect(a.interfaces[0].spanningTree?.state).toBe('discarding');
    e.advanceTo(22000);
    expect(a.interfaces[0].spanningTree?.guardInconsistent).toBeUndefined();
    expect(a.spanningTree?.rootPort).toBe('p0');
    validateSnapshot(e.snapshot());
  });
});
