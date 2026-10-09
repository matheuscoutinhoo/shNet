import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  validateSnapshot,
  tcpAdd,
  tcpBytes,
  tcpFinished,
  TerminalSession,
  makeTemplate,
  terminalText,
  type TcpPacket,
} from '../packages/simulation-engine/src';

function network() {
  const engine = new SimulationEngine();
  const client = engine.addDevice('pc'),
    router = engine.addDevice('router'),
    server = engine.addDevice('server');
  Object.assign(client.interfaces[0], { ip: '10.0.0.10', prefix: 24 });
  client.gateway = '10.0.0.1';
  Object.assign(router.interfaces[0], { ip: '10.0.0.1', prefix: 24, natRole: 'inside' });
  Object.assign(router.interfaces[1], { ip: '203.0.113.1', prefix: 24, natRole: 'outside' });
  Object.assign(server.interfaces[0], { ip: '203.0.113.20', prefix: 24 });
  server.gateway = '203.0.113.1';
  const inside = engine.connect(
    { device: client.id, port: client.interfaces[0].id },
    { device: router.id, port: router.interfaces[0].id }
  );
  const outside = engine.connect(
    { device: router.id, port: router.interfaces[1].id },
    { device: server.id, port: server.interfaces[0].id }
  );
  engine.configureTcpService(server.id, { kind: 'echo', port: 7, enabled: true });
  engine.configureTcpService(server.id, {
    kind: 'http',
    port: 80,
    enabled: true,
    body: 'Olá da rede simulada!\n',
  });
  return { engine, client, router, server, inside, outside };
}
function stepUntil(engine: SimulationEngine, condition: () => boolean) {
  for (let i = 0; i < 1000 && !condition(); i++) {
    expect(engine.step()).toBe(true);
    validateSnapshot(engine.snapshot());
  }
  expect(condition()).toBe(true);
}
function loseOne(engine: SimulationEngine, match: (packet: TcpPacket, device: string) => boolean) {
  stepUntil(engine, () =>
    engine.state.queue.some(
      ({ action }) =>
        action.kind === 'deliver' &&
        action.frame.packet?.protocol === 'TCP' &&
        match(action.frame.packet, action.device)
    )
  );
  const index = engine.state.queue.findIndex(
    ({ action }) =>
      action.kind === 'deliver' &&
      action.frame.packet?.protocol === 'TCP' &&
      match(action.frame.packet, action.device)
  );
  engine.state.queue.splice(index, 1);
}

