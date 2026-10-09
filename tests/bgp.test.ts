import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  makeTemplate,
  validateSnapshot,
  bgpConfig,
} from '../packages/simulation-engine/src';

function topology() {
  const engine = new SimulationEngine(makeTemplate('bgp'));
  const [a, b, c, client, server] = engine.state.devices;
  return { engine, a, b, c, client, server };
}
describe('BGP por sessões TCP reais do modelo', () => {
  it('negocia OPEN/KEEPALIVE, resolve colisões TCP e aprende AS_PATH sem loops', () => {
    const { engine, a, b, c } = topology();
    for (let steps = 0; engine.state.clock < 14000 && steps < 3000; steps++) {
      engine.step();
      validateSnapshot(engine.snapshot());
    }
    for (const router of [a, b, c])
      expect(router.bgp!.peers.map((peer) => peer.state)).toEqual(['Established', 'Established']);
    expect(
      a.bgp!.rib.find((path) => path.peer === '10.0.13.3' && path.network === '192.168.20.0')?.asPath
    ).toEqual([65003]);
    expect(
      a.bgp!.rib.find((path) => path.peer === '10.0.12.2' && path.network === '192.168.20.0')?.asPath
    ).toEqual([65002, 65003]);
    expect(a.bgp!.routes.find((path) => path.network === '192.168.20.0')?.nextHop).toBe('10.0.13.3');
    expect(
      engine.state.events.some(
        (event) =>
          event.frame?.packet?.protocol === 'TCP' &&
          [event.frame.packet.sourcePort, event.frame.packet.destinationPort].includes(179) &&
          event.frame.packet.data.includes('"type":"UPDATE"')
      )
    ).toBe(true);
  });
  it('encaminha ping/HTTP pelo melhor caminho e reconverge ao perder a interface direta', () => {
    const { engine, a, client, server } = topology();
    engine.advanceTo(15000);
    const probe = engine.ping(client.id, server.interfaces[0].ip!);
    engine.advanceTo(15500);
    expect(engine.state.probes.find((p) => p.id === probe)?.status).toBe('success');
    engine.setPort(a.id, 'p1', false);
    engine.advanceTo(20000);
    expect(a.bgp!.routes.find((path) => path.network === '192.168.20.0')?.nextHop).toBe('10.0.12.2');
    engine.httpGet(client.id, server.interfaces[0].ip!);
    engine.advanceTo(25000);
    expect(client.tcpConnections!.find((c) => c.remotePort === 80)?.received).toContain(
      'Resposta encaminhada pelo BGP'
    );
    validateSnapshot(engine.snapshot());
  });
  it('aplica LOCAL_PREF e filtro de saída ao fluxo de anúncios', () => {
    const { engine, a, c } = topology();
    const config = bgpConfig(a)!;
    config.neighbors[0].localPref = 200;
    engine.configureBgp(a.id, config);
    engine.advanceTo(15000);
    expect(a.bgp!.routes.find((path) => path.network === '192.168.20.0')?.nextHop).toBe('10.0.12.2');
    const remote = bgpConfig(c)!;
    remote.neighbors[0].exportFilter = [
      { network: '192.168.20.0', prefix: 24, action: 'deny', sequence: 10 },
    ];
    engine.configureBgp(c.id, remote);
    engine.advanceTo(30000);
    expect(a.bgp!.rib.some((path) => path.peer === '10.0.13.3' && path.network === '192.168.20.0')).toBe(
      false
    );
    validateSnapshot(engine.snapshot());
  });
  it('retira origem sem rota correspondente e divulga WITHDRAW', () => {
    const { engine, a, c } = topology();
    engine.advanceTo(15000);
    engine.setPort(c.id, 'p2', false);
    engine.advanceTo(20000);
    expect(a.bgp!.rib.some((path) => path.network === '192.168.20.0')).toBe(false);
    expect(
      engine.state.events.some((event) => event.type === 'BGP_SENT' && event.reason.includes('1 retiradas'))
    ).toBe(true);
    validateSnapshot(engine.snapshot());
  });
  it('expira Hold quando ACL bloqueia TCP/179 e usa o outro peer', () => {
    const { engine, a } = topology();
    engine.advanceTo(15000);
    const any = { network: '0.0.0.0', prefix: 0 };
    engine.configureAcl(a.id, {
      name: 'BGP-BLOCK',
      rules: [
        { sequence: 10, action: 'deny', protocol: 'tcp', source: any, destination: any, sourcePort: 179 },
        {
          sequence: 20,
          action: 'deny',
          protocol: 'tcp',
          source: any,
          destination: any,
          destinationPort: 179,
        },
        { sequence: 30, action: 'permit', protocol: 'ip', source: any, destination: any },
      ],
    });
    a.interfaces[1].aclIn = 'BGP-BLOCK';
    engine.advanceTo(30000);
    expect(a.bgp!.peers.find((peer) => peer.ip === '10.0.13.3')?.state).not.toBe('Established');
    expect(a.bgp!.routes.find((route) => route.network === '192.168.20.0')?.nextHop).toBe('10.0.12.2');
    expect(
      engine.state.events.some(
        (event) => event.type === 'BGP_SESSION_CLOSED' && event.reason.includes('Hold timer')
      )
    ).toBe(true);
    validateSnapshot(engine.snapshot());
  });
  it('mantém sessões longas consumindo o fluxo TCP sem esgotar o limite de 16 KiB', () => {
    const { engine, a } = topology();
    engine.advanceTo(5000000, 200000);
    expect(a.bgp!.peers.every((peer) => peer.state === 'Established')).toBe(true);
    const streams = a.tcpConnections!.filter(
      (connection) => connection.service === 'bgp' && connection.state === 'ESTABLISHED'
    );
    expect(
      streams.some(
        (connection) => connection.stream!.writtenBytes > 16384 && connection.stream!.readBytes > 16384
      )
    ).toBe(true);
    expect(streams.every((connection) => connection.received.length < 4096)).toBe(true);
    validateSnapshot(engine.snapshot());
  });
  it('nega trânsito iBGP entre peers sem refletor e permite reflexão sem loops quando configurado', () => {
    const { engine, a, b, c, client, server } = topology();
    for (const router of [a, b, c]) {
      const config = bgpConfig(router)!;
      config.asn = 65001;
      config.neighbors.forEach((peer) => {
        peer.remoteAs = 65001;
        peer.nextHopSelf = true;
      });
      engine.configureBgp(router.id, config);
    }
    engine.advanceTo(15000);
    engine.setPort(a.id, 'p1', false);
    engine.advanceTo(20000);
    expect(a.bgp!.routes.some((route) => route.network === '192.168.20.0')).toBe(false);
    const config = bgpConfig(b)!;
    config.neighbors[1].reflectorClient = true;
    engine.configureBgp(b.id, config);
    engine.advanceTo(35000);
    const route = a.bgp!.routes.find((route) => route.network === '192.168.20.0');
    expect(route?.distance).toBe(200);
    expect(route?.nextHop).toBe('10.0.12.2');
    const path = a.bgp!.rib.find((path) => path.network === '192.168.20.0');
    expect(path?.originatorId).toBe('3.3.3.3');
    expect(path?.clusterList).toEqual(['2.2.2.2']);
    const id = engine.ping(client.id, server.interfaces[0].ip!);
    engine.advanceTo(36000);
    expect(engine.state.probes.find((p) => p.id === id)?.status).toBe('success');
    validateSnapshot(engine.snapshot());
  });
  it('descarta UPDATE com o próprio AS no caminho sem encerrar a sessão', () => {
    const { engine, a, c } = topology();
    engine.advanceTo(15000);
    const connection = c.bgp!.peers.find((peer) => peer.ip === '10.0.13.1')!.connection!;
    engine.writeTcp(
      c.id,
      connection,
      JSON.stringify({
        type: 'UPDATE',
        withdrawn: [],
        announcements: [
          {
            network: '192.168.20.0',
            prefix: 24,
            nextHop: '10.0.13.3',
            asPath: [65003, 65001],
            origin: 'IGP',
            localPref: 100,
            med: 0,
          },
        ],
      }) + '\n'
    );
    engine.advanceTo(15500);
    expect(a.bgp!.rib.some((path) => path.peer === '10.0.13.3' && path.network === '192.168.20.0')).toBe(
      false
    );
    expect(a.bgp!.peers.find((peer) => peer.ip === '10.0.13.3')?.state).toBe('Established');
    expect(engine.state.events.some((event) => event.type === 'BGP_ROUTE_REJECTED')).toBe(true);
    validateSnapshot(engine.snapshot());
  });
  it('rejeita OPEN com ASN inesperado e cancela rotas do peer', () => {
    const { engine, a, c } = topology();
    const config = bgpConfig(c)!;
    config.neighbors[0].remoteAs = 65009;
    engine.configureBgp(c.id, config);
    engine.advanceTo(15000);
    expect(a.bgp!.peers.find((peer) => peer.ip === '10.0.13.3')?.state).not.toBe('Established');
    expect(engine.state.events.some((event) => event.reason.includes('OPEN inválido'))).toBe(true);
    validateSnapshot(engine.snapshot());
  });
  it('preserva sessões, RIB, TCP parcial e timers ao restaurar e recusa adulterações', () => {
    const { engine, a } = topology();
    engine.advanceTo(1001);
    const snapshot = engine.snapshot(),
      restored = new SimulationEngine(snapshot);
    engine.advanceTo(25000);
    restored.advanceTo(25000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    const duplicate = structuredClone(snapshot);
    duplicate.queue.push(structuredClone(duplicate.queue.find((item) => item.action.kind === 'bgp-tick')!));
    expect(() => validateSnapshot(duplicate)).toThrow();
    const invalid = engine.snapshot();
    invalid.devices.find((device) => device.id === a.id)!.bgp!.routes[0].nextHop = '192.0.2.99';
    expect(() => validateSnapshot(invalid)).toThrow();
  });
  it('CLI aplica políticas, mostra caminhos e preserva running-config; configuração inválida faz rollback', () => {
    const { engine, a } = topology();
    const cli = new TerminalSession(engine, a.id);
    for (const command of [
      'enable',
      'conf t',
      'neighbor 10.0.12.2 local-preference 250',
      'neighbor 10.0.12.2 prefix-filter in 10 permit 192.168.20.0/24',
      'bgp hold-time 12',
    ])
      expect(cli.execute(command)).toBe('OK');
    engine.advanceTo(15000);
    expect(cli.execute('show ip bgp summary')).toContain('Established');
    expect(cli.execute('show running-config')).toContain('prefix-filter in 10 permit 192.168.20.0/24');
    expect(cli.execute('show ip route')).toContain('B 192.168.20.0/24 [20/0] via 10.0.12.2');
    const before = engine.snapshot();
    expect(cli.execute('neighbor 10.0.12.2 route-reflector-client')).toMatch(/%/);
    expect(engine.snapshot()).toEqual(before);
    validateSnapshot(engine.snapshot());
  });
});
