import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  dhcpPoolStats,
  makeTemplate,
  validateSnapshot,
  type Device,
  type UdpPacket,
} from '../packages/simulation-engine/src';
import { receiveUdp } from '../packages/simulation-engine/src/protocols/udp';

function relayLan(leaseMs = 3600000) {
  const engine = new SimulationEngine();
  const client = engine.addDevice('pc'),
    other = engine.addDevice('pc'),
    sw = engine.addDevice('switch');
  const relay = engine.addDevice('router'),
    core = engine.addDevice('router'),
    server = engine.addDevice('server');
  const ip = (device: Device, index: number, address: string, prefix = 24) =>
    Object.assign(device.interfaces[index], { ip: address, prefix });
  ip(relay, 0, '192.168.10.1');
  ip(relay, 1, '10.0.0.1', 30);
  ip(core, 0, '10.0.0.2', 30);
  ip(core, 1, '192.168.20.1');
  ip(server, 0, '192.168.20.10');
  server.gateway = '192.168.20.1';
  relay.routes.push({ network: '192.168.20.0', prefix: 24, nextHop: '10.0.0.2', metric: 1 });
  core.routes.push({ network: '192.168.10.0', prefix: 24, nextHop: '10.0.0.1', metric: 1 });
  for (const [a, ap, b, bp] of [
    [client, 'p0', sw, 'p0'],
    [other, 'p0', sw, 'p1'],
    [sw, 'p2', relay, 'p0'],
    [relay, 'p1', core, 'p0'],
    [core, 'p1', server, 'p0'],
  ] as const)
    engine.connect({ device: a.id, port: ap }, { device: b.id, port: bp });
  engine.configureDhcpRelay(relay.id, 'p0', ['192.168.20.10']);
  engine.configureDhcpPool(server.id, {
    name: 'REMOTE',
    port: 'p0',
    network: '192.168.10.0',
    prefix: 24,
    start: '192.168.10.50',
    end: '192.168.10.55',
    gateway: '192.168.10.1',
    relayAddress: '192.168.10.1',
    dns: ['192.168.20.10'],
    leaseMs,
    excluded: [],
    reservations: [{ clientMac: client.interfaces[0].mac.toUpperCase(), address: '192.168.10.53' }],
  });
  return { engine, client, other, relay, core, server, sw };
}

function acquire(context: ReturnType<typeof relayLan>, both = false) {
  context.engine.requestDhcp(context.client.id, 'p0');
  if (both) context.engine.requestDhcp(context.other.id, 'p0');
  context.engine.advanceTo(context.engine.state.clock + 300);
}

function dhcpPacket(engine: SimulationEngine, type: string, source: string): UdpPacket {
  const packet = engine.state.events.find(
    (event) =>
      event.type === 'FRAME_SENT' &&
      event.device === source &&
      event.frame?.packet?.protocol === 'UDP' &&
      event.frame.packet.payload.protocol === 'DHCP' &&
      event.frame.packet.payload.message.type === type
  )?.frame?.packet;
  expect(packet).toBeDefined();
  return structuredClone(packet!) as UdpPacket;
}

