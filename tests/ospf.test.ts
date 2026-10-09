import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  validateSnapshot,
  TerminalSession,
  makeTemplate,
  resolveRoute,
} from '../packages/simulation-engine/src';

function topology() {
  const engine = new SimulationEngine();
  const routers = [1, 2, 3].map(() => engine.addDevice('router'));
  const client = engine.addDevice('pc'),
    server = engine.addDevice('server');
  const [a, b, c] = routers;
  const pair = (left: typeof a, li: number, lip: string, right: typeof a, ri: number, rip: string) => {
    Object.assign(left.interfaces[li], { ip: lip, prefix: 24 });
    Object.assign(right.interfaces[ri], { ip: rip, prefix: 24 });
    return engine.connect(
      { device: left.id, port: left.interfaces[li].id },
      { device: right.id, port: right.interfaces[ri].id }
    );
  };
  const primary = pair(a, 0, '10.0.12.1', b, 0, '10.0.12.2');
  pair(b, 1, '10.0.23.2', c, 0, '10.0.23.3');
  pair(a, 1, '10.0.13.1', c, 1, '10.0.13.3');
  pair(a, 2, '192.168.1.1', client, 0, '192.168.1.10');
  pair(c, 2, '192.168.3.1', server, 0, '192.168.3.10');
  client.gateway = '192.168.1.1';
  server.gateway = '192.168.3.1';
  routers.forEach((router, index) =>
    engine.configureOspf(router.id, {
      enabled: true,
      routerId: `${index + 1}.${index + 1}.${index + 1}.${index + 1}`,
      interfaces: router.interfaces
        .filter((port) => port.ip)
        .map((port, n) => ({
          port: port.id,
          area: 0,
          cost: (router === a || router === c) && n === 1 ? 30 : n === 2 ? 1 : 10,
          passive: n === 2,
        })),
    })
  );
  return { engine, routers, a, b, c, client, server, primary };
}

