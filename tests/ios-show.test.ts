import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  makeTemplate,
  validateSnapshot,
} from '../packages/simulation-engine/src';

const run = (t: TerminalSession, lines: string[]) => {
  for (const line of lines) expect(t.execute(line), line).not.toMatch(/^%/);
};
/** R1 Gi0/1 — 10.0.12.0/30 — R2, each with a PC LAN /24 on Gi0/2 and a loopback, running OSPF. */
function twoRouters() {
  const e = new SimulationEngine();
  const routers = [1, 2].map((n) => {
    const r = e.addFactoryProfile('router', { x: n * 200, y: 0 });
    e.setDevicePower(r.id, true);
    return r;
  });
  e.connect({ device: routers[0].id, port: 'p0' }, { device: routers[1].id, port: 'p0' });
  const pcs = routers.map((r, i) => {
    const pc = e.addDevice('pc');
    Object.assign(pc.interfaces[0], { ip: `192.168.${i + 1}0.10`, prefix: 24 });
    pc.gateway = `192.168.${i + 1}0.1`;
    e.connect({ device: pc.id, port: 'p0' }, { device: r.id, port: 'p1' });
    return pc;
  });
  const terminals = routers.map((r, i) => {
    const n = i + 1,
      t = new TerminalSession(e, r.id);
    run(t, [
      'enable',
      'configure terminal',
      `hostname R${n}`,
      'interface Gi0/1',
      `ip address 10.0.12.${n} 255.255.255.252`,
      'ip ospf network point-to-point',
      'interface Gi0/2',
      `ip address 192.168.${n}0.1 255.255.255.0`,
      'interface Loopback0',
      `ip address 10.255.0.${n} 255.255.255.255`,
      'router ospf 1',
      `router-id 10.255.0.${n}`,
      'network 0.0.0.0 255.255.255.255 area 0',
      'end',
    ]);
    return t;
  });
  e.advanceTo(60000, 2_000_000);
  return { e, routers, terminals, pcs };
}

describe('IOS show output formats', () => {
  it('show ip route has the code legend, gateway of last resort and classful grouping', () => {
    const { terminals } = twoRouters();
    const t = terminals[0];
    run(t, ['configure terminal', 'ip route 0.0.0.0 0.0.0.0 10.0.12.2', 'end']);
    const out = t.execute('show ip route');
    expect(out).toMatch(/^Codes: L - local, C - connected, S - static/);
    expect(out).toContain('\nGateway of last resort is 10.0.12.2 to network 0.0.0.0\n');
    expect(out).toMatch(/^S\*\s{4}0\.0\.0\.0\/0 \[1\/0\] via 10\.0\.12\.2$/m);
    expect(out).toMatch(/^ {6}10\.0\.0\.0\/8 is variably subnetted, 4 subnets, 2 masks$/m);
    expect(out).toMatch(/^C {8}10\.0\.12\.0\/30 is directly connected, GigabitEthernet0\/1$/m);
    expect(out).toMatch(/^L {8}10\.0\.12\.1\/32 is directly connected, GigabitEthernet0\/1$/m);
    expect(out).toMatch(/^O {8}10\.255\.0\.2\/32 \[110\/\d+\] via 10\.0\.12\.2, GigabitEthernet0\/1$/m);
    expect(out).toMatch(/^O {5}192\.168\.20\.0\/24 \[110\/\d+\] via 10\.0\.12\.2, GigabitEthernet0\/1$/m);
    expect(out).toMatch(/^ {6}192\.168\.10\.0\/24 is variably subnetted, 2 subnets, 2 masks$/m);
    expect(out).not.toMatch(/^L\s+10\.255\.0\.1\/32/m);
  });

  it('a switch without ip routing shows its default gateway', () => {
    const e = new SimulationEngine();
    const sw = e.addFactoryProfile('access');
    e.setDevicePower(sw.id, true);
    const t = new TerminalSession(e, sw.id);
    run(t, ['enable', 'configure terminal', 'ip default-gateway 10.1.99.1', 'end']);
    expect(t.execute('show ip route')).toMatch(/^Default gateway is 10\.1\.99\.1\n/);
  });

  it('show ip ospf neighbor shows priority, state/role, dead time and full interface name', () => {
    const { terminals } = twoRouters();
    expect(terminals[0].execute('show ip ospf neighbor')).toMatch(
      /^10\.255\.0\.2\s+1\s+FULL\/ {2}-\s+00:00:\d\d\s+10\.0\.12\.2\s+GigabitEthernet0\/1$/m
    );
  });

  it('show ip bgp marks valid and best paths and locally originated networks', () => {
    const e = new SimulationEngine(makeTemplate('bgp'));
    e.advanceTo(30000, 2_000_000);
    const router = e.state.devices.find((d) => d.bgp?.networks.length)!;
    const t = new TerminalSession(e, router.id);
    run(t, ['enable']);
    const table = t.execute('show ip bgp');
    expect(table).toContain('     Network          Next Hop            Metric LocPrf Weight Path');
    expect(table).toMatch(/^ \*> {2}\S+\s+0\.0\.0\.0\s+0\s+32768 i$/m);
    // A best path learned from a peer; it may follow another path of the same prefix (blank Network).
    expect(table).toMatch(/^ \*> {2}\S*\s+\d+\.\d+\.\d+\.\d+\s+\d+\s+0 \d+.* i$/m);
    expect(table).toMatch(/^ \* {3}\S*\s+\d+\.\d+\.\d+\.\d+\s+\d+\s+0 \d+.* i$/m);
    expect(t.execute('show ip bgp summary')).toMatch(/^Neighbor\s+V\s+AS MsgRcvd MsgSent/m);
    expect(t.execute('show ip bgp neighbors')).toMatch(
      /^BGP neighbor is \S+, {2}remote AS \d+, (in|ex)ternal link/m
    );
  });

  it('show spanning-tree and show vlan brief use the per-VLAN IOS layouts', () => {
    const e = new SimulationEngine();
    const sw = e.addFactoryProfile('access');
    e.setDevicePower(sw.id, true);
    const pc = e.addDevice('pc');
    e.connect({ device: pc.id, port: 'p0' }, { device: sw.id, port: 'p0' });
    const t = new TerminalSession(e, sw.id);
    run(t, [
      'enable',
      'configure terminal',
      'vlan 10',
      'name USERS',
      'interface Gi0/1',
      'switchport access vlan 10',
      'spanning-tree portfast',
      'end',
    ]);
    e.advanceTo(5000, 500000);
    const stp = t.execute('show spanning-tree vlan 10');
    expect(stp).toMatch(/^VLAN0010\n {2}Spanning tree enabled protocol rstp\n/);
    expect(stp).toContain('This bridge is the root');
    expect(stp).toMatch(/Bridge ID {2}Priority {4}32778 {2}\(priority 32768 sys-id-ext 10\)/);
    expect(stp).toMatch(/^Gi0\/1\s+Desg FWD 4\s+128\.1\s+P2p Edge$/m);
    const vlans = t.execute('show vlan brief');
    expect(vlans).toMatch(/^10 {3}USERS {28}active {4}Gi0\/1$/m);
    expect(vlans).toMatch(/^1 {4}default {26}active {4}Gi0\/2, Gi0\/3/m);
    expect(vlans).toContain('1002 fddi-default');
  });

  it('show access-lists prints IOS entries with match counts', () => {
    const e = new SimulationEngine();
    const r = e.addFactoryProfile('router');
    e.setDevicePower(r.id, true);
    const t = new TerminalSession(e, r.id);
    run(t, [
      'enable',
      'configure terminal',
      'access-list 10 permit 10.0.0.0 0.255.255.255',
      'ip access-list extended EDGE',
      'deny tcp any host 10.1.1.1 eq 22',
      'permit ip any any',
      'end',
    ]);
    e.device(r.id).accessLists!.find((a) => a.name === 'EDGE')!.rules[1].hits = 3;
    const out = t.execute('show access-lists');
    expect(out).toContain('Standard IP access list 10\n    10 permit 10.0.0.0, wildcard bits 0.255.255.255');
    expect(out).toContain(
      'Extended IP access list EDGE\n    10 deny tcp any host 10.1.1.1 eq 22\n    20 permit ip any any (3 matches)'
    );
    expect(t.execute('show ip access-lists EDGE').split('\n')[0]).toBe('Extended IP access list EDGE');
  });
});

