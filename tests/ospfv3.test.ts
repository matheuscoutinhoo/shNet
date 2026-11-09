import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  validateSnapshot,
  type Device,
} from '../packages/simulation-engine/src';
import { decodeEthernet, encodeEthernet } from '../packages/simulation-engine/src/wire/ethernet-codec';

const ok = (t: TerminalSession, lines: string[]) => {
  for (const line of lines) expect(t.execute(line), line).not.toMatch(/^%/m);
};
/**
 * R1 =(area 0, broadcast)= R2 =(area 1, point-to-point)= R3. R2 is the ABR and, with priority 10,
 * the DR of the R1-R2 segment. R1 and R3 advertise IPv6 loopbacks.
 */
function lab() {
  const e = new SimulationEngine();
  const routers = [0, 1, 2].map((i) => {
    const d = e.addFactoryProfile('router', { x: i * 200, y: 0 });
    e.setDevicePower(d.id, true);
    return d;
  });
  const [r1, r2, r3] = routers;
  const port = (d: Device, name: string) => e.device(d.id).interfaces.find((p) => p.name === name)!.id;
  e.connect({ device: r1.id, port: port(r1, 'Gi0/1') }, { device: r2.id, port: port(r2, 'Gi0/1') });
  e.connect({ device: r2.id, port: port(r2, 'Gi0/2') }, { device: r3.id, port: port(r3, 'Gi0/1') });
  const [t1, t2, t3] = routers.map((d) => {
    const t = new TerminalSession(e, d.id);
    ok(t, ['enable', 'configure terminal', 'ipv6 unicast-routing']);
    return t;
  });
  ok(t1, [
    'hostname R1',
    'interface Loopback0',
    'ipv6 address 2001:db8:1::1/64',
    'ipv6 ospf 1 area 0',
    'interface g0/1',
    'ipv6 address 2001:db8:12::1/64',
    'ipv6 ospf 1 area 0',
    'ipv6 router ospf 1',
    'router-id 1.1.1.1',
    'end',
  ]);
  ok(t2, [
    'hostname R2',
    'ipv6 router ospf 1',
    'router-id 2.2.2.2',
    'interface g0/1',
    'ipv6 address 2001:db8:12::2/64',
    'ipv6 ospf 1 area 0',
    'ipv6 ospf priority 10',
    'interface g0/2',
    'ipv6 address 2001:db8:23::2/64',
    'ipv6 ospf 1 area 1',
    'ipv6 ospf network point-to-point',
    'end',
  ]);
  ok(t3, [
    'hostname R3',
    // No router-id: OSPFv3 takes the highest IPv4 loopback address, like IOS.
    'interface Loopback0',
    'ip address 3.3.3.3 255.255.255.255',
    'ipv6 address 2001:db8:3::3/64',
    'ipv6 ospf 1 area 1',
    'interface g0/1',
    'ipv6 address 2001:db8:23::3/64',
    'ipv6 ospf 1 area 1',
    'ipv6 ospf network point-to-point',
    'end',
  ]);
  const advance = (ms: number) => e.advanceTo(e.state.clock + ms, 3_000_000);
  // Broadcast segments wait a dead interval (40 s) before electing the DR.
  advance(60_000);
  return { e, routers, terminals: [t1, t2, t3], advance };
}

