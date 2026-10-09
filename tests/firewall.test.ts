import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  TerminalSession,
  validateSnapshot,
  type UdpPacket,
} from '../packages/simulation-engine/src';

function network(pat = false) {
  const engine = new SimulationEngine(makeTemplate(pat ? 'tcp' : 'routed'));
  const client = engine.state.devices[0];
  const server = engine.state.devices.find((device) => device.type === 'server')!;
  const router = engine.state.devices.find((device) => device.type === 'router')!;
  engine.configureFirewall(router.id, { enabled: true, trustedPorts: ['p0'] });
  engine.configureDnsRecord(server.id, { name: 'firewall.lab', type: 'A', value: '203.0.113.50', ttl: 0 });
  return { engine, client, server, router };
}
function datagram(): UdpPacket {
  return {
    protocol: 'UDP',
    src: '192.168.10.10',
    dst: '192.168.20.10',
    sourcePort: 50123,
    destinationPort: 54,
    ttl: 64,
    bytes: 60,
    payload: {
      protocol: 'DNS',
      message: {
        type: 'query',
        transactionId: 42,
        question: { name: 'firewall.lab', type: 'A' },
        recursionDesired: false,
      },
    },
  };
}
function until(engine: SimulationEngine, ready: () => boolean) {
  for (let i = 0; i < 150 && !ready(); i++) {
    expect(engine.step()).toBe(true);
    validateSnapshot(engine.snapshot());
  }
  expect(ready()).toBe(true);
}

