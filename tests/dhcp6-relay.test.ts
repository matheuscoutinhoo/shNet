import { describe, expect, it } from 'vitest';
import { SimulationEngine, validateSnapshot } from '../packages/simulation-engine/src';
import { replyDhcp6Relay } from '../packages/simulation-engine/src/protocols/dhcp6-relay';
function network(nested = false) {
  const e = new SimulationEngine(),
    client = e.addDevice('router'),
    relay = e.addDevice('router'),
    outer = nested ? e.addDevice('router') : undefined,
    server = e.addDevice('server');
  client.ipv6Routing = true;
  e.connect({ device: client.id, port: 'p0' }, { device: relay.id, port: 'p0' });
  e.connect({ device: relay.id, port: 'p1' }, { device: outer?.id ?? server.id, port: 'p0' });
  if (outer) e.connect({ device: outer.id, port: 'p1' }, { device: server.id, port: 'p0' });
  const addresses = [
    [relay, 'p0', '2001:db8:1::1'],
    [relay, 'p1', '2001:db8:2::1'],
    ...(outer
      ? [
          [outer, 'p0', '2001:db8:2::2'],
          [outer, 'p1', '2001:db8:3::1'],
        ]
      : []),
    [server, 'p0', nested ? '2001:db8:3::10' : '2001:db8:2::10'],
  ] as const;
  for (const [device, port, ip] of addresses) {
    if (typeof device === 'string' || typeof port !== 'string' || typeof ip !== 'string')
      throw new Error('Fixture inválida');
    e.configureIpv6(device.id, port, {
      auto: false,
      addresses: [{ ip, prefix: 64 }],
      ...(device === relay && port === 'p0'
        ? {
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
                  preferredMs: 45000,
                },
              ],
            },
          }
        : {}),
    });
  }
  relay.ipv6Routing = true;
  if (outer) {
    outer.ipv6Routing = true;
    e.configureRoute6(relay.id, {
      network: '2001:db8:3::',
      prefix: 64,
      nextHop: '2001:db8:2::2',
      port: 'p1',
      metric: 1,
    });
    e.configureRoute6(outer.id, {
      network: '2001:db8:1::',
      prefix: 64,
      nextHop: '2001:db8:2::1',
      port: 'p0',
      metric: 1,
    });
  }
  e.configureIpv6(client.id, 'p0', { auto: true, addresses: [] });
  e.configureIpv6(client.id, 'p1', { auto: false, addresses: [] });
  const downstream = e.addDevice('pc');
  e.connect({ device: client.id, port: 'p1' }, { device: downstream.id, port: 'p0' });
  e.configureIpv6(downstream.id, 'p0', { auto: true, addresses: [] });
  e.configureDhcp6Relay(relay.id, 'p0', {
    enabled: true,
    servers: [nested ? '2001:db8:2::2' : '2001:db8:2::10'],
  });
  if (outer) e.configureDhcp6Relay(outer.id, 'p0', { enabled: true, servers: ['2001:db8:3::10'] });
  e.configureDhcp6Server(server.id, {
    enabled: true,
    relayPeers: [nested ? '2001:db8:3::1' : '2001:db8:2::1'],
    pools: [
      {
        name: 'REMOTE',
        port: 'p0',
        relayLink: { network: '2001:db8:1::', prefix: 64 },
        addresses: { start: '2001:db8:1::100', end: '2001:db8:1::110' },
        delegation: { network: '2001:db8:100::', prefix: 56, delegatedLength: 64, maxLeases: 8 },
        validMs: 60000,
        preferredMs: 45000,
        t1Ms: 20000,
        t2Ms: 40000,
        dns: [nested ? '2001:db8:3::10' : '2001:db8:2::10'],
      },
    ],
  });
  e.advanceTo(6000);
  e.configureDhcp6Client(client.id, 'p0', {
    enabled: true,
    requestAddress: true,
    requestPrefix: true,
    delegatePort: 'p1',
  });
  return { e, client, relay, outer, server };
}
describe('Relay DHCPv6 roteado', () => {
  for (const nested of [false, true])
    it(`encaminha ${nested ? 'dois relays' : 'um relay'}, seleciona pool remoto, instala PD e renova após restore`, () => {
      const { e, client, relay, outer, server } = network(nested);
      e.advanceTo(12000);
      const c = client.interfaces[0].dhcp6!;
      expect(c.state).toBe('BOUND');
      expect(c.address).toBe('2001:db8:1::100');
      expect(c.delegatedPrefix).toBe('2001:db8:100::');
      expect(relay.interfaces[0].dhcp6Relay!.replied).toBeGreaterThan(0);
      expect(relay.routes6?.some((r) => r.dhcp6RelayLease)).toBe(true);
      if (outer) expect(outer.routes6?.some((r) => r.dhcp6RelayLease)).toBe(true);
      expect(server.routes6?.some((r) => r.dhcp6Lease)).toBe(true);
      const hops = e.state.events.flatMap((v) =>
        v.frame?.ipv6?.protocol === 'UDP' && v.frame.ipv6.datagram.payload.protocol === 'DHCPv6-RELAY'
          ? [v.frame.ipv6.datagram.payload.relay.hops.length]
          : []
      );
      expect(hops).toContain(nested ? 2 : 1);
      const ping = e.ping6(server.id, '2001:db8:100::1');
      e.advanceTo(15000);
      expect(e.state.probes6!.find((p) => p.id === ping)!.status).toBe('success');
      const before = c.validUntil!,
        restored = new SimulationEngine(e.snapshot());
      e.advanceTo(33000);
      restored.advanceTo(33000);
      expect(e.snapshot()).toEqual(restored.snapshot());
      expect(c.validUntil!).toBeGreaterThan(before);
      expect(server.dhcp6Server!.leases).toHaveLength(1);
      validateSnapshot(e.snapshot());
      e.releaseDhcp6(client.id, 'p0');
      e.advanceTo(35000);
      expect(server.dhcp6Server!.leases).toHaveLength(0);
      expect(relay.routes6?.some((r) => r.dhcp6RelayLease)).toBe(false);
      validateSnapshot(e.snapshot());
    });
  it('recusa resposta fora da correlação, relay não autorizado e snapshot com interface adulterada', () => {
    const { e, client, relay, server } = network();
    server.dhcp6Server!.relayPeers = [];
    e.advanceTo(12000);
    expect(client.interfaces[0].dhcp6!.state).not.toBe('BOUND');
    expect(server.dhcp6Server!.leases).toHaveLength(0);
    const entry = e.state.events.find(
        (v) => v.frame?.ipv6?.protocol === 'UDP' && v.frame.ipv6.datagram.payload.protocol === 'DHCPv6-RELAY'
      )!,
      packet = structuredClone(entry.frame!.ipv6!);
    if (packet.protocol !== 'UDP' || packet.datagram.payload.protocol !== 'DHCPv6-RELAY')
      throw new Error('Fixture');
    const response = packet.datagram.payload.relay;
    response.type = 'RELAY-REPL';
    response.message.type = 'REPLY';
    response.message.status = 'Success';
    response.hops[0].peerAddress = 'fe80::dead';
    packet.src = '2001:db8:2::10';
    packet.datagram.destinationPort = 547;
    const before = relay.interfaces[0].dhcp6Relay!.replied;
    replyDhcp6Relay(e, relay, relay.interfaces[1], packet, response);
    expect(relay.interfaces[0].dhcp6Relay!.replied).toBe(before);
    const invalid = e.snapshot();
    invalid.devices.find((d) => d.id === relay.id)!.interfaces[0].dhcp6Relay!.pending[0].hops[0].interfaceId =
      'missing';
    expect(() => validateSnapshot(invalid)).toThrow('interface de origem');
    const invalidPeer = e.snapshot();
    invalidPeer.devices.find((d) => d.id === server.id)!.dhcp6Server!.relayPeers = ['fe80::1'];
    expect(() => validateSnapshot(invalidPeer)).toThrow('Peers');
  });
});
