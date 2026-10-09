import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  validateSnapshot,
  normalize6,
  network6,
  slaacAddress6,
  multicastMac6,
} from '../packages/simulation-engine/src';
const config = (ip: string, prefix = 64) => ({ auto: false, addresses: [{ ip, prefix }] });
const ra = (network: string) => ({
  intervalMs: 3000,
  lifetimeMs: 9000,
  prefixes: [{ network, prefix: 64, autonomous: true, onLink: true, validMs: 60000, preferredMs: 30000 }],
});
function slaac() {
  const e = new SimulationEngine(),
    r = e.addDevice('router'),
    a = e.addDevice('pc'),
    b = e.addDevice('pc');
  r.ipv6Routing = true;
  for (const [i, pc] of [a, b].entries()) {
    const network = `2001:db8:${i + 1}::`;
    e.connect({ device: r.id, port: 'p' + i }, { device: pc.id, port: 'p0' });
    e.configureIpv6(r.id, 'p' + i, { ...config(network + '1'), ra: ra(network) });
    e.configureIpv6(pc.id, 'p0', { auto: true, addresses: [] });
  }
  return { e, r, a, b, target: slaacAddress6('2001:db8:2::', b.interfaces[0].mac) };
}
describe('IPv6, ICMPv6 e descoberta por frames', () => {
  it('normaliza compressão, prefixos e IPv4 mapeado', () => {
    expect(normalize6('2001:0DB8:0000:0:0000:0:0:1')).toBe('2001:db8::1');
    expect(normalize6('::ffff:192.0.2.1')).toBe('::ffff:c000:201');
    expect(network6('2001:db8:abff::1', 40)).toBe('2001:db8:ab00::');
    expect(() => normalize6('2001::db8::1')).toThrow();
  });
  it('DAD, RS, RA e SLAAC instalam gateway link-local e NDP permite ping roteado', () => {
    const { e, a, b, target } = slaac();
    e.advanceTo(10000);
    expect(b.interfaces[0].ipv6?.addresses.find((v) => v.ip === target)?.state).toBe('preferred');
    expect(a.interfaces[0].ipv6?.routers).toHaveLength(1);
    const id = e.ping6(a.id, target);
    e.advanceTo(11000);
    expect(e.state.probes6?.find((p) => p.id === id)?.status).toBe('success');
    expect(e.state.events.some((v) => v.frame?.ipv6?.kind === 'ns')).toBe(true);
    expect(e.state.events.some((v) => v.frame?.ipv6?.kind === 'ra')).toBe(true);
    expect(a.neighbors6?.some((n) => n.ip.startsWith('fe80:'))).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('retorna Hop Limit excedido e Packet Too Big, sem fragmentação no roteador', () => {
    const { e, r, a, target } = slaac();
    e.advanceTo(10000);
    r.interfaces[1].mtu = 1280;
    const ttl = e.ping6(a.id, target, 1),
      mtu = e.ping6(a.id, target, 64, undefined, undefined, 1400);
    e.advanceTo(11000);
    expect(e.state.probes6?.find((p) => p.id === ttl)?.status).toBe('time-exceeded');
    expect(e.state.probes6?.find((p) => p.id === mtu)).toMatchObject({ status: 'packet-too-big', mtu: 1280 });
    r.ipv6Routing = false;
    const blocked = e.ping6(a.id, target);
    e.advanceTo(42000);
    expect(e.state.probes6?.find((p) => p.id === blocked)?.status).toBe('timeout');
  });
  it('detecta duplicação e rejeita NDP com Hop Limit diferente de 255', () => {
    const e = new SimulationEngine(),
      a = e.addDevice('pc'),
      b = e.addDevice('pc');
    e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
    e.configureIpv6(a.id, 'p0', config('2001:db8::1'));
    e.configureIpv6(b.id, 'p0', config('2001:db8::1'));
    e.advanceTo(3000);
    expect(a.interfaces[0].ipv6?.addresses.find((v) => v.origin === 'static')?.state).toBe('duplicate');
    expect(b.interfaces[0].ipv6?.addresses.find((v) => v.origin === 'static')?.state).toBe('duplicate');
    e.configureIpv6(a.id, 'p0', { auto: true, addresses: [] });
    e.advanceTo(5000);
    e.sendFrame(b.id, 'p0', {
      src: b.interfaces[0].mac,
      dst: multicastMac6('ff02::1'),
      etherType: 'IPv6',
      hops: 32,
      ipv6: {
        src: slaacAddress6('fe80::', b.interfaces[0].mac),
        dst: 'ff02::1',
        protocol: 'ICMPv6',
        kind: 'ra',
        hopLimit: 64,
        bytes: 96,
        lifetimeMs: 9000,
        prefixes: ra('2001:db8:bad::').prefixes,
      },
    });
    e.advanceTo(5500);
    expect(a.interfaces[0].ipv6?.routers).toEqual([]);
    expect(a.interfaces[0].ipv6?.addresses.some((v) => v.origin === 'slaac')).toBe(false);
    expect(e.state.events.some((v) => v.reason.includes('Hop Limit/opção MAC inválidos'))).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('expira gateway RA e NDP sem resposta após três solicitações', () => {
    const { e, a, r, target } = slaac();
    e.advanceTo(10000);
    r.interfaces[0].ipv6!.ra = undefined;
    e.advanceTo(21000);
    expect(a.interfaces[0].ipv6?.routers).toEqual([]);
    const failed = e.ping6(a.id, target);
    e.advanceTo(52000);
    expect(e.state.probes6?.find((p) => p.id === failed)?.status).toBe('timeout');
    const start = e.state.clock,
      missed = e.ping6(a.id, '2001:db8:1::dead');
    e.advanceTo(start + 31000);
    expect(e.state.probes6?.find((p) => p.id === missed)?.status).toBe('timeout');
    const requests = e.state.events.filter(
      (v) => v.type === 'NDP_SENT' && v.device === a.id && v.frame?.ipv6?.target === '2001:db8:1::dead'
    );
    expect(requests).toHaveLength(3);
    expect(a.pending6).toEqual([]);
    expect(a.resolutions6).toEqual([]);
    validateSnapshot(e.snapshot());
  });
  it('isola IPv6 sobreposto por VRF e exige escopo para link-local', () => {
    const e = new SimulationEngine(),
      r = e.addDevice('router'),
      a = e.addDevice('pc'),
      b = e.addDevice('pc');
    for (const [i, pc] of [a, b].entries()) {
      const vrf = i ? 'RED' : 'BLUE';
      e.configureVrf(r.id, vrf);
      e.setInterfaceVrf(r.id, 'p' + i, vrf);
      e.connect({ device: r.id, port: 'p' + i }, { device: pc.id, port: 'p0' });
      e.configureIpv6(r.id, 'p' + i, config('2001:db8::1'));
      e.configureIpv6(pc.id, 'p0', config('2001:db8::2'));
    }
    e.advanceTo(3000);
    const p = e.ping6(r.id, '2001:db8::2', 64, 'BLUE');
    e.advanceTo(4000);
    expect(e.state.probes6?.find((q) => q.id === p)?.status).toBe('success');
    expect(b.interfaces[0].rx).toBeGreaterThan(0);
    expect(b.logs.some((l) => l.includes('echo-request'))).toBe(false);
    expect(() => e.ping6(r.id, slaacAddress6('fe80::', a.interfaces[0].mac), 64, 'BLUE')).toThrow(
      'interface'
    );
    const ll = e.ping6(r.id, slaacAddress6('fe80::', a.interfaces[0].mac), 64, 'BLUE', 'p0');
    e.advanceTo(5000);
    expect(e.state.probes6?.find((q) => q.id === ll)?.status).toBe('success');
    validateSnapshot(e.snapshot());
  });
  it('SVIs transportam RA e roteiam IPv6 entre VLANs; ACL IPv6 bloqueia echo', () => {
    const e = new SimulationEngine(),
      sw = e.addDevice('switch'),
      a = e.addDevice('pc'),
      b = e.addDevice('pc');
    sw.ipv6Routing = true;
    for (const [i, pc] of [a, b].entries()) {
      const v = (i + 1) * 10;
      const s = e.addSvi(sw.id, v);
      sw.interfaces[i].accessVlan = v;
      const network = `2001:db8:${v}::`;
      e.connect({ device: sw.id, port: 'p' + i }, { device: pc.id, port: 'p0' });
      e.configureIpv6(sw.id, s.id, { ...config(network + '1'), ra: ra(network) });
      e.configureIpv6(pc.id, 'p0', { auto: true, addresses: [] });
    }
    e.advanceTo(10000);
    const target = slaacAddress6('2001:db8:20::', b.interfaces[0].mac),
      id = e.ping6(a.id, target);
    e.advanceTo(11000);
    expect(e.state.probes6?.find((p) => p.id === id)?.status).toBe('success');
    const svi = sw.interfaces.find((p) => p.logical?.vlan === 10)!;
    svi.ipv6!.aclIn = [
      {
        action: 'deny',
        kind: 'echo-request',
        source: '::',
        sourcePrefix: 0,
        destination: '::',
        destinationPrefix: 0,
        hits: 0,
      },
      {
        action: 'permit',
        kind: 'any',
        source: '::',
        sourcePrefix: 0,
        destination: '::',
        destinationPrefix: 0,
        hits: 0,
      },
    ];
    const denied = e.ping6(a.id, target);
    e.advanceTo(42000);
    expect(e.state.probes6?.find((p) => p.id === denied)?.status).toBe('timeout');
    expect(svi.ipv6!.aclIn[0].hits).toBe(1);
    validateSnapshot(e.snapshot());
  });
  it('restaura DAD, NDP pendente e RA sem divergência; rejeita timers adulterados', () => {
    const { e, a, target } = slaac();
    const initial = new SimulationEngine(e.snapshot());
    e.advanceTo(10000);
    initial.advanceTo(10000);
    expect(initial.snapshot()).toEqual(e.snapshot());
    e.ping6(a.id, target);
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(11000);
    restored.advanceTo(11000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    const bad = e.snapshot();
    bad.queue = bad.queue.filter((q) => q.action.kind !== 'ipv6-tick');
    expect(() => validateSnapshot(bad)).toThrow('Timer IPv6');
    const orphan = e.snapshot();
    orphan.queue.push({
      at: 12000,
      order: ++orphan.sequence,
      action: { kind: 'ndp-timer', device: a.id, port: 'p0', ip: '2001:db8::bad', token: 'fake' },
    });
    expect(() => validateSnapshot(orphan)).toThrow('órfão');
  });
  it('rotas estáticas levam tráfego por dois roteadores e respondem unreachable quando retiradas', () => {
    const e = new SimulationEngine(),
      a = e.addDevice('pc'),
      r = e.addDevice('router'),
      s = e.addDevice('router'),
      b = e.addDevice('pc');
    r.ipv6Routing = true;
    s.ipv6Routing = true;
    e.connect({ device: a.id, port: 'p0' }, { device: r.id, port: 'p0' });
    e.connect({ device: r.id, port: 'p1' }, { device: s.id, port: 'p0' });
    e.connect({ device: s.id, port: 'p1' }, { device: b.id, port: 'p0' });
    for (const [d, p, ip] of [
      [a, 'p0', '2001:db8:1::10'],
      [r, 'p0', '2001:db8:1::1'],
      [r, 'p1', '2001:db8:12::1'],
      [s, 'p0', '2001:db8:12::2'],
      [s, 'p1', '2001:db8:2::1'],
      [b, 'p0', '2001:db8:2::10'],
    ] as const)
      e.configureIpv6(d.id, p, config(ip));
    const routes = [
      { d: a, network: '::', prefix: 0, nextHop: '2001:db8:1::1', port: 'p0', metric: 1 },
      { d: r, network: '2001:db8:2::', prefix: 64, nextHop: '2001:db8:12::2', port: 'p1', metric: 1 },
      { d: s, network: '2001:db8:1::', prefix: 64, nextHop: '2001:db8:12::1', port: 'p0', metric: 1 },
      { d: b, network: '::', prefix: 0, nextHop: '2001:db8:2::1', port: 'p0', metric: 1 },
    ];
    for (const { d, ...route } of routes) e.configureRoute6(d.id, route);
    e.advanceTo(3000);
    const id = e.ping6(a.id, '2001:db8:2::10');
    e.advanceTo(4000);
    expect(e.state.probes6?.find((p) => p.id === id)?.status).toBe('success');
    const { d, ...route } = routes[1];
    e.configureRoute6(d.id, route, true);
    const missing = e.ping6(a.id, '2001:db8:2::10');
    e.advanceTo(5000);
    expect(e.state.probes6?.find((p) => p.id === missing)?.status).toBe('unreachable');
    validateSnapshot(e.snapshot());
  });
  it('deprecia e remove endereços SLAAC; RA zero retira gateway sem apagar endereço prematuramente', () => {
    const { e, r, a } = slaac();
    e.advanceTo(10000);
    const state = a.interfaces[0].ipv6!,
      address = state.addresses.find((v) => v.origin === 'slaac')!,
      expiry = address.validUntil!;
    const advertisement = r.interfaces[0].ipv6!.ra!;
    advertisement.lifetimeMs = 0;
    advertisement.prefixes[0].validMs = 0;
    advertisement.prefixes[0].preferredMs = 0;
    e.advanceTo(14000);
    expect(state.routers).toEqual([]);
    expect(address.validUntil).toBe(expiry);
    expect(address.state).toBe('deprecated');
    r.interfaces[0].ipv6!.ra = undefined;
    e.advanceTo(expiry + 2000);
    expect(state.addresses.some((v) => v.origin === 'slaac')).toBe(false);
    validateSnapshot(e.snapshot());
  });
  it('CLI configura SLAAC, RA, ACL e rotas; uma opção inválida faz rollback', () => {
    const e = new SimulationEngine(),
      r = e.addDevice('router'),
      t = new TerminalSession(e, r.id);
    for (const cmd of [
      'enable',
      'conf t',
      'ipv6 unicast-routing',
      'interface Gi0/1',
      'ipv6 address 2001:db8::1/64',
      'ipv6 nd prefix 2001:db8::/64 valid 60 preferred 30',
      'ipv6 traffic-filter in permit any ::/0 ::/0',
      'end',
      'conf t',
      'ipv6 route 2001:db8:2::/64 Gi0/1 2001:db8::2',
      'end',
    ])
      expect(t.execute(cmd), cmd).not.toMatch(/^%/);
    expect(t.execute('show running-config')).toContain('ipv6 address 2001:db8::1/64');
    expect(t.execute('show ipv6 route')).toContain('2001:db8:2::/64');
    t.execute('conf t');
    t.execute('interface Gi0/1');
    const before = e.snapshot();
    expect(t.execute('ipv6 address ff02::1/64')).toMatch(/^%/);
    expect(e.snapshot()).toEqual(before);
    validateSnapshot(e.snapshot());
  });
  it('subinterfaces IPv6 usam VLAN sobre LACP e mantêm ping após falha de membro', () => {
    const e = new SimulationEngine(),
      a = e.addDevice('router'),
      b = e.addDevice('router');
    const links = [0, 1].map((i) =>
      e.connect({ device: a.id, port: 'p' + i }, { device: b.id, port: 'p' + i })
    );
    const aa = e.configureLacp(a.id, 1, 'active', ['p0', 'p1']),
      bb = e.configureLacp(b.id, 1, 'passive', ['p0', 'p1']);
    const x = e.addSubinterface(a.id, aa.id, 30),
      y = e.addSubinterface(b.id, bb.id, 30);
    e.configureIpv6(a.id, x.id, config('2001:db8:30::1'));
    e.configureIpv6(b.id, y.id, config('2001:db8:30::2'));
    e.advanceTo(5000);
    const id = e.ping6(a.id, '2001:db8:30::2');
    e.advanceTo(6000);
    expect(e.state.probes6?.find((p) => p.id === id)?.status).toBe('success');
    links[0].up = false;
    const again = e.ping6(a.id, '2001:db8:30::2');
    e.advanceTo(10000);
    expect(e.state.probes6?.find((p) => p.id === again)?.status).toBe('success');
    validateSnapshot(e.snapshot());
  });
});
