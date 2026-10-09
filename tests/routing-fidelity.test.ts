import { describe, it, expect } from 'vitest';
import { SimulationEngine, validateSnapshot, type UdpPacket } from '../packages/simulation-engine/src';
import { receiveRip, ripBytes } from '../packages/simulation-engine/src/protocols/rip';
import { ripAuthentication, encodeRip } from '../packages/simulation-engine/src/protocols/rip-codec';
import { receiveOspf } from '../packages/simulation-engine/src/protocols/ospf';
function chain(areaType: 'normal' | 'nssa' | 'stub', metricType: 'E1' | 'E2' = 'E1') {
  const e = new SimulationEngine(),
    a = e.addDevice('router'),
    b = e.addDevice('router'),
    c = e.addDevice('router'),
    server = e.addDevice('server');
  Object.assign(a.interfaces[0], { ip: '10.0.1.1', prefix: 24 });
  Object.assign(b.interfaces[0], { ip: '10.0.1.2', prefix: 24 });
  Object.assign(b.interfaces[1], { ip: '10.0.2.2', prefix: 24 });
  Object.assign(c.interfaces[0], { ip: '10.0.2.3', prefix: 24 });
  Object.assign(a.interfaces[1], { ip: '198.51.100.1', prefix: 24 });
  Object.assign(server.interfaces[0], { ip: '198.51.100.20', prefix: 24 });
  server.gateway = '198.51.100.1';
  e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
  e.connect({ device: b.id, port: 'p1' }, { device: c.id, port: 'p0' });
  e.connect({ device: a.id, port: 'p1' }, { device: server.id, port: 'p0' });
  a.routes.push({ network: '198.51.100.0', prefix: 24, nextHop: '198.51.100.20', metric: 1 });
  const key = 'ospf-routing-key',
    p = (port: string, area: number, cost = 1) => ({
      port,
      area,
      cost,
      helloMs: 1000,
      deadMs: 3000,
      authenticationKey: key,
    });
  e.configureOspf(a.id, {
    enabled: true,
    routerId: '1.1.1.1',
    areas: [{ id: 1, type: areaType }],
    interfaces: [p('p0', 1)],
    externalRoutes: [{ network: '198.51.100.0', prefix: 24, cost: 20, metricType, tag: 42 }],
  });
  e.configureOspf(b.id, {
    enabled: true,
    routerId: '2.2.2.2',
    areas: [{ id: 1, type: areaType, defaultCost: 7 }],
    interfaces: [p('p0', 1, 3), p('p1', 0, 5)],
  });
  e.configureOspf(c.id, { enabled: true, routerId: '3.3.3.3', interfaces: [p('p0', 0, 2)] });
  return { e, a, b, c, server };
}
describe('Fidelidade OSPF / RIP', () => {
  it.each(['E1', 'E2'] as const)(
    'OSPF %s cruza ABR com ASBR summary, checksum e autenticação, entrega ping e retira anúncio',
    (metric) => {
      const { e, a, b, c } = chain('normal', metric);
      e.advanceTo(6000);
      expect(c.ospf!.routes).toContainEqual(
        expect.objectContaining({
          network: '198.51.100.0',
          pathType: metric,
          metric: metric === 'E1' ? 25 : 20,
          internalCost: 5,
          tag: 42,
        })
      );
      expect(c.ospf!.lsdb.some((l) => l.type === 'asbr-summary')).toBe(true);
      const id = e.ping(c.id, '198.51.100.20');
      e.advanceTo(7000);
      expect(e.state.probes.find((p) => p.id === id)!.status).toBe('success');
      validateSnapshot(e.snapshot());
      const saved = e.snapshot(),
        resumed = new SimulationEngine(saved);
      e.advanceTo(8000);
      resumed.advanceTo(8000);
      expect(resumed.snapshot()).toEqual(e.snapshot());
      const hello = e.state.events.find(
        (v) => v.device === b.id && v.frame?.packet?.protocol === 'OSPF' && v.frame.packet.src === '10.0.2.2'
      )!.frame!.packet!;
      if (hello.protocol === 'OSPF') {
        const before = c.dropped;
        receiveOspf(e, c, c.interfaces[0], hello, b.interfaces[1].mac);
        expect(c.dropped).toBe(before + 1);
      }
      e.configureOspf(a.id, {
        enabled: true,
        routerId: '1.1.1.1',
        areas: a.ospf!.areas,
        interfaces: a.ospf!.interfaces,
        externalRoutes: [],
      });
      e.advanceTo(14000);
      expect(c.ospf!.routes.some((r) => r.network === '198.51.100.0')).toBe(false);
      validateSnapshot(e.snapshot());
    }
  );
  it('NSSA traduz tipo 7; stub bloqueia externos e recebe default do ABR', () => {
    const n = chain('nssa');
    n.e.advanceTo(6000);
    expect(n.a.ospf!.lsdb.some((l) => l.type === 'nssa')).toBe(true);
    expect(n.c.ospf!.routes).toContainEqual(
      expect.objectContaining({ network: '198.51.100.0', pathType: 'E1' })
    );
    expect(n.c.ospf!.lsdb.some((l) => l.type === 'external' && l.advertisingRouter === '2.2.2.2')).toBe(true);
    validateSnapshot(n.e.snapshot());
    const s = chain('stub');
    s.e.advanceTo(6000);
    expect(s.a.ospf!.routes).toContainEqual(
      expect.objectContaining({ network: '0.0.0.0', prefix: 0, metric: 8, pathType: 'inter' })
    );
    expect(
      s.a.ospf!.lsdb.some((l) => l.type === 'external' || l.type === 'nssa' || l.type === 'asbr-summary')
    ).toBe(false);
    validateSnapshot(s.e.snapshot());
  });
  it('RIP SHA-256 codifica autenticação/RTEs, rejeita corrupção/replay e aplica next hop/filtros/hold-down', () => {
    const e = new SimulationEngine(),
      a = e.addDevice('router'),
      b = e.addDevice('router');
    Object.assign(a.interfaces[0], { ip: '10.0.0.1', prefix: 24 });
    Object.assign(b.interfaces[0], { ip: '10.0.0.2', prefix: 24 });
    e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
    const keys = [{ id: 1, key: 'rip-sha256-key', from: 0 }];
    e.configureRip(a.id, {
      enabled: true,
      holdDownMs: 60000,
      interfaces: [{ port: 'p0', keys, inputPrefixes: [{ network: '192.0.2.0', prefix: 24 }] }],
    });
    e.configureRip(b.id, { enabled: true, interfaces: [{ port: 'p0', keys }] });
    e.advanceTo(3000);
    const message = {
      type: 'response' as const,
      version: 2 as const,
      entries: [
        { network: '192.0.2.0', prefix: 24, metric: 2, tag: 77, nextHop: '10.0.0.3' },
        { network: '203.0.113.0', prefix: 24, metric: 1, tag: 0 },
      ],
      authentication: { keyId: 1, sequence: 10000, digest: '00'.repeat(32) },
    };
    message.authentication.digest = ripAuthentication(message, keys[0].key);
    const wire = encodeRip(message);
    expect([...wire.slice(0, 8)]).toEqual([2, 2, 0, 0, 255, 255, 0, 3]);
    expect(wire.length).toBe(100);
    const packet: UdpPacket = {
      protocol: 'UDP',
      src: '10.0.0.2',
      dst: '224.0.0.9',
      ttl: 1,
      sourcePort: 520,
      destinationPort: 520,
      bytes: ripBytes(message),
      payload: { protocol: 'RIP', message },
    };
    receiveRip(e, a, a.interfaces[0], packet, b.interfaces[0].mac);
    expect(a.rip!.table.find((r) => r.network === '192.0.2.0')).toMatchObject({
      metric: 3,
      tag: 77,
      nextHop: '10.0.0.3',
    });
    expect(a.rip!.table.some((r) => r.network === '203.0.113.0')).toBe(false);
    const before = a.dropped;
    message.authentication.sequence = 9999;
    message.authentication.digest = ripAuthentication(message, keys[0].key);
    receiveRip(e, a, a.interfaces[0], packet, b.interfaces[0].mac);
    expect(a.dropped).toBe(before + 1);
    message.authentication.sequence = 10001;
    message.entries[0].metric = 16;
    message.authentication.digest = ripAuthentication(message, keys[0].key);
    receiveRip(e, a, a.interfaces[0], packet, b.interfaces[0].mac);
    expect(a.rip!.table.find((r) => r.network === '192.0.2.0')!.holdDownUntil).toBe(63000);
    validateSnapshot(e.snapshot());
    message.entries[0].metric = 2;
    receiveRip(e, a, a.interfaces[0], packet, b.interfaces[0].mac);
    expect(a.rip!.table.find((r) => r.network === '192.0.2.0')!.metric).toBe(16);
  });
});
