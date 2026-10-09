import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  makeTemplate,
  validateSnapshot,
  vrrpConfigGroups,
  vrrpMac,
  type Device,
  type VrrpPacket,
} from '../packages/simulation-engine/src';
import { receiveVrrp } from '../packages/simulation-engine/src/protocols/vrrp';

function topology() {
  const engine = new SimulationEngine(makeTemplate('vrrp'));
  const [client, lan, a, b, wan, server] = engine.state.devices;
  return { engine, client, lan, a, b, wan, server };
}
const states = (device: Device) => device.vrrp!.groups.map((group) => group.state);
function ping(engine: SimulationEngine, client: Device, server: Device) {
  const id = engine.ping(client.id, server.interfaces[0].ip!);
  engine.advanceTo(engine.state.clock + 150);
  expect(engine.state.probes.find((probe) => probe.id === id)?.status).toBe('success');
}
function changePriority(engine: SimulationEngine, device: Device, priority: number, preempt = true) {
  engine.configureVrrp(device.id, {
    enabled: true,
    groups: vrrpConfigGroups(device).map((group) => ({ ...group, priority, preempt })),
  });
}
function advert(overrides: Partial<VrrpPacket> = {}): VrrpPacket {
  return {
    src: '192.168.10.2',
    dst: '224.0.0.18',
    ttl: 255,
    protocol: 'VRRP',
    version: 3,
    vrid: 10,
    vip: '192.168.10.1',
    priority: 150,
    advertMs: 1000,
    bytes: 32,
    ...overrides,
  };
}
describe('VRRPv3 IPv4 por anúncios Ethernet', () => {
  it('tracking do uplink reduz prioridade e mantém ping/HTTP com o primário ligado', () => {
    const { engine, a, b, client, server } = topology();
    engine.configureVrrp(a.id, {
      enabled: true,
      groups: vrrpConfigGroups(a).map((g) => ({ ...g, track: [{ port: 'p1', decrement: 80 }] })),
    });
    engine.advanceTo(engine.state.clock + 6000);
    expect(states(a)).toEqual(['ACTIVE', 'ACTIVE']);
    const link = engine.state.links.find((l) =>
      [l.a, l.b].some((end) => end.device === a.id && end.port === 'p1')
    )!;
    link.up = false;
    engine.advanceTo(engine.state.clock + 6000);
    expect(a.power).toBe(true);
    expect(a.vrrp!.groups[0].effectivePriority).toBe(70);
    expect(states(b)).toEqual(['ACTIVE', 'ACTIVE']);
    ping(engine, client, server);
    const connection = engine.httpGet(client.id, server.interfaces[0].ip!);
    engine.advanceTo(engine.state.clock + 200);
    expect(client.tcpConnections?.find((c) => c.id === connection)?.received).toContain(
      'HTTP pelo gateway VRRP'
    );
    link.up = true;
    engine.advanceTo(engine.state.clock + 6000);
    expect(a.vrrp!.groups[0].effectivePriority).toBe(150);
    expect(states(a)).toEqual(['ACTIVE', 'ACTIVE']);
    validateSnapshot(engine.snapshot());
  });
  it('tracking de rota observa retirada e restaura timers deterministicamente', () => {
    const { engine, a } = topology();
    a.routes.push({ network: '203.0.113.0', prefix: 24, nextHop: '192.168.20.3', metric: 1 });
    engine.configureVrrp(a.id, {
      enabled: true,
      groups: vrrpConfigGroups(a).map((g) => ({ ...g, track: [{ route: '203.0.113.5', decrement: 80 }] })),
    });
    engine.advanceTo(engine.state.clock + 6000);
    expect(a.vrrp!.groups[0].effectivePriority).toBe(150);
    a.routes = a.routes.filter((r) => r.network !== '203.0.113.0');
    engine.refreshVrrp();
    expect(a.vrrp!.groups[0].effectivePriority).toBe(70);
    const checkpoint = engine.snapshot(),
      restored = new SimulationEngine(checkpoint);
    const until = engine.state.clock + 6000;
    engine.advanceTo(until);
    restored.advanceTo(until);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    const bad = structuredClone(checkpoint);
    bad.devices.find((d) => d.id === a.id)!.vrrp!.groups[0].effectivePriority = 100;
    expect(() => validateSnapshot(bad)).toThrow(/VRRP/);
  });
  it('CLI configura/remova tracking e recusa referências inválidas sem efeitos parciais', () => {
    const { engine, a } = topology(),
      cli = new TerminalSession(engine, a.id);
    for (const command of [
      'enable',
      'conf t',
      'interface Gi0/1',
      'vrrp 10 track interface Gi0/2 decrement 80',
      'end',
    ])
      expect(cli.execute(command)).not.toMatch(/Erro|%/);
    expect(cli.execute('show running-config')).toContain('track interface Gi0/2 decrement 80');
    expect(cli.execute('show vrrp')).toContain('efetiva 150');
    const bad = engine.snapshot();
    bad.devices.find((d) => d.id === a.id)!.vrrp!.groups[0].track![0].port = 'missing';
    expect(() => validateSnapshot(bad)).toThrow(/Tracking/);
    for (const command of ['conf t', 'interface Gi0/1', 'no vrrp 10 track interface Gi0/2'])
      expect(cli.execute(command)).not.toMatch(/Erro|%/);
    expect(engine.device(a.id).vrrp!.groups[0].track).toEqual([]);
  });
  it('elege por prioridade, anuncia multicast e responde ARP somente no ativo', () => {
    const { engine, client, a, b, server } = topology();
    expect(states(a)).toEqual(['ACTIVE', 'ACTIVE']);
    expect(states(b)).toEqual(['BACKUP', 'BACKUP']);
    expect(b.vrrp!.groups[0].activeIp).toBe('192.168.10.2');
    ping(engine, client, server);
    expect(client.arpTable).toContainEqual(expect.objectContaining({ ip: client.gateway, mac: vrrpMac(10) }));
    const replies = engine.state.events.filter(
      (event) => event.type === 'ARP_REPLY' && event.frame?.arp?.senderIp === client.gateway
    );
    expect(replies.map((event) => event.device)).toEqual([a.id]);
    engine.advanceTo(5600);
    expect(
      engine.state.events.some(
        (event) =>
          event.frame?.packet?.protocol === 'VRRP' &&
          event.frame.dst === '01:00:5e:00:00:12' &&
          event.frame.src === vrrpMac(event.frame.packet.vrid) &&
          event.frame.packet.ttl === 255
      )
    ).toBe(true);
    validateSnapshot(engine.snapshot());
  });
  it('mantém ARP, move o MAC virtual no switch e recupera ping/HTTP após queda e retorno', () => {
    const { engine, client, lan, a, b, server } = topology();
    ping(engine, client, server);
    const cache = structuredClone(client.arpTable);
    a.power = false;
    engine.advanceTo(engine.state.clock + 4000);
    expect(states(a)).toEqual(['INIT', 'INIT']);
    expect(states(b)).toEqual(['ACTIVE', 'ACTIVE']);
    expect(client.arpTable).toEqual(cache);
    expect(lan.macTable.find((entry) => entry.mac === vrrpMac(10))?.port).toBe('p2');
    ping(engine, client, server);
    engine.httpGet(client.id, server.interfaces[0].ip!);
    engine.advanceTo(engine.state.clock + 500);
    expect(client.tcpConnections!.at(-1)?.received).toContain('HTTP pelo gateway VRRP');
    a.power = true;
    engine.advanceTo(engine.state.clock + 4000);
    expect(states(a)).toEqual(['ACTIVE', 'ACTIVE']);
    expect(states(b)).toEqual(['BACKUP', 'BACKUP']);
    ping(engine, client, server);
    validateSnapshot(engine.snapshot());
  });
  it('preempt desabilitado mantém o ativo de menor prioridade quando o primário retorna', () => {
    const { engine, a, b } = topology();
    a.power = false;
    engine.advanceTo(9000);
    changePriority(engine, a, 150, false);
    a.power = true;
    engine.advanceTo(14000);
    expect(states(a)).toEqual(['BACKUP', 'BACKUP']);
    expect(states(b)).toEqual(['ACTIVE', 'ACTIVE']);
    validateSnapshot(engine.snapshot());
  });
  it('usa prioridade zero no desligamento administrativo para assumir pelo skew time', () => {
    const { engine, a, b } = topology();
    engine.configureVrrp(a.id, { enabled: false, groups: vrrpConfigGroups(a) });
    expect(
      engine.state.events.some(
        (event) => event.frame?.packet?.protocol === 'VRRP' && event.frame.packet.priority === 0
      )
    ).toBe(true);
    engine.advanceTo(5200);
    expect(states(b)).toEqual(['ACTIVE', 'ACTIVE']);
    validateSnapshot(engine.snapshot());
  });
  it('desempata ativos de prioridade igual pelo maior IPv4 físico', () => {
    const { engine, a, b } = topology();
    changePriority(engine, a, 100);
    changePriority(engine, b, 100);
    engine.advanceTo(10000);
    expect(states(a)).toEqual(['BACKUP', 'BACKUP']);
    expect(states(b)).toEqual(['ACTIVE', 'ACTIVE']);
    validateSnapshot(engine.snapshot());
  });
  it('respeita VLAN e perda de anúncios sem consultar a topologia para eleger', () => {
    const { engine, lan, a, b } = topology();
    lan.vlans.push({ id: 20, name: 'isolada' });
    lan.interfaces[2].accessVlan = 20;
    engine.advanceTo(9000);
    expect(states(a)[0]).toBe('ACTIVE');
    expect(states(b)[0]).toBe('ACTIVE');
    expect(states(b)[1]).toBe('BACKUP');
    validateSnapshot(engine.snapshot());
  });
  it('ACL filtra protocolo 112 e a restauração dos anúncios resolve split brain', () => {
    const { engine, a, b } = topology();
    engine.configureAcl(b.id, {
      name: 'CONTROL',
      rules: [
        {
          sequence: 10,
          action: 'deny',
          protocol: 'vrrp',
          source: { network: '0.0.0.0', prefix: 0 },
          destination: { network: '0.0.0.0', prefix: 0 },
        },
        {
          sequence: 20,
          action: 'permit',
          protocol: 'ip',
          source: { network: '0.0.0.0', prefix: 0 },
          destination: { network: '0.0.0.0', prefix: 0 },
        },
      ],
    });
    b.interfaces[0].aclIn = 'CONTROL';
    engine.advanceTo(9000);
    expect(states(b)[0]).toBe('ACTIVE');
    expect(states(a)[0]).toBe('ACTIVE');
    delete b.interfaces[0].aclIn;
    engine.advanceTo(11000);
    expect(states(b)[0]).toBe('BACKUP');
    expect(b.accessLists![0].rules[0].hits).toBeGreaterThan(0);
    validateSnapshot(engine.snapshot());
  });
  it('converge por interface e rotas de apoio após shutdown de uma porta', () => {
    const { engine, client, a, b, server } = topology();
    engine.setPort(a.id, 'p0', false);
    engine.advanceTo(9000);
    expect(states(a)).toEqual(['INIT', 'ACTIVE']);
    expect(states(b)).toEqual(['ACTIVE', 'BACKUP']);
    ping(engine, client, server);
    validateSnapshot(engine.snapshot());
  });
  it('rejeita anúncios com TTL, origem, VIP ou MAC inválidos e aceita intervalo diferente', () => {
    const { engine, b } = topology(),
      group = b.vrrp!.groups[0],
      deadline = group.downAt;
    for (const packet of [
      advert({ ttl: 254 }),
      advert({ src: '192.168.99.2' }),
      advert({ vip: '192.168.10.99' }),
    ])
      receiveVrrp(engine, b, b.interfaces[0], packet, vrrpMac(10));
    receiveVrrp(engine, b, b.interfaces[0], advert(), b.interfaces[0].mac);
    expect(group.downAt).toBe(deadline);
    expect(b.dropped).toBe(4);
    receiveVrrp(engine, b, b.interfaces[0], advert({ advertMs: 500 }), vrrpMac(10));
    expect(group.downAt).toBe(engine.state.clock + 1500 + (156 / 256) * 500);
    validateSnapshot(engine.snapshot());
  });
  it('reserva prioridade 255 ao dono, que inicia imediatamente e atende o VIP local', () => {
    const { engine, client, a, b } = topology();
    engine.configureVrrp(a.id, { enabled: false, groups: [] });
    engine.configureVrrp(b.id, { enabled: false, groups: [] });
    engine.configureVrrp(a.id, {
      enabled: true,
      groups: [{ port: 'p0', vrid: 10, vip: '192.168.10.2', priority: 255 }],
    });
    engine.configureVrrp(b.id, {
      enabled: true,
      groups: [{ port: 'p0', vrid: 10, vip: '192.168.10.2', priority: 100 }],
    });
    expect(states(a)).toEqual(['ACTIVE']);
    const id = engine.ping(client.id, '192.168.10.2');
    engine.advanceTo(5000);
    expect(engine.state.probes.find((probe) => probe.id === id)?.status).toBe('success');
    expect(client.arpTable.find((entry) => entry.ip === '192.168.10.2')?.mac).toBe(vrrpMac(10));
    validateSnapshot(engine.snapshot());
  });
  it('mantém MAC virtual no ARP request do dono e encaminha após sua queda', () => {
    const { engine, client, a, b, server } = topology();
    engine.configureVrrp(a.id, { enabled: false, groups: [] });
    engine.configureVrrp(b.id, { enabled: false, groups: [] });
    const groups = (priority: number) => [
      { port: 'p0', vrid: 10, vip: '192.168.10.2', priority },
      { port: 'p1', vrid: 20, vip: '192.168.20.2', priority },
    ];
    engine.configureVrrp(a.id, { enabled: true, groups: groups(255) });
    engine.configureVrrp(b.id, { enabled: true, groups: groups(100) });
    client.gateway = '192.168.10.2';
    server.gateway = '192.168.20.2';
    engine.ping(a.id, client.interfaces[0].ip!);
    engine.advanceTo(5000);
    expect(client.arpTable.find((row) => row.ip === client.gateway)?.mac).toBe(vrrpMac(10));
    ping(engine, client, server);
    expect(server.arpTable.find((row) => row.ip === server.gateway)?.mac).toBe(vrrpMac(20));
    a.power = false;
    engine.advanceTo(10000);
    ping(engine, client, server);
    validateSnapshot(engine.snapshot());
  });
  it('descarta tráfego dirigido ao VIP de não dono em vez de criar loop de encaminhamento', () => {
    const { engine, client } = topology();
    engine.ping(client.id, client.gateway!);
    engine.advanceTo(5000);
    expect(
      engine.state.events.some((event) => event.reason.includes('IP virtual VRRP não aceita tráfego local'))
    ).toBe(true);
    expect(engine.state.probes.at(-1)?.status).toBe('pending');
  });
  it('persiste eleição/timers e continua deterministicamente; recusa timers órfãos/duplicados', () => {
    const { engine, a } = topology();
    a.power = false;
    engine.advanceTo(5500);
    const snapshot = engine.snapshot(),
      restored = new SimulationEngine(snapshot);
    engine.advanceTo(12000);
    restored.advanceTo(12000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    const duplicate = structuredClone(snapshot);
    duplicate.queue.push(structuredClone(duplicate.queue.find((item) => item.action.kind === 'vrrp-timer')!));
    expect(() => validateSnapshot(duplicate)).toThrow();
    const missing = structuredClone(snapshot);
    missing.queue = missing.queue.filter((item) => item.action.kind !== 'vrrp-timer');
    expect(() => validateSnapshot(missing)).toThrow();
    const orphan = structuredClone(snapshot);
    const action = orphan.queue.find((item) => item.action.kind === 'vrrp-timer')!.action;
    if (action.kind === 'vrrp-timer') action.token = 'orphan';
    expect(() => validateSnapshot(orphan)).toThrow();
  });
  it('valida configuração e mantém grupos não alterados ao editar pelo terminal', () => {
    const { engine, a } = topology();
    const timer = structuredClone(a.vrrp!.groups[1]);
    const cli = new TerminalSession(engine, a.id);
    for (const cmd of [
      'enable',
      'conf t',
      'interface Gi0/1',
      'vrrp 10 priority 160',
      'vrrp 10 advertisement-interval 500',
      'no vrrp 10 preempt',
    ])
      expect(cli.execute(cmd)).toBe('OK');
    expect(engine.device(a.id).vrrp!.groups[1]).toEqual(timer);
    expect(cli.execute('show running-config')).toContain('no vrrp 10 preempt');
    expect(cli.execute('show vrrp')).toContain('00:00:5e:00:01:0a');
    expect(cli.execute('vrrp 10 priority 255')).toMatch(/Erro|Error|%/);
    expect(() =>
      engine.configureVrrp(a.id, { enabled: true, groups: [{ port: 'p0', vrid: 1, vip: '192.168.99.1' }] })
    ).toThrow();
    expect(() =>
      engine.configureVrrp(a.id, { enabled: true, groups: [{ port: 'p0', vrid: 1, vip: '192.168.10.0' }] })
    ).toThrow();
    expect(() =>
      engine.configureVrrp(a.id, {
        enabled: true,
        groups: [{ port: 'p0', vrid: 1, vip: '192.168.10.2', priority: 100 }],
      })
    ).toThrow();
    const groups = vrrpConfigGroups(engine.device(a.id));
    expect(() => engine.configureVrrp(a.id, { enabled: true, groups: [...groups, groups[0]] })).toThrow();
    validateSnapshot(engine.snapshot());
  });
});