describe('DHCP relay e reservas', () => {
  it('envia aos destinos configurados e recebe lease do segundo servidor quando o primeiro está desativado', () => {
    const c = relayLan();
    c.engine.setDhcpEnabled(c.server.id, false);
    const alternate = c.engine.addDevice('server');
    Object.assign(alternate.interfaces[0], { ip: '172.16.0.10', prefix: 24 });
    alternate.gateway = '172.16.0.1';
    Object.assign(c.core.interfaces[2], { ip: '172.16.0.1', prefix: 24 });
    c.engine.connect({ device: c.core.id, port: 'p2' }, { device: alternate.id, port: 'p0' });
    c.relay.routes.push({ network: '172.16.0.0', prefix: 24, nextHop: '10.0.0.2', metric: 1 });
    c.engine.configureDhcpPool(alternate.id, c.server.dhcpServer!.pools[0]);
    c.engine.configureDhcpRelay(c.relay.id, 'p0', ['192.168.20.10', '172.16.0.10']);
    acquire(c);
    expect(c.client.interfaces[0].dhcp).toMatchObject({
      status: 'bound',
      lease: { server: '172.16.0.10', address: '192.168.10.53' },
    });
    expect(c.server.dhcpServer!.bindings).toHaveLength(0);
    expect(alternate.dhcpServer!.bindings).toHaveLength(1);
    validateSnapshot(c.engine.snapshot());
  });
  it('recusa giaddr/hops/portas falsificados e Request tentando ocupar reserva de outro MAC', () => {
    const c = relayLan();
    acquire(c, true);
    const original = dhcpPacket(c.engine, 'discover', c.relay.id),
      bindings = structuredClone(c.server.dhcpServer!.bindings);
    if (original.payload.protocol !== 'DHCP') throw new Error('DHCP esperado');
    const count = () => c.engine.state.events.filter((event) => event.type === 'DHCP_OFFER').length;
    const before = count();
    for (const patch of [
      { sourcePort: 68 },
      { src: '192.168.20.1' },
      { payload: { protocol: 'DHCP' as const, message: { ...original.payload.message, hops: 2 } } },
      {
        src: '192.168.30.1',
        payload: {
          protocol: 'DHCP' as const,
          message: { ...original.payload.message, giaddr: '192.168.30.1' },
        },
      },
    ])
      receiveUdp(
        c.engine,
        c.server,
        c.server.interfaces[0],
        { ...original, ...patch },
        c.core.interfaces[1].mac
      );
    expect(count()).toBe(before);
    expect(c.server.dhcpServer!.bindings).toEqual(bindings);
    receiveUdp(
      c.engine,
      c.server,
      c.server.interfaces[0],
      {
        ...original,
        payload: {
          protocol: 'DHCP',
          message: {
            type: 'request',
            transactionId: c.other.interfaces[0].dhcp!.transactionId,
            clientMac: c.other.interfaces[0].mac,
            clientIp: '0.0.0.0',
            giaddr: '192.168.10.1',
            hops: 1,
            requestedIp: '192.168.10.53',
            server: '192.168.20.10',
          },
        },
      },
      c.core.interfaces[1].mac
    );
    expect(c.server.dhcpServer!.bindings).toEqual(bindings);
    expect(c.engine.state.events.some((event) => event.type === 'DHCP_NAK')).toBe(true);
    validateSnapshot(c.engine.snapshot());
  });
  it('completa DORA por dois roteadores, preserva xid/chaddr e reserva antes da alocação dinâmica', () => {
    const c = relayLan();
    acquire(c, true);
    expect(c.client.interfaces[0]).toMatchObject({
      ip: '192.168.10.53',
      gateway: '192.168.10.1',
      dns: ['192.168.20.10'],
      dhcp: { status: 'bound', lease: { server: '192.168.20.10' } },
    });
    expect(c.other.interfaces[0].ip).toBe('192.168.10.50');
    const request = dhcpPacket(c.engine, 'discover', c.relay.id),
      reply = dhcpPacket(c.engine, 'ack', c.server.id);
    expect(request).toMatchObject({
      src: '192.168.10.1',
      dst: '192.168.20.10',
      sourcePort: 67,
      destinationPort: 67,
      payload: { message: { giaddr: '192.168.10.1', hops: 1, clientMac: c.client.interfaces[0].mac } },
    });
    expect(reply).toMatchObject({
      src: '192.168.20.10',
      dst: '192.168.10.1',
      sourcePort: 67,
      destinationPort: 67,
    });
    if (reply.payload.protocol !== 'DHCP' || request.payload.protocol !== 'DHCP')
      throw new Error('DHCP esperado');
    expect(reply.payload.message.transactionId).toBe(request.payload.message.transactionId);
    expect(
      c.engine.state.events.some(
        (event) =>
          event.type === 'DHCP_RELAY_REPLY' &&
          event.frame?.packet?.protocol === 'UDP' &&
          event.frame.packet.destinationPort === 68
      )
    ).toBe(true);
    const id = c.engine.ping(c.client.id, '192.168.20.10');
    c.engine.advanceTo(600);
    expect(c.engine.state.probes.find((probe) => probe.id === id)?.status).toBe('success');
    const stats = dhcpPoolStats(c.server, c.server.dhcpServer!.pools[0], c.engine.state.clock);
    expect(stats).toMatchObject({ capacity: 6, reserved: 1, bound: 2, available: 4 });
    expect(new SimulationEngine(c.engine.snapshot()).snapshot()).toEqual(c.engine.snapshot());
  });

  it('renova T1 e devolve o lease em unicast roteado, mesmo após remover o helper', () => {
    const c = relayLan(10000);
    acquire(c);
    const original = structuredClone(c.client.interfaces[0].dhcp!.lease!);
    c.engine.configureDhcpRelay(c.relay.id, 'p0', []);
    c.engine.state.events = [];
    c.engine.advanceTo(original.renewAt + 300);
    expect(c.client.interfaces[0].dhcp).toMatchObject({
      status: 'bound',
      lease: { address: original.address },
    });
    expect(c.client.interfaces[0].dhcp!.lease!.expiresAt).toBeGreaterThan(original.expiresAt);
    expect(c.engine.state.events.some((event) => event.type === 'DHCP_RELAY_REQUEST')).toBe(false);
    expect(dhcpPacket(c.engine, 'request', c.client.id)).toMatchObject({
      dst: '192.168.20.10',
      sourcePort: 68,
      destinationPort: 67,
    });
    c.engine.releaseDhcp(c.client.id, 'p0');
    c.engine.advanceTo(c.engine.state.clock + 300);
    expect(c.server.dhcpServer!.bindings).toHaveLength(0);
    expect(c.client.interfaces[0].ip).toBeUndefined();
    validateSnapshot(c.engine.snapshot());
  });

  it('rebind T2 volta por relay quando a renovação unicast é bloqueada', () => {
    const c = relayLan(10000);
    acquire(c);
    const original = structuredClone(c.client.interfaces[0].dhcp!.lease!);
    c.engine.configureAcl(c.relay.id, {
      name: 'T1',
      rules: [
        {
          sequence: 10,
          action: 'deny',
          protocol: 'udp',
          source: { network: '192.168.10.0', prefix: 24 },
          destination: { network: '192.168.20.10', prefix: 32 },
          sourcePort: 68,
          destinationPort: 67,
        },
        {
          sequence: 20,
          action: 'permit',
          protocol: 'ip',
          source: { network: '0.0.0.0', prefix: 0 },
          destination: { network: '0.0.0.0', prefix: 0 },
        },
      ],
    });
    c.engine.bindAcl(c.relay.id, 'p1', 'out', 'T1');
    c.engine.advanceTo(original.rebindAt + 300);
    expect(c.client.interfaces[0].dhcp?.status).toBe('bound');
    expect(c.client.interfaces[0].dhcp!.lease!.expiresAt).toBeGreaterThan(original.expiresAt);
    expect(c.engine.state.events.some((event) => event.type === 'DHCP_REBINDING')).toBe(true);
    expect(c.engine.state.events.some((event) => event.type === 'ACL_DENY')).toBe(true);
  });

  it('restaura a descoberta e a oferta em trânsito sem alterar o resultado ou os timers', () => {
    const c = relayLan();
    c.engine.requestDhcp(c.client.id, 'p0');
    while (!c.server.dhcpServer!.bindings.length) {
      expect(c.engine.step()).toBe(true);
      validateSnapshot(c.engine.snapshot());
    }
    const restored = new SimulationEngine(c.engine.snapshot());
    expect(restored.snapshot()).toEqual(c.engine.snapshot());
    c.engine.advanceTo(500);
    restored.advanceTo(500);
    expect(restored.snapshot()).toEqual(c.engine.snapshot());
    expect(c.client.interfaces[0].dhcp?.status).toBe('bound');
  });

  it('perda de oferta dispara retry; sem helper, rota de retorno ou ACL permissiva não há lease', () => {
    const c = relayLan();
    c.engine.requestDhcp(c.client.id, 'p0');
    while (!c.server.dhcpServer!.bindings.length) expect(c.engine.step()).toBe(true);
    c.engine.state.queue = c.engine.state.queue.filter(
      ({ action }) =>
        !(
          action.kind === 'deliver' &&
          action.frame.packet?.protocol === 'UDP' &&
          action.frame.packet.payload.protocol === 'DHCP' &&
          action.frame.packet.payload.message.type === 'offer'
        )
    );
    c.engine.advanceTo(4500);
    expect(c.client.interfaces[0].dhcp?.status).toBe('bound');
    for (const failure of ['helper', 'return', 'acl'] as const) {
      const bad = relayLan();
      if (failure === 'helper') bad.engine.configureDhcpRelay(bad.relay.id, 'p0', []);
      else if (failure === 'return') bad.core.routes = [];
      else {
        bad.engine.configureAcl(bad.server.id, { name: 'BLOCK', rules: [] });
        bad.engine.bindAcl(bad.server.id, 'p0', 'in', 'BLOCK');
      }
      bad.engine.requestDhcp(bad.client.id, 'p0');
      bad.engine.advanceTo(61000);
      expect(bad.client.interfaces[0].dhcp?.status).toBe('failed');
      validateSnapshot(bad.engine.snapshot());
    }
  });

  it('seleciona pools remotos por giaddr e mantém clientes de outra rede isolados', () => {
    const c = relayLan();
    const remote = c.engine.addDevice('pc');
    Object.assign(c.relay.interfaces[2], { ip: '192.168.30.1', prefix: 24 });
    c.engine.connect({ device: remote.id, port: 'p0' }, { device: c.relay.id, port: 'p2' });
    c.core.routes.push({ network: '192.168.30.0', prefix: 24, nextHop: '10.0.0.1', metric: 1 });
    c.engine.configureDhcpRelay(c.relay.id, 'p2', ['192.168.20.10']);
    c.engine.configureDhcpPool(c.server.id, {
      ...c.server.dhcpServer!.pools[0],
      name: 'OTHER',
      network: '192.168.30.0',
      start: '192.168.30.50',
      end: '192.168.30.55',
      relayAddress: '192.168.30.1',
      gateway: '192.168.30.1',
      reservations: [],
    });
    c.engine.requestDhcp(remote.id, 'p0');
    acquire(c);
    expect(remote.interfaces[0].ip).toBe('192.168.30.50');
    expect(c.client.interfaces[0].ip).toBe('192.168.10.53');
    expect(c.server.dhcpServer!.bindings.map((entry) => entry.pool).sort()).toEqual(['OTHER', 'REMOTE']);
  });

  it('reservas locais não vazam para outros MACs e mudanças invalidam bindings e timers antigos', () => {
    const engine = new SimulationEngine(makeTemplate('dhcp'));
    const client = engine.state.devices[0],
      other = engine.state.devices.find((device) => device.hostname === 'PC-02')!;
    const server = engine.state.devices.find((device) => device.type === 'server')!;
    engine.configureDhcpPool(server.id, {
      ...server.dhcpServer!.pools[0],
      reservations: [{ clientMac: client.interfaces[0].mac, address: '192.168.50.10' }],
    });
    engine.requestDhcp(other.id, 'p0');
    engine.advanceTo(200);
    expect(other.interfaces[0].ip).toBe('192.168.50.12');
    engine.requestDhcp(client.id, 'p0');
    engine.advanceTo(400);
    expect(client.interfaces[0].ip).toBe('192.168.50.10');
    const oldBinding = server.dhcpServer!.bindings.find(
      (entry) => entry.clientMac === client.interfaces[0].mac
    )!.id;
    engine.configureDhcpPool(server.id, {
      ...server.dhcpServer!.pools[0],
      reservations: [{ clientMac: client.interfaces[0].mac, address: '192.168.50.15' }],
    });
    expect(server.dhcpServer!.bindings.some((entry) => entry.id === oldBinding)).toBe(false);
    expect(
      engine.state.queue.some(
        ({ action }) => action.kind === 'dhcp-binding-expire' && action.binding === oldBinding
      )
    ).toBe(false);
    engine.renewDhcp(client.id, 'p0');
    engine.advanceTo(5500);
    expect(client.interfaces[0].ip).toBe('192.168.50.15');
    validateSnapshot(engine.snapshot());
  });

  it('recusa relay/pools/reservas inválidos e respostas de servidor não configurado', () => {
    const c = relayLan();
    const pool = c.server.dhcpServer!.pools[0];
    for (const reservations of [
      [{ clientMac: c.client.interfaces[0].mac, address: '192.168.10.1' }],
      [{ clientMac: c.client.interfaces[0].mac, address: '192.168.10.59' }],
      [
        { clientMac: c.client.interfaces[0].mac, address: '192.168.10.53' },
        { clientMac: c.other.interfaces[0].mac, address: '192.168.10.53' },
      ],
    ])
      expect(() => c.engine.configureDhcpPool(c.server.id, { ...pool, reservations })).toThrow();
    expect(() => c.engine.configureDhcpPool(c.server.id, { ...pool, relayAddress: '192.168.40.1' })).toThrow(
      'relay'
    );
    expect(() => c.engine.configureDhcpRelay(c.client.id, 'p0', ['192.168.20.10'])).toThrow('roteador');
    expect(() => c.engine.configureDhcpRelay(c.relay.id, 'p0', ['192.168.20.10', '192.168.20.10'])).toThrow(
      'únicos'
    );
    expect(() => c.engine.requestDhcp(c.relay.id, 'p0')).toThrow('relay');
    Object.assign(c.relay.interfaces[2], { ip: '192.168.40.0', prefix: 24 });
    expect(() => c.engine.configureDhcpRelay(c.relay.id, 'p2', ['192.168.20.10'])).toThrow('IPv4 estático');
    acquire(c);
    const reply = dhcpPacket(c.engine, 'ack', c.server.id);
    const previous = c.engine.state.events.filter((event) => event.type === 'DHCP_RELAY_REPLY').length;
    c.engine.configureDhcpRelay(c.relay.id, 'p0', ['192.168.20.11']);
    receiveUdp(c.engine, c.relay, c.relay.interfaces[1], reply, c.core.interfaces[0].mac);
    expect(c.engine.state.events.filter((event) => event.type === 'DHCP_RELAY_REPLY')).toHaveLength(previous);
    const badSnapshot = c.engine.snapshot();
    badSnapshot.devices.find((device) => device.id === c.relay.id)!.interfaces[0].ipv4Mode = 'dhcp';
    expect(() => validateSnapshot(badSnapshot)).toThrow();
  });

  it('CLI configura relay e reservas, publica running-config e desfaz configuração inválida', () => {
    const c = relayLan(),
      cli = new TerminalSession(c.engine, c.relay.id),
      serverCli = new TerminalSession(c.engine, c.server.id);
    for (const command of [
      'enable',
      'conf t',
      'interface Gi0/1',
      'no ip helper-address',
      'ip helper-address 192.168.20.10',
    ])
      expect(cli.execute(command)).toBe('OK');
    expect(cli.execute('show ip dhcp relay')).toContain('giaddr=192.168.10.1');
    expect(cli.execute('show running-config')).toContain('ip helper-address 192.168.20.10');
    for (const command of [
      'enable',
      'conf t',
      'ip dhcp pool REMOTE relay 192.168.10.1/24 interface Eth0',
      'reservation ' + c.client.interfaces[0].mac + ' 192.168.10.54',
    ])
      expect(serverCli.execute(command)).toBe('OK');
    expect(serverCli.execute('show running-config')).toContain(
      'reservation ' + c.client.interfaces[0].mac + ' 192.168.10.54'
    );
    const before = c.engine.snapshot();
    expect(serverCli.execute('reservation ' + c.client.interfaces[0].mac + ' 10.1.1.10')).toContain('%');
    expect(c.engine.state.devices).toEqual(before.devices);
    validateSnapshot(c.engine.snapshot());
  });

  it('o template inicia pendente e entrega concessão reservada, DNS e HTTP reais', () => {
    const engine = new SimulationEngine(makeTemplate('dhcp-relay'));
    engine.advanceTo(300);
    const client = engine.state.devices[0];
    expect(client.interfaces[0].ip).toBe('192.168.10.60');
    engine.lookupDns(client.id, 'central.lab');
    engine.advanceTo(600);
    expect(client.dnsQueries?.[0].status).toBe('success');
    engine.httpGet(client.id, '192.168.20.10');
    engine.advanceTo(1200);
    expect(client.tcpConnections?.some((connection) => connection.received.includes('200 OK'))).toBe(true);
  });
});
