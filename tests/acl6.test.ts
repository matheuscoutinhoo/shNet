import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  slaacAddress6,
  validateSnapshot,
} from '../packages/simulation-engine/src';

const ra = (network: string) => ({
  intervalMs: 3000,
  lifetimeMs: 9000,
  prefixes: [{ network, prefix: 64, autonomous: true, onLink: true, validMs: 60000, preferredMs: 30000 }],
});
/** PC a — Gi0/0 router Gi0/1 — PC b, with SLAAC on both LANs. */
function lab() {
  const e = new SimulationEngine(),
    r = e.addDevice('router'),
    a = e.addDevice('pc'),
    b = e.addDevice('pc');
  r.ipv6Routing = true;
  for (const [i, pc] of [a, b].entries()) {
    const network = `2001:db8:${i + 1}::`;
    e.connect({ device: r.id, port: 'p' + i }, { device: pc.id, port: 'p0' });
    e.configureIpv6(r.id, 'p' + i, {
      auto: false,
      addresses: [{ ip: network + '1', prefix: 64 }],
      ra: ra(network),
    });
    e.configureIpv6(pc.id, 'p0', { auto: true, addresses: [] });
  }
  e.advanceTo(10000);
  const t = new TerminalSession(e, r.id);
  t.execute('enable');
  return {
    e,
    r,
    a,
    b,
    t,
    lan: r.interfaces[0].name,
    wan: r.interfaces[1].name,
    source: slaacAddress6('2001:db8:1::', a.interfaces[0].mac),
    target: slaacAddress6('2001:db8:2::', b.interfaces[0].mac),
  };
}
function run(t: TerminalSession, lines: string[]) {
  for (const line of lines) expect(t.execute(line), line).not.toMatch(/^%/m);
}
function ping(e: SimulationEngine, from: string, to: string) {
  const id = e.ping6(from, to);
  e.advanceTo(e.state.clock + 3000);
  return e.state.probes6?.find((p) => p.id === id)?.status;
}

