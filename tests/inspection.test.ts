import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  TerminalSession,
} from '../packages/simulation-engine/src';
function lab(pat = false) {
  const e = new SimulationEngine(makeTemplate(pat ? 'tcp' : 'routed')),
    pc = e.state.devices[0],
    r = e.state.devices.find((d) => d.type === 'router')!,
    server = e.state.devices.find((d) => d.type === 'server')!;
  e.configureFirewall(r.id, { enabled: true, trustedPorts: ['p0'] });
  e.configureTcpService(server.id, { kind: 'http', port: 80, enabled: true, body: 'HTTP permitido.' });
  e.configureInspection(r.id, {
    enabled: true,
    defaultAction: 'permit',
    rules: [
      { sequence: 10, application: 'http', action: 'deny', host: 'blocked.lab' },
      { sequence: 20, application: 'http', action: 'deny', pathPrefix: '/admin' },
      { sequence: 30, application: 'dns', action: 'deny', nameSuffix: 'blocked.lab' },
    ],
  });
  return { e, pc, r, server };
}
function request(e: SimulationEngine, id: string, host: string, path = '/', extra = '') {
  return e.openTcp(
    id,
    '192.168.20.10',
    80,
    `GET ${path} HTTP/1.1\r\n${extra}Host: ${host}\r\nConnection: close\r\n\r\n`,
    true
  );
}
describe('firewall classifica aplicações do tráfego real', () => {
  it('permite HTTP comum e bloqueia Host/caminho após handshake, inclusive por PAT', () => {
    for (const pat of [false, true]) {
      const { e, pc, r, server } = lab(pat);
      const okay = request(e, pc.id, 'allowed.lab'),
        blocked = request(e, pc.id, 'blocked.lab'),
        path = request(e, pc.id, 'allowed.lab', '/admin/users');
      e.advanceTo(1500);
      expect(pc.tcpConnections?.find((c) => c.id === okay)?.received).toContain('200 OK');
      expect(pc.tcpConnections?.find((c) => c.id === blocked)?.received).toBe('');
      expect(pc.tcpConnections?.find((c) => c.id === path)?.received).toBe('');
      expect(server.tcpConnections?.filter((c) => c.httpHandled)).toHaveLength(1);
      expect(r.firewall?.application?.flows.filter((f) => f.decision === 'deny')).toHaveLength(2);
      expect(r.firewall?.application?.rules.slice(0, 2).map((r) => r.hits)).toEqual([1, 1]);
      validateSnapshot(e.snapshot());
    }
  });
  it('recompõe cabeçalho em vários segmentos e save/load conserva classificação sem duplicar hits', () => {
    const { e, pc, r, server } = lab();
    const id = request(e, pc.id, 'blocked.lab', '/', 'X-Long: ' + 'a'.repeat(1000) + '\r\n');
    for (
      let n = 0;
      n < 100 && !r.firewall?.application?.flows.some((f) => f.buffer.length || f.pendingSegments?.length);
      n++
    )
      e.step();
    expect(r.firewall?.application?.flows[0].decision).toBe('pending');
    const s = JSON.parse(JSON.stringify(e.snapshot())),
      restored = new SimulationEngine(s);
    e.advanceTo(5000);
    restored.advanceTo(5000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    expect(r.firewall?.application?.rules[0].hits).toBe(1);
    expect(pc.tcpConnections?.find((c) => c.id === id)?.received).toBe('');
    expect(server.tcpConnections?.[0].httpHandled).toBe(false);
    const connection = server.tcpConnections![0];
    expect(
      connection.received.length + (connection.flow?.receiveQueue.reduce((n, p) => n + p.data.length, 0) ?? 0)
    ).toBeGreaterThan(0);
    validateSnapshot(e.snapshot());
  });
  it('DNS aplica fronteira de domínio e ação padrão unknown decide stream echo', () => {
    const { e, pc, r, server } = lab();
    for (const name of ['blocked.lab', 'sub.blocked.lab', 'notblocked.lab'])
      e.configureDnsRecord(server.id, { name, type: 'A', value: '203.0.113.1', ttl: 0 });
    const ids = ['blocked.lab', 'sub.blocked.lab', 'notblocked.lab'].map((name) =>
      e.lookupDns(pc.id, name, 'A', '192.168.20.10', undefined, 'udp')
    );
    e.advanceTo(1000);
    expect(pc.dnsQueries?.find((q) => q.id === ids[2])?.status).toBe('success');
    expect(ids.slice(0, 2).every((id) => pc.dnsQueries?.find((q) => q.id === id)?.status === 'pending')).toBe(
      true
    );
    expect(r.firewall?.application?.rules[2].hits).toBe(2);
    e.configureTcpService(server.id, { kind: 'echo', port: 7, enabled: true });
    e.configureInspection(r.id, { enabled: true, defaultAction: 'deny', rules: [] });
    const echo = e.openTcp(pc.id, '192.168.20.10', 7, 'echo desconhecido', true);
    e.advanceTo(2000);
    expect(pc.tcpConnections?.find((c) => c.id === echo)?.received).toBe('');
    expect(r.firewall?.application?.flows[0].application).toBe('unknown');
    validateSnapshot(e.snapshot());
  });
  it('CLI configura inspeção e rejeita timer órfão/regra incompatível', () => {
    const { e, r } = lab();
    const t = new TerminalSession(e, r.id);
    t.execute('enable');
    t.execute('conf t');
    expect(
      t.execute(
        'firewall application configure {"enabled":true,"defaultAction":"deny","rules":[{"sequence":1,"application":"dns","action":"permit","nameSuffix":"allowed.lab"}]}'
      )
    ).toBe('OK');
    expect(
      t.execute(
        'firewall application configure {"enabled":true,"defaultAction":"deny","rules":[{"sequence":1,"application":"dns","action":"permit","host":"allowed.lab"}]}'
      )
    ).toContain('inválida');
    const { e: other, pc, r: fw } = lab();
    request(other, pc.id, 'blocked.lab');
    other.advanceTo(1000);
    const bad = other.snapshot();
    bad.queue = bad.queue.filter((q) => q.action.kind !== 'inspection-expire');
    expect(() => validateSnapshot(bad)).toThrow('inspeção');
    other.configureInspection(fw.id, { enabled: false, defaultAction: 'permit', rules: [] });
    validateSnapshot(other.snapshot());
  });
});