describe('OSPFv3 for IPv6', () => {
  it('forms adjacencies, elects the DR and installs intra- and inter-area routes', () => {
    const {
      e,
      routers: [r1],
      terminals: [t1, t2, t3],
      advance,
    } = lab();
    validateSnapshot(e.snapshot());
    const n1 = t1.execute('show ipv6 ospf neighbor');
    expect(n1).toContain('OSPFv3 1 address-family ipv6 (router-id 1.1.1.1)');
    expect(n1).toContain('Neighbor ID     Pri   State           Dead Time   Interface ID    Interface');
    expect(n1).toMatch(/^2\.2\.2\.2 {10}10 {3}FULL\/DR {9}00:00:3\d {4}1 {15}GigabitEthernet0\/1$/m);
    const n2 = t2.execute('show ipv6 ospf neighbor');
    expect(n2).toMatch(/^1\.1\.1\.1 +1 {3}FULL\/BDR +00:00:\d\d +1 +GigabitEthernet0\/1$/m);
    expect(n2).toMatch(/^3\.3\.3\.3 +1 {3}FULL\/- +00:00:\d\d +1 +GigabitEthernet0\/2$/m);
    expect(t2.execute('show ipv6 ospf interface brief')).toMatch(/^Gi0\/1 +1 +0 +1 +1 +DR +1\/1$/m);
    expect(t2.execute('show ipv6 ospf interface brief')).toMatch(/^Gi0\/2 +1 +1 +2 +1 +P2P +1\/1$/m);
    expect(t2.execute('show ipv6 ospf')).toContain(' It is an area border router');
    expect(t3.execute('show ipv6 ospf')).toContain(' Router ID 3.3.3.3');

    // R2 (ABR) sees both loopbacks as intra-area routes; loopbacks are advertised as /128.
    const route2 = t2.execute('show ipv6 route ospf');
    expect(route2).toMatch(
      /^O {3}2001:DB8:1::1\/128 \[110\/1\]\n {5}via FE80::[0-9A-F:]+, GigabitEthernet0\/1$/m
    );
    expect(route2).toMatch(
      /^O {3}2001:DB8:3::3\/128 \[110\/1\]\n {5}via FE80::[0-9A-F:]+, GigabitEthernet0\/2$/m
    );
    // R1 and R3 learn the other area through the ABR's inter-area-prefix LSAs.
    const route1 = t1.execute('show ipv6 route');
    expect(route1).toMatch(/^IPv6 Routing Table - default - \d+ entries$/m);
    expect(route1).toContain('O - OSPF Intra, OI - OSPF Inter');
    expect(route1).toMatch(
      /^OI {2}2001:DB8:3::3\/128 \[110\/2\]\n {5}via FE80::[0-9A-F:]+, GigabitEthernet0\/1$/m
    );
    expect(route1).toMatch(/^OI {2}2001:DB8:23::\/64 \[110\/2\]$/m);
    expect(route1).toMatch(
      /^C {3}2001:DB8:12::\/64 \[0\/0\]\n {5}via GigabitEthernet0\/1, directly connected$/m
    );
    expect(route1).toMatch(/^L {3}2001:DB8:12::1\/128 \[0\/0\]\n {5}via GigabitEthernet0\/1, receive$/m);
    expect(t3.execute('show ipv6 route ospf')).toMatch(/^OI {2}2001:DB8:1::1\/128 \[110\/2\]$/m);
    expect(t3.execute('show ipv6 route ospf')).toMatch(/^OI {2}2001:DB8:12::\/64 \[110\/2\]$/m);
    const database = t1.execute('show ipv6 ospf database');
    expect(database).toContain('Router Link States (Area 0)');
    expect(database).toContain('Inter Area Prefix Link States (Area 0)');
    expect(database).toMatch(/^2\.2\.2\.2 +\d+ +0x8000000\d +2001:DB8:3::3\/128$/m);

    // End-to-end IPv6 forwarding across both areas.
    const probe = e.ping6(r1.id, '2001:db8:3::3');
    advance(2_000);
    expect(e.state.probes6?.find((p) => p.id === probe)?.status).toBe('success');
    expect(t1.execute('show logging')).toContain(
      '%OSPFv3-5-ADJCHG: Process 1, IPv6, Nbr 2.2.2.2 on GigabitEthernet0/1 from LOADING to FULL, Loading Done'
    );
  });

  it('withdraws inter-area routes when the area 1 adjacency fails and relearns them', () => {
    const {
      terminals: [t1, t2],
      advance,
    } = lab();
    ok(t2, ['configure terminal', 'interface g0/2', 'shutdown', 'end']);
    advance(3_000);
    expect(t2.execute('show logging')).toContain(
      '%OSPFv3-5-ADJCHG: Process 1, IPv6, Nbr 3.3.3.3 on GigabitEthernet0/2 from FULL to DOWN, Neighbor Down: Interface down or detached'
    );
    expect(t1.execute('show ipv6 route')).not.toContain('2001:DB8:3::3/128');
    expect(t2.execute('show ipv6 ospf')).not.toContain('area border router');
    ok(t2, ['configure terminal', 'interface g0/2', 'no shutdown', 'end']);
    advance(25_000);
    expect(t1.execute('show ipv6 route')).toMatch(/^OI {2}2001:DB8:3::3\/128 \[110\/2\]$/m);
  });

  it('drops neighbors on hello mismatches and honours passive interfaces and costs', () => {
    const {
      terminals: [t1, t2, t3],
      advance,
    } = lab();
    ok(t3, ['configure terminal', 'interface g0/1', 'ipv6 ospf hello-interval 5', 'end']);
    advance(45_000);
    expect(t3.execute('show ipv6 ospf neighbor')).not.toContain('2.2.2.2');
    expect(t3.execute('show logging')).toContain('Neighbor Down: Dead timer expired');
    expect(t1.execute('show ipv6 route')).not.toContain('2001:DB8:3::3/128');
    ok(t3, ['configure terminal', 'interface g0/1', 'no ipv6 ospf hello-interval', 'end']);
    ok(t1, ['configure terminal', 'interface g0/1', 'ipv6 ospf cost 50', 'end']);
    advance(30_000);
    expect(t1.execute('show ipv6 route')).toMatch(/^OI {2}2001:DB8:3::3\/128 \[110\/51\]$/m);
    ok(t2, ['configure terminal', 'ipv6 router ospf 1', 'passive-interface GigabitEthernet0/2', 'end']);
    advance(5_000);
    expect(t2.execute('show ipv6 ospf neighbor')).not.toContain('3.3.3.3');
    // The passive interface's prefix is still advertised.
    expect(t1.execute('show ipv6 route')).toMatch(/^OI {2}2001:DB8:23::\/64 \[110\/51\]$/m);
  });

  it('keeps the configuration across write memory and reload', () => {
    const {
      e,
      routers,
      terminals: [t1, t2, t3],
      advance,
    } = lab();
    const config = t2.execute('show running-config');
    expect(config).toContain('ipv6 unicast-routing');
    expect(config).toMatch(
      /interface GigabitEthernet0\/1\n(?: .*\n)* ipv6 ospf 1 area 0\n ipv6 ospf priority 10\n/
    );
    expect(config).toMatch(
      /interface GigabitEthernet0\/2\n(?: .*\n)* ipv6 ospf 1 area 1\n ipv6 ospf network point-to-point\n/
    );
    expect(config).toContain('ipv6 router ospf 1\n router-id 2.2.2.2\n!');
    for (const t of [t1, t2, t3]) ok(t, ['write memory', 'reload', '']);
    advance(61_000);
    advance(60_000);
    for (const r of routers) expect(e.device(r.id).bootLog).toEqual([]);
    const t = new TerminalSession(e, routers[0].id);
    expect(t.execute('show ipv6 ospf neighbor')).toMatch(/^2\.2\.2\.2 +10 {3}FULL\/DR/m);
    expect(t.execute('show ipv6 route')).toMatch(/^OI {2}2001:DB8:3::3\/128 \[110\/2\]$/m);
    validateSnapshot(e.snapshot());
  });

  it('shows IPv6 interfaces and neighbors like IOS and filters OSPFv3 with traffic filters', () => {
    const {
      e,
      routers: [r1],
      terminals: [t1, t2],
      advance,
    } = lab();
    const brief = t2.execute('show ipv6 interface brief');
    expect(brief).toMatch(/^GigabitEthernet0\/1 {5}\[up\/up\]\n {4}FE80::[0-9A-F:]+\n {4}2001:DB8:12::2$/m);
    expect(brief).toMatch(/^GigabitEthernet0\/\d {5}\[down\/down\]\n {4}unassigned$/m);
    const detail = t2.execute('show ipv6 interface g0/1');
    expect(detail).toMatch(
      /^GigabitEthernet0\/1 is up, line protocol is up\n {2}IPv6 is enabled, link-local address is FE80::/
    );
    expect(detail).toContain(
      '  Global unicast address(es):\n    2001:DB8:12::2, subnet is 2001:DB8:12::/64\n'
    );
    // A router joins all-routers, OSPFv3 AllSPFRouters and, as DR, AllDRouters.
    expect(detail).toMatch(
      /Joined group address\(es\):\n {4}FF02::1\n {4}FF02::2\n {4}FF02::5\n {4}FF02::6\n {4}FF02::1:FF/
    );
    expect(detail).toContain('  MTU is 1500 bytes');
    e.ping6(r1.id, '2001:db8:12::2');
    advance(1_000);
    expect(t1.execute('show ipv6 neighbors')).toMatch(
      /^IPv6 Address {30}Age Link-layer Addr State Interface\n(?:.*\n)*2001:DB8:12::2 {28} {2}0 [0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4} {2}REACH Gi0\/1$/m
    );
    // An inbound filter that only permits ICMPv6 drops OSPFv3: the adjacency dies on the dead timer.
    ok(t1, [
      'configure terminal',
      'interface g0/1',
      'ipv6 traffic-filter in permit ndp ::/0 ::/0',
      'ipv6 traffic-filter in permit echo-request ::/0 ::/0',
      'end',
    ]);
    advance(45_000);
    expect(t1.execute('show ipv6 ospf neighbor')).not.toContain('2.2.2.2');
    ok(t1, ['configure terminal', 'interface g0/1', 'ipv6 traffic-filter in permit ospf ::/0 ::/0', 'end']);
    advance(60_000);
    expect(t1.execute('show ipv6 ospf neighbor')).toMatch(/^2\.2\.2\.2 +10 {3}FULL\/DR/m);
  });

  it('requires IPv6 routing and encodes OSPFv3 on the wire (next header 89)', () => {
    const e = new SimulationEngine();
    const d = e.addFactoryProfile('router', { x: 0, y: 0 });
    e.setDevicePower(d.id, true);
    const t = new TerminalSession(e, d.id);
    ok(t, ['enable', 'configure terminal']);
    expect(t.execute('ipv6 router ospf 1')).toContain('% IPv6 routing not enabled');
    const { e: lab1, routers } = lab();
    const frames = lab1.state.events.map((x) => x.frame).filter((f) => f?.ipv6?.protocol === 'OSPFv3');
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames.slice(0, 20)) {
      const decoded = decodeEthernet(encodeEthernet(f!));
      expect(decoded.protocol).toBe(89);
      expect(decoded.ospf3?.routerId).toBe((f!.ipv6 as { routerId: string }).routerId);
    }
    expect(routers).toHaveLength(3);
  });
});