describe('TCP sobre a rede simulada', () => {
  it('confirma FIN retransmitido quando o último ACK se perde em TIME-WAIT', () => {
    const { engine, client, server } = network();
    engine.openTcp(client.id, '203.0.113.20', 7, 'fim', true);
    stepUntil(engine, () => client.tcpConnections![0].state === 'TIME-WAIT');
    loseOne(engine, (packet, target) => target === server.id && packet.flags.join() === 'ACK');
    engine.advanceTo(5000);
    expect(server.tcpConnections![0].state).toBe('CLOSED');
    expect(server.tcpConnections![0].retransmissions).toBeGreaterThan(0);
    expect(client.tcpConnections![0].received).toBe('fim');
    validateSnapshot(engine.snapshot());
  });
  it('encerra simultaneamente os dois sentidos sem perder FIN', () => {
    const { engine, client, server } = network();
    engine.openTcp(client.id, '203.0.113.20', 7);
    stepUntil(engine, () => server.tcpConnections?.[0].state === 'ESTABLISHED');
    engine.closeTcp(client.id, client.tcpConnections![0].id);
    engine.closeTcp(server.id, server.tcpConnections![0].id);
    engine.advanceTo(1000);
    expect(client.tcpConnections![0].state).toBe('TIME-WAIT');
    expect(server.tcpConnections![0].state).toBe('TIME-WAIT');
    engine.run();
    validateSnapshot(engine.snapshot());
  });
  it('aplica janela remota e retoma o buffer quando o receptor reabre a janela', () => {
    const { engine, client, server } = network();
    engine.openTcp(client.id, '203.0.113.20', 7);
    stepUntil(engine, () => server.tcpConnections?.[0].state === 'ESTABLISHED');
    const connection = client.tcpConnections![0];
    const windowUpdate: TcpPacket = {
      src: connection.remoteIp,
      dst: connection.localIp,
      sourcePort: 7,
      destinationPort: connection.localPort,
      protocol: 'TCP',
      ttl: 64,
      sequence: connection.receiveNext,
      acknowledgment: connection.sendNext,
      window: 0,
      flags: ['ACK'],
      bytes: 40,
      data: '',
    };
    engine.sendIp(server.id, windowUpdate);
    engine.advanceTo(100);
    engine.writeTcp(client.id, connection.id, 'janela');
    expect(connection.pending).toBeUndefined();
    expect(connection.sendBuffer).toBe('janela');
    engine.sendIp(server.id, { ...windowUpdate, window: 3 });
    stepUntil(engine, () => connection.pending !== undefined);
    expect(connection.pending!.packet.data).toBe('jan');
    engine.advanceTo(1000);
    expect(connection.received).toBe('janela');
    validateSnapshot(engine.snapshot());
  });
  it('retém sequência fora de ordem sem entregar bytes e aceita o wrap de 32 bits', () => {
    const { engine, client, server } = network();
    engine.openTcp(client.id, '203.0.113.20', 7);
    stepUntil(engine, () => server.tcpConnections?.[0].state === 'ESTABLISHED');
    const source = client.tcpConnections![0],
      receiver = server.tcpConnections![0];
    engine.sendIp(client.id, {
      src: source.localIp,
      dst: source.remoteIp,
      sourcePort: source.localPort,
      destinationPort: 7,
      protocol: 'TCP',
      ttl: 64,
      flags: ['ACK', 'PSH'],
      sequence: tcpAdd(source.sendNext, 9),
      acknowledgment: source.receiveNext,
      window: 1000,
      data: 'fora',
      bytes: 44,
    });
    engine.advanceTo(100);
    expect(receiver.received).toBe('');
    expect(receiver.flow!.receiveQueue).toHaveLength(1);
    // Start a separate synthetic sequence space for the wrap-around check.
    receiver.flow!.receiveQueue = [];
    source.sendNext = source.sendUna = 4294967294;
    receiver.receiveNext = 4294967294;
    engine.writeTcp(client.id, source.id, 'wrap');
    engine.advanceTo(1000);
    expect(source.sendNext).toBe(2);
    expect(source.received).toBe('wrap');
    validateSnapshot(engine.snapshot());
  });
  it('template entrega HTTP via PAT e firewall e restaura a sessão em andamento', () => {
    const engine = new SimulationEngine(makeTemplate('tcp'));
    const client = engine.state.devices[0];
    engine.httpGet(client.id, '192.168.20.10');
    stepUntil(engine, () => engine.state.devices.some((device) => !!device.firewall?.sessions.length));
    const restored = new SimulationEngine(engine.snapshot());
    restored.advanceTo(1000);
    engine.advanceTo(1000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(client.tcpConnections![0].received).toContain('200 OK');
    const router = engine.state.devices.find((device) => device.firewall)!;
    expect(router.firewall!.dropped).toBe(0);
    const invalid = engine.snapshot();
    invalid.queue = invalid.queue.filter(({ action }) => action.kind !== 'firewall-expire');
    expect(() => validateSnapshot(invalid)).toThrow('firewall sem timer');
    engine.run();
    expect(router.firewall!.sessions).toHaveLength(0);
    validateSnapshot(engine.snapshot());
  });
  it('firewall bloqueia SYN externo e ACK sem handshake, mas autoriza retorno', () => {
    const { engine, client, router, server } = network();
    engine.configureTcpService(router.id, { kind: 'http', port: 80, enabled: true });
    engine.configureFirewall(router.id, { enabled: true, trustedPorts: [router.interfaces[0].id] });
    engine.openTcp(server.id, '10.0.0.10', 80);
    engine.advanceTo(100);
    expect(client.tcpConnections).toBeUndefined();
    expect(router.firewall!.dropped).toBeGreaterThan(0);
    engine.sendIp(server.id, {
      protocol: 'TCP',
      src: '203.0.113.20',
      dst: '10.0.0.10',
      sourcePort: 80,
      destinationPort: 50123,
      sequence: 12,
      acknowledgment: 45,
      ttl: 64,
      flags: ['ACK'],
      window: 100,
      data: '',
      bytes: 40,
    });
    engine.advanceTo(200);
    expect(router.firewall!.sessions).toHaveLength(0);
    engine.httpGet(client.id, '203.0.113.20');
    engine.advanceTo(1000);
    expect(client.tcpConnections![0].received).toContain('200 OK');
    validateSnapshot(engine.snapshot());
  });
  it('firewall mantém retransmissão e ACL continua bloqueando tráfego rastreado', () => {
    const { engine, client, router, server } = network();
    engine.configureFirewall(router.id, { enabled: true, trustedPorts: [router.interfaces[0].id] });
    engine.openTcp(client.id, '203.0.113.20', 7);
    loseOne(engine, (packet, target) => target === client.id && packet.flags.includes('SYN'));
    engine.advanceTo(2000);
    expect(client.tcpConnections![0].state).toBe('ESTABLISHED');
    expect(router.firewall!.dropped).toBe(0);
    engine.configureAcl(router.id, { name: 'DENY', rules: [] });
    engine.bindAcl(router.id, router.interfaces[1].id, 'out', 'DENY');
    engine.writeTcp(client.id, client.tcpConnections![0].id, 'bloqueado pela ACL');
    engine.advanceTo(132000);
    expect(server.tcpConnections![0].received).toBe('');
    expect(client.tcpConnections![0].state).toBe('TIMED-OUT');
  });
  it('CLI configura serviços, firewall e regras TCP e mantém isolamento do terminal', () => {
    const { engine, client, router, server } = network();
    const cli = new TerminalSession(engine, server.id);
    for (const command of ['enable', 'configure terminal', 'no service http', 'service http 8080'])
      expect(cli.execute(command)).toBe('OK');
    expect(cli.execute('show services')).toContain('http TCP/8080: LISTEN');
    expect(cli.execute('show running-config')).toContain('service http 8080');
    const routing = new TerminalSession(engine, router.id);
    for (const command of [
      'enable',
      'configure terminal',
      'firewall trust ' + router.interfaces[0].name,
      'service firewall',
      'access-list WEB 10 permit tcp any any eq 8080',
    ])
      expect(routing.execute(command)).toBe('OK');
    const endpoint = new TerminalSession(engine, client.id);
    expect(endpoint.execute('http get 203.0.113.20 8080')).toContain('HTTP GET enfileirado');
    engine.advanceTo(1000);
    expect(endpoint.execute('show tcp')).toContain('200 OK');
    expect(routing.execute('show firewall')).toContain('CLOSING');
    const before = engine.snapshot();
    expect(endpoint.execute('http get 203.0.113.20; powershell')).toMatch(/^%/);
    expect(engine.snapshot()).toEqual(before);
    expect(terminalText('\x1b]52;secret\x07\nhello')).toBe(']52;secret\nhello');
  });
  it('faz handshake, echo UTF-8 segmentado e FIN sem duplicar a aplicação', () => {
    const { engine, client, server } = network();
    const data = 'Olá 🌐! '.repeat(170);
    const id = engine.openTcp(client.id, '203.0.113.20', 7, data, true);
    const connection = client.tcpConnections!.find((entry) => entry.id === id)!;
    stepUntil(engine, () => connection.state === 'TIME-WAIT');
    expect(connection.received).toBe(data);
    expect(connection.bytesReceived).toBe(tcpBytes(data));
    expect(server.tcpConnections![0].received).toBe(data);
    expect(
      engine.state.events.some(
        (event) => event.frame?.packet?.protocol === 'TCP' && event.frame.packet.ttl === 63
      )
    ).toBe(true);
    engine.run();
    expect(connection.state).toBe('CLOSED');
    expect(server.tcpConnections![0].state).toBe('CLOSED');
    validateSnapshot(engine.snapshot());
  });
  it.each(['SYN', 'SYN-ACK', 'ACK', 'DATA', 'DATA-ACK', 'FIN', 'FIN-ACK'])('recupera perda de %s', (kind) => {
    const { engine, client, server } = network();
    engine.openTcp(client.id, '203.0.113.20', 7);
    const connection = client.tcpConnections![0];
    if (['DATA', 'DATA-ACK', 'FIN', 'FIN-ACK'].includes(kind)) {
      stepUntil(engine, () => server.tcpConnections?.[0].state === 'ESTABLISHED');
      if (kind.startsWith('DATA')) engine.writeTcp(client.id, connection.id, 'mensagem única');
      else engine.closeTcp(client.id, connection.id);
    }
    loseOne(engine, (packet, target) => {
      if (kind === 'SYN') return target === server.id && packet.flags.join() === 'SYN';
      if (kind === 'SYN-ACK') return target === client.id && packet.flags.join() === 'SYN,ACK';
      if (kind === 'ACK') return target === server.id && packet.flags.join() === 'ACK';
      if (kind === 'DATA') return target === server.id && !!packet.data;
      if (kind === 'DATA-ACK') return target === client.id && packet.flags.join() === 'ACK';
      if (kind === 'FIN') return target === server.id && packet.flags.includes('FIN');
      return target === client.id && packet.flags.join() === 'ACK';
    });
    engine.advanceTo(engine.state.clock + 8000);
    if (kind.startsWith('FIN')) expect(['TIME-WAIT', 'CLOSED']).toContain(connection.state);
    else expect(connection.state).toBe('ESTABLISHED');
    if (kind.startsWith('DATA')) {
      expect(connection.received).toBe('mensagem única');
      expect(server.tcpConnections![0].received).toBe('mensagem única');
    }
    validateSnapshot(engine.snapshot());
  });
  it('produz HTTP 200/404 pelos segmentos e não realiza acesso externo', () => {
    const { engine, client } = network();
    engine.httpGet(client.id, '203.0.113.20');
    engine.httpGet(client.id, '203.0.113.20', 80, '/ausente');
    engine.advanceTo(1000);
    expect(client.tcpConnections![0].received).toContain('HTTP/1.1 200 OK');
    expect(client.tcpConnections![0].received).toContain('Olá da rede simulada!');
    expect(client.tcpConnections![1].received).toContain('HTTP/1.1 404 Not Found');
    validateSnapshot(engine.snapshot());
  });
  it('responde RST em porta fechada e ignora RST/ACK forjados', () => {
    const { engine, client, server } = network();
    engine.openTcp(client.id, '203.0.113.20', 81);
    engine.advanceTo(100);
    expect(client.tcpConnections![0].state).toBe('RESET');
    engine.openTcp(client.id, '203.0.113.20', 7);
    stepUntil(engine, () => server.tcpConnections?.[0].state === 'ESTABLISHED');
    const connection = client.tcpConnections![1];
    const forged: TcpPacket = {
      protocol: 'TCP',
      src: connection.remoteIp,
      dst: connection.localIp,
      sourcePort: 7,
      destinationPort: connection.localPort,
      ttl: 64,
      bytes: 40,
      data: '',
      window: 1000,
      sequence: tcpAdd(connection.receiveNext, 99),
      acknowledgment: connection.sendNext,
      flags: ['RST'],
    };
    engine.sendIp(server.id, forged);
    engine.advanceTo(200);
    expect(connection.state).toBe('ESTABLISHED');
    engine.sendIp(server.id, {
      ...forged,
      sequence: connection.receiveNext,
      flags: ['ACK'],
      acknowledgment: tcpAdd(connection.sendNext, 99),
    });
    engine.advanceTo(300);
    expect(connection.state).toBe('ESTABLISHED');
    engine.closeTcp(client.id, connection.id, true);
    engine.advanceTo(400);
    expect(server.tcpConnections![0].state).toBe('RESET');
    validateSnapshot(engine.snapshot());
  });
  it('limita retransmissões com cabo perdido e recupera ao religar', () => {
    const { engine, client, inside } = network();
    inside.loss = 1;
    engine.openTcp(client.id, '203.0.113.20', 7, 'sem caminho', true);
    engine.advanceTo(64000);
    expect(client.tcpConnections![0]).toMatchObject({ state: 'TIMED-OUT', retransmissions: 5 });
    expect(engine.state.queue.filter(({ action }) => action.kind === 'tcp-timer')).toHaveLength(0);
    inside.loss = 0;
    engine.openTcp(client.id, '203.0.113.20', 7, 'voltou', true);
    engine.advanceTo(65000);
    expect(client.tcpConnections![1].received).toBe('voltou');
  });
  it.each(['static', 'dynamic', 'pat'])(
    'transporta HTTP com NAT %s e sem rota de retorno privada',
    (kind) => {
      const { engine, client, router, server } = network();
      delete server.gateway;
      engine.configureNat(router.id, {
        enabled: true,
        statics:
          kind === 'static'
            ? [{ inside: '10.0.0.10', global: '203.0.113.100', outside: router.interfaces[1].id }]
            : [],
        pools:
          kind === 'static'
            ? []
            : [
                {
                  name: 'WEB',
                  source: { network: '10.0.0.0', prefix: 24 },
                  outside: router.interfaces[1].id,
                  start: '203.0.113.100',
                  end: '203.0.113.100',
                  overload: kind === 'pat',
                },
              ],
      });
      engine.httpGet(client.id, '203.0.113.20');
      engine.advanceTo(1000);
      expect(client.tcpConnections![0].received).toContain('200 OK');
      expect(server.tcpConnections![0].remoteIp).toBe('203.0.113.100');
      if (kind === 'pat') expect(router.nat?.bindings[0].protocol).toBe('TCP');
      validateSnapshot(engine.snapshot());
    }
  );
  it('filtra TCP por porta de destino em ACL', () => {
    const { engine, client, router } = network();
    const any = { network: '0.0.0.0', prefix: 0 };
    engine.configureAcl(router.id, {
      name: 'WEB',
      rules: [
        {
          sequence: 10,
          action: 'permit',
          protocol: 'tcp',
          source: any,
          destination: any,
          destinationPort: 80,
        },
      ],
    });
    engine.bindAcl(router.id, router.interfaces[0].id, 'in', 'WEB');
    engine.httpGet(client.id, '203.0.113.20');
    engine.openTcp(client.id, '203.0.113.20', 7, 'bloqueado', true);
    engine.advanceTo(64000);
    expect(client.tcpConnections![0].received).toContain('200 OK');
    expect(client.tcpConnections![1].state).toBe('TIMED-OUT');
    expect(router.accessLists![0].implicitDrops).toBeGreaterThan(0);
  });
  it('restaura fila e conexões durante handshake e rejeita timers adulterados', () => {
    const { engine, client } = network();
    engine.httpGet(client.id, '203.0.113.20');
    const restored = new SimulationEngine(engine.snapshot());
    engine.advanceTo(1000);
    restored.advanceTo(1000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    const bad = engine.snapshot();
    bad.queue = bad.queue.filter(({ action }) => action.kind !== 'tcp-timer');
    expect(() => validateSnapshot(bad)).toThrow('timer');
    const badCounters = engine.snapshot();
    badCounters.devices[0].tcpConnections![0].bytesReceived++;
    expect(() => validateSnapshot(badCounters)).toThrow('Contadores');
    const badResponse = engine.snapshot();
    badResponse.devices.find((device) => device.type === 'server')!.tcpConnections![0].responseBody =
      '🌐'.repeat(1500);
    expect(() => validateSnapshot(badResponse)).toThrow('Resposta HTTP');
  });
  it('faz loopback sem cabo e permite remover equipamento durante conexão', () => {
    const { engine, server, client } = network();
    engine.httpGet(server.id, '203.0.113.20');
    expect(server.tcpConnections!.some((connection) => connection.received.includes('200 OK'))).toBe(true);
    validateSnapshot(engine.snapshot());
    engine.openTcp(client.id, '203.0.113.20', 7);
    engine.removeDevice(client.id);
    engine.run();
    validateSnapshot(engine.snapshot());
    expect(server.tcpConnections!.every(tcpFinished)).toBe(true);
  });
});
