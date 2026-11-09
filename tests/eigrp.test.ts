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
 * R1 - R2 - R3 triangle with a slow R1-R3 link (delay 1000): R1 reaches R3's networks through R2,
 * with R3 itself as a feasible successor for 3.3.3.3. R3 summarizes 172.16.0.0/16 towards R2.
 */
function triangle() {
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
  e.connect({ device: r1.id, port: port(r1, 'Gi0/2') }, { device: r3.id, port: port(r3, 'Gi0/2') });
  const [t1, t2, t3] = routers.map((d) => {
    const t = new TerminalSession(e, d.id);
    ok(t, ['enable', 'configure terminal']);
    return t;
  });
  ok(t1, [
    'hostname R1',
    'interface Loopback0',
    'ip address 1.1.1.1 255.255.255.255',
    'interface g0/1',
    'ip address 10.0.12.1 255.255.255.0',
    'interface g0/2',
    'ip address 10.0.13.1 255.255.255.0',
    'delay 1000',
    'router eigrp 100',
    'network 10.0.0.0',
    'network 1.1.1.1 0.0.0.0',
    'eigrp router-id 1.1.1.1',
    'passive-interface Loopback0',
    'end',
  ]);
  ok(t2, [
    'hostname R2',
    'interface lo0',
    'ip address 2.2.2.2 255.255.255.255',
    'interface g0/1',
    'ip address 10.0.12.2 255.255.255.0',
    'interface g0/2',
    'ip address 10.0.23.2 255.255.255.0',
    'router eigrp 100',
    'network 10.0.0.0 255.0.0.0',
    'network 2.2.2.2 0.0.0.0',
    'end',
  ]);
  ok(t3, [
    'hostname R3',
    'interface lo0',
    'ip address 3.3.3.3 255.255.255.255',
    'interface lo1',
    'ip address 172.16.1.1 255.255.255.0',
    'interface lo2',
    'ip address 172.16.2.1 255.255.255.0',
    'interface g0/1',
    'ip address 10.0.23.3 255.255.255.0',
    'ip summary-address eigrp 100 172.16.0.0 255.255.0.0',
    'interface g0/2',
    'ip address 10.0.13.3 255.255.255.0',
    'exit',
    'ip route 192.168.99.0 255.255.255.0 Null0',
    'router eigrp 100',
    'network 10.0.0.0',
    'network 3.3.3.3 0.0.0.0',
    'network 172.16.0.0',
    'redistribute static',
    'end',
  ]);
  const advance = (ms: number) => e.advanceTo(e.state.clock + ms, 3_000_000);
  advance(30_000);
  return { e, routers, terminals: [t1, t2, t3], advance };
}