describe('OSPF pela rede simulada', () => {
  it('mantém snapshots válidos em cada transição e aplica a preferência por rotas estáticas', () => {
    const { engine, a } = topology();
    for (let i = 0; i < 300; i++) {
      engine.step();
      validateSnapshot(engine.snapshot());
    }
    expect(resolveRoute(a, '192.168.3.10')?.nextHop).toBe('10.0.12.2');
    a.routes.push({ network: '192.168.3.0', prefix: 24, nextHop: '10.0.13.3', metric: 200 });
    expect(resolveRoute(a, '192.168.3.10')?.nextHop).toBe('10.0.13.3');
  });
  it('configura por terminal, bloqueia Hellos por ACL e entrega HTTP pelo template', () => {
    const engine = new SimulationEngine(makeTemplate('ospf'));
    const router = engine.state.devices[0],
      cli = new TerminalSession(engine, router.id);
    expect(cli.execute('enable')).toBe('OK');
    expect(cli.execute('conf t')).toBe('OK');
    for (const command of [
      'access-list BLOCK 10 deny ospf any any',
      'access-list BLOCK 20 permit ip any any',
      'interface Gi0/1',
      'ip access-group BLOCK in',
    ])
      expect(cli.execute(command)).toBe('OK');
    engine.advanceTo(1000);
    expect(router.ospf!.neighbors.some((entry) => entry.port === 'p0')).toBe(false);
    expect(cli.execute('show ip route')).toContain('[110/31] via 10.0.13.3');
    expect(cli.execute('show ip ospf database')).toContain('router');
    expect(cli.execute('show running-config')).toContain('router ospf 1.1.1.1');
    const client = engine.state.devices.find((device) => device.type === 'pc')!;
    engine.httpGet(client.id, '192.168.20.10');
    engine.advanceTo(2000);
    expect(client.tcpConnections![0].received).toContain('200 OK');
    expect(cli.execute('no ip access-group BLOCK in')).toBe('OK');
    expect(cli.execute('ip ospf cost 9')).toBe('OK');
    engine.advanceTo(15000);
    expect(cli.execute('show ip route')).toContain('[110/20] via 10.0.12.2');
    expect(cli.execute('no service ospf')).toBe('OK');
    expect(engine.state.devices[0].ospf!.routes).toEqual([]);
  });
  it('forma adjacências, aprende por LSAs e reconverge após falha', () => {
    const { engine, routers, a, client, primary } = topology();
    engine.advanceTo(1000);
    for (const router of routers)
      expect(router.ospf!.neighbors.map((n) => n.state)).toEqual(['Full', 'Full']);
    expect(a.ospf!.routes).toContainEqual(
      expect.objectContaining({ network: '192.168.3.0', nextHop: '10.0.12.2', metric: 21 })
    );
    engine.ping(client.id, '192.168.3.10');
    engine.advanceTo(2000);
    expect(engine.state.probes.at(-1)?.status).toBe('success');
    primary.up = false;
    engine.advanceTo(4000);
    expect(a.ospf!.routes).toContainEqual(
      expect.objectContaining({ network: '192.168.3.0', nextHop: '10.0.13.3', metric: 31 })
    );
    engine.ping(client.id, '192.168.3.10');
    engine.advanceTo(5000);
    expect(engine.state.probes.at(-1)?.status).toBe('success');
    validateSnapshot(engine.snapshot());
  });
  it('retoma uma troca de banco de dados a partir do snapshot', () => {
    const { engine } = topology();
    for (let i = 0; i < 30; i++) engine.step();
    const resumed = new SimulationEngine(validateSnapshot(engine.snapshot()));
    engine.advanceTo(15000);
    resumed.advanceTo(15000);
    expect(JSON.stringify(resumed.snapshot().devices.map((d) => d.ospf?.routes))).toBe(
      JSON.stringify(engine.snapshot().devices.map((d) => d.ospf?.routes))
    );
    expect(resumed.state.sequence).toBe(engine.state.sequence);
    expect(resumed.snapshot()).toEqual(engine.snapshot());
  });
  it.each(['database', 'request', 'update', 'ack'])('recupera a perda de mensagens %s', (type) => {
    const { engine, routers } = topology();
    let dropped = 0;
    while (engine.state.queue[0]?.at < 100) {
      engine.state.queue = engine.state.queue.filter(({ action }) => {
        const discard =
          action.kind === 'deliver' &&
          action.frame.packet?.protocol === 'OSPF' &&
          action.frame.packet.message.type === type;
        if (discard) dropped++;
        return !discard;
      });
      engine.step();
    }
    expect(dropped).toBeGreaterThan(0);
    engine.advanceTo(15000);
    for (const router of routers) {
      expect(router.ospf!.neighbors.every((neighbor) => neighbor.state === 'Full')).toBe(true);
      expect(router.ospf!.neighbors.every((neighbor) => neighbor.pending.length === 0)).toBe(true);
    }
    validateSnapshot(engine.snapshot());
  });
  it.each(['area', 'helloMs', 'mtu'])('recusa adjacência com %s incompatível', (field) => {
    const { engine, a, b } = topology();
    if (field === 'mtu') a.interfaces[0].mtu = 1400;
    else {
      const interfaces = structuredClone(a.ospf!.interfaces);
      if (field === 'area') interfaces[0].area = 1;
      else interfaces[0].helloMs = 2000;
      engine.configureOspf(a.id, { enabled: true, routerId: a.ospf!.routerId, interfaces });
    }
    engine.advanceTo(15000);
    expect(a.ospf!.neighbors.find((entry) => entry.routerId === b.ospf!.routerId)?.state).not.toBe('Full');
    expect(
      engine.state.events.some((entry) => entry.type === 'PACKET_DROPPED' && entry.reason.includes('OSPF'))
    ).toBe(true);
    validateSnapshot(engine.snapshot());
  });
  it('rejeita snapshots com timer, rota ou LSA adulterados', () => {
    const { engine } = topology();
    engine.advanceTo(1000);
    const timer = engine.snapshot();
    timer.queue = timer.queue.filter(({ action }) => action.kind !== 'ospf-tick');
    expect(() => validateSnapshot(timer)).toThrow(/Timer OSPF/);
    const route = engine.snapshot();
    route.devices[0].ospf!.routes[0].metric++;
    expect(() => validateSnapshot(route)).toThrow(/Rotas OSPF/);
    const lsa = engine.snapshot();
    lsa.devices[0].ospf!.lsdb[0].originatedAt++;
    lsa.devices[0].ospf!.lsdb[0].originatedAt = engine.state.clock + 1;
    expect(() => validateSnapshot(lsa)).toThrow(/LSA OSPF/);
  });
  it('propaga sumários entre áreas através do backbone e retira redes perdidas', () => {
    const engine = new SimulationEngine();
    const routers = [1, 2, 3, 4].map(() => engine.addDevice('router'));
    for (let i = 0; i < 3; i++) {
      Object.assign(routers[i].interfaces[1], { ip: `10.0.${i}.1`, prefix: 24 });
      Object.assign(routers[i + 1].interfaces[0], { ip: `10.0.${i}.2`, prefix: 24 });
      engine.connect({ device: routers[i].id, port: 'p1' }, { device: routers[i + 1].id, port: 'p0' });
    }
    for (const i of [0, 3]) {
      const pc = engine.addDevice('pc');
      Object.assign(pc.interfaces[0], { ip: `192.168.${i}.10`, prefix: 24 });
      Object.assign(routers[i].interfaces[2], { ip: `192.168.${i}.1`, prefix: 24 });
      engine.connect({ device: routers[i].id, port: 'p2' }, { device: pc.id, port: 'p0' });
    }
    routers.forEach((router, i) =>
      engine.configureOspf(router.id, {
        enabled: true,
        routerId: `${i + 1}.1.1.1`,
        interfaces: router.interfaces
          .filter((port) => port.ip)
          .map((port) => ({
            port: port.id,
            area:
              i === 0 || (i === 1 && port.id === 'p0') ? 1 : i === 3 || (i === 2 && port.id === 'p1') ? 2 : 0,
            passive: port.id === 'p2',
          })),
      })
    );
    engine.advanceTo(2000);
    expect(routers[0].ospf!.routes).toContainEqual(
      expect.objectContaining({ network: '192.168.3.0', pathType: 'inter', metric: 4, nextHop: '10.0.0.2' })
    );
    expect(routers[3].ospf!.routes).toContainEqual(
      expect.objectContaining({ network: '192.168.0.0', pathType: 'inter', metric: 4 })
    );
    engine.setPort(routers[3].id, 'p2', false);
    engine.advanceTo(4000);
    expect(routers[0].ospf!.routes.some((entry) => entry.network === '192.168.3.0')).toBe(false);
    validateSnapshot(engine.snapshot());
  });
  it('elege DR/BDR, mantém DROTHER em 2-Way e promove o BDR após expiração', () => {
    const engine = new SimulationEngine(),
      sw = engine.addDevice('switch');
    const routers = [1, 2, 3, 4].map((index) => {
      const router = engine.addDevice('router');
      Object.assign(router.interfaces[0], { ip: `10.0.0.${index}`, prefix: 24 });
      engine.connect({ device: router.id, port: 'p0' }, { device: sw.id, port: `p${index - 1}` });
      engine.configureOspf(router.id, {
        enabled: true,
        routerId: `${index}.1.1.1`,
        interfaces: [
          {
            port: 'p0',
            area: 0,
            networkType: 'broadcast',
            priority: index === 4 ? 0 : 1,
            helloMs: 1000,
            deadMs: 4000,
          },
        ],
      });
      return router;
    });
    engine.advanceTo(7000);
    for (const router of routers) {
      expect(router.ospf!.ports[0]).toMatchObject({ dr: '3.1.1.1', bdr: '2.1.1.1' });
      expect(router.ospf!.neighbors.filter((entry) => entry.state === 'Full').length).toBe(
        router === routers[0] || router === routers[3] ? 2 : 3
      );
    }
    routers[2].power = false;
    engine.advanceTo(13000);
    expect(routers[0].ospf!.ports[0]).toMatchObject({ dr: '2.1.1.1', bdr: '1.1.1.1' });
    expect(routers[0].ospf!.neighbors.some((entry) => entry.routerId === '3.1.1.1')).toBe(false);
    validateSnapshot(engine.snapshot());
  });
});
