import { describe, it, expect } from 'vitest';
import {
  LIMITS,
  SimulationEngine,
  SimulationRunner,
  ScenarioRunner,
  applySimulationDelta,
  validateSnapshot,
  TerminalSession,
  makeTemplate,
  type Device,
} from '../packages/simulation-engine/src';
import { type7Decode, type7Encode } from '../packages/simulation-engine/src/cli/secrets';
import { decodePcap, exportPcap } from '../packages/simulation-engine/src/wire/pcap';

const ok = (t: TerminalSession, lines: string[]) => {
  for (const line of lines) expect(t.execute(line), line).not.toMatch(/^%/m);
};
/** Several powered factory devices in one lab, each with a privileged terminal in global configuration. */
function lab(...profiles: string[]) {
  const e = new SimulationEngine();
  const devices = profiles.map((profile, i) => {
    const d = e.addFactoryProfile(profile, { x: i * 200, y: 0 });
    e.setDevicePower(d.id, true);
    return d;
  });
  const terminals = devices.map((d) => {
    const t = new TerminalSession(e, d.id);
    ok(t, ['enable', 'configure terminal']);
    return t;
  });
  const cable = (a: Device, ap: string, b: Device, bp: string) => {
    const pa = e.device(a.id).interfaces.find((p) => p.name === ap)!;
    const pb = e.device(b.id).interfaces.find((p) => p.name === bp)!;
    const optical = pa.media !== 'rj45';
    if (optical) for (const p of [pa, pb]) p.transceiver = 'single-mode';
    return e.connect(
      { device: a.id, port: pa.id },
      { device: b.id, port: pb.id },
      optical ? 'fiber-sm' : 'copper'
    );
  };
  return {
    e,
    devices,
    terminals,
    cable,
    advance: (ms: number) => e.advanceTo(e.state.clock + ms, 2_000_000),
  };
}

describe('spanning tree and routed switch ports', () => {
  it('a routed switch port discards BPDUs instead of crashing the engine', () => {
    const {
      devices: [a, b],
      terminals: [ta, tb],
      cable,
      advance,
      e,
    } = lab('distribution', 'distribution');
    cable(a, 'Fo0/27', b, 'Fo0/27');
    // One end routed, the other still a Rapid-PVST switchport sending BPDUs.
    ok(ta, [
      'interface Fo0/27',
      'no switchport',
      'ip address 10.0.0.1 255.255.255.252',
      'no shutdown',
      'end',
    ]);
    expect(() => advance(30000)).not.toThrow();
    // Both ends routed with OSPF: the adjacency forms over the former switch link.
    ok(tb, [
      'ip routing',
      'interface Fo0/27',
      'no switchport',
      'ip address 10.0.0.2 255.255.255.252',
      'ip ospf 1 area 0',
      'end',
    ]);
    ok(ta, ['configure terminal', 'ip routing', 'interface Fo0/27', 'ip ospf 1 area 0', 'end']);
    expect(() => advance(60000)).not.toThrow();
    expect(ta.execute('show ip ospf neighbor')).toMatch(/FULL/);
    expect(e.device(a.id).interfaces.find((p) => p.name === 'Fo0/27')!.errDisabled).toBeUndefined();
  });
  it('BPDU Guard does not err-disable a routed port', () => {
    const {
      devices: [a, b],
      terminals: [ta],
      cable,
      advance,
      e,
    } = lab('access', 'access');
    ok(ta, [
      'interface Gi0/1',
      'spanning-tree bpduguard enable',
      'no switchport',
      'ip address 10.0.0.1 255.255.255.252',
      'end',
    ]);
    cable(a, 'Gi0/1', b, 'Gi0/1');
    expect(() => advance(10000)).not.toThrow();
    expect(e.device(a.id).interfaces.find((p) => p.name === 'Gi0/1')!.errDisabled).toBeUndefined();
  });
});

describe('startup-config lifecycle (write memory, reload)', () => {
  const RELOAD_MS = 60_000;
  it('write memory always saves the running-config, and reload restores it after the boot time', () => {
    const {
      e,
      devices: [r, sw],
      terminals: [t, ts],
      cable,
      advance,
    } = lab('edge', 'access');
    cable(r, 'Gi0/2', sw, 'Gi0/24');
    // Features that used to make write memory refuse: name servers, IPv6, ingress QoS,
    // zone firewall, floating static routes.
    ok(t, [
      'hostname EDGE-1',
      'ip name-server 10.2.50.53 10.3.50.53',
      'ipv6 unicast-routing',
      'interface Gi0/1',
      'ip address 198.51.100.2 255.255.255.252',
      'ipv6 address 2001:db8:1::1/64',
      'no shutdown',
      'interface Gi0/2',
      'ip address 10.1.0.1 255.255.255.0',
      'no shutdown',
      'ip route 10.9.0.0 255.255.0.0 10.1.0.254 250',
      'class-map match-any VOICE',
      'match dscp ef',
      'policy-map MARK',
      'class VOICE',
      'set dscp ef',
      'interface Gi0/2',
      'service-policy input MARK',
      'firewall mode zones',
      'firewall zone INSIDE Gi0/2',
      'firewall zone OUTSIDE Gi0/1',
      'firewall rule 10 INSIDE OUTSIDE inspect ip',
      'end',
    ]);
    const running = t.execute('show running-config');
    expect(t.execute('write memory')).toBe('Building configuration...\n[OK]');
    expect(t.execute('show startup-config')).toBe(
      `Using ${new TextEncoder().encode(running).length} out of 33554432 bytes\n${running}`
    );
    advance(5000);
    expect(t.execute('reload')).toBe('');
    expect(t.prompt).toBe('Proceed with reload? [confirm]');
    expect(t.execute('')).toMatch(
      /^\*Mar {2}1 \d\d:\d\d:\d\d\.\d{3}: %SYS-5-RELOAD: Reload requested by console/
    );
    // While booting the device is down: its links drop and the console only reports progress.
    const link = e.state.links[0];
    expect(e.device(r.id).power).toBe(false);
    expect(t.execute('enable')).toMatch(/is reloading; it boots from startup-config in \d+ s/);
    expect(ts.execute('do show interfaces status')).toMatch(/Gi0\/24\s+\S*\s*notconnect/);
    advance(RELOAD_MS);
    expect(e.device(r.id).power).toBe(true);
    expect(e.state.links).toContain(link);
    ok(t, ['enable']);
    expect(t.execute('show running-config')).toBe(running);
    expect(e.device(r.id).bootLog).toEqual([]);
  });
  it('reload asks to save only when the running-config differs from NVRAM', () => {
    const {
      terminals: [t],
      advance,
    } = lab('router');
    ok(t, ['hostname SAVED', 'end', 'write memory']);
    expect(t.execute('reload')).toBe('');
    expect(t.prompt).toBe('Proceed with reload? [confirm]');
    expect(t.execute('n')).toBe('');
    ok(t, ['configure terminal', 'hostname UNSAVED', 'end']);
    expect(t.execute('reload')).toBe('');
    expect(t.prompt).toBe('System configuration has been modified. Save? [yes/no]:');
    expect(t.execute('no')).toBe('');
    expect(t.execute('')).toMatch(/Reload requested/);
    advance(RELOAD_MS);
    ok(t, ['enable']);
    expect(t.prompt).toBe('SAVED#');
  });
  it('an L3 switch with routed uplinks reloads without crashing and its neighbor reconverges', () => {
    const {
      e,
      devices: [a, b],
      terminals: [ta, tb],
      cable,
      advance,
    } = lab('distribution', 'distribution');
    for (const [t, n] of [
      [ta, 1],
      [tb, 2],
    ] as const)
      ok(t, [
        'ip routing',
        'interface Fo0/27',
        'no switchport',
        `ip address 10.0.0.${n} 255.255.255.252`,
        'ip ospf 1 area 0',
        'no shutdown',
        'interface Gi0/1',
        'switchport mode trunk',
        'end',
        'write memory',
      ]);
    cable(a, 'Fo0/27', b, 'Fo0/27');
    cable(a, 'Gi0/1', b, 'Gi0/1');
    advance(60000);
    expect(tb.execute('show ip ospf neighbor')).toMatch(/FULL/);
    ok(ta, ['reload', '']);
    advance(5000);
    expect(tb.execute('show ip ospf neighbor')).not.toMatch(/FULL/);
    expect(() => advance(RELOAD_MS + 60000)).not.toThrow();
    expect(tb.execute('show ip ospf neighbor')).toMatch(/FULL/);
    expect(e.device(a.id).interfaces.find((p) => p.name === 'Fo0/27')!.mode).toBe('routed');
  });
  it('rejected startup-config lines are reported and the rest of the configuration still boots', () => {
    const {
      e,
      devices: [r],
      terminals: [t],
      advance,
    } = lab('router');
    ok(t, ['hostname R-BOOT', 'interface Gi0/1', 'description UPLINK', 'end', 'write memory']);
    e.device(r.id).startupConfig!.commands.splice(1, 0, 'this-is-not-ios');
    // NVRAM now differs from the running-config, so IOS asks whether to save first.
    ok(t, ['reload', 'no', '']);
    advance(RELOAD_MS);
    ok(t, ['enable']);
    expect(t.prompt).toBe('R-BOOT#');
    expect(t.execute('show running-config')).toContain(' description UPLINK');
    expect(e.device(r.id).bootLog).toEqual([expect.stringMatching(/^line 2: this-is-not-ios\n% /)]);
  });
});