describe('EIGRP for IPv4 (DUAL)', () => {
  it('forms adjacencies and installs routes with the classic composite metric', () => {
    const {
      e,
      terminals: [t1, t2, t3],
    } = triangle();
    validateSnapshot(e.snapshot());
    const neighbors = t1.execute('show ip eigrp neighbors');
    expect(neighbors).toMatch(
      /^EIGRP-IPv4 Neighbors for AS\(100\)\nH {3}Address {17}Interface {14}Hold Uptime {3}SRTT {3}RTO {2}Q {2}Seq\n {51}\(sec\) {9}\(ms\) {7}Cnt Num\n/
    );
    expect(neighbors).toMatch(/^0 {3}10\.0\.1[23]\.[23] {15}Gi0\/[12] +\d+ 00:00:\d\d +\d+ +\d+ +0 +\d+$/m);
    expect(neighbors).toMatch(/^\d +10\.0\.12\.2 +Gi0\/1 +\d+ 00:00:\d\d +\d+ +\d+ +0 +\d+$/m);
    expect(neighbors).toMatch(/^\d +10\.0\.13\.3 +Gi0\/2 +\d+ 00:00:\d\d +\d+ +\d+ +0 +\d+$/m);
    const topology = t1.execute('show ip eigrp topology');
    expect(topology).toContain('EIGRP-IPv4 Topology Table for AS(100)/ID(1.1.1.1)\n');
    // GigabitEthernet: 256 x (10^7/10^6 + 1 + 1) = 3072; a loopback adds 500 tens of microseconds.
    expect(topology).toContain(
      'P 10.0.23.0/24, 1 successors, FD is 3072\n        via 10.0.12.2 (3072/2816), GigabitEthernet0/1\n'
    );
    // R3 is a feasible successor for 3.3.3.3: its reported distance 128256 is below the FD.
    expect(topology).toContain(
      'P 3.3.3.3/32, 1 successors, FD is 131072\n        via 10.0.12.2 (131072/130816), GigabitEthernet0/1\n        via 10.0.13.3 (386560/128256), GigabitEthernet0/2\n'
    );
    expect(topology).toContain(
      'P 1.1.1.1/32, 1 successors, FD is 128256\n        via Connected, Loopback0\n'
    );
    expect(t1.execute('show ip route eigrp')).toMatch(
      /^D {8}2\.2\.2\.2 \[90\/130816\] via 10\.0\.12\.2, \d\d:\d\d:\d\d, GigabitEthernet0\/1$/m
    );
    // R3 advertises only the summary towards R2 and installs it to Null0.
    expect(t3.execute('show ip route eigrp')).toContain('D        172.16.0.0/16 is a summary, Null0');
    expect(t3.execute('show ip eigrp topology')).toContain(
      'P 172.16.0.0/16, 1 successors, FD is 128256\n        via Summary (128256/0), Null0\n'
    );
    expect(t2.execute('show ip route eigrp')).toMatch(
      /^D {8}172\.16\.0\.0\/16 \[90\/130816\] via 10\.0\.23\.3,/m
    );
    // Redistributed static routes are external: D EX with distance 170.
    expect(t1.execute('show ip route eigrp')).toMatch(/^D EX +192\.168\.99\.0(?:\/24)? \[170\/\d+\] via /m);
    expect(t1.execute('show logging')).toContain(
      '%DUAL-5-NBRCHANGE: EIGRP-IPv4 100: Neighbor 10.0.12.2 (GigabitEthernet0/1) is up: new adjacency'
    );
    expect(t1.execute('ping 3.3.3.3')).toContain('Success rate is 100 percent (5/5)');
    expect(t1.execute('show ip protocols')).toContain('Routing Protocol is "eigrp 100"\n');
    expect(t1.execute('show ip protocols')).toContain('    Metric weight K1=1, K2=0, K3=1, K4=0, K5=0\n');
  });
  it('switches to a feasible successor at once and queries when none exists', () => {
    const {
      e,
      routers: [r1],
      terminals: [t1],
      advance,
    } = triangle();
    const queries = e.device(r1.id).eigrp!.counters.querySent;
    ok(t1, ['configure terminal', 'interface g0/1', 'shutdown', 'end']);
    advance(5000);
    validateSnapshot(e.snapshot());
    const routes = t1.execute('show ip route eigrp');
    expect(routes).toMatch(/^D {8}3\.3\.3\.3 \[90\/386560\] via 10\.0\.13\.3,/m);
    expect(routes).toMatch(/^D {8}2\.2\.2\.2 \[90\/386816\] via 10\.0\.13\.3,/m);
    // 2.2.2.2 had no feasible successor (R3's reported distance equals the FD): DUAL went active.
    expect(e.device(r1.id).eigrp!.counters.querySent).toBeGreaterThan(queries);
    expect(e.device(r1.id).eigrp!.topology.every((t) => t.state === 'passive')).toBe(true);
    expect(t1.execute('show logging')).toContain(
      '%DUAL-5-NBRCHANGE: EIGRP-IPv4 100: Neighbor 10.0.12.2 (GigabitEthernet0/1) is down: interface down'
    );
    expect(t1.execute('ping 2.2.2.2')).toContain('Success rate is 100 percent (5/5)');
    ok(t1, ['configure terminal', 'interface g0/1', 'no shutdown', 'end']);
    advance(10_000);
    expect(t1.execute('show ip route eigrp')).toMatch(/^D {8}2\.2\.2\.2 \[90\/130816\] via 10\.0\.12\.2,/m);
  });
  it('requires matching MD5 authentication and K values, honours stub and passive interfaces', () => {
    const {
      e,
      routers: [r1, r2, r3],
      terminals: [t1, t2, t3],
      advance,
    } = triangle();
    const peers = (t: TerminalSession) =>
      (t.execute('show ip eigrp neighbors').match(/^\d+ +[\d.]+/gm) ?? []).length;
    ok(t2, [
      'configure terminal',
      'key chain EIGRP-KEYS',
      'key 1',
      'key-string s3cret',
      'interface g0/2',
      'ip authentication mode eigrp 100 md5',
      'ip authentication key-chain eigrp 100 EIGRP-KEYS',
      'end',
    ]);
    advance(20_000);
    expect(peers(t2)).toBe(1);
    ok(t3, [
      'configure terminal',
      'key chain EIGRP-KEYS',
      'key 1',
      'key-string s3cret',
      'interface g0/1',
      'ip authentication mode eigrp 100 md5',
      'ip authentication key-chain eigrp 100 EIGRP-KEYS',
      'end',
    ]);
    advance(10_000);
    expect(peers(t2)).toBe(2);
    expect(t2.execute('show ip eigrp interfaces detail')).toContain(
      '  Authentication mode is md5,  key-chain is "EIGRP-KEYS"'
    );
    // Mismatched metric weights tear the adjacency down.
    ok(t1, ['configure terminal', 'router eigrp 100', 'metric weights 0 1 1 1 0 0', 'end']);
    advance(10_000);
    expect(peers(t1)).toBe(0);
    expect(e.device(r2.id).eigrp!.neighbors.some((n) => n.address === '10.0.12.1')).toBe(false);
    ok(t1, ['configure terminal', 'router eigrp 100', 'no metric weights', 'end']);
    advance(10_000);
    expect(peers(t1)).toBe(2);
    // A stub router is not queried and advertises only connected and summary routes.
    ok(t3, ['configure terminal', 'router eigrp 100', 'eigrp stub', 'end']);
    advance(10_000);
    expect(t1.execute('show ip eigrp neighbors detail')).toContain(
      '   Stub Peer Advertising (CONNECTED SUMMARY ) Routes\n   Suppressing queries'
    );
    expect(t1.execute('show ip route eigrp')).not.toContain('192.168.99.0');
    // A passive interface keeps its network but sends no Hellos.
    ok(t1, ['configure terminal', 'router eigrp 100', 'passive-interface g0/2', 'end']);
    advance(20_000);
    expect(e.device(r1.id).eigrp!.neighbors.map((n) => n.address)).toEqual(['10.0.12.2']);
    expect(e.device(r3.id).eigrp!.neighbors.map((n) => n.address)).toEqual(['10.0.23.2']);
    expect(t1.execute('show ip eigrp interfaces')).not.toContain('Gi0/2');
    expect(e.device(r1.id).eigrp!.topology.some((t) => t.network === '10.0.13.0' && t.local)).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('keeps the configuration across write memory and reload, and redistributes into OSPF', () => {
    const {
      e,
      routers,
      terminals: [t1, t2, t3],
      advance,
    } = triangle();
    const running = t3.execute('show running-config');
    expect(running).toContain(
      '!\nrouter eigrp 100\n network 10.0.0.0\n network 3.3.3.3 0.0.0.0\n network 172.16.0.0\n redistribute static\n!\n'
    );
    expect(running).toContain(
      'interface GigabitEthernet0/1\n ip address 10.0.23.3 255.255.255.0\n ip summary-address eigrp 100 172.16.0.0 255.255.0.0\n!'
    );
    expect(t1.execute('show running-config')).toContain(
      'interface GigabitEthernet0/2\n ip address 10.0.13.1 255.255.255.0\n delay 1000\n!'
    );
    expect(t2.execute('show running-config')).toContain('\n network 10.0.0.0 0.255.255.255\n');
    const before = t1.execute('show running-config');
    for (const t of [t1, t2, t3]) ok(t, ['write memory', 'reload', '']);
    advance(61_000);
    advance(30_000);
    for (const r of routers) expect(e.device(r.id).bootLog).toEqual([]);
    const t = new TerminalSession(e, routers[0].id);
    ok(t, ['enable']);
    expect(t.execute('show ip route eigrp')).toMatch(/^D {8}2\.2\.2\.2 \[90\/130816\] via 10\.0\.12\.2,/m);
    expect(t.execute('show running-config')).toBe(before);
    // OSPF on R2 learns the EIGRP routes as externals.
    const t2b = new TerminalSession(e, routers[1].id);
    ok(t2b, ['enable', 'configure terminal', 'router ospf 1', 'redistribute eigrp 100 subnets', 'end']);
    expect(e.device(routers[1].id).ospf!.redistribute).toEqual([{ source: 'eigrp', process: 100 }]);
    validateSnapshot(e.snapshot());
  });
  it('sends RFC 7868 packets: Hello parameters, Update route TLVs and acknowledgements', () => {
    const { e } = triangle();
    const frames = e.state.events.filter((v) => v.type === 'EIGRP_SENT' && v.frame).map((v) => v.frame!);
    const hello = frames.find((f) => f.packet?.protocol === 'EIGRP' && f.packet.message.opcode === 'hello')!;
    const update = frames.find(
      (f) =>
        f.packet?.protocol === 'EIGRP' &&
        f.packet.message.opcode === 'update' &&
        f.packet.message.routes.length
    )!;
    expect(hello.dst).toBe('01:00:5e:00:00:0a');
    const decodedHello = decodeEthernet(encodeEthernet(hello));
    expect(decodedHello.protocol).toBe(88);
    expect(decodedHello.eigrp).toMatchObject({ opcode: 5, asn: 100, k: [1, 0, 1, 0, 0], holdTime: 15 });
    const decodedUpdate = decodeEthernet(encodeEthernet(update));
    expect(decodedUpdate.eigrp!.opcode).toBe(1);
    expect(decodedUpdate.eigrp!.routes.length).toBe(
      update.packet?.protocol === 'EIGRP' && 'routes' in update.packet.message
        ? update.packet.message.routes.length
        : -1
    );
    expect(frames.some((f) => f.packet?.protocol === 'EIGRP' && f.packet.message.opcode === 'ack')).toBe(
      true
    );
  });
});
