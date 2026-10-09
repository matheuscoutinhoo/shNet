import { describe, expect, it } from 'vitest';
import { SimulationEngine, validateSnapshot } from '../packages/simulation-engine/src';
import { wirelessConfig } from '../packages/simulation-engine/src/protocols/wireless';
function mesh() {
  const e = new SimulationEngine(),
    root = e.addDevice('switch', { x: 0, y: 0 }),
    relay = e.addDevice('switch', { x: 80, y: 0 }),
    leaf = e.addDevice('switch', { x: 160, y: 0 }),
    backup = e.addDevice('switch', { x: 160, y: 80 }),
    client = e.addDevice('pc'),
    server = e.addDevice('server');
  for (const d of [root, relay, leaf, backup]) {
    e.configureWireless(d.id, {
      ...wirelessConfig(d),
      role: 'ap',
      ssid: 'Campus',
      security: 'open',
      noise: -110,
      txPower: 30,
    });
    e.configureMesh(d.id, {
      enabled: true,
      meshId: 'campus-mesh',
      key: 'mesh-network-key',
      root: d === root || d === backup,
      priority: d === root ? 1 : 100,
      maxDistance: 21,
    });
  }
  Object.assign(client.interfaces[0], { ip: '10.0.0.10', prefix: 24 });
  Object.assign(server.interfaces[0], { ip: '10.0.0.20', prefix: 24 });
  e.connect({ device: client.id, port: 'p0' }, { device: leaf.id, port: 'p0' });
  e.connect({ device: server.id, port: 'p0' }, { device: root.id, port: 'p0' });
  e.advanceTo(5000);
  return { e, root, relay, leaf, backup, client, server };
}
describe('Mesh e IDS/IPS', () => {
  it('aprende caminho por anúncios autenticados, encaminha Ethernet e troca de raiz', () => {
    const { e, root, relay, leaf, backup, client } = mesh();
    expect(leaf.mesh?.parent).toBe(relay.id);
    expect(leaf.mesh?.route?.path).toEqual([root.id, relay.id, leaf.id]);
    const id = e.ping(client.id, '10.0.0.20');
    e.advanceTo(5200);
    expect(e.state.probes.find((p) => p.id === id)?.status).toBe('success');
    expect(e.state.events.some((v) => v.frame?.secure?.cipher === 'AES-GCM')).toBe(true);
    validateSnapshot(e.snapshot());
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(6000);
    restored.advanceTo(6000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    root.power = false;
    e.advanceTo(11000);
    expect(leaf.mesh?.route?.root).toBe(backup.id);
    expect(leaf.mesh?.parent).toBe(backup.id);
    expect(new Set(leaf.mesh!.route!.path).size).toBe(leaf.mesh!.route!.path.length);
    validateSnapshot(e.snapshot());
  });
  it('chaves mesh distintas impedem vizinhança e dados', () => {
    const { e, root, relay, leaf } = mesh();
    e.configureMesh(relay.id, {
      enabled: true,
      meshId: 'campus-mesh',
      key: 'wrong-network-key',
      root: false,
      priority: 100,
      maxDistance: 21,
    });
    e.advanceTo(12000);
    expect(relay.mesh!.route).toBeUndefined();
    expect(leaf.mesh!.route!.root).not.toBe(root.id);
    expect(e.state.events.some((v) => v.reason.includes('Mesh: anúncio sem autenticação'))).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it.each(['ids', 'ips'] as const)('inspeciona assinatura entre segmentos TCP em modo %s', (mode) => {
    const e = new SimulationEngine(),
      pc = e.addDevice('pc'),
      server = e.addDevice('server');
    Object.assign(pc.interfaces[0], { ip: '10.0.0.1', prefix: 24 });
    Object.assign(server.interfaces[0], { ip: '10.0.0.2', prefix: 24 });
    e.connect({ device: pc.id, port: 'p0' }, { device: server.id, port: 'p0' });
    e.configureTcpService(server.id, { enabled: true, kind: 'echo', port: 7 });
    e.configureIds(server.id, {
      enabled: true,
      mode,
      rules: [
        {
          id: 'signature',
          name: 'Assinatura teste',
          protocol: 'TCP',
          destinationPort: 7,
          pattern: 'blocked-pattern',
          action: 'drop',
        },
      ],
    });
    e.openTcp(pc.id, '10.0.0.2', 7, 'x'.repeat(530) + 'blocked-pattern' + 'y'.repeat(40), true);
    e.advanceTo(1500);
    expect(server.ids!.alerts[0].blocked).toBe(mode === 'ips');
    expect(server.ids!.dropped > 0).toBe(mode === 'ips');
    if (mode === 'ids') expect(pc.tcpConnections![0].received).toContain('blocked-pattern');
    else expect(server.tcpConnections![0].received).not.toContain('blocked-pattern');
    validateSnapshot(e.snapshot());
  });
  it('limiar de SYN agrega uma origem e alerta sem bloquear em IDS', () => {
    const e = new SimulationEngine(),
      pc = e.addDevice('pc'),
      server = e.addDevice('server');
    Object.assign(pc.interfaces[0], { ip: '10.0.0.1', prefix: 24 });
    Object.assign(server.interfaces[0], { ip: '10.0.0.2', prefix: 24 });
    e.connect({ device: pc.id, port: 'p0' }, { device: server.id, port: 'p0' });
    e.configureIds(server.id, {
      enabled: true,
      mode: 'ids',
      rules: [
        {
          id: 'syn-rate',
          name: 'Rajada SYN',
          protocol: 'TCP',
          synOnly: true,
          threshold: 5,
          windowMs: 1000,
          action: 'drop',
        },
      ],
    });
    for (let i = 0; i < 6; i++) e.openTcp(pc.id, '10.0.0.2', 8000 + i);
    e.advanceTo(100);
    expect(server.ids!.alerts).toHaveLength(1);
    expect(server.ids!.dropped).toBe(0);
    validateSnapshot(e.snapshot());
  });
});
