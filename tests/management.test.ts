import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  TerminalSession,
  validateSnapshot,
  compareOids,
  snmpMib,
  type UdpPacket,
} from '../packages/simulation-engine/src';
import { managementPacket } from '../packages/simulation-engine/src/protocols/management-wire';

const nameOid = '1.3.6.1.2.1.1.5.0',
  rxOid = '1.3.6.1.4.1.32473.1.1.1';
function network(pat = false) {
  const engine = new SimulationEngine(makeTemplate(pat ? 'tcp' : 'routed'));
  const client = engine.state.devices[0],
    router = engine.state.devices.find((device) => device.type === 'router')!,
    server = engine.state.devices.find((device) => device.type === 'server')!;
  engine.configureSnmpAgent(server.id, { enabled: true, community: 'lab_read' });
  engine.setSyslogEnabled(server.id, true);
  engine.configureSyslog(client.id, {
    enabled: true,
    server: server.interfaces[0].ip,
    automatic: false,
    severity: 6,
  });
  return { engine, client, router, server };
}
function until(engine: SimulationEngine, ready: () => boolean) {
  for (let i = 0; i < 200 && !ready(); i++) {
    expect(engine.step()).toBe(true);
    validateSnapshot(engine.snapshot());
  }
  expect(ready()).toBe(true);
}
function result(engine: SimulationEngine, clientId: string, id: string) {
  return engine.device(clientId).snmpQueries!.find((query) => query.id === id)!;
}

