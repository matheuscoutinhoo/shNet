import { describe, expect, it } from 'vitest';
import { SimulationEngine, TerminalSession, validateSnapshot } from '../packages/simulation-engine/src';

function topology(mode: 'active' | 'passive' = 'passive', stp = false) {
  const e = new SimulationEngine(),
    a = e.addDevice('switch'),
    b = e.addDevice('switch'),
    pc = e.addDevice('pc'),
    srv = e.addDevice('server');
  Object.assign(pc.interfaces[0], { ip: '10.0.0.10', prefix: 24 });
  Object.assign(srv.interfaces[0], { ip: '10.0.0.20', prefix: 24 });
  e.connect({ device: pc.id, port: 'p0' }, { device: a.id, port: 'p2' });
  e.connect({ device: srv.id, port: 'p0' }, { device: b.id, port: 'p2' });
  const links = [0, 1].map((i) =>
    e.connect({ device: a.id, port: 'p' + i }, { device: b.id, port: 'p' + i })
  );
  const aa = e.configureLacp(a.id, 1, 'active', ['p0', 'p1']),
    bb = e.configureLacp(b.id, 2, mode, ['p0', 'p1']);
  if (stp) {
    e.configureSpanningTree(a.id, 'rstp');
    e.configureSpanningTree(b.id, 'rstp');
  }
  e.configureTcpService(srv.id, { kind: 'http', port: 80, enabled: true, body: 'LACP members' });
  return { e, a, b, pc, srv, links, aa, bb };
}
describe('LACP por PDUs e encaminhamento EtherChannel', () => {
  it('negocia active/passive com keys locais diferentes e envia broadcast uma vez', () => {
    const { e, a, b, pc, srv, aa, bb } = topology();
    e.advanceTo(5000);
    expect(aa.aggregate!.selected).toEqual(['p0', 'p1']);
    expect(bb.aggregate!.selected).toEqual(['p0', 'p1']);
    const probe = e.ping(pc.id, srv.interfaces[0].ip!),
      tcp = e.httpGet(pc.id, srv.interfaces[0].ip!);
    e.advanceTo(10000);
    expect(e.state.probes.find((p) => p.id === probe)?.status).toBe('success');
    expect(pc.tcpConnections?.find((c) => c.id === tcp)?.received).toContain('LACP members');
    expect(a.macTable.find((m) => m.mac === srv.interfaces[0].mac)?.port).toBe(aa.id);
    expect(b.macTable.find((m) => m.mac === pc.interfaces[0].mac)?.port).toBe(bb.id);
    const arp = e.state.events.filter(
      (ev) => ev.type === 'FRAME_SENT' && ev.device === a.id && ev.frame?.arp?.kind === 'request'
    );
    expect(arp).toHaveLength(1);
    validateSnapshot(e.snapshot());
  });
  it('passive/passive não sincroniza e min-links suspende o grupo após falha', () => {
    const { e, a, aa, bb, pc, srv, links } = topology();
    e.configureLacp(a.id, 1, 'passive', ['p0', 'p1']);
    e.advanceTo(5000);
    expect(a.interfaces.find((p) => p.aggregate)!.aggregate!.selected).toEqual([]);
    expect(bb.aggregate!.selected).toEqual([]);
    const port = e.configureLacp(a.id, 1, 'active', ['p0', 'p1'], 2);
    e.advanceTo(10000);
    expect(port.aggregate!.selected).toHaveLength(2);
    links[0].up = false;
    e.advanceTo(15000);
    expect(port.aggregate!.selected).toEqual([]);
    const probe = e.ping(pc.id, srv.interfaces[0].ip!);
    e.advanceTo(46000);
    expect(e.state.probes.find((p) => p.id === probe)?.status).toBe('timeout');
    expect(aa.id).toBe(port.id);
    validateSnapshot(e.snapshot());
  });
  it('STP enxerga um enlace agregado e HTTP continua com um membro restante', () => {
    const { e, aa, bb, a, pc, srv, links } = topology('active', true);
    e.advanceTo(35000);
    expect(aa.spanningTree?.state).toBe('forwarding');
    expect(bb.spanningTree?.state).toBe('forwarding');
    expect(a.interfaces[0].spanningTree).toBeUndefined();
    links[0].up = false;
    e.advanceTo(37000);
    expect(aa.aggregate!.selected).toEqual(['p1']);
    const tcp = e.httpGet(pc.id, srv.interfaces[0].ip!);
    e.advanceTo(40000);
    expect(pc.tcpConnections?.find((c) => c.id === tcp)?.received).toContain('LACP members');
    validateSnapshot(e.snapshot());
  });
  it('conserva negociação e dados pendentes em snapshots e recusa members/timers inválidos', () => {
    const { e, a, aa } = topology();
    e.advanceTo(1);
    const checkpoint = e.snapshot(),
      restored = new SimulationEngine(checkpoint);
    e.advanceTo(5000);
    restored.advanceTo(5000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    const stable = new SimulationEngine(e.snapshot());
    e.advanceTo(9000);
    stable.advanceTo(9000);
    expect(stable.snapshot()).toEqual(e.snapshot());
    const bad = structuredClone(checkpoint);
    bad.devices
      .find((d) => d.id === a.id)!
      .interfaces.find((p) => p.id === aa.id)!
      .aggregate!.members.push('missing');
    expect(() => validateSnapshot(bad)).toThrow(/Membro/);
    const noTimer = structuredClone(checkpoint);
    noTimer.queue = noTimer.queue.filter(({ action }) => action.kind !== 'lacp-tick');
    expect(() => validateSnapshot(noTimer)).toThrow(/Timer LACP/);
  });
  it('CLI reúne membros físicos e aplica configuração à interface Port-channel', () => {
    const e = new SimulationEngine(),
      sw = e.addDevice('switch'),
      cli = new TerminalSession(e, sw.id);
    for (const command of [
      'enable',
      'conf t',
      'interface Gi0/1',
      'channel-group 1 mode active',
      'interface Gi0/2',
      'channel-group 1 mode active',
      'interface Port-channel1',
      'lacp min-links 2',
      'switchport mode trunk',
      'switchport trunk allowed vlan 1,10',
      'end',
    ])
      expect(cli.execute(command)).not.toMatch(/Erro|%/);
    expect(cli.execute('show running-config')).toContain('channel-group 1 mode active');
    expect(cli.execute('show etherchannel summary')).toContain('min-links=2');
    expect(sw.interfaces[0].channel).toBe('po1');
    cli.execute('conf t');
    cli.execute('interface Gi0/1');
    const checkpoint = e.snapshot();
    expect(cli.execute('channel-group 2 mode active')).toContain('outro grupo');
    expect(e.snapshot()).toEqual(checkpoint);
  });
  it('transporta VLANs no trunk agregado e mantém o hash estável por fluxo', () => {
    const { e, a, b, pc, srv, aa, bb } = topology();
    for (const sw of [a, b]) {
      sw.vlans.push({ id: 10, name: 'Users' });
      sw.interfaces[2].accessVlan = 10;
    }
    for (const agg of [aa, bb]) Object.assign(agg, { mode: 'trunk', allowedVlans: [1, 10] });
    e.advanceTo(5000);
    const tcp = e.httpGet(pc.id, srv.interfaces[0].ip!);
    e.advanceTo(10000);
    expect(pc.tcpConnections?.find((c) => c.id === tcp)?.received).toContain('LACP members');
    const ports = e.state.events
      .filter(
        (ev) =>
          ev.type === 'FRAME_SENT' &&
          ev.device === a.id &&
          ev.frame?.packet?.protocol === 'TCP' &&
          ev.frame.packet.src === pc.interfaces[0].ip &&
          aa.aggregate!.members.includes(ev.port!)
      )
      .map((ev) => ev.port);
    expect(new Set(ports).size).toBe(1);
    expect(
      e.state.events.some((ev) => ev.type === 'FRAME_SENT' && ev.device === a.id && ev.frame?.vlan === 10)
    ).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('BGP e TCP atravessam subinterfaces de um EtherChannel routed após falha de membro', () => {
    const e = new SimulationEngine(),
      a = e.addDevice('router'),
      b = e.addDevice('router');
    const links = [0, 1].map((i) =>
      e.connect({ device: a.id, port: 'p' + i }, { device: b.id, port: 'p' + i })
    );
    const aa = e.configureLacp(a.id, 1, 'active', ['p0', 'p1']),
      bb = e.configureLacp(b.id, 2, 'passive', ['p0', 'p1']);
    const left = e.addSubinterface(a.id, aa.id, 10),
      right = e.addSubinterface(b.id, bb.id, 10);
    Object.assign(left, { ip: '10.0.0.1', prefix: 24 });
    Object.assign(right, { ip: '10.0.0.2', prefix: 24 });
    for (const [d, remote, asn] of [
      [a, '10.0.0.2', 65001],
      [b, '10.0.0.1', 65002],
    ] as const)
      e.configureBgp(d.id, {
        enabled: true,
        asn,
        routerId: d === a ? '1.1.1.1' : '2.2.2.2',
        holdMs: 9000,
        networks: [],
        neighbors: [{ ip: remote, remoteAs: asn === 65001 ? 65002 : 65001 }],
      });
    e.configureTcpService(b.id, { kind: 'http', port: 80, enabled: true, body: 'Subinterface agregada' });
    e.advanceTo(14000);
    expect(a.bgp!.peers[0].state).toBe('Established');
    links[0].up = false;
    const tcp = e.httpGet(a.id, '10.0.0.2');
    e.advanceTo(18000);
    expect(a.bgp!.peers[0].state).toBe('Established');
    expect(a.tcpConnections?.find((c) => c.id === tcp)?.received).toContain('Subinterface agregada');
    validateSnapshot(e.snapshot());
  });
});
