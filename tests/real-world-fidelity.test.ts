import { describe, it, expect } from 'vitest';
import {
  LIMITS,
  SimulationEngine,
  ScenarioRunner,
  TerminalSession,
  makeTemplate,
  type Device,
} from '../packages/simulation-engine/src';
import { type7Decode, type7Encode } from '../packages/simulation-engine/src/cli/secrets';

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
