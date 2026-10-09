import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  packetSchema,
  type Packet,
  type IcmpPacket,
  type UdpPacket,
} from '../packages/simulation-engine/src';
import { natInbound, natOutbound } from '../packages/simulation-engine/src/protocols/nat';
import { permitFirewall } from '../packages/simulation-engine/src/protocols/firewall';
import { sendIcmpError } from '../packages/simulation-engine/src/protocols/icmp';

function network(overload = true) {
  const engine = new SimulationEngine(makeTemplate('static'));
  const [client, edge, upstream, server] = engine.state.devices;
  edge.interfaces[0].natRole = 'inside';
  edge.interfaces[1].natRole = 'outside';
  engine.configureNat(edge.id, {
    enabled: true,
    statics: [],
    pools: [
      {
        name: 'TEST',
        source: { network: '192.168.10.0', prefix: 24 },
        outside: 'p1',
        start: '10.0.0.1',
        end: '10.0.0.1',
        overload,
      },
    ],
  });
  engine.configureFirewall(edge.id, { enabled: true, trustedPorts: ['p0'] });
  return { engine, client, edge, upstream, server };
}
function udp(): UdpPacket {
  return {
    protocol: 'UDP',
    src: '192.168.10.10',
    dst: '192.168.20.10',
    sourcePort: 50123,
    destinationPort: 53,
    ttl: 2,
    bytes: 60,
    payload: {
      protocol: 'DNS',
      message: {
        type: 'query',
        transactionId: 1,
        question: { name: 'test.lab', type: 'A' },
        recursionDesired: false,
      },
    },
  };
}
function until(engine: SimulationEngine, ready: () => boolean) {
  for (let i = 0; i < 180 && !ready(); i++) {
    expect(engine.step()).toBe(true);
    validateSnapshot(engine.snapshot());
  }
  expect(ready()).toBe(true);
}
function received(engine: SimulationEngine, device: string) {
  return engine.state.events
    .filter(
      (event) =>
        event.device === device && event.type === 'FRAME_RECEIVED' && event.frame?.packet?.protocol === 'ICMP'
    )
    .map((event) => event.frame!.packet as IcmpPacket);
}

