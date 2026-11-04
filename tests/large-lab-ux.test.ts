import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  addCanvasItem,
  applyBulkConfig,
  collapsedMembers,
  configChanges,
  contextualDiff,
  groupBySite,
  parseVariableTable,
  renderTemplate,
  routingView,
  setGroupsCollapsed,
  siteOf,
  validateSnapshot,
} from '../packages/simulation-engine/src';

const run = (t: TerminalSession, lines: string[]) => {
  for (const line of lines) expect(t.execute(line), line).not.toMatch(/^%/);
};
function device(e: SimulationEngine, profile: 'router' | 'switch-l2', hostname: string, x = 0) {
  const d = e.addFactoryProfile(profile, { x, y: 0 });
  e.setDevicePower(d.id, true);
  const t = new TerminalSession(e, d.id);
  run(t, ['enable', 'configure terminal', 'hostname ' + hostname]);
  return { id: d.id, t };
}
/** R1 (AS 65001) — R2 (AS 65002) over 10.0.12.0/30 with OSPF area 0 and eBGP. */
function routedPair() {
  const e = new SimulationEngine();
  const a = device(e, 'router', 'HQ-R1'),
    b = device(e, 'router', 'BR-R2', 300);
  e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
  for (const [r, ip, asn, peer, peerAs] of [
    [a, '10.0.12.1', 65001, '10.0.12.2', 65002],
    [b, '10.0.12.2', 65002, '10.0.12.1', 65001],
  ] as const)
    run(r.t, [
      'interface Gi0/1',
      'ip address ' + ip + ' 255.255.255.252',
      'ip ospf network point-to-point',
      'ip ospf 1 area 0',
      'router bgp ' + asn,
      'neighbor ' + peer + ' remote-as ' + peerAs,
      'end',
    ]);
  e.advanceTo(90000, 3_000_000);
  return { e, a, b };
}

describe('site groups', () => {
  it('derives the site from the hostname prefix', () => {
    expect(siteOf('HQ-CORE-1')).toBe('HQ');
    expect(siteOf('br01_rtr')).toBe('BR01');
    expect(siteOf('PC1')).toBeUndefined();
  });

  it('groups devices per site, arranges them by tier and collapses groups', () => {
    const e = new SimulationEngine();
    const ids = [
      device(e, 'switch-l2', 'HQ-ACC-1').id,
      device(e, 'router', 'HQ-WAN-1').id,
      device(e, 'router', 'LON-WAN-1').id,
      device(e, 'switch-l2', 'LON-ACC-1').id,
      device(e, 'router', 'CORE').id,
    ];
    const result = groupBySite(e.snapshot());
    expect(result.groups).toBe(2);
    expect(result.grouped).toBe(4);
    const groups = result.snapshot.canvasItems!.filter((item) => item.kind === 'group');
    expect(groups.map((g) => g.text)).toEqual(['Site HQ', 'Site LON']);
    const pos = (id: string) => result.snapshot.devices.find((d) => d.id === id)!.position;
    // Routers sit above switches inside the site.
    expect(pos(ids[1]).y).toBeLessThan(pos(ids[0]).y);
    for (const g of groups)
      for (const member of g.members!) {
        const p = pos(member);
        expect(p.x).toBeGreaterThanOrEqual(g.position.x);
        expect(p.y).toBeGreaterThanOrEqual(g.position.y);
        expect(p.x).toBeLessThan(g.position.x + g.width);
        expect(p.y).toBeLessThan(g.position.y + g.height);
      }
    e.state = result.snapshot;
    expect(setGroupsCollapsed(e, true)).toBe(2);
    expect(collapsedMembers(e.state).size).toBe(4);
    validateSnapshot(e.snapshot());
    setGroupsCollapsed(e, false, groups[0].id);
    expect(collapsedMembers(e.state).size).toBe(2);
    // Already grouped devices are not regrouped.
    expect(() => groupBySite(e.snapshot())).toThrow(/Nenhum site/);
  });

  it('places site groups below existing annotations instead of over them', () => {
    const e = new SimulationEngine();
    device(e, 'router', 'HQ-R1');
    device(e, 'router', 'HQ-R2', 300);
    addCanvasItem(e, {
      kind: 'region',
      text: 'Old HQ region',
      color: 'lime',
      position: { x: 0, y: 0 },
      width: 900,
      height: 700,
    });
    const groups = groupBySite(e.snapshot()).snapshot.canvasItems!.filter((item) => item.kind === 'group');
    expect(groups).toHaveLength(1);
    expect(groups[0].position.y).toBeGreaterThanOrEqual(700);
  });

  it('only groups may be collapsed', () => {
    const e = new SimulationEngine();
    const s = e.snapshot();
    s.canvasItems = [
      {
        id: 'note-1',
        kind: 'note',
        text: 'x',
        position: { x: 0, y: 0 },
        width: 100,
        height: 50,
        color: 'cyan',
        collapsed: true,
      },
    ];
    expect(() => validateSnapshot(s)).toThrow(/grupos/);
  });
});

