import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  validateSnapshot,
  TerminalSession,
  slaacAddress6,
} from '../packages/simulation-engine/src';

function routed() {
  const e = new SimulationEngine(),
    pc = e.addDevice('pc'),
    r = e.addDevice('router'),
    srv = e.addDevice('server');
  r.ipv6Routing = true;
  e.connect({ device: pc.id, port: 'p0' }, { device: r.id, port: 'p0' });
  e.connect({ device: srv.id, port: 'p0' }, { device: r.id, port: 'p1' });
  for (const [i, host] of [pc, srv].entries()) {
    e.configureIpv6(r.id, 'p' + i, {
      auto: false,
      addresses: [{ ip: `2001:db8:${i + 1}::1`, prefix: 64 }],
      ra: {
        intervalMs: 3000,
        lifetimeMs: 9000,
        prefixes: [
          {
            network: `2001:db8:${i + 1}::`,
            prefix: 64,
            onLink: true,
            autonomous: false,
            validMs: 60000,
            preferredMs: 30000,
          },
        ],
      },
    });
    e.configureIpv6(host.id, 'p0', { auto: true, addresses: [{ ip: `2001:db8:${i + 1}::10`, prefix: 64 }] });
  }
  e.configureTcpService(srv.id, { kind: 'echo', port: 7, enabled: true });
  e.configureTcpService(srv.id, { kind: 'http', port: 80, enabled: true, body: 'HTTP IPv6 roteado' });
  e.configureUdp6Service(srv.id, { kind: 'echo', port: 7, enabled: true });
  e.advanceTo(6000);
  return { e, pc, r, srv };
}
describe('TCP/UDP sobre IPv6 e alcançabilidade de vizinhos', () => {
  it('HTTP, echo segmentado e UDP cruzam roteador, NDP, RA e restore', () => {
    const { e, pc, srv } = routed(),
      text = 'IPv6 🌐 '.repeat(330);
    e.httpGet(pc.id, '2001:db8:2::10');
    e.openTcp(pc.id, '2001:db8:2::10', 7, text, true);
    const id = e.sendUdp6(pc.id, '2001:db8:2::10', 7, 'datagrama IPv6');
    const resumed = new SimulationEngine(e.snapshot());
    e.advanceTo(12000);
    resumed.advanceTo(12000);
    expect(resumed.snapshot()).toEqual(e.snapshot());
    expect(pc.tcpConnections![0].received).toContain('HTTP IPv6 roteado');
    expect(pc.tcpConnections![1].received).toBe(text);
    expect(pc.udp6Records!.find((r) => r.id === id)).toMatchObject({ data: 'datagrama IPv6', reply: true });
    expect(srv.tcpConnections!.every((c) => c.localIp.includes(':'))).toBe(true);
    expect(
      e.state.events.some((v) => v.frame?.ipv6?.protocol === 'TCP' && v.frame.ipv6.hopLimit === 63)
    ).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('ACL IPv6 distingue TCP/UDP e aplica bloqueio nos dois sentidos', () => {
    const { e, pc, r } = routed();
    r.interfaces[1].ipv6!.aclOut = [
      {
        action: 'deny',
        source: '::',
        sourcePrefix: 0,
        destination: '::',
        destinationPrefix: 0,
        kind: 'tcp',
        hits: 0,
      },
      {
        action: 'permit',
        source: '::',
        sourcePrefix: 0,
        destination: '::',
        destinationPrefix: 0,
        kind: 'any',
        hits: 0,
      },
    ];
    e.httpGet(pc.id, '2001:db8:2::10');
    e.sendUdp6(pc.id, '2001:db8:2::10', 7, 'liberado');
    e.advanceTo(71000);
    expect(pc.tcpConnections![0].state).toBe('TIMED-OUT');
    expect(pc.udp6Records![0].data).toBe('liberado');
    expect(r.interfaces[1].ipv6!.aclOut[0].hits).toBeGreaterThan(0);
    validateSnapshot(e.snapshot());
  });
  it('link-local exige scope e HTTP local/CLI usa o mesmo TCP', () => {
    const { e, srv, pc, r } = routed();
    expect(() => e.openTcp(pc.id, slaacAddress6('fe80::', r.interfaces[0].mac), 7)).toThrow('interface');
    e.configureTcpService(r.id, { kind: 'echo', port: 7, enabled: true });
    e.openTcp(pc.id, slaacAddress6('fe80::', r.interfaces[0].mac), 7, 'local', true, undefined, 'p0');
    const cli = new TerminalSession(e, srv.id);
    expect(cli.execute('http get 2001:db8:2::10')).toContain('enfileirado');
    e.advanceTo(8000);
    expect(pc.tcpConnections![0].received).toBe('local');
    expect(cli.execute('show tcp')).toContain('HTTP IPv6 roteado');
    validateSnapshot(e.snapshot());
  });
  it('STALE/DELAY/PROBE confirma MAC por NS unicast e remove vizinho sem resposta', () => {
    const e = new SimulationEngine(),
      a = e.addDevice('pc'),
      b = e.addDevice('pc');
    e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
    for (const [i, d] of [a, b].entries())
      e.configureIpv6(d.id, 'p0', { auto: false, addresses: [{ ip: '2001:db8::' + (i + 1), prefix: 64 }] });
    e.advanceTo(3000);
    e.ping6(a.id, '2001:db8::2');
    e.advanceTo(15000);
    const n = a.neighbors6!.find((n) => n.ip === '2001:db8::2')!;
    expect(n.state).toBe('REACHABLE');
    e.advanceTo(n.expiresAt + 1000);
    expect(n.state).toBe('STALE');
    e.sendUdp6(a.id, '2001:db8::2', 9999, 'sem confirmação de aplicação');
    expect(n.state).toBe('DELAY');
    e.advanceTo(e.state.clock + 6000);
    const renewed = a.neighbors6!.find((n) => n.ip === '2001:db8::2')!;
    expect(renewed.state).toBe('REACHABLE');
    expect(
      e.state.events.some((v) => v.frame?.ipv6?.kind === 'ns' && v.frame.ipv6.dst === '2001:db8::2')
    ).toBe(true);
    e.advanceTo(73000);
    b.power = false;
    e.sendUdp6(a.id, '2001:db8::2', 9999, 'falha');
    const resumed = new SimulationEngine(e.snapshot());
    e.advanceTo(82000);
    resumed.advanceTo(82000);
    expect(e.snapshot()).toEqual(resumed.snapshot());
    expect(a.neighbors6!.find((n) => n.ip === '2001:db8::2')!.state).toBe('FAILED');
    validateSnapshot(e.snapshot());
  });
});