describe('firewall de trânsito multiprotocolo', () => {
  it('rastreia DNS UDP e ping por PAT, e restaura cada transporte em andamento', () => {
    const { engine, client, router, server } = network(true);
    const query = engine.lookupDns(client.id, 'firewall.lab', 'A', server.interfaces[0].ip, undefined, 'udp');
    const probe = engine.ping(client.id, server.interfaces[0].ip!);
    until(engine, () => router.firewall!.sessions.length === 2);
    expect(router.firewall!.sessions.map((session) => session.protocol).sort()).toEqual(['ICMP', 'UDP']);
    const restored = new SimulationEngine(engine.snapshot());
    until(
      engine,
      () =>
        client.dnsQueries?.find((entry) => entry.id === query)?.status === 'success' &&
        engine.state.probes.find((entry) => entry.id === probe)?.status === 'success'
    );
    restored.advanceTo(engine.state.clock);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(router.firewall!.sessions.every((session) => session.state === 'REPLIED')).toBe(true);
    expect(router.firewall!.dropped).toBe(0);
    expect(router.nat!.bindings.map((entry) => entry.protocol).sort()).toEqual(['ICMP', 'UDP']);
  });
  it('bloqueia UDP não solicitado, tuple alterado e retorno em outra interface', () => {
    const { engine, client, router, server } = network();
    const outgoing = datagram();
    const reply = {
      ...outgoing,
      src: outgoing.dst,
      dst: outgoing.src,
      sourcePort: 54,
      destinationPort: 50123,
    };
    engine.sendIp(server.id, reply);
    engine.advanceTo(100);
    expect(router.firewall!.sessions).toHaveLength(0);
    expect(router.firewall!.dropped).toBe(1);
    engine.sendIp(client.id, outgoing);
    engine.advanceTo(200);
    const pending = structuredClone(router.firewall!.sessions[0]);
    expect(pending.state).toBe('UNREPLIED');
    for (const packet of [
      { ...reply, sourcePort: 55 },
      { ...reply, destinationPort: 50124 },
      { ...reply, src: '192.168.20.99' },
    ])
      engine.sendIp(server.id, packet);
    const other = engine.addDevice('pc');
    Object.assign(other.interfaces[0], { ip: '192.168.30.10', prefix: 24 });
    other.gateway = '192.168.30.1';
    Object.assign(router.interfaces[2], { ip: '192.168.30.1', prefix: 24 });
    engine.connect({ device: other.id, port: 'p0' }, { device: router.id, port: 'p2' });
    engine.sendIp(other.id, reply);
    engine.advanceTo(300);
    expect(router.firewall!.dropped).toBe(5);
    expect(router.firewall!.sessions).toEqual([pending]);
    engine.sendIp(server.id, reply);
    engine.advanceTo(400);
    expect(router.firewall!.sessions[0].state).toBe('REPLIED');
    expect(router.firewall!.dropped).toBe(5);
    validateSnapshot(engine.snapshot());
  });
  it('correlaciona tipo e identificador ICMP sem abrir entrada para Echo Request externo', () => {
    const { engine, client, router, server } = network();
    engine.configureAcl(server.id, { name: 'SILENCE', rules: [] });
    engine.bindAcl(server.id, 'p0', 'out', 'SILENCE');
    const probe = engine.ping(client.id, server.interfaces[0].ip!);
    engine.advanceTo(100);
    const pending = structuredClone(router.firewall!.sessions[0]);
    engine.bindAcl(server.id, 'p0', 'out', undefined);
    for (const change of [
      { probeId: 'unsolicited' },
      { kind: 'echo-request' as const },
      { kind: 'time-exceeded' as const },
    ]) {
      engine.sendIp(server.id, {
        protocol: 'ICMP',
        src: server.interfaces[0].ip!,
        dst: client.interfaces[0].ip!,
        kind: 'echo-reply',
        ttl: 64,
        bytes: 32,
        probeId: probe,
        ...change,
      });
    }
    engine.advanceTo(200);
    expect(router.firewall!.dropped).toBe(3);
    expect(router.firewall!.sessions).toEqual([pending]);
    engine.sendIp(server.id, {
      protocol: 'ICMP',
      src: server.interfaces[0].ip!,
      dst: client.interfaces[0].ip!,
      kind: 'echo-reply',
      ttl: 64,
      bytes: 32,
      probeId: probe,
    });
    engine.advanceTo(300);
    expect(engine.state.probes.find((entry) => entry.id === probe)?.status).toBe('success');
    expect(router.firewall!.sessions[0].state).toBe('REPLIED');
    validateSnapshot(engine.snapshot());
  });
  it('expira UDP e ICMP e rejeita retorno tardio sem prolongar o timer', () => {
    const { engine, client, router, server } = network();
    const outgoing = datagram();
    engine.sendIp(client.id, outgoing);
    engine.ping(client.id, server.interfaces[0].ip!);
    engine.advanceTo(100);
    expect(router.firewall!.sessions).toHaveLength(2);
    engine.advanceTo(61000);
    expect(router.firewall!.sessions.map((session) => session.protocol)).toEqual(['UDP']);
    engine.advanceTo(121000);
    expect(router.firewall!.sessions).toHaveLength(0);
    engine.sendIp(server.id, {
      ...outgoing,
      src: outgoing.dst,
      dst: outgoing.src,
      sourcePort: 54,
      destinationPort: 50123,
    });
    engine.advanceTo(121100);
    expect(router.firewall!.sessions).toHaveLength(0);
    expect(router.firewall!.dropped).toBe(1);
    engine.sendIp(client.id, outgoing);
    engine.advanceTo(121200);
    expect(router.firewall!.sessions).toHaveLength(1);
    engine.configureFirewall(router.id, { enabled: false, trustedPorts: ['p0'] });
    expect(router.firewall!.sessions).toHaveLength(0);
    expect(engine.state.queue.some(({ action }) => action.kind === 'firewall-expire')).toBe(false);
    validateSnapshot(engine.snapshot());
  });
  it('mantém ACL sobre uma sessão UDP e recusa timers, protocolos e tuples inconsistentes', () => {
    const { engine, client, router, server } = network();
    const outgoing = datagram();
    engine.sendIp(client.id, outgoing);
    engine.advanceTo(100);
    const pending = structuredClone(router.firewall!.sessions[0]);
    engine.configureAcl(router.id, { name: 'BLOCK', rules: [] });
    engine.bindAcl(router.id, 'p1', 'in', 'BLOCK');
    engine.sendIp(server.id, {
      ...outgoing,
      src: outgoing.dst,
      dst: outgoing.src,
      sourcePort: 54,
      destinationPort: 50123,
    });
    engine.advanceTo(200);
    expect(router.firewall!.sessions).toEqual([pending]);
    expect(engine.state.events.some((event) => event.type === 'ACL_DENY')).toBe(true);
    for (const mutate of [
      (copy: ReturnType<SimulationEngine['snapshot']>) => {
        copy.queue = copy.queue.filter(({ action }) => action.kind !== 'firewall-expire');
      },
      (copy: ReturnType<SimulationEngine['snapshot']>) => {
        copy.devices.find((d) => d.id === router.id)!.firewall!.protocols = ['TCP'];
      },
      (copy: ReturnType<SimulationEngine['snapshot']>) => {
        copy.devices
          .find((d) => d.id === router.id)!
          .firewall!.sessions.push({ ...pending, id: 'duplicate' });
      },
      (copy: ReturnType<SimulationEngine['snapshot']>) => {
        copy.devices.find((d) => d.id === router.id)!.firewall!.sessions[0].outside = 'missing';
      },
    ]) {
      const invalid = engine.snapshot();
      mutate(invalid);
      expect(() => validateSnapshot(invalid)).toThrow();
    }
  });
  it('preserva snapshots TCP antigos e aplica seleção de protocolos pela CLI com rollback', () => {
    const { engine, client, router } = network(true);
    engine.httpGet(client.id, '192.168.20.10');
    engine.advanceTo(100);
    const legacy = engine.snapshot();
    const policy = legacy.devices.find((d) => d.id === router.id)!.firewall!;
    delete policy.protocols;
    policy.sessions.forEach((session) => Reflect.deleteProperty(session, 'protocol'));
    const restored = new SimulationEngine(legacy);
    expect(restored.device(router.id).firewall!.sessions[0].protocol).toBe('TCP');
    const cli = new TerminalSession(restored, router.id);
    for (const command of ['enable', 'configure terminal', 'service firewall'])
      expect(cli.execute(command)).toBe('OK');
    expect(restored.device(router.id).firewall!.protocols).toEqual(['TCP']);
    expect(cli.execute('firewall protocols udp icmp')).toBe('OK');
    expect(cli.execute('show running-config')).toContain('firewall protocols udp icmp');
    const before = restored.snapshot();
    expect(cli.execute('firewall protocols udp udp')).toMatch(/^%/);
    expect(restored.snapshot()).toEqual(before);
    expect(cli.execute('show firewall')).toContain('UDP, ICMP');
    validateSnapshot(restored.snapshot());
  });
});