describe('running-config layout and secrets', () => {
  const RELOAD_MS = 60_000;
  it('prints each interface once with all of its features and replays it identically', () => {
    const {
      e,
      devices: [sw],
      terminals: [t],
      advance,
    } = lab('distribution');
    ok(t, [
      'ip routing',
      'ipv6 unicast-routing',
      'vlan 10',
      'name USERS',
      'interface Vlan10',
      'description USERS-GW',
      'ip address 10.1.10.2 255.255.255.0',
      'ipv6 address 2001:db8:1:10::2/64',
      'ip helper-address 10.2.50.10',
      'standby version 2',
      'standby 10 ip 10.1.10.1',
      'standby 10 priority 110',
      'standby 10 preempt',
      'ip ospf 1 area 0',
      'no shutdown',
      'exit',
      'ipv6 route 2001:db8:99::/48 2001:db8:1:10::1',
      'router ospf 1',
      'router-id 10.255.0.1',
      'end',
    ]);
    const running = t.execute('show running-config'),
      lines = running.split('\n');
    expect(lines.filter((l) => l === 'interface Vlan10')).toHaveLength(1);
    const block = lines.slice(
      lines.indexOf('interface Vlan10'),
      lines.indexOf('exit', lines.indexOf('interface Vlan10'))
    );
    const at = (text: string) => block.findIndex((l) => l.startsWith(text));
    expect(at(' ip address 10.1.10.2')).toBeGreaterThan(0);
    for (const later of [' ipv6 address', ' ip helper-address', ' ip ospf 1 area 0', ' standby 10 ip'])
      expect(at(later), later).toBeGreaterThan(at(' ip address'));
    // Global commands that need interface addresses come after every interface.
    expect(lines.findIndex((l) => l.startsWith('ipv6 route '))).toBeGreaterThan(
      lines.findLastIndex((l) => l.startsWith('interface '))
    );
    ok(t, ['write memory', 'reload', '']);
    advance(RELOAD_MS);
    ok(t, ['enable']);
    expect(e.device(sw.id).bootLog).toEqual([]);
    expect(t.execute('show running-config')).toBe(running);
  });
  it('implements Cisco type 7 for service password-encryption', () => {
    expect(type7Decode('0822455D0A16')).toBe('cisco');
    for (const secret of ['cisco', 'Str0ng-K3y!', 'çãõ-utf8'])
      expect(type7Decode(type7Encode(secret))).toBe(secret);
    expect(() => type7Decode('99ZZ')).toThrow();
  });
  it('shows reversible secrets in clear text by default and as type 7 once encrypted, surviving reload', () => {
    const {
      e,
      devices: [r],
      terminals: [t],
      advance,
    } = lab('router');
    ok(t, [
      'key chain BFD-KEYS',
      'key 1',
      'key-string Chain-Key',
      'exit',
      'exit',
      'bfd-template single-hop FAST',
      'interval min-tx 300 min-rx 300 multiplier 3',
      'authentication sha-1 keychain BFD-KEYS',
      'exit',
      'interface Gi0/1',
      'ip address 192.0.2.1 255.255.255.252',
      'ip ospf message-digest-key 1 md5 Ospf-Key',
      'bfd template FAST',
      'exit',
      'router bgp 65001',
      'neighbor 192.0.2.2 remote-as 65002',
      'neighbor 192.0.2.2 password Bgp-Pass',
      'end',
    ]);
    const clear = t.execute('show running-config');
    for (const line of [
      ' ip ospf message-digest-key 1 md5 Ospf-Key',
      '  key-string Chain-Key',
      'neighbor 192.0.2.2 password Bgp-Pass',
      'bfd-template single-hop FAST',
      ' bfd template FAST',
    ])
      expect(clear).toContain(line);
    ok(t, ['configure terminal', 'service password-encryption', 'end']);
    const encrypted = t.execute('show running-config');
    expect(encrypted).toContain('service password-encryption');
    for (const secret of ['Ospf-Key', 'Chain-Key', 'Bgp-Pass']) expect(encrypted).not.toContain(secret);
    expect(encrypted).toContain(' ip ospf message-digest-key 1 md5 7 ' + type7Encode('Ospf-Key'));
    expect(encrypted).toContain('neighbor 192.0.2.2 password 7 ' + type7Encode('Bgp-Pass'));
    ok(t, ['write memory', 'reload', '']);
    advance(RELOAD_MS);
    ok(t, ['enable']);
    expect(t.execute('show running-config')).toBe(encrypted);
    const d = e.device(r.id);
    expect(d.interfaces.find((p) => p.name === 'Gi0/1')!.ospfAuthentication?.key).toBe('Ospf-Key');
    expect(d.keyChains?.[0].keys[0].keyString).toBe('Chain-Key');
    expect(d.interfaces.find((p) => p.name === 'Gi0/1')!.bfd?.template).toBe('FAST');
    expect(d.bgp?.neighbors[0].password).toBe('Bgp-Pass');
    // A type 7 string typed by hand (e.g. pasted from another router) is decoded.
    ok(t, ['configure terminal', 'router bgp 65001', 'neighbor 192.0.2.2 password 7 0822455D0A16', 'end']);
    expect(e.device(r.id).bgp?.neighbors[0].password).toBe('cisco');
  });
  it('IPsec tunnels are rebuilt from startup-config with their keys and come back up', () => {
    const e = new SimulationEngine(makeTemplate('sdwan')),
      a = e.state.devices.find((d) => d.hostname === 'WAN-A')!,
      t = new TerminalSession(e, a.id);
    e.advanceTo(30000, 2_000_000);
    ok(t, ['enable']);
    const running = t.execute('show running-config');
    ok(t, ['write memory', 'reload', '']);
    e.advanceTo(e.state.clock + RELOAD_MS + 30000, 2_000_000);
    ok(t, ['enable']);
    expect(e.device(a.id).bootLog).toEqual([]);
    expect(t.execute('show running-config')).toBe(running);
    const tunnels = e.device(a.id).interfaces.filter((p) => p.tunnel);
    expect(new Set(tunnels.map((p) => p.id)).size).toBe(tunnels.length);
    expect(tunnels.some((p) => p.tunnel!.status === 'up')).toBe(true);
  });
});

