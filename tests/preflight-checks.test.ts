import { describe, expect, it } from 'vitest';
import { SimulationEngine, TerminalSession, preflight } from '../packages/simulation-engine/src';

function device(e: SimulationEngine, profile: string, lines: string[], x = 0) {
  const d = e.addFactoryProfile(profile, { x, y: 0 });
  e.setDevicePower(d.id, true);
  const t = new TerminalSession(e, d.id);
  for (const line of ['enable', 'configure terminal', ...lines])
    expect(t.execute(line), line).not.toMatch(/^%/);
  return e.device(d.id);
}
const codes = (e: SimulationEngine) => preflight(e.snapshot()).map((i) => i.code);

describe('preflight configuration checks', () => {
  it('detects switchport mismatches on a cable', () => {
    const cases: [string[], string[], string][] = [
      [
        ['interface Gi0/1', 'switchport mode trunk'],
        ['interface Gi0/1', 'switchport mode access'],
        'TRUNK_MODE_MISMATCH',
      ],
      [
        ['vlan 10', 'exit', 'interface Gi0/1', 'switchport access vlan 10'],
        ['vlan 20', 'exit', 'interface Gi0/1', 'switchport access vlan 20'],
        'ACCESS_VLAN_MISMATCH',
      ],
      [
        ['interface Gi0/1', 'switchport mode trunk', 'switchport trunk allowed vlan 1,10'],
        ['interface Gi0/1', 'switchport mode trunk', 'switchport trunk allowed vlan 1,20'],
        'TRUNK_ALLOWED_MISMATCH',
      ],
      [['interface Gi0/1', 'duplex half'], [], 'DUPLEX_MISMATCH'],
    ];
    for (const [a, b, code] of cases) {
      const e = new SimulationEngine();
      const sa = device(e, 'access', a),
        sb = device(e, 'access', b, 200);
      e.connect({ device: sa.id, port: 'p0' }, { device: sb.id, port: 'p0' });
      expect(codes(e), code).toContain(code);
    }
  });

  it('flags an access port in a VLAN that was never created, but not VLAN 1 or trunk lists', () => {
    const e = new SimulationEngine();
    const sw = device(e, 'access', [
      'interface Gi0/2',
      'switchport access vlan 30',
      'interface Gi0/3',
      'switchport mode trunk',
      'switchport trunk allowed vlan 1,77',
    ]);
    const pc = e.addDevice('pc'),
      peer = device(
        e,
        'access',
        ['interface Gi0/1', 'switchport mode trunk', 'switchport trunk allowed vlan 1,77'],
        200
      );
    e.connect({ device: pc.id, port: 'p0' }, { device: sw.id, port: 'p1' });
    e.connect({ device: sw.id, port: 'p2' }, { device: peer.id, port: 'p0' });
    const issues = preflight(e.snapshot()).filter((i) => i.code === 'VLAN_NOT_DEFINED');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('Gi0/2');
  });

  it('detects OSPF parameter mismatches on a segment and MTU mismatches on routed links', () => {
    const base = (n: number, extra: string[]) => [
      'interface Gi0/1',
      `ip address 10.0.0.${n} 255.255.255.0`,
      ...extra,
      'router ospf 1',
      `router-id 1.1.1.${n}`,
      'network 10.0.0.0 0.0.0.255 area 0',
    ];
    const cases: [string[], string][] = [
      [['ip ospf hello-interval 5'], 'OSPF_TIMER_MISMATCH'],
      [['ip ospf network point-to-point'], 'OSPF_NETWORK_TYPE_MISMATCH'],
      [['mtu 1400'], 'MTU_MISMATCH'],
    ];
    for (const [extra, code] of cases) {
      const e = new SimulationEngine();
      const a = device(e, 'router', base(1, extra)),
        b = device(e, 'router', base(2, []), 200);
      e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
      expect(codes(e), code).toContain(code);
    }
    const e = new SimulationEngine();
    const a = device(e, 'router', [
        'interface Gi0/1',
        'ip address 10.0.0.1 255.255.255.0',
        'ip ospf 1 area 0',
      ]),
      b = device(
        e,
        'router',
        ['interface Gi0/1', 'ip address 10.0.0.2 255.255.255.0', 'ip ospf 1 area 1'],
        200
      );
    e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
    expect(codes(e)).toContain('OSPF_AREA_MISMATCH');
  });

  it('reports BGP networks without an exact route and NAT without inside/outside roles', () => {
    const e = new SimulationEngine();
    device(e, 'router', [
      'interface Gi0/1',
      'ip address 192.0.2.1 255.255.255.0',
      'ip nat inside',
      'exit',
      'ip nat inside source static 192.0.2.10 198.51.100.10',
      'router bgp 65001',
      'network 192.0.2.0 mask 255.255.255.0',
      'network 10.99.0.0 mask 255.255.0.0',
    ]);
    const issues = preflight(e.snapshot());
    const bgp = issues.find((i) => i.code === 'BGP_NETWORK_NOT_IN_RIB');
    expect(bgp?.message).toContain('10.99.0.0/16');
    expect(bgp?.message).not.toContain('192.0.2.0/24');
    expect(issues.find((i) => i.code === 'NAT_ROLE_MISSING')?.message).toContain('ip nat outside');
  });

  it('warns when two routers translate the same inside network without shared state', () => {
    const e = new SimulationEngine();
    const sw = device(e, 'access', []);
    const routers = [1, 2].map((n) =>
      device(
        e,
        'router',
        [
          'interface Gi0/1',
          `ip address 10.1.1.${n} 255.255.255.0`,
          'ip nat inside',
          'interface Gi0/2',
          `ip address 198.51.100.${n * 4 + 1} 255.255.255.252`,
          'ip nat outside',
          'exit',
          `ip nat inside source static 10.1.1.${50 + n} 198.51.100.${100 + n}`,
        ],
        n * 200
      )
    );
    routers.forEach((r, i) => e.connect({ device: r.id, port: 'p0' }, { device: sw.id, port: 'p' + i }));
    expect(codes(e)).toContain('NAT_ASYMMETRIC_EXIT');
  });
});
