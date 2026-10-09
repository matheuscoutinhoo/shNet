import { describe, expect, it } from 'vitest';
import { SimulationEngine, TerminalSession, validateSnapshot } from '../packages/simulation-engine/src';
import { resolveRoute } from '../packages/simulation-engine/src/protocols/ipv4';

function vlanNetwork(svi = false) {
  const e = new SimulationEngine();
  const sw = e.addDevice('switch'),
    router = svi ? sw : e.addDevice('router');
  const client = e.addDevice('pc'),
    server = e.addDevice('server');
  sw.vlans.push({ id: 10, name: 'Users' }, { id: 20, name: 'Servers' });
  sw.interfaces[0].accessVlan = 10;
  sw.interfaces[1].accessVlan = 20;
  e.connect({ device: sw.id, port: 'p0' }, { device: client.id, port: 'p0' });
  e.connect({ device: sw.id, port: 'p1' }, { device: server.id, port: 'p0' });
  if (!svi) {
    Object.assign(sw.interfaces[2], { mode: 'trunk', allowedVlans: [1, 10, 20] });
    e.connect({ device: sw.id, port: 'p2' }, { device: router.id, port: 'p0' });
  } else sw.ipRouting = true;
  const a = svi ? e.addSvi(sw.id, 10) : e.addSubinterface(router.id, 'p0', 10);
  const b = svi ? e.addSvi(sw.id, 20) : e.addSubinterface(router.id, 'p0', 20);
  Object.assign(a, { ip: '192.168.10.1', prefix: 24 });
  Object.assign(b, { ip: '192.168.20.1', prefix: 24 });
  Object.assign(client.interfaces[0], { ip: '192.168.10.10', prefix: 24 });
  client.gateway = a.ip;
  Object.assign(server.interfaces[0], { ip: '192.168.20.10', prefix: 24 });
  server.gateway = b.ip;
  e.configureTcpService(server.id, { kind: 'http', port: 80, enabled: true, body: 'VLAN routing' });
  return { e, sw, router, client, server, a, b };
}
describe('Interfaces lógicas e tabelas VRF', () => {
  it('encaminha ARP, ICMP e HTTP entre VLANs por subinterfaces 802.1Q', () => {
    const { e, sw, router, client, server, a, b } = vlanNetwork();
    const probe = e.ping(client.id, server.interfaces[0].ip!);
    const tcp = e.httpGet(client.id, server.interfaces[0].ip!);
    e.advanceTo(10000);
    expect(e.state.probes.find((p) => p.id === probe)?.status).toBe('success');
    expect(client.tcpConnections?.find((c) => c.id === tcp)?.received).toContain('VLAN routing');
    expect(router.arpTable.map((p) => p.port)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(sw.macTable.some((p) => p.vlan === 10 && p.mac === a.mac)).toBe(true);
    expect(
      e.state.events.some((p) => p.type === 'FRAME_SENT' && p.device === router.id && p.frame?.vlan === 20)
    ).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('bloqueia VLAN proibida, subinterface desligada e parent shutdown', () => {
    for (const failure of ['allowed', 'logical', 'parent']) {
      const { e, sw, router, client, server, b } = vlanNetwork();
      if (failure === 'allowed') sw.interfaces[2].allowedVlans = [1, 10];
      if (failure === 'logical') e.setPort(router.id, b.id, false);
      if (failure === 'parent') e.setPort(router.id, 'p0', false);
      const probe = e.ping(client.id, server.interfaces[0].ip!);
      e.advanceTo(31000);
      expect(e.state.probes.find((p) => p.id === probe)?.status).not.toBe('success');
      validateSnapshot(e.snapshot());
    }
  });
  it('SVIs roteiam no switch L3; desligar ip routing conserva apenas entrega local', () => {
    const { e, sw, client, server, a } = vlanNetwork(true);
    const probe = e.ping(client.id, server.interfaces[0].ip!),
      tcp = e.httpGet(client.id, server.interfaces[0].ip!);
    e.advanceTo(10000);
    expect(e.state.probes.find((p) => p.id === probe)?.status).toBe('success');
    expect(client.tcpConnections?.find((c) => c.id === tcp)?.received).toContain('VLAN routing');
    sw.ipRouting = false;
    const blocked = e.ping(client.id, server.interfaces[0].ip!),
      local = e.ping(client.id, a.ip!);
    e.advanceTo(41000);
    expect(e.state.probes.find((p) => p.id === blocked)?.status).toBe('timeout');
    expect(e.state.probes.find((p) => p.id === local)?.status).toBe('success');
    validateSnapshot(e.snapshot());
  });
  it('STP atua nas portas físicas e a queda da VLAN desativa a SVI', () => {
    const { e, sw, client, a } = vlanNetwork(true);
    e.configureSpanningTree(sw.id, 'rstp');
    e.advanceTo(35000);
    expect(a.spanningTree).toBeUndefined();
    const probe = e.ping(client.id, a.ip!);
    e.advanceTo(36000);
    expect(e.state.probes.find((p) => p.id === probe)?.status).toBe('success');
    e.setPort(sw.id, 'p0', false);
    const tcp = e.openTcp(sw.id, '192.168.10.10', 80);
    e.advanceTo(40000);
    expect(sw.tcpConnections?.find((p) => p.id === tcp)?.state).not.toBe('ESTABLISHED');
    expect(e.state.events.some((p) => p.reason.includes('SVI sem porta operacional'))).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('isola rotas, ARP e conexões TCP com endereços e tuplas sobrepostos em VRFs', () => {
    const e = new SimulationEngine(),
      router = e.addDevice('router');
    for (const [i, vrf] of ['BLUE', 'RED'].entries()) {
      e.configureVrf(router.id, vrf);
      e.setInterfaceVrf(router.id, 'p' + i, vrf);
      Object.assign(router.interfaces[i], { ip: '10.0.0.1', prefix: 24 });
      const host = e.addDevice('server');
      Object.assign(host.interfaces[0], { ip: '10.0.0.2', prefix: 24 });
      e.connect({ device: router.id, port: 'p' + i }, { device: host.id, port: 'p0' });
      e.configureTcpService(host.id, { port: 80, kind: 'http', enabled: true, body: vrf });
    }
    expect(resolveRoute(router, '10.0.0.2')).toBeUndefined();
    const blue = e.httpGet(router.id, '10.0.0.2', 80, '/', 'BLUE');
    const red = e.httpGet(router.id, '10.0.0.2', 80, '/', 'RED');
    const ping = e.ping(router.id, '10.0.0.2', 64, 'RED');
    e.advanceTo(10000);
    expect(router.tcpConnections?.find((p) => p.id === blue)?.received).toContain('BLUE');
    expect(router.tcpConnections?.find((p) => p.id === red)?.received).toContain('RED');
    expect(router.tcpConnections?.map((p) => p.localPort)).toEqual([49152, 49152]);
    expect(router.arpTable).toHaveLength(2);
    expect(e.state.probes.find((p) => p.id === ping)?.status).toBe('success');
    validateSnapshot(e.snapshot());
    expect(() => e.ping(router.id, '10.0.0.2')).toThrow(/IPv4/);
  });
  it('persiste ARP pendente e rejeita parents, SVIs, VRFs e cabos lógicos inválidos', () => {
    const { e, router, client, server, a } = vlanNetwork();
    e.ping(client.id, server.interfaces[0].ip!);
    e.step();
    const snapshot = e.snapshot(),
      restored = new SimulationEngine(snapshot);
    e.advanceTo(10000);
    restored.advanceTo(10000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    const invalid = structuredClone(snapshot);
    invalid.devices.find((p) => p.id === router.id)!.interfaces.find((p) => p.id === a.id)!.logical!.parent =
      a.id;
    expect(() => validateSnapshot(invalid)).toThrow(/lógica/);
    expect(() =>
      restored.connect({ device: router.id, port: a.id }, { device: server.id, port: 'p1' })
    ).toThrow(/físicas/);
  });
  it('não entrega ao IP local de outra VRF nem usa sua rota conectada/estática', () => {
    const e = new SimulationEngine(),
      router = e.addDevice('router'),
      client = e.addDevice('pc');
    for (const [i, vrf] of ['BLUE', 'RED'].entries()) {
      e.configureVrf(router.id, vrf);
      e.setInterfaceVrf(router.id, 'p' + i, vrf);
    }
    Object.assign(router.interfaces[0], { ip: '10.1.0.1', prefix: 24 });
    Object.assign(router.interfaces[1], { ip: '10.2.0.1', prefix: 24 });
    Object.assign(client.interfaces[0], { ip: '10.1.0.10', prefix: 24 });
    client.gateway = '10.1.0.1';
    e.connect({ device: router.id, port: 'p0' }, { device: client.id, port: 'p0' });
    router.routes.push({ network: '203.0.113.0', prefix: 24, nextHop: '10.2.0.2', metric: 1, vrf: 'RED' });
    expect(resolveRoute(router, '203.0.113.10', 'BLUE')).toBeUndefined();
    const cross = e.ping(client.id, '10.2.0.1'),
      external = e.ping(client.id, '203.0.113.10');
    e.advanceTo(31000);
    for (const id of [cross, external])
      expect(e.state.probes.find((p) => p.id === id)?.status).toBe('unreachable');
    expect(router.interfaces[1].tx).toBe(0);
    validateSnapshot(e.snapshot());
  });
  it('CLI configura SVI, dot1q, switch L3, VRF e rotas; erros preservam o estado', () => {
    const e = new SimulationEngine(),
      sw = e.addDevice('switch'),
      router = e.addDevice('router');
    const cli = new TerminalSession(e, sw.id);
    for (const cmd of [
      'enable',
      'conf t',
      'ip routing',
      'vrf definition BLUE',
      'interface Vlan10',
      'vrf forwarding BLUE',
      'ip address 10.0.0.1/24',
      'end',
    ])
      expect(cli.execute(cmd)).not.toMatch(/Erro|%/);
    expect(cli.execute('show ip route vrf BLUE')).toContain('10.0.0.0/24');
    expect(cli.execute('show running-config')).toContain('vrf forwarding BLUE');
    const r = new TerminalSession(e, router.id);
    for (const cmd of [
      'enable',
      'conf t',
      'interface Gi0/1.20',
      'encapsulation dot1q 20',
      'ip address 192.168.20.1/24',
      'end',
    ])
      expect(r.execute(cmd)).not.toMatch(/Erro|%/);
    expect(r.execute('show running-config')).toContain('encapsulation dot1q 20');
    const before = e.snapshot();
    expect(r.execute('ping vrf ABSENT 10.0.0.1')).toContain('VRF inexistente');
    expect(e.snapshot()).toEqual(before);
  });
});