describe('BGP session rules (directly connected eBGP)', () => {
  /** R1 (AS 65001) peers with R2 (AS 65002, originates 8.8.8.0/24); R1 also has a default route via R3. */
  function edge(fallover: boolean) {
    const l = lab('router', 'router', 'router');
    const {
      devices: [r1, r2, r3],
      terminals: [t1, t2, t3],
      cable,
    } = l;
    cable(r1, 'Gi0/1', r2, 'Gi0/1');
    cable(r1, 'Gi0/2', r3, 'Gi0/1');
    ok(t1, [
      'interface Gi0/1',
      'ip address 10.0.12.1 255.255.255.252',
      'interface Gi0/2',
      'ip address 10.0.13.1 255.255.255.252',
      'exit',
      // The dead peer address stays resolvable through this default route.
      'ip route 0.0.0.0 0.0.0.0 10.0.13.2',
      'router bgp 65001',
      'bgp router-id 1.1.1.1',
      'neighbor 10.0.12.2 remote-as 65002',
      ...(fallover ? [] : ['no bgp fast-external-fallover']),
      'end',
    ]);
    ok(t2, [
      'interface Gi0/1',
      'ip address 10.0.12.2 255.255.255.252',
      'interface Gi0/3',
      'ip address 8.8.8.1 255.255.255.0',
      'router bgp 65002',
      'bgp router-id 2.2.2.2',
      'neighbor 10.0.12.1 remote-as 65001',
      'network 8.8.8.0 mask 255.255.255.0',
      'end',
    ]);
    ok(t3, ['interface Gi0/1', 'ip address 10.0.13.2 255.255.255.252', 'end']);
    l.advance(30000);
    const peer = () => l.e.device(r1.id).bgp!.peers[0];
    expect(peer().state).toBe('Established');
    expect(t1.execute('show ip bgp')).toContain('8.8.8.0/24');
    return { ...l, r1, r2, t1, peer };
  }
  it('drops a directly connected eBGP session as soon as its link goes down (fast-external-fallover)', () => {
    const { e, r2, t1, peer, advance } = edge(true);
    e.setDevicePower(r2.id, false);
    advance(1000);
    expect(peer().state).not.toBe('Established');
    // The learned path is gone, so it can no longer be re-advertised or loop through the default.
    expect(t1.execute('show ip bgp')).not.toContain('8.8.8.0/24');
    expect(
      e.state.events.some((v) => v.type === 'BGP_SESSION_CLOSED' && /fast-external-fallover/.test(v.reason))
    ).toBe(true);
  });
  it('with no bgp fast-external-fallover the session waits for the hold timer', () => {
    const { e, r2, t1, peer, advance } = edge(false);
    expect(t1.execute('show running-config')).toContain('no bgp fast-external-fallover');
    e.setDevicePower(r2.id, false);
    advance(5000);
    expect(peer().state).toBe('Established');
    advance(90000);
    expect(peer().state).not.toBe('Established');
  });
  it('eBGP between loopbacks needs ebgp-multihop, as on IOS', () => {
    const {
      e,
      devices: [r1, r2],
      terminals: [t1, t2],
      cable,
      advance,
    } = lab('router', 'router');
    cable(r1, 'Gi0/1', r2, 'Gi0/1');
    const side = (lo: string, ip: string, peerLo: string, peerIp: string, asn: number, remote: number) => [
      'interface Loopback0',
      `ip address ${lo} 255.255.255.255`,
      'interface Gi0/1',
      `ip address ${ip} 255.255.255.252`,
      'exit',
      `ip route ${peerLo} 255.255.255.255 ${peerIp}`,
      `router bgp ${asn}`,
      `neighbor ${peerLo} remote-as ${remote}`,
      `neighbor ${peerLo} update-source Loopback0`,
      'end',
    ];
    ok(t1, side('1.1.1.1', '10.0.12.1', '2.2.2.2', '10.0.12.2', 65001, 65002));
    ok(t2, side('2.2.2.2', '10.0.12.2', '1.1.1.1', '10.0.12.1', 65002, 65001));
    advance(30000);
    expect(e.device(r1.id).bgp!.peers[0].state).not.toBe('Established');
    expect(t1.execute('show ip bgp neighbors')).toContain('External BGP neighbor not directly connected.');
    ok(t1, ['configure terminal', 'router bgp 65001', 'neighbor 2.2.2.2 ebgp-multihop 2', 'end']);
    ok(t2, ['configure terminal', 'router bgp 65002', 'neighbor 1.1.1.1 ebgp-multihop 2', 'end']);
    advance(30000);
    expect(e.device(r1.id).bgp!.peers[0].state).toBe('Established');
    expect(t1.execute('show ip bgp neighbors')).toContain('External BGP neighbor may be up to 2 hops away.');
    expect(t1.execute('show running-config')).toContain('neighbor 2.2.2.2 ebgp-multihop 2');
  });
});

