import { describe, expect, it } from 'vitest';
import { SimulationEngine, validateSnapshot, type Device } from '../packages/simulation-engine/src';
function network(separate = false) {
  const e = new SimulationEngine(),
    pc = e.addDevice('pc'),
    r = e.addDevice('router'),
    sw = e.addDevice('switch'),
    server = e.addDevice('server');
  Object.assign(pc.interfaces[0], { ip: '10.0.0.10', prefix: 24, gateway: '10.0.0.1' });
  Object.assign(r.interfaces[0], { ip: '10.0.0.1', prefix: 24, natRole: 'inside' });
  Object.assign(server.interfaces[0], {
    ip: separate ? '10.1.0.20' : '10.0.0.20',
    prefix: 24,
    gateway: separate ? '10.1.0.1' : '10.0.0.1',
  });
  Object.assign(r.interfaces[1], { ip: '10.1.0.1', prefix: 24, natRole: 'inside' });
  Object.assign(r.interfaces[2], { ip: '203.0.113.1', prefix: 24, natRole: 'outside' });
  const link = (a: Device, p: number, b: Device, q: number) =>
    e.connect({ device: a.id, port: a.interfaces[p].id }, { device: b.id, port: b.interfaces[q].id });
  link(pc, 0, sw, 0);
  link(r, 0, sw, 1);
  if (separate) link(r, 1, server, 0);
  else link(server, 0, sw, 2);
  e.configureNat(r.id, {
    enabled: true,
    hairpin: true,
    statics: [{ inside: server.interfaces[0].ip!, global: '203.0.113.20', outside: r.interfaces[2].id }],
    pools: [],
    bindings: [],
  });
  e.configureTcpService(server.id, { kind: 'http', enabled: true, port: 80, body: 'Hairpin HTTP' });
  e.configureDnsRecord(server.id, { type: 'A', name: 'hairpin.lab', value: '10.0.0.55', ttl: 60 });
  return { e, pc, r, server };
}
describe('NAT hairpin bidirecional', () => {
  it('retorna Fragmentation Needed ao cliente com a citação antes do NAT', () => {
    const { e, pc, r, server } = network(true);
    r.interfaces[1].mtu = 576;
    server.interfaces[0].mtu = 576;
    const id = e.ping(pc.id, '203.0.113.20', 64, undefined, 1000, true);
    e.advanceTo(200);
    expect(e.state.probes.find((p) => p.id === id)?.status).toBe('unreachable');
    expect(
      e.state.events.some(
        (v) =>
          v.frame?.packet?.protocol === 'ICMP' &&
          v.frame.packet.error?.code === 4 &&
          v.frame.packet.error.quote.dst === '203.0.113.20'
      )
    ).toBe(true);
    expect(() => validateSnapshot(e.snapshot())).not.toThrow();
  });
  it.each([false, true])('DNAT e SNAT mantêm HTTP/UDP/Echo com servidor na mesma LAN=%s', (same) => {
    const { e, pc, r } = network(!same);
    const http = e.httpGet(pc.id, '203.0.113.20'),
      dns = e.lookupDns(pc.id, 'hairpin.lab', 'A', '203.0.113.20'),
      ping = e.ping(pc.id, '203.0.113.20');
    e.advanceTo(200);
    expect(pc.tcpConnections?.find((c) => c.id === http)?.received).toContain('Hairpin HTTP');
    expect(pc.dnsQueries?.find((q) => q.id === dns)?.status).toBe('success');
    expect(e.state.probes.find((p) => p.id === ping)?.status).toBe('success');
    expect(r.nat?.hairpins).toHaveLength(3);
    expect(() => validateSnapshot(e.snapshot())).not.toThrow();
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(1000);
    restored.advanceTo(1000);
    expect(restored.snapshot()).toEqual(e.snapshot());
  });
  it('aplica políticas stateful antes de SNAT e traduz o retorno depois da decisão', () => {
    const { e, pc, r } = network(true);
    e.configureFirewall(r.id, {
      enabled: true,
      trustedPorts: [],
      zonePolicy: {
        zones: [
          { name: 'CLIENTS', ports: ['p0'] },
          { name: 'SERVERS', ports: ['p1'] },
        ],
        rules: [{ sequence: 10, from: 'CLIENTS', to: 'SERVERS', protocol: 'TCP', action: 'inspect' }],
      },
    });
    const id = e.httpGet(pc.id, '203.0.113.20');
    e.advanceTo(500);
    expect(pc.tcpConnections?.find((c) => c.id === id)?.received).toContain('Hairpin HTTP');
    expect(r.firewall?.sessions.length).toBeGreaterThan(0);
    expect(() => validateSnapshot(e.snapshot())).not.toThrow();
  });
  it('valida bindings/timers e reconfiguração remove traduções antigas', () => {
    const { e, pc, r } = network();
    e.httpGet(pc.id, '203.0.113.20');
    e.advanceTo(200);
    const bad = e.snapshot();
    bad.queue = bad.queue.filter((q) => q.action.kind !== 'nat-hairpin-expire');
    expect(() => validateSnapshot(bad)).toThrow('hairpin');
    e.configureNat(r.id, { ...r.nat!, hairpin: false });
    expect(r.nat?.hairpins).toEqual([]);
    expect(e.state.queue.some((q) => q.action.kind === 'nat-hairpin-expire')).toBe(false);
  });
});
