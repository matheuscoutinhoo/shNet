import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  ripRoutes,
  resolveRoute,
  TerminalSession,
  type UdpPacket,
} from '../packages/simulation-engine/src';
import { receiveRip, ripBytes } from '../packages/simulation-engine/src/protocols/rip';
function topology(chain = false) {
  const engine = new SimulationEngine(makeTemplate('ospf'));
  const routers = engine.state.devices.filter((device) => device.type === 'router');
  for (const router of routers) {
    const ospf = router.ospf!;
    engine.configureOspf(router.id, { enabled: false, routerId: ospf.routerId, interfaces: ospf.interfaces });
    engine.configureRip(router.id, {
      enabled: true,
      interfaces: ospf.interfaces.map((entry) => ({ port: entry.port, passive: entry.passive })),
    });
  }
  if (chain) engine.state.links[2].up = false;
  return {
    engine,
    routers,
    a: routers[0],
    b: routers[1],
    c: routers[2],
    client: engine.state.devices.find((d) => d.type === 'pc')!,
  };
}
describe('RIPv2 pela rede simulada', () => {
  it('configura pelo terminal e preserva a configuração do template', () => {
    const engine = new SimulationEngine(makeTemplate('rip')),
      router = engine.state.devices[0];
    const cli = new TerminalSession(engine, router.id);
    for (const cmd of [
      'enable',
      'conf t',
      'router rip',
      'interface Gi0/1',
      'ip rip enable',
      'no ip rip poison-reverse',
    ])
      expect(cli.execute(cmd)).toBe('OK');
    expect(cli.execute('show ip rip interface')).toContain('split horizon');
    expect(cli.execute('show running-config')).toContain('no ip rip poison-reverse');
    engine.advanceTo(20000);
    expect(cli.execute('show ip route')).toContain('[120/2]');
    expect(cli.execute('no service rip')).toBe('OK');
    expect(ripRoutes(engine.device(router.id))).toEqual([]);
    validateSnapshot(engine.snapshot());
  });
  it('aprende vetores, usa a menor métrica e reconverge após queda', () => {
    const { engine, a, client } = topology();
    engine.advanceTo(20000);
    expect(ripRoutes(a)).toContainEqual(
      expect.objectContaining({ network: '192.168.20.0', metric: 2, nextHop: '10.0.13.3', distance: 120 })
    );
    engine.ping(client.id, '192.168.20.10');
    engine.advanceTo(21000);
    expect(engine.state.probes.at(-1)?.status).toBe('success');
    engine.state.links[2].up = false;
    engine.advanceTo(65000);
    expect(ripRoutes(a)).toContainEqual(
      expect.objectContaining({ network: '192.168.20.0', metric: 3, nextHop: '10.0.12.2' })
    );
    engine.httpGet(client.id, '192.168.20.10');
    engine.advanceTo(66000);
    expect(client.tcpConnections![0].received).toContain('200 OK');
    validateSnapshot(engine.snapshot());
  });
  it('anuncia poison reverse e retira prefixo conectado que caiu', () => {
    const { engine, a, c } = topology(true);
    engine.advanceTo(20000);
    const advertisements = engine.state.events.filter(
      (event) => event.type === 'RIP_UPDATE' && event.device === a.id && event.port === 'p0'
    );
    expect(
      advertisements.some(
        (event) =>
          event.frame?.packet?.protocol === 'UDP' &&
          event.frame.packet.payload.protocol === 'RIP' &&
          event.frame.packet.payload.message.type === 'response' &&
          event.frame.packet.payload.message.entries.some(
            (entry) => entry.network === '192.168.20.0' && entry.metric === 16
          )
      )
    ).toBe(true);
    engine.setPort(c.id, 'p2', false);
    engine.advanceTo(50000);
    expect(ripRoutes(a).some((entry) => entry.network === '192.168.20.0')).toBe(false);
    expect(a.rip!.table.find((entry) => entry.network === '192.168.20.0')?.metric).toBe(16);
    engine.advanceTo(190000);
    expect(a.rip!.table.some((entry) => entry.network === '192.168.20.0')).toBe(false);
    validateSnapshot(engine.snapshot());
  });
  it('expira por ausência de anúncios e coleta a rota sem reiniciar garbage timer', () => {
    const { engine, a } = topology(true);
    engine.advanceTo(20000);
    const cli = new TerminalSession(engine, a.id);
    for (const cmd of [
      'enable',
      'conf t',
      'access-list BLOCK 10 deny udp any any eq 520',
      'access-list BLOCK 20 permit ip any any',
      'interface Gi0/1',
      'ip access-group BLOCK in',
    ])
      expect(cli.execute(cmd)).toBe('OK');
    engine.advanceTo(210000);
    expect(ripRoutes(a)).toEqual([]);
    expect(a.rip!.table.find((entry) => entry.network === '192.168.20.0')?.metric).toBe(16);
    engine.advanceTo(340000);
    expect(a.rip!.table.some((entry) => entry.learnedFrom)).toBe(false);
    validateSnapshot(engine.snapshot());
  });
  it('retoma exatamente após perda de mensagens e conserva timers', () => {
    const { engine } = topology();
    engine.state.links.forEach((link) => {
      link.loss = 0.2;
    });
    for (let i = 0; i < 60; i++) {
      engine.step();
      validateSnapshot(engine.snapshot());
    }
    const restored = new SimulationEngine(engine.snapshot());
    engine.advanceTo(90000);
    restored.advanceTo(90000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    const bad = engine.snapshot();
    bad.queue = bad.queue.filter(({ action }) => action.kind !== 'rip-tick');
    expect(() => validateSnapshot(bad)).toThrow(/Timer RIP/);
  });
  it('aplica infinito em 16 e recusa prefixos ou portas inválidos', () => {
    const { engine, a } = topology();
    engine.advanceTo(1000);
    const message = {
      type: 'response' as const,
      version: 2 as const,
      entries: [{ network: '203.0.113.0', prefix: 24, metric: 14, tag: 0 }],
    };
    const packet: UdpPacket = {
      protocol: 'UDP',
      src: '10.0.12.2',
      dst: '224.0.0.9',
      ttl: 1,
      sourcePort: 520,
      destinationPort: 520,
      payload: { protocol: 'RIP', message },
      bytes: ripBytes(message),
    };
    receiveRip(engine, a, a.interfaces[0], packet, '02:00:00:00:00:01');
    expect(ripRoutes(a).find((entry) => entry.network === '203.0.113.0')?.metric).toBe(15);
    message.entries[0].metric = 15;
    receiveRip(engine, a, a.interfaces[0], packet, '02:00:00:00:00:01');
    expect(a.rip!.table.find((entry) => entry.network === '203.0.113.0')?.metric).toBe(16);
    packet.sourcePort = 521;
    const count = a.dropped;
    receiveRip(engine, a, a.interfaces[0], packet, '02:00:00:00:00:01');
    expect(a.dropped).toBe(count + 1);
    validateSnapshot(engine.snapshot());
  });
  it('prefere OSPF e estática para o mesmo prefixo', () => {
    const { engine, routers, a } = topology();
    for (const router of routers)
      engine.configureOspf(router.id, {
        enabled: true,
        routerId: router.ospf!.routerId,
        interfaces: router.ospf!.interfaces,
      });
    engine.advanceTo(20000);
    expect(ripRoutes(a).find((entry) => entry.network === '192.168.20.0')?.nextHop).toBe('10.0.13.3');
    expect(resolveRoute(a, '192.168.20.10')?.nextHop).toBe('10.0.12.2');
    a.routes.push({ network: '192.168.20.0', prefix: 24, nextHop: '10.0.13.3', metric: 200 });
    expect(resolveRoute(a, '192.168.20.10')?.nextHop).toBe('10.0.13.3');
  });
});