describe('zone-based firewall', () => {
  it('matches return traffic per zone pair, even when it comes back on another OUTSIDE interface', () => {
    const {
      e,
      devices: [host, fw, isp1, isp2, srv],
      terminals: [th, tf, t1, t2, ts],
      cable,
      advance,
    } = lab('router', 'router', 'router', 'router', 'router');
    cable(host, 'Gi0/1', fw, 'Gi0/1');
    cable(fw, 'Gi0/2', isp1, 'Gi0/1');
    cable(fw, 'Gi0/3', isp2, 'Gi0/1');
    cable(isp1, 'Gi0/2', srv, 'Gi0/1');
    cable(isp2, 'Gi0/2', srv, 'Gi0/2');
    ok(th, [
      'interface Gi0/1',
      'ip address 10.1.1.10 255.255.255.0',
      'exit',
      'ip route 0.0.0.0 0.0.0.0 10.1.1.1',
      'end',
    ]);
    ok(tf, [
      'interface Gi0/1',
      'ip address 10.1.1.1 255.255.255.0',
      'interface Gi0/2',
      'ip address 10.0.2.1 255.255.255.252',
      'interface Gi0/3',
      'ip address 10.0.3.1 255.255.255.252',
      'exit',
      // Outbound through ISP1 only; the server answers through ISP2.
      'ip route 0.0.0.0 0.0.0.0 10.0.2.2',
      'firewall mode zones',
      'firewall zone INSIDE Gi0/1',
      'firewall zone OUTSIDE Gi0/2 Gi0/3',
      'firewall rule 10 INSIDE OUTSIDE inspect icmp',
      'service firewall',
      'end',
    ]);
    ok(t1, [
      'interface Gi0/1',
      'ip address 10.0.2.2 255.255.255.252',
      'interface Gi0/2',
      'ip address 10.0.24.1 255.255.255.252',
      'exit',
      'ip route 10.1.1.0 255.255.255.0 10.0.2.1',
      'end',
    ]);
    ok(t2, [
      'interface Gi0/1',
      'ip address 10.0.3.2 255.255.255.252',
      'interface Gi0/2',
      'ip address 10.0.34.1 255.255.255.252',
      'exit',
      'ip route 10.1.1.0 255.255.255.0 10.0.3.1',
      'end',
    ]);
    ok(ts, [
      'interface Gi0/1',
      'ip address 10.0.24.2 255.255.255.252',
      'interface Gi0/2',
      'ip address 10.0.34.2 255.255.255.252',
      'exit',
      'ip route 10.1.1.0 255.255.255.0 10.0.34.1',
      'end',
    ]);
    advance(5000);
    expect(th.execute('ping 10.0.24.2')).toMatch(/Success rate is 100 percent/);
    expect(tf.execute('show firewall')).toMatch(/ICMP REPLIED 10\.1\.1\.10 → 10\.0\.24\.2/);
    // Unsolicited traffic from OUTSIDE is still dropped by the default zone-pair policy.
    expect(ts.execute('ping 10.1.1.10')).toMatch(/Success rate is 0 percent/);
    expect(e.device(fw.id).firewall!.dropped).toBeGreaterThan(0);
  });
});

