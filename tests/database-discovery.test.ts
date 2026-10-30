import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  TerminalSession,
} from '../packages/simulation-engine/src';
import { httpMessage } from '../packages/simulation-engine/src/protocols/applications-http';
import { databaseRequestActive } from '../packages/simulation-engine/src/protocols/database-client-model';
import { cloneTopology } from '../apps/web/src/workspace/cloneTopology';
import { duplicateDevice } from '../apps/web/src/workspace/duplicateDevice';

function fixture() {
  const e = new SimulationEngine(makeTemplate('database-quorum'));
  e.advanceTo(2000);
  return e;
}
const client = (e: SimulationEngine) => e.state.devices.find((d) => d.hostname === 'SQL-CLIENT')!;
const members = (e: SimulationEngine) => e.state.devices.filter((d) => d.databaseHa);
const leader = (e: SimulationEngine, except?: string) =>
  members(e).find((d) => d.id !== except && d.quorum!.node.role === 'leader')!;
function query(e: SimulationEngine, sql: string) {
  const id = e.queryDatabaseCluster(client(e).id, sql);
  for (
    let i = 0;
    i < 180 && databaseRequestActive(client(e).databaseClient!.requests.find((r) => r.id === id)!);
    i++
  )
    e.advanceTo(e.state.clock + 100);
  return client(e).databaseClient!.requests.find((r) => r.id === id)!;
}
function isolate(e: SimulationEngine, id: string, up: boolean) {
  for (const l of e.state.links)
    if (
      (l.a.device === id && Object.values(e.device(id).quorum!.ports).includes(l.a.port)) ||
      (l.b.device === id && Object.values(e.device(id).quorum!.ports).includes(l.b.port))
    )
      l.up = up;
}
function probe(e: SimulationEngine, target: string, key = 'database-key') {
  return e.openTcp(
    client(e).id,
    target,
    8080,
    `GET /leader HTTP/1.1\r\nHost: ${target}\r\nAuthorization: Bearer ${key}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    true
  );
}
describe('SQL leader discovery through authenticated HTTP/TCP', () => {
  it('requires a fresh majority for discovery and preserves a pending probe through restore', () => {
    const e = fixture(),
      active = leader(e),
      target = active.interfaces[0].ip!;
    isolate(e, active.id, false);
    const id = probe(e, target);
    e.advanceTo(e.state.clock + 300);
    expect(client(e).tcpConnections!.find((c) => c.id === id)!.received).not.toContain('200 OK');
    expect(active.databaseHa!.pending.some((p) => p.discovery)).toBe(true);
    const restored = new SimulationEngine(e.snapshot()),
      until = e.state.clock + 3500;
    for (const engine of [e, restored]) engine.advanceTo(until);
    expect(restored.snapshot()).toEqual(e.snapshot());
    expect(client(e).tcpConnections!.find((c) => c.id === id)!.received).not.toContain('200 OK');
    expect(members(e).every((d) => d.database!.tables.length === 0)).toBe(true);
  });

  it('discovers over IPv6, exposes CLI results without credentials and validates each transition', () => {
    const e = fixture(),
      d = client(e);
    for (const [i, node] of [...members(e), d].entries())
      e.configureIpv6(node.id, 'p0', {
        auto: false,
        addresses: [{ ip: '2001:db8:90::' + (11 + i), prefix: 64 }],
      });
    const config = {
      ...d.databaseClient!.config,
      targets: members(e).map((_m, i) => '2001:db8:90::' + (11 + i)),
    };
    e.configureDatabaseClient(d.id, config);
    e.advanceTo(e.state.clock + 1500);
    const cli = new TerminalSession(e, d.id);
    expect(
      cli.execute('database cluster query ' + JSON.stringify({ query: 'CREATE TABLE ipv6 (id)' }))
    ).toContain('Consulta com descoberta');
    for (let i = 0; i < 500 && databaseRequestActive(d.databaseClient!.requests[0]); i++) {
      e.advanceTo(e.state.clock + 10);
      validateSnapshot(e.snapshot());
    }
    expect(d.databaseClient!.requests[0].phase).toBe('complete');
    const show = cli.execute('show database client');
    expect(show).toContain('complete');
    expect(show).not.toContain('database-key');
  });
  it('discovers without inspecting peers, uses fresh barriers and submits each mutation once', () => {
    const e = fixture();
    expect(query(e, 'CREATE TABLE records (id, valor)').phase).toBe('complete');
    const r = query(e, "INSERT INTO records (id, valor) VALUES (1, 'á🚀')");
    expect(r.phase).toBe('complete');
    expect(r.term).toBeGreaterThan(0);
    expect(r.index).toBeGreaterThan(0);
    expect(r.response).toContain('"affected":1');
    const posts = client(e).tcpConnections!.filter((c) => c.id === r.connection);
    expect(posts).toHaveLength(1);
    expect(query(e, 'SELECT * FROM records').response).toContain('á🚀');
    for (const d of members(e)) expect(d.database!.tables[0].rows).toEqual([{ id: 1, valor: 'á🚀' }]);
    validateSnapshot(e.snapshot());
  });
  it('finds the new leader after power loss and refuses an isolated old leader', () => {
    const e = fixture();
    expect(query(e, 'CREATE TABLE records (id)').phase).toBe('complete');
    const old = leader(e);
    isolate(e, old.id, false);
    e.advanceTo(e.state.clock + 1800);
    const next = leader(e, old.id);
    expect(next).toBeDefined();
    const cfg = client(e).databaseClient!.config;
    cfg.targets = [
      old.interfaces[0].ip!,
      ...members(e)
        .filter((d) => d !== old)
        .map((d) => d.interfaces[0].ip!),
    ];
    const r = query(e, 'INSERT INTO records (id) VALUES (42)');
    expect(r.phase).toBe('complete');
    expect(r.config.targets[r.cursor]).toBe(next.interfaces[0].ip);
    expect(old.database!.tables[0].rows).toEqual([]);
    isolate(e, old.id, true);
    e.advanceTo(e.state.clock + 1000);
    e.setDevicePower(next.id, false);
    e.advanceTo(e.state.clock + 2000);
    expect(query(e, 'SELECT * FROM records').response).toContain('42');
    validateSnapshot(e.snapshot());
  });
  it('authenticates discovery before proposing and rejects stale fences before SQL admission', () => {
    const e = fixture(),
      active = leader(e),
      before = active.quorum!.node.log.length;
    const c = probe(e, active.interfaces[0].ip!, 'incorrect-key');
    e.advanceTo(e.state.clock + 200);
    expect(client(e).tcpConnections!.find((t) => t.id === c)!.received).toContain('401 Unauthorized');
    expect(active.quorum!.node.log.length).toBe(before);
    const body = JSON.stringify({ query: 'CREATE TABLE forbidden (id)' });
    const id = e.openTcp(
      client(e).id,
      active.interfaces[0].ip!,
      8080,
      `POST /query HTTP/1.1\r\nContent-Type: application/json\r\nAuthorization: Bearer database-key\r\nX-ShLab-Cluster: ${active.databaseHa!.cluster}\r\nX-ShLab-Term: 999\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
      true
    );
    e.advanceTo(e.state.clock + 200);
    expect(client(e).tcpConnections!.find((c) => c.id === id)!.received).toContain('409 Conflict');
    expect(active.database!.tables).toEqual([]);
    expect(active.quorum!.node.log.length).toBe(before);
  });
  it('does not send SQL to a different cluster or retry after an unknown outcome', () => {
    const e = fixture(),
      d = client(e);
    const cfg = structuredClone(d.databaseClient!.config);
    cfg.cluster = 'other-cluster';
    const id = e.queryDatabaseCluster(d.id, 'CREATE TABLE forbidden (id)', cfg);
    e.advanceTo(e.state.clock + 1500);
    expect(d.databaseClient!.requests.find((r) => r.id === id)!.phase).toBe('failed');
    expect(members(e).every((d) => d.database!.tables.length === 0)).toBe(true);
    e.configureDatabaseClient(d.id, { ...cfg, cluster: leader(e).databaseHa!.cluster });
    expect(query(e, 'CREATE TABLE records (id)').phase).toBe('complete');
    const requestId = e.queryDatabaseCluster(d.id, 'INSERT INTO records (id) VALUES (7)');
    let r = d.databaseClient!.requests.find((r) => r.id === requestId)!;
    while (r.phase === 'discovering') e.advanceTo(e.state.clock + 1);
    expect(r.phase).toBe('querying');
    const target = leader(e);
    // Let the POST commit, then cut only the server-to-client LAN before reply.
    for (let i = 0; !target.database!.tables[0].rows.length && i < 2000; i++) e.advanceTo(e.state.clock + 1);
    expect(target.database!.tables[0].rows).toHaveLength(1);
    const lan = e.state.links.find(
      (l) =>
        (l.a.device === target.id && l.a.port === 'p0') || (l.b.device === target.id && l.b.port === 'p0')
    )!;
    lan.up = false;
    e.advanceTo(e.state.clock + 6000);
    r = d.databaseClient!.requests.find((r) => r.id === requestId)!;
    expect(r.phase).toBe('unknown');
    const post = r.connection;
    lan.up = true;
    e.advanceTo(e.state.clock + 2000);
    expect(r.connection).toBe(post);
    expect(members(e).every((d) => d.database!.tables[0].rows.length === 1)).toBe(true);
    expect(r.phase).toBe('unknown');
    validateSnapshot(e.snapshot());
  });
  it('resumes discovery and POST in flight deterministically and rejects forged timers/configuration', () => {
    for (const phase of ['discovering', 'querying']) {
      const e = fixture(),
        d = client(e);
      const id = e.queryDatabaseCluster(d.id, 'CREATE TABLE records (id)');
      for (let i = 0; d.databaseClient!.requests[0].phase !== phase && i < 5000; i++)
        e.advanceTo(e.state.clock + 1);
      expect(d.databaseClient!.requests[0].phase).toBe(phase);
      const snapshot = e.snapshot(),
        restored = new SimulationEngine(snapshot),
        until = e.state.clock + 2000;
      for (const engine of [e, restored]) engine.advanceTo(until);
      expect(restored.snapshot()).toEqual(e.snapshot());
      expect(client(restored).databaseClient!.requests.find((r) => r.id === id)!.phase).toBe('complete');
      const missing = structuredClone(snapshot);
      missing.queue = missing.queue.filter((q) => q.action.kind !== 'database-client-tick');
      expect(() => validateSnapshot(missing)).toThrow('cliente SQL');
      const invalid = structuredClone(snapshot);
      invalid.devices.find((x) => x.id === d.id)!.databaseClient!.requests[0].cursor = 4;
      expect(() => validateSnapshot(invalid)).toThrow();
      const copy = duplicateDevice(e, d).device;
      expect(copy.databaseClient).toBeUndefined();
      const cloned = cloneTopology(e.snapshot(), [d.id]);
      expect(
        cloned.snapshot.devices.find((x) => !e.state.devices.some((p) => p.id === x.id))!.databaseClient
      ).toBeUndefined();
    }
    expect(() => {
      const e = fixture();
      e.configureDatabaseClient(client(e).id, {
        ...client(e).databaseClient!.config,
        cluster: 'x\r\nInjected: value',
      });
    }).toThrow();
  });
  it('bounds pending work, stops after the configured candidates and never treats a probe as a SQL mutation', () => {
    const e = fixture(),
      d = client(e);
    for (const m of members(e)) e.setDevicePower(m.id, false);
    for (let i = 0; i < 8; i++) e.queryDatabaseCluster(d.id, 'CREATE TABLE should_not_exist (id)');
    expect(() => e.queryDatabaseCluster(d.id, 'CREATE TABLE overflow (id)')).toThrow('oito');
    e.advanceTo(e.state.clock + 10000);
    expect(d.databaseClient!.requests.every((r) => r.phase === 'failed')).toBe(true);
    expect(d.databaseClient!.nextAt).toBeUndefined();
    expect(d.tcpConnections!.every((c) => !httpMessage(c.received)?.line.includes('200'))).toBe(true);
    validateSnapshot(e.snapshot());
  });
});
