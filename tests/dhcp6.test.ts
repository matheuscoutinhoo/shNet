import { describe, expect, it } from 'vitest';
import { SimulationEngine, validateSnapshot, slaacAddress6 } from '../packages/simulation-engine/src';
function network(rapid = false) {
  const e = new SimulationEngine(),
    r = e.addDevice('router'),
    pc = e.addDevice('pc');
  r.ipv6Routing = true;
  const link = e.connect({ device: r.id, port: 'p0' }, { device: pc.id, port: 'p0' });
  e.configureIpv6(r.id, 'p0', {
    auto: false,
    addresses: [{ ip: '2001:db8:1::1', prefix: 64 }],
    ra: {
      intervalMs: 3000,
      lifetimeMs: 9000,
      prefixes: [
        {
          network: '2001:db8:1::',
          prefix: 64,
          onLink: true,
          autonomous: false,
          validMs: 60000,
          preferredMs: 30000,
        },
      ],
    },
  });
  e.configureIpv6(pc.id, 'p0', { auto: false, addresses: [] });
  e.configureDhcp6Server(r.id, {
    enabled: true,
    rapidCommit: rapid,
    pools: [
      {
        name: 'LAN',
        port: 'p0',
        addresses: { start: '2001:db8:1::100', end: '2001:db8:1::101' },
        validMs: 20000,
        preferredMs: 15000,
        t1Ms: 6000,
        t2Ms: 12000,
        dns: ['2001:db8:1::53'],
      },
    ],
  });
  e.configureDhcp6Client(pc.id, 'p0', {
    enabled: true,
    requestAddress: true,
    requestPrefix: false,
    rapidCommit: rapid,
  });
  return { e, r, pc, link };
}
describe('DHCPv6 IA_NA, IA_PD, renovação e conflitos', () => {
  it.each([false, true])('troca mensagens reais, DAD, RA on-link e HTTP; rapid=%s', (rapid) => {
    const { e, r, pc } = network(rapid),
      resumed = new SimulationEngine(e.snapshot());
    e.advanceTo(6000);
    resumed.advanceTo(6000);
    expect(resumed.snapshot()).toEqual(e.snapshot());
    const client = pc.interfaces[0].dhcp6!;
    expect(client.state).toBe('BOUND');
    expect(client.address).toBe('2001:db8:1::100');
    expect(client.dns).toEqual(['2001:db8:1::53']);
    expect(pc.interfaces[0].ipv6!.addresses.find((a) => a.origin === 'dhcp6')?.state).toBe('preferred');
    e.configureTcpService(r.id, { kind: 'http', port: 80, enabled: true, body: 'HTTP após DHCPv6' });
    e.httpGet(pc.id, '2001:db8:1::1');
    e.advanceTo(7000);
    expect(pc.tcpConnections![0].received).toContain('HTTP após DHCPv6');
    const types = e.state.events.flatMap((v) =>
      v.frame?.ipv6?.protocol === 'UDP' && v.frame.ipv6.datagram.payload.protocol === 'DHCPv6'
        ? [v.frame.ipv6.datagram.payload.message.type]
        : []
    );
    expect(types).toContain('SOLICIT');
    expect(types).toContain('REPLY');
    expect(types.includes('ADVERTISE')).toBe(!rapid);
    validateSnapshot(e.snapshot());
  });
  it('renova em T1, rebinda em T2 e remove endereço ao expirar sem respostas', () => {
    const { e, pc, link } = network();
    e.advanceTo(6000);
    const c = pc.interfaces[0].dhcp6!,
      before = c.validUntil!;
    e.advanceTo(12000);
    expect(c.validUntil).toBeGreaterThan(before);
    const expiry = c.validUntil!;
    link.loss = 1;
    e.advanceTo(expiry - 1000);
    expect(c.state).toBe('REBINDING');
    e.advanceTo(expiry + 1500);
    expect(pc.interfaces[0].ipv6!.addresses.some((a) => a.origin === 'dhcp6')).toBe(false);
    expect(c.state).toBe('SOLICITING');
    validateSnapshot(e.snapshot());
  });
  it('DAD envia DECLINE e escolhe outro endereço; RELEASE devolve concessão', () => {
    const { e, r, pc } = network();
    // Another on-link station owns the first pool address.
    const conflict = e.addDevice('pc'),
      sw = e.addDevice('switch');
    e.removeLink(e.state.links[0].id);
    e.connect({ device: r.id, port: 'p0' }, { device: sw.id, port: 'p0' });
    e.connect({ device: pc.id, port: 'p0' }, { device: sw.id, port: 'p1' });
    e.connect({ device: conflict.id, port: 'p0' }, { device: sw.id, port: 'p2' });
    e.configureIpv6(conflict.id, 'p0', { auto: false, addresses: [{ ip: '2001:db8:1::100', prefix: 64 }] });
    e.advanceTo(10000);
    expect(pc.interfaces[0].dhcp6!.address).toBe('2001:db8:1::101');
    expect(r.dhcp6Server!.declined.some((v) => v.address === '2001:db8:1::100')).toBe(true);
    e.releaseDhcp6(pc.id, 'p0');
    e.advanceTo(11000);
    expect(r.dhcp6Server!.leases).toHaveLength(0);
    expect(pc.interfaces[0].ipv6!.addresses.some((a) => a.origin === 'dhcp6')).toBe(false);
    validateSnapshot(e.snapshot());
  });
  it('delega /64 ao roteador e anuncia o prefixo para a LAN downstream', () => {
    const { e, r, pc } = network(),
      edge = e.addDevice('router'),
      host = e.addDevice('pc');
    edge.ipv6Routing = true;
    e.removeLink(e.state.links[0].id);
    e.configureDhcp6Client(pc.id, 'p0', { enabled: false, requestAddress: true, requestPrefix: false });
    e.connect({ device: r.id, port: 'p0' }, { device: edge.id, port: 'p0' });
    e.connect({ device: edge.id, port: 'p1' }, { device: host.id, port: 'p0' });
    for (const [d, p] of [
      [edge, 'p0'],
      [edge, 'p1'],
      [host, 'p0'],
    ] as const)
      e.configureIpv6(d.id, p, { auto: d === host, addresses: [] });
    const pools = structuredClone(r.dhcp6Server!.pools);
    pools[0].delegation = { network: '2001:db8:100::', prefix: 56, delegatedLength: 64, maxLeases: 4 };
    e.configureDhcp6Server(r.id, { enabled: true, pools });
    e.configureDhcp6Client(edge.id, 'p0', {
      enabled: true,
      requestAddress: true,
      requestPrefix: true,
      delegatePort: 'p1',
    });
    e.advanceTo(7000);
    const c = edge.interfaces[0].dhcp6!;
    expect(c.delegatedPrefix).toBe('2001:db8:100::');
    expect(r.routes6!.some((route) => route.network === '2001:db8:100::' && route.dhcp6Lease)).toBe(true);
    expect(
      host.interfaces[0].ipv6!.addresses.some(
        (a) => a.ip === slaacAddress6('2001:db8:100::', host.interfaces[0].mac) && a.state === 'preferred'
      )
    ).toBe(true);
    const q = e.ping6(host.id, '2001:db8:100::1');
    e.advanceTo(8000);
    expect(e.state.probes6!.find((q0) => q0.id === q)!.status).toBe('success');
    const routed = e.ping6(host.id, '2001:db8:1::1');
    e.advanceTo(9000);
    expect(e.state.probes6!.find((q0) => q0.id === routed)!.status).toBe('success');
    validateSnapshot(e.snapshot());
  });
  it('recupera perda e rejeita pool/timer adulterado', () => {
    const { e, r, pc, link } = network();
    link.loss = 1;
    e.advanceTo(3000);
    link.loss = 0;
    e.advanceTo(9000);
    expect(pc.interfaces[0].dhcp6!.state).toBe('BOUND');
    const bad = e.snapshot();
    bad.queue = bad.queue.filter((q) => q.action.kind !== 'dhcp6-tick');
    expect(() => validateSnapshot(bad)).toThrow('timer DHCPv6');
    const pools = structuredClone(r.dhcp6Server!.pools);
    pools[0].addresses!.end = '2001:db8:1::ffff';
    expect(() => e.configureDhcp6Server(r.id, { enabled: true, pools })).toThrow('até 256');
    validateSnapshot(e.snapshot());
  });
});