describe('erros ICMP e citações através de firewall/NAT', () => {
  it('TTL em roteador intermediário atravessa PAT e firewall com persistência determinística', () => {
    const { engine, client, edge, upstream } = network();
    const probe = engine.ping(client.id, '192.168.20.10', 2);
    until(engine, () =>
      engine.state.events.some(
        (event) =>
          event.device === upstream.id &&
          event.frame?.packet?.protocol === 'ICMP' &&
          event.frame.packet.kind === 'time-exceeded'
      )
    );
    const before = structuredClone({ sessions: edge.firewall!.sessions, bindings: edge.nat!.bindings });
    const restored = new SimulationEngine(engine.snapshot());
    until(engine, () => engine.state.probes.find((entry) => entry.id === probe)?.status === 'time-exceeded');
    restored.advanceTo(engine.state.clock);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(edge.firewall!.sessions).toEqual(before.sessions);
    expect(edge.nat!.bindings).toEqual(before.bindings);
    expect(edge.firewall!.dropped).toBe(0);
    expect(engine.state.probes.find((entry) => entry.id === probe)?.responder).toBe('10.0.0.2');
    expect(received(engine, client.id).at(-1)?.error?.quote).toMatchObject({
      protocol: 'ICMP',
      src: '192.168.10.10',
      dst: '192.168.20.10',
      probeId: probe,
    });
    expect(
      engine.state.events.some(
        (event) => event.type === 'FIREWALL_PERMIT' && event.reason.includes('RELATED')
      )
    ).toBe(true);
  });
  it('gera Time Exceeded para UDP e TCP e restaura portas e sequência citadas', () => {
    for (const protocol of ['UDP', 'TCP'] as const) {
      const { engine, client, edge } = network();
      const packet: Packet =
        protocol === 'UDP'
          ? udp()
          : {
              protocol: 'TCP',
              src: '192.168.10.10',
              dst: '192.168.20.10',
              sourcePort: 50123,
              destinationPort: 80,
              ttl: 2,
              bytes: 40,
              flags: ['SYN'],
              sequence: 0xfffffffe,
              acknowledgment: 0,
              window: 4096,
              data: '',
            };
      engine.sendIp(client.id, packet);
      engine.advanceTo(100);
      const error = received(engine, client.id).at(-1)!;
      expect(error.kind).toBe('time-exceeded');
      expect(error.error?.quote).toMatchObject({
        protocol,
        src: packet.src,
        dst: packet.dst,
        sourcePort: 50123,
        destinationPort: packet.destinationPort,
      });
      if (protocol === 'TCP') expect(error.error?.quote).toHaveProperty('sequence', 0xfffffffe);
      expect(edge.firewall!.dropped).toBe(0);
      validateSnapshot(engine.snapshot());
    }
  });
  it('mantém erros para probes do próprio roteador quando o PAT compartilha seu IPv4 outside', () => {
    const { engine, edge } = network();
    const probe = engine.ping(edge.id, '192.168.20.10', 1);
    engine.advanceTo(100);
    expect(engine.state.probes.find((entry) => entry.id === probe)?.status).toBe('time-exceeded');
    expect(edge.nat!.bindings).toHaveLength(0);
    expect(edge.firewall!.sessions).toHaveLength(0);
    validateSnapshot(engine.snapshot());
  });
  it('correlaciona UDP rastreado mesmo quando ICMP Echo não foi selecionado', () => {
    const { engine, client, edge } = network();
    engine.configureFirewall(edge.id, { enabled: true, trustedPorts: ['p0'], protocols: ['UDP'] });
    engine.sendIp(client.id, udp());
    engine.advanceTo(100);
    expect(received(engine, client.id).at(-1)?.kind).toBe('time-exceeded');
    expect(edge.firewall!.sessions[0].protocol).toBe('UDP');
    expect(edge.firewall!.dropped).toBe(0);
  });
  it('informa rede sem rota e porta UDP fechada com o código correspondente', () => {
    const { engine, client, edge } = network();
    edge.routes = [];
    const probe = engine.ping(client.id, '192.168.20.10');
    engine.advanceTo(100);
    expect(engine.state.probes.find((entry) => entry.id === probe)?.status).toBe('unreachable');
    expect(received(engine, client.id).at(-1)?.error?.code).toBe(0);
    edge.routes.push({ network: '192.168.20.0', prefix: 24, nextHop: '10.0.0.2', metric: 1 });
    engine.sendIp(client.id, { ...udp(), ttl: 64 });
    engine.advanceTo(200);
    expect(received(engine, client.id).at(-1)?.error).toMatchObject({
      code: 3,
      quote: { protocol: 'UDP', sourcePort: 50123, destinationPort: 53 },
    });
  });
  it('rejeita erros PAT sem citação, com tuple adulterado, expirado ou recebido em outra interface', () => {
    const { engine, client, edge } = network();
    engine.sendIp(client.id, udp());
    engine.advanceTo(100);
    const binding = structuredClone(edge.nat!.bindings[0]);
    const packet: IcmpPacket = {
      protocol: 'ICMP',
      src: '10.0.0.2',
      dst: binding.global,
      ttl: 64,
      bytes: 56,
      kind: 'time-exceeded',
      probeId: 'error-test',
      error: {
        code: 0,
        quote: {
          protocol: 'UDP',
          src: binding.global,
          dst: binding.remote!,
          ttl: 1,
          sourcePort: Number(binding.globalToken),
          destinationPort: 53,
        },
      },
    };
    const altered = structuredClone(packet);
    altered.error!.quote.dst = '192.168.20.99';
    const wrongPort = structuredClone(packet);
    if (wrongPort.error!.quote.protocol === 'UDP') wrongPort.error!.quote.sourcePort++;
    const missing = structuredClone(packet);
    delete missing.error;
    for (const error of [altered, wrongPort, missing])
      expect(natInbound(engine, edge, edge.interfaces[1], error)).toBeUndefined();
    expect(natInbound(engine, edge, edge.interfaces[2], packet)).toEqual(packet);
    expect(edge.nat!.bindings[0]).toEqual(binding);
    const noQuote: IcmpPacket = { ...packet, src: '192.168.10.10', dst: '192.168.20.10' };
    delete noQuote.error;
    expect(natOutbound(engine, edge, edge.interfaces[0], edge.interfaces[1], noQuote)).toBeUndefined();
    const badInsideQuote: IcmpPacket = {
      ...noQuote,
      error: {
        code: 0,
        quote: {
          protocol: 'UDP',
          src: '192.168.20.10',
          dst: '192.168.20.99',
          sourcePort: 53,
          destinationPort: 50123,
          ttl: 1,
        },
      },
    };
    expect(natOutbound(engine, edge, edge.interfaces[0], edge.interfaces[1], badInsideQuote)).toBeUndefined();
    const translated = natInbound(engine, edge, edge.interfaces[1], packet)!;
    expect(permitFirewall(engine, edge, edge.interfaces[2], edge.interfaces[0], translated)).toBe(false);
    engine.advanceTo(binding.expiresAt);
    expect(natInbound(engine, edge, edge.interfaces[1], packet)).toBeUndefined();
  });
  it('restaura a citação nas duas direções para PAT, NAT dinâmico e estático', () => {
    for (const mode of ['pat', 'dynamic', 'static']) {
      const { engine, client, edge } = network(mode === 'pat');
      if (mode === 'static')
        engine.configureNat(edge.id, {
          enabled: true,
          statics: [{ inside: '192.168.10.10', global: '10.0.0.1', outside: 'p1' }],
          pools: [],
        });
      engine.sendIp(client.id, udp());
      engine.advanceTo(100);
      expect(received(engine, client.id).at(-1)?.error?.quote.src).toBe('192.168.10.10');
      const binding = edge.nat!.bindings[0];
      const error: IcmpPacket = {
        protocol: 'ICMP',
        src: '192.168.10.10',
        dst: '192.168.20.10',
        ttl: 64,
        bytes: 56,
        kind: 'unreachable',
        probeId: 'inside-error',
        error: {
          code: 3,
          quote: {
            protocol: 'UDP',
            src: '192.168.20.10',
            dst: '192.168.10.10',
            ttl: 64,
            sourcePort: 53,
            destinationPort: 50123,
          },
        },
      };
      expect(permitFirewall(engine, edge, edge.interfaces[0], edge.interfaces[1], error)).toBe(true);
      const result = natOutbound(engine, edge, edge.interfaces[0], edge.interfaces[1], error) as IcmpPacket;
      expect(result.src).toBe('10.0.0.1');
      expect(result.error?.quote).toMatchObject({
        dst: '10.0.0.1',
        destinationPort: mode === 'pat' ? Number(binding.globalToken) : 50123,
      });
      validateSnapshot(engine.snapshot());
    }
  });
  it('ACL ainda bloqueia erros relacionados antes de tocar o estado', () => {
    const { engine, client, edge } = network();
    engine.configureAcl(edge.id, {
      name: 'BLOCK',
      rules: [
        {
          sequence: 10,
          action: 'deny',
          protocol: 'icmp',
          source: { network: '0.0.0.0', prefix: 0 },
          destination: { network: '0.0.0.0', prefix: 0 },
        },
      ],
    });
    engine.bindAcl(edge.id, 'p1', 'in', 'BLOCK');
    const probe = engine.ping(client.id, '192.168.20.10', 2);
    engine.advanceTo(100);
    expect(engine.state.probes.find((entry) => entry.id === probe)?.status).toBe('pending');
    expect(engine.state.events.some((event) => event.type === 'ACL_DENY')).toBe(true);
    expect(edge.firewall!.dropped).toBe(0);
  });
  it('não gera erro para outro erro, origem inválida, broadcast ou multicast', () => {
    const { engine, edge } = network();
    const error: IcmpPacket = {
      protocol: 'ICMP',
      src: '192.168.10.10',
      dst: '192.168.20.10',
      ttl: 1,
      bytes: 56,
      kind: 'unreachable',
      probeId: 'test',
    };
    const queue = structuredClone(engine.state.queue);
    for (const packet of [
      error,
      { ...udp(), src: '0.0.0.0' },
      { ...udp(), dst: '224.0.0.9' },
      { ...udp(), dst: '192.168.10.255' },
    ])
      sendIcmpError(engine, edge, edge.interfaces[0], packet, 'time-exceeded', 0);
    expect(engine.state.queue).toEqual(queue);
  });
  it('valida snapshots com citação limitada e preserva pacotes ICMP antigos sem citação', () => {
    const packet: IcmpPacket = {
      protocol: 'ICMP',
      src: '10.0.0.2',
      dst: '192.168.10.10',
      ttl: 64,
      bytes: 56,
      kind: 'time-exceeded',
      probeId: 'test',
      error: {
        code: 0,
        quote: {
          protocol: 'ICMP',
          src: '192.168.10.10',
          dst: '192.168.20.10',
          ttl: 1,
          kind: 'echo-request',
          probeId: 'test',
        },
      },
    };
    expect(packetSchema.safeParse(packet).success).toBe(true);
    for (const input of [
      { ...packet, kind: 'echo-reply' },
      { ...packet, bytes: 32 },
      { ...packet, dst: '192.168.10.99' },
      { ...packet, error: { ...packet.error!, code: 3 } },
      { ...packet, error: { ...packet.error!, quote: { ...packet.error!.quote, error: {} } } },
    ])
      expect(packetSchema.safeParse(input).success).toBe(false);
    const legacy = { ...packet };
    delete legacy.error;
    expect(packetSchema.safeParse(legacy).success).toBe(true);
  });
});
