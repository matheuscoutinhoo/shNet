import { describe, it, expect } from 'vitest';
import { SimulationEngine, validateSnapshot, tunnelConfig } from '../packages/simulation-engine/src';
import { receiveTunnel } from '../packages/simulation-engine/src/protocols/tunnel';
function topology() {
  const e = new SimulationEngine(),
    a = e.addDevice('router'),
    b = e.addDevice('router'),
    pc = e.addDevice('pc'),
    server = e.addDevice('server');
  Object.assign(a.interfaces[0], { ip: '10.1.0.1', prefix: 24 });
  Object.assign(b.interfaces[0], { ip: '10.2.0.1', prefix: 24 });
  Object.assign(a.interfaces[1], { ip: '192.0.2.1', prefix: 30 });
  Object.assign(b.interfaces[1], { ip: '192.0.2.2', prefix: 30 });
  Object.assign(pc.interfaces[0], { ip: '10.1.0.10', prefix: 24, gateway: '10.1.0.1' });
  Object.assign(server.interfaces[0], { ip: '10.2.0.20', prefix: 24, gateway: '10.2.0.1' });
  e.connect({ device: a.id, port: 'p0' }, { device: pc.id, port: 'p0' });
  e.connect({ device: b.id, port: 'p0' }, { device: server.id, port: 'p0' });
  const wan = e.connect({ device: a.id, port: 'p1' }, { device: b.id, port: 'p1' });
  const base = {
    number: 1,
    enabled: true,
    mode: 'ipsec',
    channel: 10,
    underlay: 'p1',
    key: 'Tunnel-Key-123',
    prefix: 30,
    transport: 'internet',
    mtu: 1400,
  };
  const x = e.configureTunnel(a.id, {
      ...base,
      remote: '192.0.2.2',
      ip: '172.16.0.1',
      peerIp: '172.16.0.2',
      advertise: [{ network: '10.1.0.0', prefix: 24 }],
    }),
    y = e.configureTunnel(b.id, {
      ...base,
      remote: '192.0.2.1',
      ip: '172.16.0.2',
      peerIp: '172.16.0.1',
      advertise: [{ network: '10.2.0.0', prefix: 24 }],
    });
  e.configureTcpService(server.id, {
    kind: 'http',
    port: 80,
    enabled: true,
    body: 'HTTP pelo túnel cifrado',
  });
  return { e, a, b, pc, server, x, y, wan };
}
describe('Túnel L3 autenticado sobre underlay', () => {
  it('UDP encapsulado atravessa PAT e responde à porta observada no underlay', () => {
    const { e, a, b, pc, x, y, wan } = topology();
    e.removeLink(wan.id);
    const nat = e.addDevice('router');
    Object.assign(a.interfaces[1], { ip: '192.168.100.2', prefix: 24, gateway: '192.168.100.1' });
    Object.assign(nat.interfaces[0], { ip: '192.168.100.1', prefix: 24, natRole: 'inside' });
    Object.assign(nat.interfaces[1], { ip: '192.0.2.1', prefix: 30, natRole: 'outside' });
    e.connect({ device: a.id, port: 'p1' }, { device: nat.id, port: 'p0' });
    e.connect({ device: nat.id, port: 'p1' }, { device: b.id, port: 'p1' });
    e.configureNat(nat.id, {
      enabled: true,
      statics: [],
      pools: [
        {
          name: 'WAN',
          source: { network: '192.168.100.0', prefix: 24 },
          start: '192.0.2.1',
          end: '192.0.2.1',
          outside: 'p1',
          overload: true,
        },
      ],
      bindings: [],
    });
    e.advanceTo(8000);
    expect(x.tunnel?.status).toBe('up');
    expect(y.tunnel?.status).toBe('up');
    expect(y.tunnel?.peerEndpoint?.ip).toBe('192.0.2.1');
    expect(nat.nat?.bindings.some((p) => p.protocol === 'UDP')).toBe(true);
    const id = e.ping(pc.id, '10.2.0.20');
    e.advanceTo(9000);
    expect(e.state.probes.find((p) => p.id === id)?.status).toBe('success');
    validateSnapshot(e.snapshot());
  });
  it('chave errada impede negociação e ACL do underlay impede mensagens de controle', () => {
    const { e, a, x, y } = topology();
    e.configureTunnel(a.id, { ...tunnelConfig(x), key: 'Invalid-Key-123' });
    e.advanceTo(5000);
    expect(x.tunnel?.status).not.toBe('up');
    expect(y.tunnel?.status).not.toBe('up');
    expect(e.state.events.some((v) => v.type === 'TUNNEL_AUTH_FAILED')).toBe(true);
    e.configureTunnel(a.id, { ...tunnelConfig(x), key: 'Tunnel-Key-123' });
    e.configureAcl(a.id, { name: 'BLOCK', implicitDrops: 0, rules: [] });
    a.interfaces[1].aclOut = 'BLOCK';
    e.advanceTo(10000);
    expect(x.tunnel?.status).not.toBe('up');
    delete a.interfaces[1].aclOut;
    e.advanceTo(15000);
    expect(x.tunnel?.status).toBe('up');
  });
  it('recusa replay/corrupção e não permite cabo em interface virtual', () => {
    const { e, a, b, pc, x, y } = topology();
    e.advanceTo(4000);
    e.ping(pc.id, '10.2.0.20');
    e.advanceTo(5000);
    const packet = e.state.events.find(
      (v) =>
        v.type === 'FRAME_SENT' &&
        v.device === a.id &&
        v.frame?.packet?.protocol === 'UDP' &&
        v.frame.packet.payload.protocol === 'TUNNEL' &&
        v.frame.packet.payload.message.kind === 'data'
    )!.frame!.packet!;
    if (
      packet.protocol !== 'UDP' ||
      packet.payload.protocol !== 'TUNNEL' ||
      packet.payload.message.kind !== 'data'
    )
      throw Error('payload');
    const count = y.tunnel!.received;
    receiveTunnel(e, b, b.interfaces[1], packet);
    expect(y.tunnel!.received).toBe(count);
    const bad = structuredClone(packet);
    if (bad.payload.protocol !== 'TUNNEL' || bad.payload.message.kind !== 'data') throw Error('bad');
    bad.payload.message.body = '00' + bad.payload.message.body.slice(2);
    receiveTunnel(e, b, b.interfaces[1], bad);
    expect(y.tunnel!.received).toBe(count);
    expect(() => e.connect({ device: a.id, port: x.id }, { device: b.id, port: y.id })).toThrow(/físicas/);
    const snapshot = e.snapshot();
    snapshot.queue = snapshot.queue.filter((q) => q.action.kind !== 'tunnel-tick');
    expect(() => validateSnapshot(snapshot)).toThrow(/Timer de túnel/);
  });
  it('IPv6 atravessa o túnel e respeita sua MTU e Hop Limit', () => {
    const { e, a, b, x, y } = topology();
    const cfg = (ip: string) => ({ auto: false, addresses: [{ ip, prefix: 64 }] });
    e.configureIpv6(a.id, x.id, cfg('2001:db8:100::1'));
    e.configureIpv6(b.id, y.id, cfg('2001:db8:100::2'));
    e.advanceTo(8000);
    const id = e.ping6(a.id, '2001:db8:100::2');
    e.advanceTo(9000);
    expect(e.state.probes6?.find((p) => p.id === id)?.status).toBe('success');
    const large = e.ping6(a.id, '2001:db8:100::2', 64, undefined, undefined, 1450);
    e.advanceTo(10000);
    expect(e.state.probes6?.find((p) => p.id === large)?.status).toBe('packet-too-big');
    validateSnapshot(e.snapshot());
  });
  it('negocia selectors, encaminha HTTP/ping e cifra o payload WAN', () => {
    const { e, pc, x, y } = topology();
    e.advanceTo(4000);
    expect(x.tunnel?.status).toBe('up');
    expect(y.tunnel?.status).toBe('up');
    const id = e.ping(pc.id, '10.2.0.20'),
      tcp = e.httpGet(pc.id, '10.2.0.20');
    e.advanceTo(5000);
    expect(e.state.probes.find((p) => p.id === id)?.status).toBe('success');
    expect(pc.tcpConnections?.find((c) => c.id === tcp)?.received).toContain('HTTP pelo túnel cifrado');
    const data = e.state.events.find(
      (v) =>
        v.type === 'FRAME_SENT' &&
        v.frame?.packet?.protocol === 'UDP' &&
        v.frame.packet.payload.protocol === 'TUNNEL' &&
        v.frame.packet.payload.message.kind === 'data'
    )!.frame!.packet!;
    if (data.protocol !== 'UDP' || data.payload.protocol !== 'TUNNEL' || data.payload.message.kind !== 'data')
      throw Error('encap');
    expect(data.dst).toMatch(/^192\.0\.2\./);
    expect(data.payload.message.body).not.toContain('10.2.0.20');
    validateSnapshot(e.snapshot());
  });
  it('falha de underlay derruba sessão, impede tráfego e recupera por negociação', () => {
    const { e, pc, x, wan } = topology();
    e.advanceTo(4000);
    wan.up = false;
    e.advanceTo(8000);
    expect(x.tunnel?.status).toBe('down');
    const id = e.ping(pc.id, '10.2.0.20');
    e.advanceTo(39000);
    expect(e.state.probes.find((p) => p.id === id)?.status).toBe('unreachable');
    wan.up = true;
    e.advanceTo(43000);
    expect(x.tunnel?.status).toBe('up');
    const good = e.ping(pc.id, '10.2.0.20');
    e.advanceTo(44000);
    expect(e.state.probes.find((p) => p.id === good)?.status).toBe('success');
    validateSnapshot(e.snapshot());
  });
  it('restaura negociação e frames cifrados pendentes', () => {
    const { e, pc } = topology();
    e.advanceTo(1);
    const initial = new SimulationEngine(e.snapshot());
    e.advanceTo(4000);
    initial.advanceTo(4000);
    expect(initial.snapshot()).toEqual(e.snapshot());
    e.ping(pc.id, '10.2.0.20');
    const replay = new SimulationEngine(e.snapshot());
    e.advanceTo(5000);
    replay.advanceTo(5000);
    expect(replay.snapshot()).toEqual(e.snapshot());
  });

  it('renova DH, SPI e chaves após lifetime e descarta a SA antiga', () => {
    const { e, a, b, pc, x, y } = topology();
    e.configureTunnel(a.id, { ...tunnelConfig(x), lifetimeMs: 10000 });
    e.configureTunnel(b.id, { ...tunnelConfig(y), lifetimeMs: 10000 });
    e.advanceTo(4000);
    const before = x.tunnel!.ike!.localSpi,
      master = x.tunnel!.ike!.master;
    const first = e.ping(pc.id, '10.2.0.20');
    e.advanceTo(5000);
    expect(e.state.probes.find((p) => p.id === first)?.status).toBe('success');
    const old = e.state.events.find(
      (v) =>
        v.frame?.packet?.protocol === 'UDP' &&
        v.frame.packet.payload.protocol === 'TUNNEL' &&
        v.frame.packet.payload.message.kind === 'data'
    )!.frame!.packet!;
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(15000);
    restored.advanceTo(15000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    expect(x.tunnel!.ike!.localSpi).not.toBe(before);
    expect(x.tunnel!.ike!.master).not.toBe(master);
    expect(x.tunnel!.ike!.phase).toBe('ESTABLISHED');
    const received = y.tunnel!.received;
    if (old.protocol !== 'UDP') throw Error('UDP');
    receiveTunnel(e, b, b.interfaces[1], old);
    expect(y.tunnel!.received).toBe(received);
    const next = e.ping(pc.id, '10.2.0.20');
    e.advanceTo(16000);
    expect(e.state.probes.find((p) => p.id === next)?.status).toBe('success');
    validateSnapshot(e.snapshot());
  });
});