describe('routing views', () => {
  it('projects L3 segments, OSPF adjacencies and BGP sessions with their state', () => {
    const { e, a, b } = routedPair();
    const l3 = routingView(e.state, 'l3');
    expect(l3.edges).toEqual([expect.objectContaining({ label: '10.0.12.0/30', up: true })]);
    const ospf = routingView(e.state, 'ospf');
    expect(ospf.edges).toEqual([
      expect.objectContaining({ a: [a.id, b.id].sort()[0], label: 'Área 0 · FULL', up: true }),
    ]);
    const bgp = routingView(e.state, 'bgp');
    expect(bgp.edges).toEqual([
      expect.objectContaining({ label: 'eBGP AS65001↔AS65002 · Established', up: true }),
    ]);
    expect(bgp.blocks.map((block) => block.name)).toEqual(['AS 65001', 'AS 65002']);
    expect(bgp.positions.size).toBe(2);
  });

  it('shows configured OSPF segments without a neighbor as failed adjacencies', () => {
    const { e, a } = routedPair();
    run(a.t, ['configure terminal', 'interface Gi0/1', 'ip ospf hello-interval 5', 'end']);
    e.advanceTo(e.state.clock + 60000, 3_000_000);
    const edge = routingView(e.state, 'ospf').edges[0];
    expect(edge.up).toBe(false);
    expect(edge.label).toMatch(/Área 0 · (?:sem adjacência|INIT)/);
  });

  it('does not expect adjacencies on passive segments and separates ABRs from area routers', () => {
    const { e, a, b } = routedPair();
    expect(routingView(e.state, 'ospf').blocks.map((block) => block.name)).toEqual(['Área 0 (backbone)']);
    for (const r of [a, b])
      run(r.t, ['configure terminal', 'router ospf 1', 'passive-interface Gi0/1', 'end']);
    e.advanceTo(e.state.clock + 60000, 3_000_000);
    expect(routingView(e.state, 'ospf').edges).toEqual([]);
    run(b.t, [
      'configure terminal',
      'interface Gi0/1',
      'ip ospf 1 area 1',
      'interface Loopback0',
      'ip address 10.255.0.2 255.255.255.255',
      'ip ospf 1 area 1',
      'end',
    ]);
    run(a.t, [
      'configure terminal',
      'interface Gi0/1',
      'ip ospf 1 area 1',
      'interface Loopback0',
      'ip address 10.255.0.1 255.255.255.255',
      'ip ospf 1 area 0',
      'end',
    ]);
    expect(routingView(e.state, 'ospf').blocks.map((block) => [block.name, block.devices.length])).toEqual([
      ['ABRs', 1],
      ['Área 1', 1],
    ]);
  });
});