describe('SNMP e syslog sobre a rede simulada', () => {
  it('switch L3 oferece agente/coletor e consulta outro agente pelas SVIs', () => {
    const e = new SimulationEngine(makeTemplate('svi')),
      sw = e.state.devices.find((d) => d.type === 'switch')!,
      pc = e.state.devices.find((d) => d.type === 'pc')!,
      srv = e.state.devices.find((d) => d.type === 'server')!;
    e.configureSnmpAgent(sw.id, { enabled: true, community: 'public' });
    e.setSyslogEnabled(sw.id, true);
    e.configureSyslog(pc.id, { enabled: true, server: '192.168.10.1', automatic: false, severity: 6 });
    const index = sw.interfaces.findIndex((p) => p.logical?.vlan === 10) + 1,
      q = e.querySnmp(pc.id, '192.168.10.1', 'public', [nameOid, '1.3.6.1.2.1.2.2.1.8.' + index]);
    e.sendSyslog(pc.id, 'evento para SVI');
    e.advanceTo(1000);
    expect(pc.snmpQueries!.find((n) => n.id === q)!.status).toBe('success');
    expect(pc.snmpQueries!.find((n) => n.id === q)!.varbinds[1]).toMatchObject({
      type: 'Integer',
      value: 1,
    });
    expect(sw.syslogServer!.entries.some((n) => n.message.text === 'evento para SVI')).toBe(true);
    e.configureSnmpAgent(srv.id, { enabled: true, community: 'public' });
    const outbound = e.querySnmp(sw.id, '192.168.20.10', 'public', [nameOid]),
      restored = new SimulationEngine(e.snapshot());
    e.advanceTo(2000);
    restored.advanceTo(2000);
    expect(e.snapshot()).toEqual(restored.snapshot());
    expect(sw.snmpQueries!.find((n) => n.id === outbound)!.status).toBe('success');
    validateSnapshot(e.snapshot());
  });

  it('GET devolve nome e contadores reais por PAT/firewall e restaura a consulta pendente', () => {
    const { engine, client, router, server } = network(true);
    engine.ping(client.id, server.interfaces[0].ip!);
    engine.advanceTo(100);
    const before = server.interfaces[0].rx;
    const id = engine.querySnmp(client.id, server.interfaces[0].ip!, 'lab_read', [nameOid, rxOid]);
    until(engine, () =>
      engine.state.queue.some(
        ({ action }) =>
          action.kind === 'deliver' &&
          action.frame.packet?.protocol === 'UDP' &&
          action.frame.packet.payload.protocol === 'SNMP'
      )
    );
    const restored = new SimulationEngine(engine.snapshot());
    until(engine, () => result(engine, client.id, id).status !== 'pending');
    restored.advanceTo(engine.state.clock);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(result(engine, client.id, id).status).toBe('success');
    expect(result(engine, client.id, id).varbinds[0]).toMatchObject({ oid: nameOid, value: server.hostname });
    expect(result(engine, client.id, id).varbinds[1]).toMatchObject({ value: server.interfaces[0].rx });
    expect(server.interfaces[0].rx).toBeGreaterThan(before);
    expect(
      router.firewall!.sessions.some(
        (session) => session.protocol === 'UDP' && session.serverPort === 161 && session.state === 'REPLIED'
      )
    ).toBe(true);
    expect(router.nat!.bindings.some((entry) => entry.protocol === 'UDP' && entry.remotePort === 161)).toBe(
      true
    );
  });
  it('GETNEXT percorre a MIB em ordem numérica e distingue noSuchObject de endOfMibView', () => {
    const { engine, client, server } = network();
    expect(compareOids('1.3.6.1.2.10', '1.3.6.1.2.9')).toBeGreaterThan(0);
    const first = engine.querySnmp(
      client.id,
      server.interfaces[0].ip!,
      'lab_read',
      ['1.3.6.1.2.1.1.1.0'],
      'get-next'
    );
    engine.advanceTo(100);
    expect(result(engine, client.id, first).varbinds[0]).toMatchObject({
      oid: '1.3.6.1.2.1.1.3.0',
      type: 'TimeTicks',
    });
    const unknown = '1.3.6.1.9.999.0';
    const get = engine.querySnmp(client.id, server.interfaces[0].ip!, 'lab_read', [unknown]);
    const next = engine.querySnmp(client.id, server.interfaces[0].ip!, 'lab_read', [unknown], 'get-next');
    engine.advanceTo(200);
    expect(result(engine, client.id, get).varbinds).toEqual([{ oid: unknown, type: 'noSuchObject' }]);
    expect(result(engine, client.id, next).varbinds).toEqual([{ oid: unknown, type: 'endOfMibView' }]);
    const local = engine.querySnmp(server.id, server.interfaces[0].ip!, 'lab_read', [nameOid]);
    expect(result(engine, server.id, local).status).toBe('success');
    validateSnapshot(engine.snapshot());
  });
  it('consulta estado administrativo/operacional após falha sem fabricar métricas de equipamento', () => {
    const { engine, client, router } = network();
    engine.configureSnmpAgent(router.id, { enabled: true, community: 'public' });
    engine.setPort(router.id, 'p1', false);
    const id = engine.querySnmp(client.id, router.interfaces[0].ip!, 'public', [
      '1.3.6.1.2.1.2.2.1.7.2',
      '1.3.6.1.2.1.2.2.1.8.2',
    ]);
    engine.advanceTo(100);
    expect(
      result(engine, client.id, id).varbinds.map((entry) => ('value' in entry ? entry.value : undefined))
    ).toEqual([2, 2]);
    expect(snmpMib(engine, router).some((entry) => entry.oid.startsWith('1.3.6.1.4.1.32473.1.'))).toBe(true);
  });
  it('retransmite GET perdido e termina em timeout para community incorreta ou agente desativado', () => {
    const { engine, client, server } = network();
    const id = engine.querySnmp(client.id, server.interfaces[0].ip!, 'lab_read', [nameOid]);
    until(engine, () =>
      engine.state.queue.some(
        ({ action }) =>
          action.kind === 'deliver' && action.device === server.id && action.frame.packet?.protocol === 'UDP'
      )
    );
    engine.state.queue = engine.state.queue.filter(
      ({ action }) =>
        !(action.kind === 'deliver' && action.device === server.id && action.frame.packet?.protocol === 'UDP')
    );
    engine.advanceTo(6000);
    expect(result(engine, client.id, id)).toMatchObject({ status: 'success', attempts: 2 });
    const wrong = engine.querySnmp(client.id, server.interfaces[0].ip!, 'wrong', [nameOid]);
    engine.advanceTo(16001);
    expect(result(engine, client.id, wrong)).toMatchObject({ status: 'timeout', attempts: 2 });
    engine.configureSnmpAgent(server.id, { enabled: false, community: 'lab_read' });
    const disabled = engine.querySnmp(client.id, server.interfaces[0].ip!, 'lab_read', [nameOid]);
    engine.advanceTo(26002);
    expect(result(engine, client.id, disabled).status).toBe('timeout');
    validateSnapshot(engine.snapshot());
  });
  it('rejeita resposta SNMP com ID, community, porta ou OID incorretos sem concluir a consulta', () => {
    const { engine, client, server } = network();
    engine.configureSnmpAgent(server.id, { enabled: false, community: 'lab_read' });
    const id = engine.querySnmp(client.id, server.interfaces[0].ip!, 'lab_read', [nameOid]);
    engine.advanceTo(100);
    const query = result(engine, client.id, id);
    const response = {
      type: 'response' as const,
      requestId: query.requestId,
      community: query.community,
      errorStatus: 'noError' as const,
      varbinds: [{ oid: nameOid, type: 'OctetString' as const, value: server.hostname }],
    };
    const packets: UdpPacket[] = [
      managementPacket(query.server, query.sourceIp, 161, query.sourcePort, {
        protocol: 'SNMP',
        message: { ...response, requestId: response.requestId + 1 },
      }),
      managementPacket(query.server, query.sourceIp, 161, query.sourcePort, {
        protocol: 'SNMP',
        message: { ...response, community: 'wrong' },
      }),
      managementPacket(query.server, query.sourceIp, 162, query.sourcePort, {
        protocol: 'SNMP',
        message: response,
      }),
      managementPacket(query.server, query.sourceIp, 161, query.sourcePort, {
        protocol: 'SNMP',
        message: { ...response, varbinds: [{ ...response.varbinds[0], oid: rxOid }] },
      }),
    ];
    packets.forEach((packet) => engine.sendIp(server.id, packet));
    engine.advanceTo(200);
    expect(query.status).toBe('pending');
    engine.sendIp(
      server.id,
      managementPacket(query.server, query.sourceIp, 161, query.sourcePort, {
        protocol: 'SNMP',
        message: response,
      })
    );
    engine.advanceTo(300);
    expect(query.status).toBe('success');
    expect(client.dropped).toBe(4);
  });
  it('retorna tooBig quando os objetos não cabem na MTU e valida OIDs antes do envio', () => {
    const { engine, client, server } = network();
    server.interfaces[0].mtu = 576;
    const id = engine.querySnmp(
      client.id,
      server.interfaces[0].ip!,
      'lab_read',
      Array.from({ length: 8 }, () => '1.3.6.1.2.1.1.1.0')
    );
    engine.advanceTo(100);
    expect(result(engine, client.id, id)).toMatchObject({ status: 'tooBig', varbinds: [] });
    for (const oid of ['1.40.0', '3.1.0', '1.3.01.0', '1.3.4294967296.0'])
      expect(() => engine.querySnmp(client.id, server.interfaces[0].ip!, 'lab_read', [oid])).toThrow();
    validateSnapshot(engine.snapshot());
  });
  it('entrega syslog com PRI e origem após PAT e mantém mensagens perdidas fora do coletor', () => {
    const { engine, client, router, server } = network(true);
    const id = engine.sendSyslog(client.id, 'Rede em operação 🌐', 5);
    const restored = new SimulationEngine(engine.snapshot());
    engine.advanceTo(100);
    restored.advanceTo(100);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(server.syslogServer!.entries[0]).toMatchObject({
      source: router.interfaces[1].ip,
      message: { id, hostname: client.hostname, severity: 5, facility: 23, text: 'Rede em operação 🌐' },
    });
    engine.configureAcl(router.id, { name: 'BLOCK_LOG', rules: [] });
    engine.bindAcl(router.id, 'p0', 'in', 'BLOCK_LOG');
    engine.sendSyslog(client.id, 'Bloqueado pela ACL', 3);
    engine.advanceTo(200);
    expect(server.syslogServer!.entries).toHaveLength(1);
    expect(engine.state.events.some((event) => event.type === 'ACL_DENY')).toBe(true);
    engine.bindAcl(router.id, 'p0', 'in', undefined);
    engine.state.links[0].loss = 1;
    engine.sendSyslog(client.id, 'Perdido no cabo', 3);
    engine.advanceTo(300);
    expect(server.syslogServer!.entries).toHaveLength(1);
    validateSnapshot(engine.snapshot());
  });
  it('filtra severidade e envia eventos automáticos sem reciclar mensagens ou falhas de entrega', () => {
    const { engine, client, server } = network();
    engine.configureSyslog(client.id, {
      enabled: true,
      server: server.interfaces[0].ip,
      automatic: true,
      severity: 4,
      facility: 16,
    });
    engine.sendSyslog(client.id, 'Debug filtrado', 7);
    engine.emit('LINK_DOWN', client.id, 'Falha de enlace para investigação.');
    engine.advanceTo(100);
    expect(server.syslogServer!.entries).toHaveLength(1);
    expect(server.syslogServer!.entries[0].message).toMatchObject({ severity: 4, facility: 16 });
    expect(engine.state.events.some((event) => event.type === 'SYSLOG_FILTERED')).toBe(true);
    engine.configureSyslog(server.id, {
      enabled: true,
      server: client.interfaces[0].ip,
      automatic: true,
      severity: 4,
    });
    engine.sendSyslog(client.id, 'Não deve iniciar loop', 3);
    engine.advanceTo(200);
    expect(server.syslogServer!.entries).toHaveLength(2);
    expect(engine.state.queue.some(({ action }) => action.kind === 'syslog-send')).toBe(false);
    engine.configureSyslog(client.id, {
      enabled: true,
      server: '198.51.100.99',
      automatic: true,
      severity: 4,
    });
    engine.sendSyslog(client.id, 'Sem destino alcançável', 3);
    engine.run();
    expect(engine.state.queue).toHaveLength(0);
    validateSnapshot(engine.snapshot());
  });
  it('limita registros e fila syslog e remove envios pendentes ao desativar origem', () => {
    const { engine, client, server, router } = network(true);
    for (let batch = 0; batch < 9; batch++) {
      for (let i = 0; i < 60; i++) engine.sendSyslog(client.id, 'registro ' + (batch * 60 + i), 4);
      engine.advanceTo((batch + 1) * 100);
    }
    expect(server.syslogServer!.entries).toHaveLength(500);
    expect(server.syslogServer!.entries[0].message.text).toBe('registro 40');
    expect(router.nat!.bindings).toHaveLength(1);
    expect(router.firewall!.sessions).toHaveLength(1);
    for (let i = 0; i < 70; i++) engine.sendSyslog(client.id, 'pendente ' + i, 4);
    expect(engine.state.queue.filter(({ action }) => action.kind === 'syslog-send')).toHaveLength(64);
    expect(engine.state.events.some((event) => event.type === 'SYSLOG_FAILED')).toBe(true);
    engine.configureSyslog(client.id, { ...client.syslogClient, enabled: false });
    expect(engine.state.queue.filter(({ action }) => action.kind === 'syslog-send')).toHaveLength(0);
    validateSnapshot(engine.snapshot());
  });
  it('valida timers e registros e isola CLI de controle de terminal e de comandos do host', () => {
    const { engine, client, server } = network();
    const terminal = new TerminalSession(engine, server.id);
    for (const command of [
      'enable',
      'configure terminal',
      'snmp-server community lab_read',
      'service snmp',
      'service syslog',
    ])
      expect(terminal.execute(command)).toBe('OK');
    expect(terminal.execute('show running-config')).toContain('service snmp');
    expect(
      engine.state.events
        .filter((event) => event.type === 'CONFIG_CHANGED')
        .every((event) => !event.reason.includes('lab_read'))
    ).toBe(true);
    const cli = new TerminalSession(engine, client.id);
    expect(cli.execute('snmp get 192.168.20.10 lab_read ' + nameOid)).toContain('SNMP [');
    const pending = engine.snapshot();
    pending.queue = pending.queue.filter(({ action }) => action.kind !== 'snmp-timeout');
    expect(() => validateSnapshot(pending)).toThrow('SNMP pendente sem timer');
    engine.sendSyslog(client.id, '\x1b]52;clipboard\x07 texto', 4);
    engine.advanceTo(100);
    expect(
      [...terminal.execute('show syslog')].some(
        (character) => character.charCodeAt(0) < 9 || character.charCodeAt(0) === 27
      )
    ).toBe(false);
    const invalid = engine.snapshot();
    invalid.devices.find((d) => d.id === server.id)!.syslogServer!.entries[0].receivedAt = invalid.clock + 1;
    expect(() => validateSnapshot(invalid)).toThrow('syslog fora do relógio');
    const before = engine.snapshot();
    expect(cli.execute('snmp get 192.168.20.10 public ' + nameOid + '; powershell')).toMatch(/^%/);
    expect(engine.snapshot()).toEqual(before);
  });
});