describe('IP SLA operations are independent of the ping history', () => {
  function slaLab() {
    const e = new SimulationEngine(),
      r = e.addProfile('router'),
      target = e.addDevice('pc'),
      t = new TerminalSession(e, r.id);
    Object.assign(target.interfaces[0], { ip: '192.0.2.2', prefix: 24, gateway: '192.0.2.1' });
    e.connect({ device: r.id, port: 'p0' }, { device: target.id, port: 'p0' });
    ok(t, [
      'enable',
      'configure terminal',
      'interface Gi0/1',
      'ip address 192.0.2.1 255.255.255.0',
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
    expect(r.monitoring!.tracks[0].state).toBe(true);
    // A reply has arrived but the operation reads it on its next tick.
    expect(r.monitoring!.operations[0].probe).toBeDefined();
    return { e, r, target };
  }
  const trackDowns = (e: SimulationEngine) =>
    e.state.events.filter((v) => v.reason.includes('Object track 10: Down'));
  it('a scenario run does not take tracked SLAs down', () => {
    const { e, r, target } = slaLab();
    const runner = new ScenarioRunner(e.snapshot(), {
      name: 'SLA keeps running',
      durationMs: 5000,
      intervalMs: 1000,
      deadlineMs: 500,
      flows: [
        {
          name: 'Ping',
          source: target.id,
          target: '192.0.2.1',
          protocol: 'icmp',
          expect: 'allow',
          maxLossPercent: 0,
        },
      ],
      faults: [],
    });
    for (let i = 0; i < 1000 && !runner.step(200); i++);
    expect(trackDowns(runner.engine)).toEqual([]);
    expect(runner.engine.device(r.id).monitoring!.tracks[0].state).toBe(true);
  });
  it('trimming the ping history keeps the result an SLA operation is waiting for', () => {
    const { e, r } = slaLab();
    // Overflow the ping history within one SLA interval, before the operation reads its reply.
    for (let i = 0; i < LIMITS.probes + 50; i++) {
      e.ping(r.id, '192.0.2.2');
      e.advanceTo(e.state.clock + 0.5);
    }
    e.advanceTo(e.state.clock + 2000);
    expect(trackDowns(e)).toEqual([]);
    expect(r.monitoring!.tracks[0].state).toBe(true);
  });
});

describe('NTP like IOS', () => {
  it('synchronized devices serve time down the hierarchy and ntp master still serves without its upstream', () => {
    const {
      devices: [r1, r2, r3],
      terminals: [t1, t2, t3],
      cable,
      advance,
      e,
    } = lab('router', 'router', 'router');
    cable(r1, 'Gi0/1', r2, 'Gi0/1');
    cable(r2, 'Gi0/2', r3, 'Gi0/1');
    // R1's own upstream is unreachable; "ntp master 3" keeps it authoritative.
    ok(t1, [
      'interface Gi0/1',
      'ip address 10.0.12.1 255.255.255.252',
      'exit',
      'ntp master 3',
      'ntp server 203.0.113.1',
      'end',
    ]);
    ok(t2, [
      'interface Gi0/1',
      'ip address 10.0.12.2 255.255.255.252',
      'interface Gi0/2',
      'ip address 10.0.23.1 255.255.255.252',
      'exit',
      'ntp server 10.0.12.1',
      'end',
    ]);
    ok(t3, [
      'interface Gi0/1',
      'ip address 10.0.23.2 255.255.255.252',
      'exit',
      'ntp server 10.0.23.1',
      'end',
    ]);
    // R3 may poll R2 before R2 is synchronized; it then retries at the next poll interval (64 s).
    advance(70000);
    expect(e.device(r2.id).ntp).toMatchObject({ synchronized: true, stratum: 4 });
    expect(e.device(r3.id).ntp).toMatchObject({ synchronized: true, stratum: 5 });
    expect(e.device(r1.id).ntp?.synchronized).toBe(false);
  });
  it('an unanswered client keeps polling once per poll interval instead of every few seconds', () => {
    const {
      devices: [server, client],
      terminals: [ts, tc],
      cable,
      advance,
      e,
    } = lab('router', 'router');
    cable(server, 'Gi0/1', client, 'Gi0/1');
    ok(ts, ['interface Gi0/1', 'ip address 10.0.0.1 255.255.255.252', 'end']);
    ok(tc, ['interface Gi0/1', 'ip address 10.0.0.2 255.255.255.252', 'exit', 'ntp server 10.0.0.1', 'end']);
    advance(300000);
    const ntp = e.device(client.id).ntp!;
    expect(ntp.synchronized).toBe(false);
    // One request at start-up, then one per 64 s interval: 5 in 300 s (it was one every ~4 s).
    expect(ntp.failures).toBeGreaterThanOrEqual(4);
    expect(ntp.failures).toBeLessThanOrEqual(5);
  });
});

describe('IOS day-0 management plane', () => {
  const RELOAD_MS = 60_000;
  const portOf = (e: SimulationEngine, d: Device, name: string) =>
    e.device(d.id).interfaces.find((p) => p.name === name)!;
  /** PCs addressed in 10.1.1.0/24, one per switch port. */
  function hosts(e: SimulationEngine, sw: Device, ports: string[]) {
    return ports.map((name, i) => {
      const pc = e.addDevice('pc', { x: i * 100, y: 200 });
      Object.assign(pc.interfaces[0], { ip: '10.1.1.' + (11 + i), prefix: 24 });
      e.connect(
        { device: pc.id, port: pc.interfaces[0].id },
        { device: sw.id, port: portOf(e, sw, name).id }
      );
      return pc;
    });
  }
  it('accepts a complete day-0 configuration and keeps it, keys and SNMPv3 users across reload', () => {
    const {
      e,
      devices: [r],
      terminals: [t],
      advance,
    } = lab('router');
    ok(t, [
      'hostname HQ-WAN-01',
      'service timestamps log datetime msec',
      'service password-encryption',
      'ip domain name globex.example',
      'username admin privilege 15 secret Adm1n-Pass',
      'aaa new-model',
      'aaa group server tacacs+ ISE',
      'server name ISE-1',
      'ip tacacs source-interface Loopback0',
      'aaa authentication login default group ISE local',
      'aaa authorization exec default group ISE local if-authenticated',
      'aaa accounting commands 15 default start-stop group ISE',
      'tacacs server ISE-1',
      'address ipv4 10.2.50.40',
      'key Tac-Key-123',
      'ip ssh version 2',
      'line con 0',
      'exec-timeout 5 0',
      'logging synchronous',
      'line vty 0 4',
      'access-class MGMT in',
      'transport input ssh',
      'line vty 5 15',
      'access-class MGMT in',
      'transport input ssh',
      'banner motd #',
      'Authorized access only',
      '',
      'Disconnect now',
      '#',
      'logging buffered 64000 informational',
      'logging trap warnings',
      'logging source-interface Loopback0',
      'logging host 10.2.50.30',
      'logging host 10.3.50.30',
      'snmp-server location HQ MDF rack 4',
      'snmp-server contact noc@globex.example',
      'snmp-server group V3GROUP v3 priv',
      'snmp-server user monitor V3GROUP v3 auth sha Auth-Pass-1 priv aes 128 Priv-Pass-1',
      'ntp authentication-key 1 md5 Ntp-Key-1',
      'ntp trusted-key 1',
      'ntp authenticate',
      'ntp source Loopback0',
      'ntp server 10.2.50.123 key 1 prefer',
      'ip access-list standard MGMT',
      'permit 10.2.0.0 0.0.255.255',
      'interface Loopback0',
      'ip address 10.255.0.1 255.255.255.255',
      'end',
    ]);
    ok(t, ['configure terminal']);
    expect(t.execute('crypto key generate rsa modulus 2048')).toMatch(/Generating 2048 bit RSA keys/);
    ok(t, ['end']);
    const running = t.execute('show running-config');
    for (const line of [
      'aaa new-model',
      'aaa authentication login default group ISE local',
      'tacacs server ISE-1',
      ' key 7 ' + type7Encode('Tac-Key-123'),
      'line vty 0 4',
      ' transport input ssh',
      'banner motd ^C\nAuthorized access only\n\nDisconnect now\n^C',
      'logging trap warnings',
      'logging host 10.2.50.30\nlogging host 10.3.50.30',
      'snmp-server location HQ MDF rack 4',
      'ntp server 10.2.50.123 key 1 prefer',
    ])
      expect(running).toContain(line);
    // The SNMPv3 user and the RSA key pair are private configuration: never printed.
    expect(running).not.toMatch(/snmp-server user|Auth-Pass-1|crypto key/);
    expect(t.execute('show ip ssh')).toMatch(/^SSH Enabled - version 2\.0/);
    expect(new TerminalSession(e, r.id).banners).toBe('\nAuthorized access only\n\nDisconnect now\n');
    ok(t, ['write memory', 'reload', '']);
    advance(RELOAD_MS);
    ok(t, ['enable']);
    expect(t.execute('show running-config')).toBe(running);
    expect(e.device(r.id).bootLog).toEqual([]);
    expect(t.execute('show ip ssh')).toMatch(/^SSH Enabled - version 2\.0/);
    expect(t.execute('show snmp user')).toMatch(/User name: monitor[\s\S]*Group-name: V3GROUP/);
  });
  it('portfast and BPDU Guard defaults protect access ports, and errdisable recovery brings them back', () => {
    const {
      e,
      devices: [a, b],
      terminals: [ta, tb],
      cable,
      advance,
    } = lab('access', 'access');
    ok(ta, [
      'spanning-tree portfast default',
      'spanning-tree portfast bpduguard default',
      'errdisable recovery cause bpduguard',
      'errdisable recovery interval 30',
      'interface Gi0/24',
      'switchport mode trunk',
      'end',
    ]);
    cable(a, 'Gi0/5', b, 'Gi0/5');
    cable(a, 'Gi0/24', b, 'Gi0/24');
    advance(5000);
    // The access port is an edge port by default and receives BPDUs: err-disabled. The trunk is not edge.
    const port = portOf(e, a, 'Gi0/5');
    expect(port.errDisabled?.reason).toBe('bpduguard');
    expect(ta.execute('show spanning-tree')).toMatch(/Gi0\/24\s+\S+\s+\S+\s+\d+\s+\S+\s+P2p\s*$/m);
    expect(ta.execute('show errdisable recovery')).toMatch(
      /bpduguard\s+Enabled[\s\S]*Gi0\/5\s+bpduguard\s+\d+/
    );
    // The neighbor port is shut, so no more BPDUs: after the interval the port recovers.
    ok(tb, ['interface Gi0/5', 'shutdown', 'end']);
    advance(31000);
    expect(portOf(e, a, 'Gi0/5').errDisabled).toBeUndefined();
    expect(e.device(a.id).logs.some((l) => l.includes('%PM-4-ERR_RECOVER'))).toBe(true);
    // "spanning-tree portfast disable" opts a port out of the default and is printed as such.
    ok(ta, ['configure terminal', 'interface Gi0/6', 'spanning-tree portfast disable', 'end']);
    expect(ta.execute('show running-config')).toMatch(
      /interface Gi0\/6\n(?: .*\n)* spanning-tree portfast disable\n/
    );
  });
  it('storm-control filters a broadcast storm and action shutdown err-disables the port', () => {
    const {
      e,
      devices: [sw],
      terminals: [t],
      advance,
    } = lab('access');
    const [pc1, pc2] = hosts(e, sw, ['Gi0/1', 'Gi0/2']);
    ok(t, ['spanning-tree portfast default', 'interface Gi0/1', 'storm-control broadcast level 0.00', 'end']);
    e.ping(pc1.id, '10.1.1.12');
    advance(5000);
    // Level 0 suppresses all broadcasts: the ARP request never reaches PC2.
    expect(e.device(pc1.id).arpTable.some((x) => x.ip === '10.1.1.12')).toBe(false);
    expect(t.execute('show storm-control')).toMatch(/Gi0\/1\s+(?:Blocking|Forwarding)\s+0\.00%/);
    ok(t, ['configure terminal', 'interface Gi0/1', 'storm-control action shutdown', 'end']);
    e.ping(pc1.id, '10.1.1.12');
    advance(5000);
    expect(portOf(e, sw, 'Gi0/1').errDisabled?.reason).toBe('storm-control');
    ok(t, [
      'configure terminal',
      'interface Gi0/1',
      'no storm-control broadcast level',
      'shutdown',
      'no shutdown',
      'end',
    ]);
    e.ping(pc1.id, '10.1.1.12');
    advance(5000);
    expect(e.device(pc1.id).arpTable.some((x) => x.ip === '10.1.1.12')).toBe(true);
    expect(e.device(pc2.id).arpTable.some((x) => x.ip === '10.1.1.11')).toBe(true);
  });
  it('SPAN copies a source port to the destination port, which no longer switches traffic', () => {
    const {
      e,
      devices: [sw],
      terminals: [t],
      advance,
    } = lab('access');
    const [pc1, , sniffer] = hosts(e, sw, ['Gi0/1', 'Gi0/2', 'Gi0/3']);
    ok(t, [
      'spanning-tree portfast default',
      'monitor session 1 source interface Gi0/1',
      'monitor session 1 destination interface Gi0/3',
      'end',
    ]);
    expect(t.execute('show monitor session 1')).toMatch(/Both\s+: Gi0\/1[\s\S]*Destination Ports\s+: Gi0\/3/);
    const seen = () =>
      e.state.events.filter((ev) => ev.device === sniffer.id && ev.frame?.packet?.protocol === 'ICMP').length;
    e.ping(pc1.id, '10.1.1.12');
    advance(5000);
    // Echo request (rx on Gi0/1) and reply (tx on Gi0/1) both reach the analyzer.
    expect(seen()).toBeGreaterThanOrEqual(2);
    expect(e.state.probes.at(-1)?.status).toBe('success');
    // A SPAN destination does not forward what it receives.
    e.ping(sniffer.id, '10.1.1.11');
    advance(5000);
    expect(e.state.probes.at(-1)?.status).not.toBe('success');
  });
  it('NTP authentication, source interfaces and SNMP system strings behave like IOS', () => {
    const {
      e,
      devices: [r1, r2],
      terminals: [t1, t2],
      cable,
      advance,
    } = lab('router', 'router');
    cable(r1, 'Gi0/1', r2, 'Gi0/1');
    ok(t1, [
      'interface Gi0/1',
      'ip address 10.0.0.1 255.255.255.252',
      'exit',
      'ip route 10.255.0.2 255.255.255.255 10.0.0.2',
      'ntp authentication-key 1 md5 Ntp-Key-1',
      'ntp master 3',
      'service syslog',
      'snmp-server community GLOBEX-RO RO',
      'snmp-server location HQ MDF',
      'end',
    ]);
    ok(t2, [
      'interface Gi0/1',
      'ip address 10.0.0.2 255.255.255.252',
      'interface Loopback0',
      'ip address 10.255.0.2 255.255.255.255',
      'exit',
      'ntp authentication-key 1 md5 Wrong-Key',
      'ntp trusted-key 1',
      'ntp authenticate',
      'ntp source Loopback0',
      'ntp server 10.0.0.1 key 1',
      'logging source-interface Loopback0',
      'logging host 10.0.0.1',
      'end',
    ]);
    advance(70000);
    // The server's reply is signed with a different key: not a valid sync source.
    expect(e.device(r2.id).ntp?.synchronized).toBe(false);
    ok(t2, ['configure terminal', 'ntp authentication-key 1 md5 Ntp-Key-1', 'end']);
    advance(70000);
    expect(e.device(r2.id).ntp).toMatchObject({ synchronized: true, stratum: 4 });
    expect(e.device(r2.id).ntp?.samples.at(-1)?.server).toBe('10.0.0.1');
    // Syslog leaves from the loopback address.
    ok(t2, ['configure terminal', 'interface Gi0/2', 'shutdown', 'end']);
    advance(2000);
    const entries = e.device(r1.id).syslogServer!.entries;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((x) => x.source === '10.255.0.2')).toBe(true);
    expect(t2.execute('show logging')).toMatch(
      /Logging to 10\.0\.0\.1[\s\S]*Logging Source-Interface[\s\S]*Loopback0/
    );
    // sysLocation is served by the SNMP agent.
    t2.execute('snmp get 10.0.0.1 GLOBEX-RO 1.3.6.1.2.1.1.6.0');
    advance(2000);
    expect(t2.execute('show snmp queries')).toContain('1.3.6.1.2.1.1.6.0 OctetString = HQ MDF');
  });
});

describe('endpoints obtain an address automatically', () => {
  it('a new desktop gets a lease once powered and cabled, uses APIPA without a server, and retries on reconnect', () => {
    const {
      e,
      devices: [sw, r],
      terminals: [ts, tr],
      cable,
      advance,
    } = lab('access', 'router');
    cable(sw, 'Gi0/24', r, 'Gi0/1');
    ok(tr, [
      'interface Gi0/1',
      'ip address 10.1.0.1 255.255.255.0',
      'no shutdown',
      'exit',
      'ip dhcp excluded-address 10.1.0.1 10.1.0.9',
      'ip dhcp pool USERS',
      'network 10.1.0.0 255.255.255.0',
      'default-router 10.1.0.1',
      'end',
    ]);
    ok(ts, [
      'spanning-tree portfast default',
      'vlan 20',
      'exit',
      'interface Gi0/2',
      'switchport access vlan 20',
      'end',
    ]);
    const swPort = (name: string) => e.device(sw.id).interfaces.find((p) => p.name === name)!.id;
    const [pc1, pc2] = [0, 1].map((i) => e.addFactoryProfile('desktop', { x: i * 100, y: 300 }));
    const link1 = e.connect({ device: pc1.id, port: 'p0' }, { device: sw.id, port: swPort('Gi0/1') });
    const link2 = e.connect({ device: pc2.id, port: 'p0' }, { device: sw.id, port: swPort('Gi0/2') });
    // Nothing is sent before the hosts are switched on.
    expect(e.device(pc1.id).interfaces[0].dhcp?.status).toBe('init');
    for (const pc of [pc1, pc2]) e.setDevicePower(pc.id, true);
    advance(3000);
    const nic1 = e.device(pc1.id).interfaces[0];
    expect(nic1.dhcp?.status).toBe('bound');
    expect(nic1.ip).toMatch(/^10\.1\.0\.(?:[1-9]\d|\d{3})$/);
    expect(nic1.gateway).toBe('10.1.0.1');
    // VLAN 20 has no DHCP server: after the discovery attempts the PC uses APIPA.
    advance(60_000);
    const nic2 = () => e.device(pc2.id).interfaces[0];
    expect(nic2().dhcp?.status).toBe('failed');
    expect(nic2().ip).toMatch(/^169\.254\./);
    expect(nic2().prefix).toBe(16);
    // Moving the cable to a port in the right VLAN triggers discovery at once (media connect).
    e.removeLink(link2.id);
    expect(nic2().dhcp?.status).toBe('init');
    e.connect({ device: pc2.id, port: 'p0' }, { device: sw.id, port: swPort('Gi0/3') });
    advance(3000);
    expect(nic2().dhcp?.status).toBe('bound');
    expect(nic2().ip).toMatch(/^10\.1\.0\./);
    expect(link1.up).toBe(true);
    expect(() => validateSnapshot(e.snapshot())).not.toThrow();
  });
});
describe('IOS tunnel interfaces (GRE and IPsec VTI)', () => {
  /** HQ and branch routers whose only path is an Internet router; each has a LAN loopback. */
  function wan() {
    const {
      e,
      devices: [hq, isp, br],
      terminals: [th, ti, tb],
      cable,
      advance,
    } = lab('router', 'isp', 'router');
    cable(hq, 'Gi0/1', isp, 'Gi0/1');
    cable(br, 'Gi0/1', isp, 'Gi0/2');
    ok(ti, [
      'interface Gi0/1',
      'ip address 198.51.100.9 255.255.255.252',
      'no shutdown',
      'interface Gi0/2',
      'ip address 198.51.100.13 255.255.255.252',
      'no shutdown',
      'end',
    ]);
    for (const [t, wanIp, gw, lan] of [
      [th, '198.51.100.10', '198.51.100.9', '10.1.0.1'],
      [tb, '198.51.100.14', '198.51.100.13', '10.2.0.1'],
    ] as const)
      ok(t, [
        'interface Gi0/1',
        `ip address ${wanIp} 255.255.255.252`,
        'no shutdown',
        'exit',
        `ip route 0.0.0.0 0.0.0.0 ${gw}`,
        'interface Loopback0',
        `ip address ${lan} 255.255.255.0`,
        'ip ospf 1 area 0',
        'exit',
        'router ospf 1',
        'exit',
      ]);
    const tunnel = (t: TerminalSession, local: string, remote: string, extra: string[]) =>
      ok(t, [
        'interface Tunnel0',
        `ip address ${local} 255.255.255.252`,
        'tunnel source GigabitEthernet0/1',
        `tunnel destination ${remote}`,
        ...extra,
        'ip ospf 1 area 0',
        'end',
      ]);
    const port = (d: Device) => e.device(d.id).interfaces.find((p) => p.name === 'Tunnel0')!;
    return { e, hq, isp, br, th, ti, tb, tunnel, port, advance };
  }
  it('GRE carries routed traffic and OSPF, and keepalives take the tunnel down when the peer stops answering', () => {
    const { e, hq, br, th, tb, tunnel, port, advance } = wan();
    tunnel(th, '172.31.0.1', '198.51.100.14', ['keepalive 5 3']);
    tunnel(tb, '172.31.0.2', '198.51.100.10', ['keepalive 5 3']);
    advance(60_000);
    expect(port(hq).iosTunnel?.status).toBe('up');
    expect(th.execute('show ip interface brief')).toMatch(/Tunnel0\s+172\.31\.0\.1\s+YES manual up\s+up/);
    expect(th.execute('show ip ospf neighbor')).toMatch(
      /10\.2\.0\.1\s+\d+\s+FULL\/\s+-\s+\S+\s+172\.31\.0\.2\s+Tunnel0/
    );
    expect(th.execute('ping 10.2.0.1 source Loopback0')).toMatch(/!!!!!/);
    // The Internet router sees GRE (IP protocol 47) between the public addresses, not the LANs.
    expect(
      e.state.events.some(
        (ev) => ev.frame?.packet?.protocol === 'GRE' && ev.frame.packet.src === '198.51.100.10'
      )
    ).toBe(true);
    expect(th.execute('show interfaces Tunnel0')).toMatch(
      /Tunnel source 198\.51\.100\.10 \(Gi0\/1\), destination 198\.51\.100\.14[\s\S]*GRE\/IP/
    );
    // Default tunnel bandwidth is 100 kbit/s: OSPF cost 1000.
    expect(e.device(hq.id).ospf!.interfaces.find((i) => i.port === port(hq).id)?.cost).toBe(1000);
    // The peer's tunnel goes down: keepalives stop being answered and the line protocol drops.
    ok(tb, ['configure terminal', 'interface Tunnel0', 'shutdown', 'end']);
    advance(25_000);
    expect(port(hq).iosTunnel?.status).toBe('down');
    expect(th.execute('show ip interface brief')).toMatch(/Tunnel0\s+172\.31\.0\.1\s+YES manual up\s+down/);
    expect(port(br).iosTunnel?.reason).toBe('administratively down');
  });
  it('an IPsec VTI comes up only with matching IKEv2 keys, encrypts as ESP and survives reload', () => {
    const { e, hq, th, tb, tunnel, port, advance } = wan();
    const crypto = (psk: string, peer: string) => [
      'crypto ikev2 proposal PROP',
      'encryption aes-cbc-256',
      'integrity sha256',
      'group 14',
      'crypto ikev2 policy POL',
      'proposal PROP',
      'crypto ikev2 keyring KR',
      'peer SITE',
      `address ${peer}`,
      `pre-shared-key ${psk}`,
      'exit',
      'exit',
      'crypto ikev2 profile IKEPROF',
      `match identity remote address ${peer} 255.255.255.255`,
      'authentication remote pre-share',
      'authentication local pre-share',
      'keyring local KR',
      'crypto ipsec transform-set TS esp-aes 256 esp-sha256-hmac',
      'mode tunnel',
      'crypto ipsec profile VTI',
      'set transform-set TS',
      'set ikev2-profile IKEPROF',
      'exit',
    ];
    ok(th, crypto('Vpn-K3y-1', '198.51.100.14'));
    ok(tb, crypto('Wrong-K3y', '198.51.100.10'));
    const vti = ['tunnel mode ipsec ipv4', 'tunnel protection ipsec profile VTI'];
    tunnel(th, '172.31.0.1', '198.51.100.14', vti);
    tunnel(tb, '172.31.0.2', '198.51.100.10', vti);
    advance(30_000);
    // Different pre-shared keys: IKE_AUTH fails and the VTI stays down.
    expect(port(hq).iosTunnel?.status).toBe('down');
    expect(th.execute('show crypto session')).toMatch(/Session status: DOWN[\s\S]*authentication failed/);
    ok(tb, ['configure terminal', 'crypto ikev2 keyring KR', 'peer SITE', 'pre-shared-key Vpn-K3y-1', 'end']);
    advance(30_000);
    expect(port(hq).iosTunnel?.status).toBe('up');
    expect(th.execute('show crypto ikev2 sa')).toMatch(
      /198\.51\.100\.10\/500\s+198\.51\.100\.14\/500\s+none\/none\s+READY/
    );
    expect(th.execute('show ip ospf neighbor')).toMatch(/FULL\/\s+-.*Tunnel0/);
    expect(th.execute('ping 10.2.0.1 source Loopback0')).toMatch(/!!!!!/);
    expect(th.execute('show crypto ipsec sa')).toMatch(/#pkts encaps: [1-9]\d*/);
    // On the wire only ESP between the public addresses: the inner packets are not visible.
    const transit = e.state.events.filter((ev) => ev.frame?.packet?.src === '198.51.100.10');
    expect(transit.some((ev) => ev.frame!.packet!.protocol === 'ESP')).toBe(true);
    expect(transit.some((ev) => ev.frame!.packet!.protocol === 'GRE')).toBe(false);
    const running = th.execute('show running-config');
    expect(running).toContain('crypto ipsec profile VTI\n set transform-set TS\n set ikev2-profile IKEPROF');
    expect(running).toMatch(
      /interface Tunnel0\n(?: .*\n)* tunnel mode ipsec ipv4\n tunnel destination 198\.51\.100\.14\n tunnel protection ipsec profile VTI/
    );
    ok(th, ['write memory', 'reload', '']);
    advance(60_000 + 30_000);
    ok(th, ['enable']);
    expect(th.execute('show running-config')).toBe(running);
    expect(port(hq).iosTunnel?.status).toBe('up');
    expect(th.execute('ping 10.2.0.1 source Loopback0')).toMatch(/!!!!!/);
    // Captures export GRE/ESP as real IP protocols that decode again.
    const pcap = exportPcap(e.snapshot());
    expect(decodePcap(pcap.bytes).some((r) => r.frame.esp !== undefined)).toBe(true);
  });
});
describe('Wi-Fi clients scan every channel', () => {
  it('a client with default radio settings associates to an AP on another band and channel', () => {
    const e = new SimulationEngine(),
      ap = e.addDevice('switch', { x: 200, y: 200 }),
      laptop = e.addDevice('pc', { x: 240, y: 200 });
    const radio = {
      txPower: 20,
      noise: -95,
      attenuation: 0,
      enabled: true,
      security: 'wpa2-psk',
      key: 'Campus-Key-1',
    };
    e.configureWireless(ap.id, { ...radio, role: 'ap', ssid: 'CORP', band: '5', channel: 36 });
    // The client's configured channel is irrelevant: it scans both bands and tunes to the AP.
    e.configureWireless(laptop.id, { ...radio, role: 'client', ssid: 'CORP', band: '2.4', channel: 1 });
    e.advanceTo(5000);
    expect(e.device(laptop.id).wireless?.phase).toBe('associated');
  });
});
describe('802.1X on a Layer 2 access switch', () => {
  /** PC (supplicant) - access switch (no ip routing) - router - RADIUS server. */
  function campus() {
    const {
      e,
      devices: [sw, r],
      terminals: [ts, tr],
      cable,
      advance,
    } = lab('access', 'router');
    cable(sw, 'Gi0/24', r, 'Gi0/1');
    const pc = e.addDevice('pc', { x: 0, y: 200 }),
      radius = e.addDevice('server', { x: 400, y: 200 });
    Object.assign(pc.interfaces[0], { ip: '10.1.0.11', prefix: 24 });
    pc.gateway = '10.1.0.1';
    Object.assign(radius.interfaces[0], { ip: '10.2.50.41', prefix: 24 });
    radius.gateway = '10.2.50.1';
    e.connect(
      { device: pc.id, port: pc.interfaces[0].id },
      { device: sw.id, port: e.device(sw.id).interfaces.find((p) => p.name === 'Gi0/1')!.id }
    );
    e.connect(
      { device: radius.id, port: radius.interfaces[0].id },
      { device: r.id, port: e.device(r.id).interfaces.find((p) => p.name === 'Gi0/2')!.id }
    );
    e.configureAaaServer(radius.id, {
      enabled: true,
      radius: true,
      tacacs: false,
      key: 'Rad-Key-1',
      clients: [],
      users: [{ username: 'alice', password: 'Alice-Pass1' }],
    });
    e.configureSupplicant(pc.id, pc.interfaces[0].id, {
      enabled: true,
      username: 'alice',
      password: 'Alice-Pass1',
    });
    ok(tr, [
      'interface Gi0/1',
      'ip address 10.1.0.1 255.255.255.0',
      'no shutdown',
      'interface Gi0/2',
      'ip address 10.2.50.1 255.255.255.0',
      'no shutdown',
      'end',
    ]);
    // Management SVI and default gateway: the switch itself does not route.
    ok(ts, [
      'interface Vlan1',
      'ip address 10.1.0.2 255.255.255.0',
      'no shutdown',
      'exit',
      'ip default-gateway 10.1.0.1',
      'spanning-tree portfast default',
      'interface Gi0/1',
      'switchport mode access',
      'exit',
    ]);
    const port = () => e.device(sw.id).interfaces.find((p) => p.name === 'Gi0/1')!;
    return { e, sw, pc, ts, port, advance };
  }
  it('authenticates with the IOS method list through ip default-gateway and keeps the port closed until then', () => {
    const { e, sw, pc, ts, port, advance } = campus();
    ok(ts, [
      'aaa new-model',
      'aaa authentication dot1x default group radius',
      'dot1x system-auth-control',
      'radius server NPS-1',
      'address ipv4 10.2.50.41 auth-port 1812 acct-port 1813',
      'key Rad-Key-1',
      'interface Gi0/1',
      'authentication port-control auto',
      'dot1x pae authenticator',
      'end',
    ]);
    expect(port().dot1x).toMatchObject({ enabled: true, aaa: true });
    advance(6000);
    expect(port().dot1x?.phase).toBe('authorized');
    expect(e.device(pc.id).interfaces[0].supplicant?.phase).toBe('authorized');
    // The Access-Request left from the management SVI towards the default gateway.
    expect(e.device(sw.id).aaaQueries?.at(-1)).toMatchObject({ sourceIp: '10.1.0.2', status: 'accepted' });
    const running = ts.execute('show running-config');
    expect(running).toMatch(/ authentication port-control auto\n dot1x pae authenticator\n/);
    expect(running).not.toMatch(/dot1x configure|aaa client configure/);
    // The configuration survives a reload and the client authenticates again.
    ok(ts, ['write memory', 'reload', '']);
    advance(60_000);
    ok(ts, ['enable']);
    expect(ts.execute('show running-config')).toBe(running);
    advance(10_000);
    expect(port().dot1x?.phase).toBe('authorized');
    // Without a reachable RADIUS server the method list fails and the port stays unauthorized.
    ok(ts, [
      'configure terminal',
      'no ip default-gateway',
      'interface Gi0/1',
      'shutdown',
      'no shutdown',
      'end',
    ]);
    advance(10_000);
    expect(port().dot1x?.phase).not.toBe('authorized');
  });
  it('the simulator AAA client binding also reaches RADIUS through ip default-gateway', () => {
    const { pc, e, ts, port, advance } = campus();
    ok(ts, [
      'dot1x system-auth-control',
      'aaa client configure {"method":"radius","server":"10.2.50.41","key":"Rad-Key-1"}',
      'interface Gi0/1',
      'authentication port-control auto',
      'end',
    ]);
    advance(6000);
    expect(port().dot1x?.phase).toBe('authorized');
    expect(e.device(pc.id).interfaces[0].supplicant?.phase).toBe('authorized');
  });
});

describe('simulation fast paths keep results exact', () => {
  it('incremental worker deltas keep a large lab mirror valid, and sync() makes it exact', () => {
    const snapshot = makeTemplate('factory');
    expect(snapshot.devices.length).toBeGreaterThan(40);
    const reference = new SimulationEngine(snapshot),
      main = new SimulationEngine(snapshot),
      runner = new SimulationRunner(snapshot),
      target = reference.state.clock + 3000;
    reference.advanceTo(target, 2_000_000);
    let deltas = 0;
    while (
      deltas < 5000 &&
      (runner.engine.state.clock < target || (runner.engine.state.queue[0]?.at ?? Infinity) <= target)
    ) {
      applySimulationDelta(main.state, structuredClone(runner.advanceUntil(target, 1)));
      if (++deltas % 25 === 0) validateSnapshot(main.snapshot());
    }
    expect(deltas).toBeGreaterThan(FULL_SWEEP_SPAN);
    expect(runner.engine.snapshot()).toEqual(reference.snapshot());
    applySimulationDelta(main.state, structuredClone(runner.sync()));
    expect(main.snapshot()).toEqual(reference.snapshot());
  }, 60000);
});
const FULL_SWEEP_SPAN = 10;