describe('configuration diff', () => {
  it('prints IOS contextual diffs', () => {
    const startup =
      'hostname R1\ninterface Gi0/1\n ip address 10.0.0.1 255.255.255.0\n shutdown\nip route 0.0.0.0 0.0.0.0 10.0.0.254';
    const running =
      'hostname R1\ninterface Gi0/1\n ip address 10.0.0.1 255.255.255.0\nrouter ospf 1\n network 10.0.0.0 0.0.0.255 area 0';
    expect(contextualDiff(startup, running)).toEqual([
      'interface Gi0/1',
      ' -shutdown',
      '+router ospf 1',
      ' +network 10.0.0.0 0.0.0.255 area 0',
      '-ip route 0.0.0.0 0.0.0.0 10.0.0.254',
    ]);
  });

  it('compares running-config with startup-config on the CLI and in the inspector API', () => {
    const e = new SimulationEngine();
    const r = device(e, 'router', 'HQ-R1');
    expect(r.t.execute('do show archive config differences')).toMatch(
      /^% Error opening nvram:startup-config/
    );
    run(r.t, ['end', 'write memory', 'configure terminal', 'interface Gi0/2', 'description UPLINK', 'end']);
    expect(r.t.execute('show archive config differences')).toBe(
      '!Contextual Config Diffs:\ninterface Gi0/2\n +description UPLINK'
    );
    expect(configChanges(e, r.id)).toMatchObject({
      saved: true,
      changes: ['interface Gi0/2', ' +description UPLINK'],
    });
    run(r.t, ['write memory']);
    expect(r.t.execute('show archive config differences')).toBe(
      '!Contextual Config Diffs:\n!No changes were found'
    );
  });
});

describe('bulk configuration', () => {
  it('renders variables from built-ins and a per-device table', () => {
    const table = parseVariableTable('hostname;loopback\nHQ-R1;10.255.0.1\nBR-R2;10.255.0.2');
    expect(table.get('hq-r1')).toEqual({ hostname: 'HQ-R1', loopback: '10.255.0.1' });
    expect(
      renderTemplate('ip address {{loopback}} 255.255.255.255 ! {{ hostname }}', table.get('br-r2')!)
    ).toBe('ip address 10.255.0.2 255.255.255.255 ! BR-R2');
    expect(() => renderTemplate('{{missing}}', {})).toThrow('{{missing}}');
    expect(() => parseVariableTable('name,ip\nx,y')).toThrow(/hostname/);
  });

  it('applies a template to many devices, atomically per device', () => {
    const e = new SimulationEngine();
    const r1 = device(e, 'router', 'HQ-R1'),
      r2 = device(e, 'router', 'BR-R2', 300),
      sw = device(e, 'switch-l2', 'BR-SW1', 600);
    const table = parseVariableTable(
      'hostname,loopback\nHQ-R1,10.255.0.1\nBR-R2,10.255.0.2\nBR-SW1,10.255.0.3'
    );
    const template = [
      '! site {{site}} device {{index}}',
      'ntp server 10.0.0.{{index}}',
      'interface Loopback0',
      ' ip address {{loopback}} 255.255.255.255',
      ' description MGMT {{hostname}} site {{site}}',
      'exit',
      'router ospf 1',
      ' network {{loopback}} 0.0.0.0 area 0',
    ].join('\n');
    const results = applyBulkConfig(e, [r1.id, r2.id, sw.id], template, table);
    expect(results.map((r) => r.status)).toEqual(['applied', 'applied', 'failed']);
    // The L2 switch has no "router ospf"; nothing from the template may remain on it.
    expect(results[2].error).toMatchObject({ number: 7, line: 'router ospf 1' });
    expect(e.device(sw.id).interfaces.some((p) => p.loopback)).toBe(false);
    const show = new TerminalSession(e, r2.id);
    run(show, ['enable']);
    expect(show.execute('show running-config')).toMatch(
      /interface Loopback0\n description MGMT BR-R2 site BR\n(?: .*\n)* ip address 10\.255\.0\.2 255\.255\.255\.255/
    );
    expect(show.execute('show running-config')).toMatch(/^ntp server 10\.0\.0\.2$/m);
    expect(
      e.state.events.filter((ev) => ev.type === 'CONFIG_CHANGED' && /massa/.test(ev.reason))
    ).toHaveLength(2);
    validateSnapshot(e.snapshot());
  });

  it('refuses destructive commands', () => {
    const e = new SimulationEngine();
    const r = device(e, 'router', 'HQ-R1');
    expect(applyBulkConfig(e, [r.id], 'hostname X\ndo reload')[0]).toMatchObject({
      status: 'failed',
      error: { number: 2 },
    });
    expect(e.device(r.id).hostname).toBe('HQ-R1');
  });
});
