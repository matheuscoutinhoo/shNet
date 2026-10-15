import { describe, expect, it } from 'vitest';
import { SimulationEngine, validateSnapshot, interfaceOperational, defaultDhcpPool } from '@shlab/engine';
function topology(monitored = false, migrateKnownNeighbor = false) {
  const e = new SimulationEngine(),
    host = e.addDevice('pc'),
    spare = e.installNic(host.id),
    a = e.addDevice('switch'),
    b = e.addDevice('switch'),
    core = e.addDevice('switch'),
    server = e.addDevice('server');
  const cable = (device: string, port: string, remote: string, other: string) =>
    e.connect({ device, port }, { device: remote, port: other });
  cable(host.id, 'p0', a.id, 'p0');
  cable(host.id, spare.id, b.id, 'p0');
  cable(a.id, 'p1', core.id, 'p0');
  cable(b.id, 'p1', core.id, 'p1');
  cable(server.id, 'p0', core.id, 'p2');
  Object.assign(host.interfaces[0], { ip: '192.0.2.10', prefix: 24 });
  Object.assign(server.interfaces[0], { ip: '192.0.2.1', prefix: 24 });
  e.configureTcpService(server.id, { kind: 'echo', port: 7, enabled: true });
  if (migrateKnownNeighbor) {
    const probe = e.ping(server.id, '192.0.2.10');
    e.advanceTo(500, 100000);
    expect(e.state.probes.find((p) => p.id === probe)?.status).toBe('success');
  }
  const bond = e.configureBond(
    host.id,
    1,
    ['p0', spare.id],
    'p0',
    monitored ? { target: '192.0.2.1' } : undefined
  );
  e.advanceTo(4000, 100000);
  const ping = () => {
    const id = e.ping(host.id, '192.0.2.1');
    e.advanceTo(e.state.clock + 500, 100000);
    return e.state.probes.find((p) => p.id === id)!;
  };
  return { e, host, spare, a, b, core, server, bond, ping };
}
describe('Bond ativo/backup de hosts', () => {
  it('anuncia o MAC lógico a um vizinho que já conhecia o IPv4 físico', () => {
    const { e, host, server, bond } = topology(false, true);
    expect(server.arpTable.find((row) => row.ip === bond.ip)?.mac).toBe(bond.mac);
    const id = e.ping(server.id, bond.ip!);
    e.advanceTo(e.state.clock + 500, 100000);
    expect(e.state.probes.find((p) => p.id === id)?.status).toBe('success');
    expect(host.interfaces[0].ip).toBeUndefined();
  });
  it('conserva IPv4 e a mesma conexão TCP após perda de switch e failback', () => {
    const { e, host, spare, a, bond, ping } = topology();
    expect(host.interfaces[0].ip).toBeUndefined();
    expect(bond.ip).toBe('192.0.2.10');
    expect(ping().status).toBe('success');
    const id = e.openTcp(host.id, '192.0.2.1', 7, 'before|', false);
    e.advanceTo(e.state.clock + 1000, 100000);
    e.setDevicePower(a.id, false);
    expect(bond.bond!.active).toBe(spare.id);
    e.writeTcp(host.id, id, 'after|');
    e.advanceTo(e.state.clock + 3000, 100000);
    expect(host.tcpConnections!.find((c) => c.id === id)!.received).toBe('before|after|');
    expect(ping().status).toBe('success');
    e.setDevicePower(a.id, true);
    e.advanceTo(e.state.clock + 500, 100000);
    expect(bond.bond!.active).toBe('p0');
    expect(ping().status).toBe('success');
    expect(() => validateSnapshot(e.snapshot())).not.toThrow();
  });
  it('detecta perda de uplink mantendo carrier local e recupera a primária após prova ARP', () => {
    const { e, host, spare, a, bond, ping } = topology(true);
    expect(bond.bond!.health.every((h) => h.lastResponseAt !== undefined)).toBe(true);
    e.setPort(a.id, 'p1', false);
    e.advanceTo(e.state.clock + 3500, 100000);
    expect(interfaceOperational(e.state, host, host.interfaces[0])).toBe(true);
    expect(bond.bond!.active).toBe(spare.id);
    expect(ping().status).toBe('success');
    e.setPort(a.id, 'p1', true);
    e.advanceTo(e.state.clock + 1500, 100000);
    expect(bond.bond!.active).toBe('p0');
    expect(ping().status).toBe('success');
  });
  it('carrier isolado não inventa recuperação de uma partição além da NIC', () => {
    const { e, a, bond, ping } = topology();
    e.setPort(a.id, 'p1', false);
    e.advanceTo(e.state.clock + 3500, 100000);
    expect(bond.bond!.active).toBe('p0');
    expect(ping().status).not.toBe('success');
  });
  it('mantém restore determinístico com sondagens/announcements em trânsito e recusa timers adulterados', () => {
    const { e, a, bond } = topology(true);
    e.setDevicePower(a.id, false);
    const snapshot = e.snapshot(),
      restored = new SimulationEngine(snapshot);
    e.advanceTo(e.state.clock + 5500, 100000);
    restored.advanceTo(restored.state.clock + 5500, 100000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    const bad = structuredClone(snapshot);
    bad.queue = bad.queue.filter((q) => q.action.kind !== 'bond-tick');
    expect(() => validateSnapshot(bad)).toThrow('Timer de bond');
    const future = e.snapshot();
    future.devices
      .find((d) => d.interfaces.some((p) => p.id === bond.id))!
      .interfaces.find((p) => p.id === bond.id)!.bond!.health[0].lastResponseAt = future.clock + 1;
    expect(() => validateSnapshot(future)).toThrow('Estado de bond');
  });
  it('IPv6 usa a mesma interface lógica após perda de NIC', () => {
    const { e, host, server, spare, bond } = topology();
    e.configureIpv6(host.id, bond.id, { auto: false, addresses: [{ ip: '2001:db8::10', prefix: 64 }] });
    e.configureIpv6(server.id, 'p0', { auto: false, addresses: [{ ip: '2001:db8::1', prefix: 64 }] });
    e.advanceTo(e.state.clock + 2500, 100000);
    e.setPort(host.id, 'p0', false);
    e.advanceTo(e.state.clock + 500, 100000);
    expect(bond.bond!.active).toBe(spare.id);
    const id = e.ping6(host.id, '2001:db8::1');
    e.advanceTo(e.state.clock + 1000, 100000);
    expect(e.state.probes6!.find((p) => p.id === id)?.status).toBe('success');
    expect(() => validateSnapshot(e.snapshot())).not.toThrow();
  });
  it('preserva identidade DHCP e renova o lease pela NIC de reserva', () => {
    const { e, host, server, a, bond } = topology();
    delete bond.ip;
    delete bond.prefix;
    e.configureDhcpPool(server.id, { ...defaultDhcpPool(server, 'BOND-CLIENTS', 'p0'), leaseMs: 60000 });
    e.requestDhcp(host.id, bond.id);
    e.advanceTo(e.state.clock + 2000, 100000);
    const address = bond.ip;
    const originalExpiry = bond.dhcp!.lease!.expiresAt;
    expect(bond.dhcp?.status).toBe('bound');
    e.setDevicePower(a.id, false);
    e.advanceTo(e.state.clock + 31000, 100000);
    expect(bond.ip).toBe(address);
    expect(bond.dhcp?.status).toBe('bound');
    expect(bond.dhcp!.lease!.expiresAt).toBeGreaterThan(originalExpiry);
    expect(server.dhcpServer!.bindings.filter((b) => b.clientMac === bond.mac)).toHaveLength(1);
    expect(() => validateSnapshot(e.snapshot())).not.toThrow();
  });
  it('recusa NIC repetida e cabo na interface virtual sem alterar a configuração', () => {
    const { e, host, bond, server } = topology(),
      before = e.snapshot();
    expect(() => e.configureBond(host.id, 2, ['p0', 'p0'], 'p0')).toThrow();
    expect(e.snapshot()).toEqual(before);
    expect(() => e.connect({ device: host.id, port: bond.id }, { device: server.id, port: 'p1' })).toThrow(
      'físicas'
    );
  });
});