describe('IOS named IPv6 ACLs (ipv6 access-list / ipv6 traffic-filter)', () => {
  it('denies by entry, counts matches and prints IOS show output', () => {
    const { e, a, t, lan, target } = lab();
    expect(ping(e, a.id, target)).toBe('success');
    t.execute('configure terminal');
    expect(t.execute('ipv6 access-list NO-PING')).toBe('');
    expect(t.prompt).toMatch(/\(config-ipv6-acl\)#$/);
    run(t, ['deny icmp any any echo-request', 'permit ipv6 any any', 'interface ' + lan]);
    run(t, ['ipv6 traffic-filter NO-PING in', 'end']);
    expect(ping(e, a.id, target)).not.toBe('success');
    const show = t.execute('show ipv6 access-list NO-PING');
    expect(show).toMatch(
      /^IPv6 access list NO-PING\n {4}deny icmp any any echo-request \(\d+ match(es)?\) sequence 10\n/
    );
    expect(show).toMatch(/ {4}permit ipv6 any any(?: \(\d+ match(es)?\))? sequence 20$/);
    expect(t.execute('show access-lists')).toContain('IPv6 access list NO-PING');
    expect(t.execute('show ip access-lists')).not.toContain('IPv6 access list');
    expect(t.execute('show ipv6 interface ' + lan)).toContain('Inbound access list NO-PING');
    expect(
      e.state.events.some((v) => v.type === 'ACL_DENY' && /NO-PING in: sequence 10 deny/.test(v.reason))
    ).toBe(true);
    t.execute('clear ipv6 access-list NO-PING');
    expect(t.execute('show ipv6 access-list')).not.toMatch(/match/);
    validateSnapshot(e.snapshot());
  });

  it('ends with the implicit nd-na/nd-ns permit and deny ipv6 any any', () => {
    const { e, a, r, t, lan, source, target } = lab();
    // Only echo requests are listed: replies arrive on Gi0/1 (no filter) and NDP is implicitly permitted.
    run(t, ['configure terminal', 'ipv6 access-list ECHO-ONLY', 'permit icmp any any echo-request', 'exit']);
    run(t, ['interface ' + lan, 'ipv6 traffic-filter ECHO-ONLY in', 'end']);
    // Force neighbor discovery through the filter.
    r.neighbors6 = [];
    a.neighbors6 = [];
    expect(ping(e, a.id, target)).toBe('success');
    // Anything else from the LAN hits the implicit deny.
    run(t, [
      'configure terminal',
      'ipv6 access-list ECHO-ONLY',
      'no sequence 10',
      'permit icmp host 2001:db8:1::99 any',
      'end',
    ]);
    expect(ping(e, a.id, target)).not.toBe('success');
    expect(
      e.state.events.some((v) => v.type === 'ACL_DENY' && v.reason.includes('implicit deny ipv6 any any'))
    ).toBe(true);
    // Permitting the PC's own address restores it.
    run(t, ['configure terminal', 'ipv6 access-list ECHO-ONLY', `permit ipv6 ${source}/128 any`, 'end']);
    expect(ping(e, a.id, target)).toBe('success');
  });

  it('a filter naming a missing ACL permits all; outbound filters skip router-originated traffic', () => {
    const { e, a, r, t, lan, wan, target } = lab();
    run(t, ['configure terminal', 'interface ' + lan, 'ipv6 traffic-filter MISSING in', 'end']);
    expect(ping(e, a.id, target)).toBe('success');
    run(t, ['configure terminal', 'ipv6 access-list DENY-ALL', 'deny ipv6 any any', 'exit']);
    run(t, ['interface ' + wan, 'ipv6 traffic-filter DENY-ALL out', 'end']);
    expect(ping(e, a.id, target)).not.toBe('success');
    expect(ping(e, r.id, target)).toBe('success');
    run(t, ['configure terminal', 'interface ' + wan, 'no ipv6 traffic-filter DENY-ALL out', 'end']);
    expect(ping(e, a.id, target)).toBe('success');
  });

  it('parses ports, hosts, prefixes and sequence numbers, and round-trips through running-config', () => {
    const { t, lan } = lab();
    run(t, [
      'configure terminal',
      'ipv6 access-list WEB-IN',
      'remark Web servers',
      'permit tcp any host 2001:DB8:2::10 eq www',
      'permit tcp 2001:db8:1::/64 any range 8000 8080',
      'sequence 15 permit udp any any eq domain',
      'permit tcp any any established',
      'deny ipv6 any any log',
      'interface ' + lan,
      'ipv6 traffic-filter WEB-IN in',
      'end',
    ]);
    expect(t.execute('show ipv6 access-list WEB-IN')).toBe(
      [
        'IPv6 access list WEB-IN',
        '    permit tcp any host 2001:DB8:2::10 eq www sequence 10',
        '    permit udp any any eq domain sequence 15',
        '    permit tcp 2001:DB8:1::/64 any range 8000 8080 sequence 20',
        '    permit tcp any any established sequence 30',
        '    deny ipv6 any any log sequence 40',
      ].join('\n')
    );
    const config = t.execute('show running-config');
    expect(config).toContain(
      [
        'ipv6 access-list WEB-IN',
        ' remark Web servers',
        ' sequence 10 permit tcp any host 2001:DB8:2::10 eq www',
        ' sequence 15 permit udp any any eq domain',
      ].join('\n')
    );
    expect(config).toMatch(
      /interface GigabitEthernet0\/1\n(?: .*\n)* ipv6 nd prefix 2001:db8:1::\/64 .*\n ipv6 traffic-filter WEB-IN in\n/
    );
    // Pasting the running-config into a fresh router reproduces the same configuration.
    const fresh = new SimulationEngine(),
      other = fresh.addDevice('router'),
      paste = new TerminalSession(fresh, other.id);
    paste.execute('enable');
    paste.execute('configure terminal');
    const lines = config.split('\n').filter((l) => /^(?:ipv6 access-list| (?:remark|sequence))/.test(l));
    for (const line of lines) expect(paste.execute(line.trim()), line).not.toMatch(/^%/m);
    paste.execute('end');
    expect(paste.execute('show ipv6 access-list')).toBe(t.execute('show ipv6 access-list'));
    paste.execute('configure terminal');
    paste.execute('ipv6 access-list X');
    for (const bad of [
      'permit tcp any any eq',
      'permit icmp any any eq 80',
      'permit gre any any',
      'deny ipv6 2001:db8::/129 any',
    ])
      expect(paste.execute(bad), bad).toMatch(/^%/);
  });

  it('survives write memory and reload', () => {
    const { e, r, a, t, lan, target } = lab();
    run(t, [
      'configure terminal',
      'ipv6 access-list NO-PING',
      'deny icmp any any echo-request',
      'permit ipv6 any any',
    ]);
    run(t, ['interface ' + lan, 'ipv6 traffic-filter NO-PING in', 'end', 'write memory', 'reload', '']);
    e.advanceTo(e.state.clock + 121_000);
    expect(e.device(r.id).bootLog).toEqual([]);
    const after = new TerminalSession(e, r.id);
    after.execute('enable');
    expect(after.execute('show ipv6 access-list')).toMatch(/deny icmp any any echo-request.*sequence 10/);
    expect(after.execute('show running-config')).toContain(' ipv6 traffic-filter NO-PING in');
    expect(ping(e, a.id, target)).not.toBe('success');
    expect(after.execute('show ipv6 access-list NO-PING')).toMatch(
      /echo-request \(\d+ match(es)?\) sequence 10/
    );
    validateSnapshot(e.snapshot());
  });
});
