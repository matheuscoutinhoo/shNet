import { describe, it, expect } from 'vitest';
import { evaluateLab, makeLab } from '@shlab/engine';
import { addCanvasItem, groupDevices, moveCanvasItem, removeCanvasItem } from '@shlab/engine';
import { traceNetworkPath, packetPath, deviceParticipatesInVlan } from '@shlab/engine';
import {
  SimulationEngine,
  TerminalSession,
  makeTemplate,
  validateSnapshot,
  subnet,
  dnsRecordSchema,
  tcpPacketSchema,
} from '@shlab/engine';
function probe(e: SimulationEngine, target?: string) {
  const a = e.state.devices[0];
  const dest = target ?? e.state.devices.at(-1)!.interfaces[0].ip!;
  const id = e.ping(a.id, dest);
  e.run();
  return e.state.probes.find((p) => p.id === id)!;
}
describe('contrato TCP', () => {
  it('valida sequência, flags e tamanho real do segmento', () => {
    const packet = {
      src: '192.168.1.10',
      dst: '192.168.1.20',
      ttl: 64,
      protocol: 'TCP',
      sourcePort: 49152,
      destinationPort: 80,
      sequence: 42,
      acknowledgment: 0,
      flags: ['SYN'],
      window: 8192,
      data: '',
      bytes: 40,
    };
    expect(tcpPacketSchema.safeParse(packet).success).toBe(true);
    expect(tcpPacketSchema.safeParse({ ...packet, flags: ['SYN', 'FIN'] }).success).toBe(false);
    expect(tcpPacketSchema.safeParse({ ...packet, flags: ['ACK'], data: 'hello', bytes: 40 }).success).toBe(
      false
    );
    expect(
      tcpPacketSchema.safeParse({ ...packet, flags: ['ACK', 'PSH'], data: 'hello', bytes: 45 }).success
    ).toBe(true);
  });
});
function dhcpLan(leaseMs = 3600000) {
  const engine = new SimulationEngine();
  const client = engine.addDevice('pc');
  const networkSwitch = engine.addDevice('switch');
  const server = engine.addDevice('server');
  Object.assign(server.interfaces[0], { ip: '192.168.50.2', prefix: 24 });
  engine.connect(
    { device: client.id, port: client.interfaces[0].id },
    { device: networkSwitch.id, port: networkSwitch.interfaces[0].id }
  );
  engine.connect(
    { device: server.id, port: server.interfaces[0].id },
    { device: networkSwitch.id, port: networkSwitch.interfaces[1].id }
  );
  engine.configureDhcpPool(server.id, {
    name: 'LAN',
    port: server.interfaces[0].id,
    network: '192.168.50.0',
    prefix: 24,
    start: '192.168.50.10',
    end: '192.168.50.20',
    gateway: '192.168.50.1',
    dns: ['192.168.50.2'],
    leaseMs,
    excluded: ['192.168.50.11'],
  });
  return { engine, client, networkSwitch, server, port: client.interfaces[0] };
}
function redundantLan(mode: 'stp' | 'rstp') {
  const engine = new SimulationEngine();
  const switches = [engine.addDevice('switch'), engine.addDevice('switch'), engine.addDevice('switch')];
  const client = engine.addDevice('pc');
  const target = engine.addDevice('pc');
  Object.assign(client.interfaces[0], { ip: '10.0.0.10', prefix: 24 });
  Object.assign(target.interfaces[0], { ip: '10.0.0.20', prefix: 24 });
  const connect = (left: typeof client, leftPort: number, right: typeof client, rightPort: number) =>
    engine.connect(
      { device: left.id, port: left.interfaces[leftPort].id },
      { device: right.id, port: right.interfaces[rightPort].id }
    );
  connect(client, 0, switches[0], 0);
  connect(target, 0, switches[2], 0);
  connect(switches[0], 1, switches[1], 1);
  const redundant = connect(switches[0], 2, switches[2], 1);
  connect(switches[1], 2, switches[2], 2);
  switches[0].interfaces[0].stpEdge = true;
  switches[2].interfaces[0].stpEdge = true;
  for (const networkSwitch of switches) engine.configureSpanningTree(networkSwitch.id, mode);
  return { engine, switches, client, target, redundant };
}
describe('spanning tree por BPDUs', () => {
  it('não usa acordo rápido em porta half-duplex', () => {
    const { engine, switches } = redundantLan('rstp');
    switches[1].interfaces[1].duplex = 'half';
    engine.configureSpanningTree(switches[1].id, 'rstp');
    engine.advanceTo(100);
    expect(switches[1].interfaces[1].spanningTree?.state).toBe('discarding');
    engine.advanceTo(31000);
    expect(switches[1].interfaces[1].spanningTree?.state).toBe('forwarding');
  });
  it('custo da porta altera o caminho e pode voltar ao valor automático', () => {
    const { engine, switches } = redundantLan('rstp');
    engine.advanceTo(100);
    engine.setSpanningTreePort(switches[2].id, 'p1', { cost: 100 });
    engine.advanceTo(5000);
    expect(switches[2].spanningTree?.rootPort).toBe('p2');
    expect(switches[2].spanningTree?.cost).toBe(8);
    engine.setSpanningTreePort(switches[2].id, 'p1', { cost: undefined });
    engine.advanceTo(10000);
    expect(switches[2].spanningTree?.rootPort).toBe('p1');
    expect(switches[2].spanningTree?.cost).toBe(4);
  });
  it('RSTP usa transição temporizada quando o vizinho fala STP clássico', () => {
    const { engine, switches } = redundantLan('rstp');
    engine.configureSpanningTree(switches[1].id, 'stp');
    engine.advanceTo(100);
    expect(switches[1].interfaces[1].spanningTree?.state).toBe('discarding');
    engine.advanceTo(16000);
    expect(switches[1].interfaces[1].spanningTree?.state).toBe('learning');
    engine.advanceTo(31000);
    expect(switches[1].interfaces[1].spanningTree?.state).toBe('forwarding');
    expect(() => validateSnapshot(engine.snapshot())).not.toThrow();
  });
  it('CLI altera prioridade da raiz e valida timers e portas importadas', () => {
    const { engine, switches } = redundantLan('rstp');
    engine.advanceTo(100);
    const cli = new TerminalSession(engine, switches[2].id);
    for (const command of ['enable', 'configure terminal', 'spanning-tree priority 4096'])
      expect(cli.execute(command)).toBe('OK');
    engine.advanceTo(5000);
    expect(switches.every((device) => device.spanningTree?.root.mac === switches[2].interfaces[0].mac)).toBe(
      true
    );
    expect(cli.execute('show spanning-tree')).toContain('4096.');
    const before = engine.snapshot();
    expect(cli.execute('spanning-tree priority 123')).toMatch(/^%/);
    expect(engine.snapshot()).toEqual(before);
    const broken = engine.snapshot();
    broken.queue = broken.queue.filter(({ action }) => action.kind !== 'stp-hello');
    expect(() => validateSnapshot(broken)).toThrow('Hello');
    const badPort = engine.snapshot();
    const alternate = badPort.devices
      .flatMap((device) => device.interfaces)
      .find((port) => port.spanningTree?.role === 'alternate')!;
    alternate.spanningTree!.state = 'forwarding';
    expect(() => validateSnapshot(badPort)).toThrow('bloqueada');
  });
  it('RSTP elege root, bloqueia redundância e mantém conectividade', () => {
    const { engine, switches, client } = redundantLan('rstp');
    engine.advanceTo(100);
    expect(switches.every((device) => device.spanningTree?.root.mac === switches[0].interfaces[0].mac)).toBe(
      true
    );
    expect(switches[2].interfaces[2].spanningTree).toMatchObject({ role: 'alternate', state: 'discarding' });
    const probeId = engine.ping(client.id, '10.0.0.20');
    engine.advanceTo(200);
    expect(engine.state.probes.find((probe) => probe.id === probeId)?.status).toBe('success');
    expect(engine.state.events.some((event) => event.type === 'BPDU_RECEIVED')).toBe(true);
    expect(() => validateSnapshot(engine.snapshot())).not.toThrow();
  });
  it('RSTP promove alternate após falha e reconverge ao restaurar o link', () => {
    const { engine, switches, client, redundant } = redundantLan('rstp');
    engine.advanceTo(100);
    redundant.up = false;
    engine.advanceTo(200);
    expect(switches[2].interfaces[2].spanningTree).toMatchObject({ role: 'root', state: 'forwarding' });
    const probeId = engine.ping(client.id, '10.0.0.20');
    engine.advanceTo(300);
    expect(engine.state.probes.find((probe) => probe.id === probeId)?.status).toBe('success');
    redundant.up = true;
    engine.advanceTo(5000);
    expect(switches[2].interfaces[2].spanningTree).toMatchObject({ role: 'alternate', state: 'discarding' });
  });
  it('STP clássico passa por learning e preserva timers ao restaurar', () => {
    const { engine, switches, client } = redundantLan('stp');
    engine.advanceTo(100);
    expect(switches[1].interfaces[1].spanningTree?.state).toBe('discarding');
    engine.advanceTo(16000);
    expect(switches[1].interfaces[1].spanningTree?.state).toBe('learning');
    const restored = new SimulationEngine(engine.snapshot());
    engine.advanceTo(31000);
    restored.advanceTo(31000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(switches[1].interfaces[1].spanningTree?.state).toBe('forwarding');
    const probeId = engine.ping(client.id, '10.0.0.20');
    engine.advanceTo(31100);
    expect(engine.state.probes.find((probe) => probe.id === probeId)?.status).toBe('success');
  });
});
describe('DNS sobre a rede simulada', () => {
  it('mantém snapshots válidos com nomes DNS no limite de 253 caracteres', () => {
    const engine = new SimulationEngine(makeTemplate('dns'));
    const name = [63, 63, 63, 61].map((length) => 'a'.repeat(length)).join('.');
    const client = engine.state.devices[0];
    const server = engine.state.devices.find((device) => device.dnsServer)!;
    engine.configureDnsRecord(server.id, { name, type: 'A', value: '192.168.50.2', ttl: 60 });
    engine.lookupDns(client.id, name);
    expect(() => validateSnapshot(engine.snapshot())).not.toThrow();
    engine.advanceTo(300);
    expect(client.dnsQueries?.at(-1)).toMatchObject({
      status: 'success',
      transport: 'tcp',
      tcpFallback: true,
    });
    expect(() => validateSnapshot(engine.snapshot())).not.toThrow();
  });
  it('ignora resposta com ID adulterado e aceita a retransmissão legítima', () => {
    const engine = new SimulationEngine(makeTemplate('dns'));
    const client = engine.state.devices[0];
    engine.lookupDns(client.id, 'server.lab');
    let altered = false;
    for (let step = 0; step < 32 && !altered; step++) {
      engine.step();
      for (const { action } of engine.state.queue) {
        if (
          action.kind === 'deliver' &&
          action.frame.packet?.protocol === 'UDP' &&
          action.frame.packet.payload.protocol === 'DNS' &&
          action.frame.packet.payload.message.type === 'response'
        ) {
          action.frame.packet.payload.message.transactionId =
            (action.frame.packet.payload.message.transactionId + 1) % 65536;
          altered = true;
        }
      }
    }
    expect(altered).toBe(true);
    engine.advanceTo(400);
    expect(client.dnsQueries?.at(-1)?.status).toBe('pending');
    expect(client.dnsCache?.length ?? 0).toBe(0);
    engine.advanceTo(6000);
    expect(client.dnsQueries?.at(-1)).toMatchObject({ status: 'success', attempts: 2 });
  });
  it('não ultrapassa VLANs e recupera a consulta após corrigir a porta', () => {
    const engine = new SimulationEngine(makeTemplate('dns'));
    const client = engine.state.devices[0];
    const networkSwitch = engine.state.devices.find((device) => device.type === 'switch')!;
    networkSwitch.vlans.push({ id: 20, name: 'ISOLATED' });
    networkSwitch.interfaces[0].accessVlan = 20;
    engine.lookupDns(client.id, 'server.lab');
    engine.advanceTo(11000);
    expect(client.dnsQueries?.at(-1)?.status).toBe('timeout');
    networkSwitch.interfaces[0].accessVlan = 1;
    engine.lookupDns(client.id, 'server.lab');
    engine.advanceTo(11100);
    expect(client.dnsQueries?.at(-1)?.status).toBe('success');
  });
  it('sinaliza TC sem usar resposta UDP maior que 512 bytes', () => {
    const engine = new SimulationEngine(makeTemplate('dns'));
    const client = engine.state.devices[0];
    const server = engine.state.devices.find((device) => device.dnsServer)!;
    for (let index = 1; index <= 32; index++)
      engine.configureDnsRecord(server.id, {
        name: 'large.lab',
        type: 'A',
        value: '192.168.60.' + index,
        ttl: 60,
      });
    engine.lookupDns(client.id, 'large.lab', 'A', undefined, undefined, 'udp');
    engine.advanceTo(300);
    expect(client.dnsQueries?.at(-1)).toMatchObject({ status: 'truncated', answers: [] });
    expect(client.dnsCache?.length ?? 0).toBe(0);
  });
  it('configura DNS pela CLI, consulta localmente e rejeita alterações inválidas atomicamente', () => {
    const engine = new SimulationEngine();
    const server = engine.addDevice('server');
    Object.assign(server.interfaces[0], { ip: '10.0.0.2', prefix: 24 });
    const cli = new TerminalSession(engine, server.id);
    for (const command of [
      'enable',
      'configure terminal',
      'service dns',
      'dns record server.lab A 10.0.0.2 ttl 60',
      'interface Eth0',
      'ip name-server 10.0.0.2',
      'end',
    ])
      expect(cli.execute(command)).toBe('OK');
    expect(cli.execute('nslookup server.lab')).toContain('success');
    expect(cli.execute('show dns records')).toContain('server.lab 60 IN A 10.0.0.2');
    expect(cli.execute('show dns cache')).toContain('TTL=60s');
    expect(cli.execute('show running-config')).toContain('ip name-server 10.0.0.2');
    cli.execute('configure terminal');
    const before = engine.snapshot();
    expect(cli.execute('dns record server.lab CNAME other.lab')).toMatch(/^%/);
    expect(engine.snapshot()).toEqual(before);
    expect(cli.execute('nslookup server.lab; whoami')).toMatch(/^%/);
    expect(cli.execute('clear dns cache')).toBe('OK');
    expect(cli.execute('show dns cache')).toBe('Cache DNS vazio');
  });
  it('consulta um DNS em outra subnet usando rotas e ARP', () => {
    const engine = new SimulationEngine(makeTemplate('routed'));
    const client = engine.state.devices[0];
    const server = engine.state.devices.at(-1)!;
    engine.setDnsServers(client.id, client.interfaces[0].id, [server.interfaces[0].ip!]);
    engine.configureDnsRecord(server.id, { name: 'remote.lab', type: 'A', value: '192.168.20.10', ttl: 60 });
    engine.lookupDns(client.id, 'remote.lab');
    engine.advanceTo(300);
    expect(client.dnsQueries?.at(-1)?.status).toBe('success');
    expect(
      engine.state.events.some(
        (event) => event.frame?.packet?.protocol === 'UDP' && event.frame.packet.ttl === 63
      )
    ).toBe(true);
    expect(client.arpTable.some((entry) => entry.ip === '192.168.10.1')).toBe(true);
  });
  it('usa servidor alternativo e rejeita snapshots sem timer ou com cache adulterado', () => {
    const { engine, client, server, port } = dhcpLan();
    engine.configureDhcpPool(server.id, {
      ...server.dhcpServer!.pools[0],
      dns: ['192.168.50.99', '192.168.50.2'],
    });
    engine.configureDnsRecord(server.id, { name: 'server.lab', type: 'A', value: '192.168.50.2', ttl: 60 });
    engine.requestDhcp(client.id, port.id);
    engine.advanceTo(100);
    engine.lookupDns(client.id, 'server.lab');
    const missingTimer = engine.snapshot();
    missingTimer.queue = missingTimer.queue.filter(({ action }) => action.kind !== 'dns-timeout');
    expect(() => validateSnapshot(missingTimer)).toThrow('timer');
    engine.advanceTo(11000);
    expect(client.dnsQueries?.at(-1)).toMatchObject({
      status: 'success',
      server: '192.168.50.2',
      attempts: 3,
    });
    const poisoned = engine.snapshot();
    poisoned.devices[0].dnsCache![0].answers[0].name = 'unrelated.lab';
    expect(() => validateSnapshot(poisoned)).toThrow('Cache DNS');
    expect(() => validateSnapshot(engine.snapshot())).not.toThrow();
  });
  it('usa DNS fornecido por DHCP, resolve CNAME/A/AAAA e respeita TTL', () => {
    const { engine, client, server, port } = dhcpLan();
    engine.configureDnsRecord(server.id, { name: 'server.lab', type: 'A', value: '192.168.50.2', ttl: 60 });
    engine.configureDnsRecord(server.id, { name: 'server.lab', type: 'AAAA', value: '2001:db8::2', ttl: 60 });
    engine.configureDnsRecord(server.id, { name: 'alias.lab', type: 'CNAME', value: 'server.lab', ttl: 10 });
    engine.requestDhcp(client.id, port.id);
    engine.advanceTo(100);
    const queryId = engine.lookupDns(client.id, 'ALIAS.LAB.');
    const restored = new SimulationEngine(engine.snapshot());
    engine.advanceTo(200);
    restored.advanceTo(200);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(client.dnsQueries?.find((query) => query.id === queryId)).toMatchObject({
      status: 'success',
      answers: [
        { type: 'CNAME', value: 'server.lab' },
        { type: 'A', value: '192.168.50.2' },
      ],
    });
    const transmissions = engine.state.events.filter((event) => event.type === 'DNS_QUERY').length;
    const cached = engine.lookupDns(client.id, 'alias.lab');
    expect(client.dnsQueries?.find((query) => query.id === cached)?.fromCache).toBe(true);
    expect(engine.state.events.filter((event) => event.type === 'DNS_QUERY')).toHaveLength(transmissions);
    engine.advanceTo(11000);
    expect(client.dnsCache).toHaveLength(0);
    const ipv6 = engine.lookupDns(client.id, 'server.lab', 'AAAA');
    engine.advanceTo(11100);
    expect(client.dnsQueries?.find((query) => query.id === ipv6)).toMatchObject({
      status: 'success',
      answers: [{ value: '2001:db8::2' }],
    });
    expect(() => validateSnapshot(engine.snapshot())).not.toThrow();
  });
  it('distingue NXDOMAIN, NODATA e loop CNAME sem consultar DNS real', () => {
    const { engine, client, server, port } = dhcpLan();
    engine.configureDnsRecord(server.id, { name: 'only-a.lab', type: 'A', value: '192.168.50.2', ttl: 0 });
    engine.configureDnsRecord(server.id, { name: 'a.lab', type: 'CNAME', value: 'b.lab', ttl: 10 });
    engine.configureDnsRecord(server.id, { name: 'b.lab', type: 'CNAME', value: 'a.lab', ttl: 10 });
    engine.requestDhcp(client.id, port.id);
    engine.advanceTo(100);
    const missing = engine.lookupDns(client.id, 'missing.lab');
    const noData = engine.lookupDns(client.id, 'only-a.lab', 'AAAA');
    const loop = engine.lookupDns(client.id, 'a.lab');
    engine.advanceTo(300);
    expect(client.dnsQueries?.find((query) => query.id === missing)?.status).toBe('nxdomain');
    expect(client.dnsQueries?.find((query) => query.id === noData)?.status).toBe('nodata');
    expect(client.dnsQueries?.find((query) => query.id === loop)?.status).toBe('servfail');
    expect(() =>
      engine.configureDnsRecord(server.id, { name: 'a.lab', type: 'A', value: '192.168.50.20', ttl: 20 })
    ).toThrow('CNAME');
  });
  it('resolve nomes antes do ping e falha quando o serviço DNS é desligado', () => {
    const { engine, client, server, port } = dhcpLan();
    engine.configureDnsRecord(server.id, { name: 'server.lab', type: 'A', value: '192.168.50.2', ttl: 0 });
    engine.requestDhcp(client.id, port.id);
    engine.advanceTo(100);
    const query = engine.ping(client.id, 'server.lab');
    engine.advanceTo(300);
    const probeId = client.dnsQueries?.find((entry) => entry.id === query)?.probeId;
    expect(engine.state.probes.find((probe) => probe.id === probeId)?.status).toBe('success');
    engine.setDnsEnabled(server.id, false);
    const failed = engine.lookupDns(client.id, 'server.lab');
    engine.advanceTo(11000);
    expect(client.dnsQueries?.find((entry) => entry.id === failed)?.status).toBe('timeout');
  });
});
describe('comportamento real da rede', () => {
  it('ACL de saída também filtra DHCP transmitido diretamente como frame', () => {
    const { engine, client, server, port } = dhcpLan();
    const range = { network: '0.0.0.0', prefix: 0 };
    engine.configureAcl(client.id, {
      name: 'NO-DHCP',
      rules: [
        {
          sequence: 10,
          action: 'deny',
          protocol: 'udp',
          source: range,
          destination: range,
          destinationPort: 67,
        },
      ],
    });
    engine.bindAcl(client.id, port.id, 'out', 'NO-DHCP');
    engine.requestDhcp(client.id, port.id);
    engine.advanceTo(61000);
    expect(port.dhcp?.status).toBe('failed');
    expect(server.dhcpServer?.bindings).toHaveLength(0);
    expect(client.accessLists![0].rules[0].hits).toBe(4);
  });
  it('reconstrói o caminho por eventos reais e inclui hosts no destaque de VLAN', () => {
    const engine = new SimulationEngine(makeTemplate('routed'));
    const id = traceNetworkPath(engine, engine.state.devices[0].id, engine.state.devices.at(-1)!.id);
    const hops = packetPath(engine.state, id);
    expect(hops.some((hop) => hop.hostname === 'R-EDGE-01' && hop.ttl === 63)).toBe(true);
    expect(hops.some((hop) => hop.kind === 'echo-reply')).toBe(true);
    const vlan = makeTemplate('vlan');
    expect(deviceParticipatesInVlan(vlan, vlan.devices[0].id, 10)).toBe(true);
    expect(deviceParticipatesInVlan(vlan, vlan.devices[0].id, 20)).toBe(false);
  });
  it('persiste anotações e move grupos sem modificar a conectividade', () => {
    const engine = new SimulationEngine(makeTemplate('lan'));
    addCanvasItem(engine, {
      kind: 'note',
      text: 'LAN',
      position: { x: 20, y: 20 },
      width: 200,
      height: 100,
      color: 'lime',
    });
    const members = engine.state.devices.slice(0, 2).map((device) => device.id);
    const original = structuredClone(engine.device(members[0]).position);
    const group = groupDevices(engine, members);
    moveCanvasItem(engine, group.id, { x: group.position.x + 100, y: group.position.y + 50 });
    expect(engine.device(members[0]).position).toEqual({ x: original.x + 100, y: original.y + 50 });
    expect(probe(engine).status).toBe('success');
    expect(new SimulationEngine(engine.snapshot()).snapshot()).toEqual(engine.snapshot());
    removeCanvasItem(engine, group.id, true);
    expect(engine.state.devices).toHaveLength(3);
    expect(engine.state.canvasItems).toHaveLength(1);
  });
  it.each(['ospf', 'rip'] as const)(
    'avalia com %s recém-convergido após queda de um caminho aprendido',
    (template) => {
      const engine = new SimulationEngine(makeTemplate(template));
      engine.advanceTo(20000);
      engine.state.links[template === 'ospf' ? 0 : 2].up = false;
      const snapshot = engine.snapshot();
      const evaluation = evaluateLab('routing-repair', snapshot);
      expect(evaluation.tasks.find((task) => task.id === 'ping')?.passed).toBe(true);
      expect(snapshot).toEqual(engine.snapshot());
    }
  );
  it('avalia labs com tráfego novo sem alterar o snapshot do usuário', () => {
    const working = makeTemplate('lan');
    const before = structuredClone(working);
    expect(evaluateLab('lan-foundations', working).complete).toBe(true);
    expect(working).toEqual(before);
    expect(evaluateLab('lan-foundations', makeTemplate('empty')).complete).toBe(false);
    expect(evaluateLab('routing-repair', makeLab('routing-repair')).complete).toBe(false);
    expect(evaluateLab('rstp-failover', makeLab('rstp-failover')).complete).toBe(true);
  });
  it.each([
    { helloMs: 10000, deadMs: 40000 },
    { helloMs: 60000, deadMs: 240000 },
  ])(
    'aguarda DR/BDR com Hello $helloMs e Dead $deadMs na avaliação OSPF broadcast',
    ({ helloMs, deadMs }) => {
      const engine = new SimulationEngine(makeTemplate('ospf'));
      for (const router of engine.state.devices.filter((device) => device.ospf))
        engine.configureOspf(router.id, {
          enabled: true,
          routerId: router.ospf!.routerId,
          interfaces: router.ospf!.interfaces.map((port) => ({
            ...port,
            helloMs,
            deadMs,
            networkType: port.passive ? port.networkType : 'broadcast',
          })),
        });
      engine.advanceTo(deadMs + helloMs + 1000);
      const snapshot = engine.snapshot();
      expect(evaluateLab('routing-repair', snapshot).tasks.find((task) => task.id === 'ping')?.passed).toBe(
        true
      );
      expect(engine.snapshot()).toEqual(snapshot);
    }
  );
  it('lab NAT exige tradução observada e bloqueio DNS de verdade', () => {
    const engine = new SimulationEngine(makeLab('nat-boundary'));
    const router = engine.state.devices.find((device) => device.type === 'router')!;
    const cli = new TerminalSession(engine, router.id);
    for (const command of [
      'enable',
      'configure terminal',
      'ip nat pool WAN 192.168.10.0/24 192.168.20.100 192.168.20.100 overload',
      'access-list FILTER 10 permit icmp any any',
      'interface Gi0/1',
      'ip access-group FILTER in',
    ])
      expect(cli.execute(command)).toBe('OK');
    const result = evaluateLab('nat-boundary', engine.snapshot());
    expect(result.complete).toBe(true);
    expect(result.tasks.find((task) => task.id === 'translated')?.passed).toBe(true);
    expect(engine.state.probes).toHaveLength(0);
  });
  it('CLI configura PAT para consultas DNS UDP e ACL por porta', () => {
    const engine = new SimulationEngine(makeTemplate('routed'));
    const client = engine.state.devices[0];
    const router = engine.state.devices.find((device) => device.type === 'router')!;
    const target = engine.state.devices.at(-1)!;
    delete target.gateway;
    engine.configureDnsRecord(target.id, {
      name: 'outside.lab',
      type: 'A',
      value: target.interfaces[0].ip!,
      ttl: 0,
    });
    engine.setDnsServers(client.id, client.interfaces[0].id, [target.interfaces[0].ip!]);
    const cli = new TerminalSession(engine, router.id);
    for (const command of [
      'enable',
      'configure terminal',
      'interface Gi0/1',
      'ip nat inside',
      'interface Gi0/2',
      'ip nat outside',
      'exit',
      'ip nat pool WAN 192.168.10.0/24 192.168.20.100 192.168.20.100 overload',
      'access-list DNS 10 permit udp any any eq 53',
      'interface Gi0/1',
      'ip access-group DNS in',
    ])
      expect(cli.execute(command)).toBe('OK');
    const lookup = engine.lookupDns(client.id, 'outside.lab');
    engine.advanceTo(200);
    expect(client.dnsQueries?.find((query) => query.id === lookup)?.status).toBe('success');
    expect(router.nat!.bindings[0].protocol).toBe('UDP');
    expect(cli.execute('show access-lists')).toContain('hits=1');
    expect(cli.execute('show ip nat translations')).toContain('192.168.20.100');
    expect(() => validateSnapshot(engine.snapshot())).not.toThrow();
    const bad = engine.snapshot();
    bad.devices.find((device) => device.type === 'router')!.nat!.bindings[0].globalToken = 'invalid';
    expect(() => validateSnapshot(bad)).toThrow('Portas PAT');
  });
  it.each(['static', 'dynamic', 'pat'] as const)(
    'NAT %s permite ida e retorno sem rota remota para a rede interna',
    (mode) => {
      const engine = new SimulationEngine(makeTemplate('routed'));
      const client = engine.state.devices[0];
      const router = engine.state.devices.find((device) => device.type === 'router')!;
      const target = engine.state.devices.at(-1)!;
      delete target.gateway;
      router.interfaces[0].natRole = 'inside';
      router.interfaces[1].natRole = 'outside';
      engine.configureNat(router.id, {
        enabled: true,
        statics:
          mode === 'static'
            ? [{ inside: '192.168.10.10', global: '192.168.20.100', outside: router.interfaces[1].id }]
            : [],
        pools:
          mode === 'static'
            ? []
            : [
                {
                  name: 'OUT',
                  source: { network: '192.168.10.0', prefix: 24 },
                  outside: router.interfaces[1].id,
                  start: '192.168.20.100',
                  end: '192.168.20.100',
                  overload: mode === 'pat',
                },
              ],
      });
      const id = engine.ping(client.id, target.interfaces[0].ip!);
      engine.advanceTo(200);
      expect(engine.state.probes.find((probe) => probe.id === id)?.status).toBe('success');
      expect(engine.state.events.some((event) => event.frame?.packet?.src === '192.168.20.100')).toBe(true);
      expect(() => validateSnapshot(engine.snapshot())).not.toThrow();
      const restored = new SimulationEngine(engine.snapshot());
      engine.advanceTo(130000);
      restored.advanceTo(130000);
      expect(restored.snapshot()).toEqual(engine.snapshot());
      expect(router.nat?.bindings).toHaveLength(0);
    }
  );
  it('ACL ordenada bloqueia, conta e libera tráfego entre sub-redes', () => {
    const engine = new SimulationEngine(makeTemplate('routed'));
    const router = engine.state.devices.find((device) => device.type === 'router')!;
    const any = { network: '0.0.0.0', prefix: 0 };
    engine.configureAcl(router.id, {
      name: 'FILTER',
      rules: [
        { sequence: 20, action: 'permit', protocol: 'ip', source: any, destination: any },
        { sequence: 10, action: 'deny', protocol: 'icmp', source: any, destination: any },
      ],
    });
    engine.bindAcl(router.id, router.interfaces[0].id, 'in', 'FILTER');
    expect(probe(engine).status).toBe('timeout');
    expect(router.accessLists![0].rules[0].hits).toBeGreaterThan(0);
    expect(
      engine.state.events.some((event) => event.type === 'ACL_DENY' && event.reason.includes('regra 10'))
    ).toBe(true);
    engine.configureAcl(router.id, {
      name: 'FILTER',
      rules: [{ sequence: 10, action: 'permit', protocol: 'icmp', source: any, destination: any }],
    });
    expect(probe(engine).status).toBe('success');
    expect(() => engine.removeAcl(router.id, 'FILTER')).toThrow('interfaces');
    expect(() => validateSnapshot(engine.snapshot())).not.toThrow();
  });
  it('STP bloqueia dados e distingue discarding de learning na tabela MAC', () => {
    const engine = new SimulationEngine(makeTemplate('lan'));
    const networkSwitch = engine.state.devices.find((device) => device.type === 'switch')!;
    networkSwitch.interfaces[0].spanningTree = { role: 'designated', state: 'discarding' };
    expect(probe(engine).status).toBe('timeout');
    expect(networkSwitch.macTable).toHaveLength(0);
    networkSwitch.interfaces[0].spanningTree.state = 'learning';
    expect(probe(engine).status).toBe('timeout');
    expect(networkSwitch.macTable.length).toBeGreaterThan(0);
    networkSwitch.interfaces[0].spanningTree.state = 'forwarding';
    networkSwitch.interfaces[1].spanningTree = { role: 'alternate', state: 'discarding' };
    expect(probe(engine).status).toBe('timeout');
    networkSwitch.interfaces[1].spanningTree = { role: 'designated', state: 'forwarding' };
    expect(probe(engine).status).toBe('success');
  });
  it('valida registros DNS e normaliza nomes sem confundir AAAA com tráfego IPv6', () => {
    expect(
      dnsRecordSchema.parse({ name: 'SERVER.Lab.', type: 'A', value: '192.168.50.20', ttl: 60 })
    ).toEqual({ name: 'server.lab', type: 'A', value: '192.168.50.20', ttl: 60 });
    expect(
      dnsRecordSchema.parse({ name: 'alias.lab', type: 'CNAME', value: 'SERVER.Lab.', ttl: 30 }).value
    ).toBe('server.lab');
    expect(
      dnsRecordSchema.safeParse({ name: 'server.lab', type: 'AAAA', value: '2001:db8::20', ttl: 60 }).success
    ).toBe(true);
    for (const record of [
      { name: '-invalid.lab', type: 'A', value: '192.168.50.20', ttl: 60 },
      { name: 'server.lab', type: 'A', value: '999.0.0.1', ttl: 60 },
      { name: 'server.lab', type: 'AAAA', value: '192.168.50.20', ttl: 60 },
      { name: 'server.lab', type: 'CNAME', value: 'bad..lab', ttl: 60 },
      { name: 'server.lab', type: 'A', value: '192.168.50.20', ttl: -1 },
    ])
      expect(dnsRecordSchema.safeParse(record).success).toBe(false);
  });
  it('preserva um datagrama DHCP/UDP pendente ao restaurar o snapshot', () => {
    const engine = new SimulationEngine(makeTemplate('lan'));
    const client = engine.state.devices[0];
    const port = client.interfaces[0];
    engine.sendFrame(client.id, port.id, {
      src: port.mac,
      dst: 'ff:ff:ff:ff:ff:ff',
      etherType: 'IPv4',
      hops: 32,
      packet: {
        src: '0.0.0.0',
        dst: '255.255.255.255',
        ttl: 64,
        protocol: 'UDP',
        sourcePort: 68,
        destinationPort: 67,
        bytes: 328,
        payload: {
          protocol: 'DHCP',
          message: {
            type: 'discover',
            transactionId: 'dhcp-1',
            clientMac: port.mac,
            clientIp: '0.0.0.0',
          },
        },
      },
    });
    expect(engine.state.queue).not.toHaveLength(0);
    expect(new SimulationEngine(engine.snapshot()).snapshot()).toEqual(engine.snapshot());
  });
  it('ARP broadcast, aprendizado MAC e Echo Reply atravessam uma LAN', () => {
    const e = new SimulationEngine(makeTemplate('lan'));
    expect(probe(e).status).toBe('success');
    const sw = e.state.devices.find((d) => d.type === 'switch')!;
    expect(sw.macTable).toHaveLength(2);
    expect(e.state.devices[0].arpTable[0].ip).toBe('192.168.10.20');
    expect(e.state.events.some((v) => v.type === 'FRAME_FLOODED')).toBe(true);
  });
  it('persiste configuração DHCP e recusa intervalos e interfaces incompatíveis', () => {
    const engine = new SimulationEngine();
    const server = engine.addDevice('server');
    const port = server.interfaces[0];
    const pool = {
      name: 'LAN',
      port: port.id,
      network: '192.168.50.0',
      prefix: 24,
      start: '192.168.50.10',
      end: '192.168.50.20',
      gateway: '192.168.50.1',
      dns: ['192.168.50.2'],
      leaseMs: 3600000,
      excluded: ['192.168.50.11'],
    };
    expect(() => engine.configureDhcpPool(server.id, pool)).toThrow('IPv4 estático');
    Object.assign(port, { ip: '192.168.50.2', prefix: 24 });
    engine.configureDhcpPool(server.id, pool);
    expect(new SimulationEngine(engine.snapshot()).snapshot()).toEqual(engine.snapshot());
    expect(() => engine.configureDhcpPool(server.id, { ...pool, end: '192.168.50.255' })).toThrow('host');
    expect(() => engine.configureDhcpPool(server.id, { ...pool, start: '192.168.50.21' })).toThrow(
      'intervalo'
    );
    expect(() => engine.configureDhcpPool(server.id, { ...pool, name: 'DUPLICATE' })).toThrow('sobrepostos');
    expect(server.dhcpServer?.pools).toHaveLength(1);
  });
  it('roteia PC → SW → R → SW → server e decrementa TTL', () => {
    const e = new SimulationEngine(makeTemplate('routed'));
    expect(probe(e).status).toBe('success');
    expect(e.state.events.some((v) => v.frame?.packet?.ttl === 63)).toBe(true);
    expect(e.state.devices[0].arpTable[0].ip).toBe('192.168.10.1');
  });
  it('rotas estáticas exigem caminho de retorno', () => {
    const e = new SimulationEngine(makeTemplate('static'));
    e.state.devices.find((d) => d.hostname === 'R-02')!.routes = [];
    expect(probe(e).status).toBe('timeout');
  });
  it('rotas estáticas alcançam a rede remota', () => {
    expect(probe(new SimulationEngine(makeTemplate('static'))).status).toBe('success');
  });
  it('trunk transporta tag VLAN e allowed VLAN bloqueia de fato', () => {
    const e = new SimulationEngine(makeTemplate('vlan'));
    expect(probe(e).status).toBe('success');
    expect(e.state.events.some((v) => v.frame?.vlan === 10)).toBe(true);
    e.state.devices.find((d) => d.hostname === 'SW-02')!.interfaces[1].allowedVlans = [1];
    expect(probe(e).status).toBe('timeout');
  });
  it('access VLAN diferente isola hosts', () => {
    const e = new SimulationEngine(makeTemplate('lan'));
    const s = e.state.devices.find((d) => d.type === 'switch')!;
    s.vlans.push({ id: 20, name: 'SERVERS' });
    s.interfaces[1].accessVlan = 20;
    expect(probe(e).status).toBe('timeout');
  });
  it('CLI altera estado: shutdown falha e no shutdown restaura', () => {
    const e = new SimulationEngine(makeTemplate('routed'));
    const r = e.state.devices.find((d) => d.type === 'router')!;
    const cli = new TerminalSession(e, r.id);
    for (const cmd of ['enable', 'configure terminal', 'interface GigabitEthernet 0/2', 'shutdown'])
      expect(cli.execute(cmd)).toBe('OK');
    expect(probe(e).status).toBe('unreachable');
    cli.execute('no shutdown');
    expect(probe(e).status).toBe('success');
  });
  it('recusa configuração inválida e shell injection', () => {
    const e = new SimulationEngine(makeTemplate('lan')),
      cli = new TerminalSession(e, e.state.devices[0].id);
    for (const cmd of ['enable', 'conf t', 'interface Eth0']) cli.execute(cmd);
    expect(cli.execute('ip address 999.1.1.1/24')).toMatch(/^%/);
    expect(cli.execute('ping 1.1.1.1; whoami')).toMatch(/^%/);
    expect(cli.execute('ip address 10.0.0.0/24')).toMatch(/^%/);
  });
  it('mantém determinismo e restaura fila pendente', () => {
    const a = new SimulationEngine(makeTemplate('routed'));
    a.ping(a.state.devices[0].id, '192.168.20.10');
    a.step();
    const b = new SimulationEngine(a.snapshot());
    a.run();
    b.run();
    expect(b.snapshot()).toEqual(a.snapshot());
  });
  it('aging depende do relógio virtual', () => {
    const e = new SimulationEngine(makeTemplate('lan'));
    probe(e);
    e.schedule(400000, { kind: 'probe-timeout', probeId: e.state.probes[0].id });
    e.run();
    expect(e.state.devices.every((d) => d.macTable.length === 0 && d.arpTable.length === 0)).toBe(true);
  });
  it('valida cabos e referências importadas', () => {
    const e = new SimulationEngine(makeTemplate('lan'));
    expect(() =>
      e.connect({ device: e.state.devices[0].id, port: 'p0' }, { device: e.state.devices[1].id, port: 'p2' })
    ).toThrow('utilizada');
    const s = e.snapshot();
    s.links[0].b.port = 'missing';
    expect(() => validateSnapshot(s)).toThrow();
  });
  it('perda 100% no cabo causa timeout', () => {
    const e = new SimulationEngine(makeTemplate('lan'));
    e.state.links[0].loss = 1;
    expect(probe(e).status).toBe('timeout');
  });
  it('TTL expirado produz resposta ICMP real de um router', () => {
    const e = new SimulationEngine(makeTemplate('routed'));
    const id = e.ping(e.state.devices[0].id, '192.168.20.10', 1);
    e.run();
    expect(e.state.probes.find((p) => p.id === id)?.status).toBe('time-exceeded');
  });
  it('calcula corretamente /0, /24, /31 e /32', () => {
    expect(subnet('192.168.10.10', 24)).toMatchObject({
      network: '192.168.10.0',
      broadcast: '192.168.10.255',
    });
    expect(subnet('1.2.3.4', 0).broadcast).toBe('255.255.255.255');
    expect(subnet('10.0.0.0', 31).last).toBe('10.0.0.1');
    expect(subnet('10.0.0.1', 32).first).toBe('10.0.0.1');
  });
});

describe('DHCP sobre UDP e Ethernet', () => {
  it('configura pools e cliente pela CLI, consulta leases e retorna ao IPv4 estático', () => {
    const { engine, client, server, port } = dhcpLan();
    engine.removeDhcpPool(server.id, 'LAN');
    const serverCli = new TerminalSession(engine, server.id);
    for (const command of [
      'enable',
      'configure terminal',
      'ip dhcp pool USERS interface Eth0',
      'network 192.168.50.0/24',
      'range 192.168.50.10 192.168.50.12',
      'default-router 192.168.50.1',
      'dns-server 192.168.50.2',
      'excluded-address 192.168.50.11',
      'lease 20',
    ]) {
      expect(serverCli.execute(command)).toBe('OK');
    }
    expect(serverCli.prompt).toContain('(config-dhcp)#');
    expect(serverCli.execute('show ip dhcp pool')).toContain('free=2');
    expect(serverCli.execute('show running-config')).toContain('lease 20');
    const clientCli = new TerminalSession(engine, client.id);
    for (const command of ['enable', 'configure terminal', 'interface Eth0'])
      expect(clientCli.execute(command)).toBe('OK');
    expect(clientCli.execute('ip address dhcp')).toContain('DHCP iniciado');
    engine.advanceTo(100);
    expect(clientCli.execute('show dhcp lease')).toContain('192.168.50.10/24');
    expect(clientCli.execute('show ip route')).toContain('D 0.0.0.0/0 via 192.168.50.1');
    expect(clientCli.execute('show running-config')).toContain('ip address dhcp');
    expect(serverCli.execute('show ip dhcp binding')).toContain('bound');
    expect(clientCli.execute('ip dhcp renew')).toBe('OK');
    engine.advanceTo(200);
    expect(clientCli.execute('ip address 192.168.50.30/24')).toBe('OK');
    engine.advanceTo(300);
    expect(engine.device(client.id).interfaces[0]).toMatchObject({ ip: '192.168.50.30', ipv4Mode: 'static' });
    expect(engine.device(client.id).interfaces[0].dhcp).toBeUndefined();
    expect(engine.device(server.id).dhcpServer?.bindings).toHaveLength(0);
    expect(port.ip).toBe('192.168.50.30');
    serverCli.execute('exit');
    serverCli.execute('interface Eth0');
    const before = engine.snapshot();
    expect(serverCli.execute('ip address 10.99.0.2/24')).toMatch(/^%/);
    expect(engine.snapshot()).toEqual(before);
  });

  it('usa o gateway recebido para alcançar outra subnet', () => {
    const { engine, client, networkSwitch, port } = dhcpLan();
    client.gateway = '192.168.50.254';
    const router = engine.addDevice('router');
    const remote = engine.addDevice('pc');
    Object.assign(router.interfaces[0], { ip: '192.168.50.1', prefix: 24 });
    Object.assign(router.interfaces[1], { ip: '10.20.0.1', prefix: 24 });
    Object.assign(remote.interfaces[0], { ip: '10.20.0.10', prefix: 24 });
    remote.gateway = '10.20.0.1';
    engine.connect(
      { device: router.id, port: router.interfaces[0].id },
      { device: networkSwitch.id, port: networkSwitch.interfaces[3].id }
    );
    engine.connect(
      { device: router.id, port: router.interfaces[1].id },
      { device: remote.id, port: remote.interfaces[0].id }
    );
    engine.requestDhcp(client.id, port.id);
    engine.advanceTo(100);
    const probeId = engine.ping(client.id, '10.20.0.10');
    engine.advanceTo(500);
    expect(engine.state.probes.find((entry) => entry.id === probeId)?.status).toBe('success');
    expect(client.arpTable.some((entry) => entry.ip === '192.168.50.1')).toBe(true);
    expect(new TerminalSession(engine, client.id).execute('show ip route')).not.toContain('192.168.50.254');
  });

  it('recusa snapshots com leases divergentes ou timers ausentes', () => {
    const { engine, client, port } = dhcpLan();
    engine.requestDhcp(client.id, port.id);
    engine.advanceTo(100);
    const missingTimer = engine.snapshot();
    missingTimer.queue = missingTimer.queue.filter(
      ({ action }) => action.kind !== 'dhcp-client-timer' || action.timer !== 'expire'
    );
    expect(() => validateSnapshot(missingTimer)).toThrow('timer de expiração');
    const missingBindingTimer = engine.snapshot();
    missingBindingTimer.queue = missingBindingTimer.queue.filter(
      ({ action }) => action.kind !== 'dhcp-binding-expire'
    );
    expect(() => validateSnapshot(missingBindingTimer)).toThrow('Binding DHCP');
    const mismatched = engine.snapshot();
    mismatched.devices[0].interfaces[0].ip = '192.168.50.99';
    expect(() => validateSnapshot(mismatched)).toThrow('diverge');
  });

  it('recusa mensagens DHCP em portas UDP incompatíveis', () => {
    const { engine, client, server, port } = dhcpLan();
    engine.requestDhcp(client.id, port.id);
    for (const { action } of engine.state.queue) {
      if (action.kind === 'deliver' && action.frame.packet?.protocol === 'UDP')
        action.frame.packet.destinationPort = 53;
    }
    engine.advanceTo(100);
    expect(server.dhcpServer?.bindings).toHaveLength(0);
    expect(port.ip).toBeUndefined();
    expect(
      engine.state.events.some(
        (event) => event.type === 'PACKET_DROPPED' && event.reason.includes('portas UDP')
      )
    ).toBe(true);
    expect(() => validateSnapshot(engine.snapshot())).not.toThrow();
  });

  it('isola descoberta DHCP por VLAN e recupera após correção da porta', () => {
    const { engine, client, networkSwitch, server, port } = dhcpLan();
    networkSwitch.vlans.push({ id: 20, name: 'ISOLATED' });
    networkSwitch.interfaces[0].accessVlan = 20;
    engine.requestDhcp(client.id, port.id);
    engine.advanceTo(61000);
    expect(port.ip).toBeUndefined();
    expect(port.dhcp?.status).toBe('failed');
    expect(server.dhcpServer?.bindings).toHaveLength(0);
    networkSwitch.interfaces[0].accessVlan = 1;
    engine.renewDhcp(client.id, port.id);
    engine.advanceTo(61100);
    expect(port.dhcp?.status).toBe('bound');
  });

  it('reinicia descoberta após NAK quando o pool muda durante DORA', () => {
    const { engine, client, server, port } = dhcpLan();
    engine.requestDhcp(client.id, port.id);
    while (port.dhcp?.status !== 'requesting') expect(engine.step()).toBe(true);
    engine.configureDhcpPool(server.id, {
      ...server.dhcpServer!.pools[0],
      start: '192.168.50.20',
      end: '192.168.50.20',
    });
    engine.advanceTo(5000);
    expect(engine.state.events.some((event) => event.type === 'DHCP_NAK')).toBe(true);
    expect(port.dhcp?.status).toBe('bound');
    expect(port.ip).toBe('192.168.50.20');
  });

  it('executa DORA, aplica opções e permite ping com o endereço recebido', () => {
    const { engine, client, server, port } = dhcpLan();
    engine.requestDhcp(client.id, port.id);
    expect(port.ip).toBeUndefined();
    engine.advanceTo(100);
    expect(port).toMatchObject({
      ip: '192.168.50.10',
      prefix: 24,
      gateway: '192.168.50.1',
      dns: ['192.168.50.2'],
      dhcp: { status: 'bound' },
    });
    expect(
      engine.state.events
        .filter((event) => ['DHCP_DISCOVER', 'DHCP_OFFER', 'DHCP_REQUEST', 'DHCP_ACK'].includes(event.type))
        .map((event) => event.type)
    ).toEqual(['DHCP_DISCOVER', 'DHCP_OFFER', 'DHCP_REQUEST', 'DHCP_ACK']);
    expect(server.dhcpServer?.bindings).toHaveLength(1);
    const probeId = engine.ping(client.id, '192.168.50.2');
    engine.advanceTo(200);
    expect(engine.state.probes.find((entry) => entry.id === probeId)?.status).toBe('success');
    expect(() => validateSnapshot(engine.snapshot())).not.toThrow();
  });

  it('renova em T1 e conserva fila, concessões e determinismo após restauração', () => {
    const { engine, client, port } = dhcpLan(10000);
    engine.requestDhcp(client.id, port.id);
    engine.step();
    const restored = new SimulationEngine(JSON.parse(JSON.stringify(engine.snapshot())));
    engine.advanceTo(100);
    restored.advanceTo(100);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    const original = structuredClone(port.dhcp!.lease!);
    engine.advanceTo(original.renewAt + 100);
    restored.advanceTo(original.renewAt + 100);
    expect(port.dhcp?.status).toBe('bound');
    expect(port.dhcp!.lease!.expiresAt).toBeGreaterThan(original.expiresAt);
    expect(engine.state.events.some((event) => event.type === 'DHCP_RENEWING')).toBe(true);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(() => validateSnapshot(engine.snapshot())).not.toThrow();
  });

  it('tenta rebinding, remove configuração vencida e recupera após retorno do serviço', () => {
    const { engine, client, server, port } = dhcpLan(10000);
    engine.requestDhcp(client.id, port.id);
    engine.advanceTo(100);
    const expires = port.dhcp!.lease!.expiresAt;
    server.dhcpServer!.enabled = false;
    engine.advanceTo(expires + 100);
    expect(port.ip).toBeUndefined();
    expect(port.gateway).toBeUndefined();
    expect(port.dns).toBeUndefined();
    expect(engine.state.events.some((event) => event.type === 'DHCP_REBINDING')).toBe(true);
    expect(engine.state.events.some((event) => event.type === 'DHCP_EXPIRED')).toBe(true);
    expect(server.dhcpServer?.bindings).toHaveLength(0);
    server.dhcpServer!.enabled = true;
    engine.renewDhcp(client.id, port.id);
    engine.advanceTo(engine.state.clock + 100);
    expect(port.dhcp?.status).toBe('bound');
    expect(port.ip).toBe('192.168.50.10');
  });

  it('reserva ofertas concorrentes e respeita exclusões', () => {
    const { engine, client, networkSwitch, server, port } = dhcpLan();
    const other = engine.addDevice('pc');
    engine.connect(
      { device: other.id, port: other.interfaces[0].id },
      { device: networkSwitch.id, port: networkSwitch.interfaces[2].id }
    );
    engine.requestDhcp(client.id, port.id);
    engine.requestDhcp(other.id, other.interfaces[0].id);
    engine.advanceTo(100);
    expect([port.ip, other.interfaces[0].ip]).toEqual(['192.168.50.10', '192.168.50.12']);
    expect(server.dhcpServer?.bindings.map((entry) => entry.status)).toEqual(['bound', 'bound']);
  });

  it('explica esgotamento e reutiliza endereço devolvido por DHCP RELEASE', () => {
    const { engine, client, networkSwitch, server, port } = dhcpLan();
    engine.configureDhcpPool(server.id, { ...server.dhcpServer!.pools[0], end: '192.168.50.10' });
    const other = engine.addDevice('pc');
    engine.connect(
      { device: other.id, port: other.interfaces[0].id },
      { device: networkSwitch.id, port: networkSwitch.interfaces[2].id }
    );
    engine.requestDhcp(client.id, port.id);
    engine.advanceTo(100);
    engine.requestDhcp(other.id, other.interfaces[0].id);
    engine.advanceTo(61000);
    expect(other.interfaces[0].dhcp?.status).toBe('failed');
    expect(engine.state.events.some((event) => event.type === 'DHCP_POOL_EXHAUSTED')).toBe(true);
    engine.releaseDhcp(client.id, port.id);
    engine.advanceTo(61100);
    expect(port.ip).toBeUndefined();
    expect(server.dhcpServer?.bindings).toHaveLength(0);
    engine.requestDhcp(other.id, other.interfaces[0].id);
    engine.advanceTo(61200);
    expect(other.interfaces[0].ip).toBe('192.168.50.10');
    expect(() => validateSnapshot(engine.snapshot())).not.toThrow();
  });
});