describe('synchronous ping and traceroute', () => {
  it('IOS ping waits for the replies and prints !!!!! with statistics', () => {
    const { e, terminals } = twoRouters();
    const out = terminals[0].execute('ping 10.255.0.2 repeat 3 size 200 source Loopback0');
    expect(out).toContain('Sending 3, 200-byte ICMP Echos to 10.255.0.2, timeout is 2 seconds:');
    expect(out).toContain('Packet sent with a source address of 10.255.0.1');
    expect(out).toMatch(/^!!!$/m);
    expect(out).toMatch(/Success rate is 100 percent \(3\/3\), round-trip min\/avg\/max = \d+\/\d+\/\d+ ms/);
    validateSnapshot(e.snapshot());
  });

  it('a lost echo prints a dot without waiting for the whole timeout', () => {
    const { e, terminals } = twoRouters();
    const start = e.state.clock;
    const out = terminals[0].execute('ping 192.168.20.77');
    expect(out).toMatch(/^\.\.\.\.\.$/m);
    expect(out).toContain('Success rate is 0 percent (0/5)');
    expect(e.state.clock - start).toBeLessThan(10000);
  });

  it('traceroute lists each hop until the destination', () => {
    const { terminals } = twoRouters();
    const out = terminals[0].execute('traceroute 192.168.20.10');
    expect(out).toContain('Tracing the route to 192.168.20.10');
    expect(out).toMatch(/^ {2}1 10\.0\.12\.2 \d+ msec \d+ msec \d+ msec$/m);
    expect(out).toMatch(/^ {2}2 192\.168\.20\.10 (\d+ msec|\*)( \d+ msec){2}$/m);
  });

  it('hosts print Windows-style replies and statistics', () => {
    const { e, pcs } = twoRouters();
    const t = new TerminalSession(e, pcs[0].id);
    // Routers drop the packet that triggers ARP resolution, so the first echo may time out (as on IOS).
    const out = t.execute('ping 192.168.20.10');
    expect(out).toContain('Pinging 192.168.20.10 with 32 bytes of data:');
    expect(out).toMatch(/^Reply from 192\.168\.20\.10: bytes=32 time=\d+ms$/m);
    expect(out).toMatch(/Packets: Sent = 4, Received = [34], Lost = [01] \((0|25)% loss\),/);
    expect(t.execute('tracert 192.168.20.10')).toMatch(
      /^ {2}3\s+\d+ ms\s+\d+ ms\s+\d+ ms {2}192\.168\.20\.10$/m
    );
  });
});
