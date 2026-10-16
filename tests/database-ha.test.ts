import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  executeDatabase,
  configurationDiff,
} from '../packages/simulation-engine/src';
import { cloneTopology } from '../apps/web/src/workspace/cloneTopology';
import { duplicateDevice } from '../apps/web/src/workspace/duplicateDevice';

function fixture() {
  const e = new SimulationEngine(makeTemplate('database-quorum'));
  e.advanceTo(2000);
  return e;
}
const members = (e: SimulationEngine) => e.state.devices.filter((d) => d.databaseHa);
const leader = (e: SimulationEngine, except?: string) =>
  members(e).find((d) => d.power && d.id !== except && d.quorum?.node.role === 'leader')!;
const client = (e: SimulationEngine) => e.state.devices.find((d) => d.hostname === 'SQL-CLIENT')!;
function start(e: SimulationEngine, target: string, query: string, key = 'database-key') {
  return e.queryDatabase(client(e).id, e.device(target).interfaces[0].ip!, query, key);
}
function response(e: SimulationEngine, id: string) {
  return client(e).tcpConnections!.find((c) => c.id === id)!.received;
}
function query(e: SimulationEngine, target: string, sql: string, key = 'database-key') {
  const id = start(e, target, sql, key);
  e.advanceTo(e.state.clock + 400);
  return response(e, id);
}
function isolate(e: SimulationEngine, id: string, up: boolean) {
  for (const l of e.state.links)
    if (
      (l.a.device === id && Object.values(e.device(id).quorum!.ports).includes(l.a.port)) ||
      (l.b.device === id && Object.values(e.device(id).quorum!.ports).includes(l.b.port))
    )
      l.up = up;
}
const rows = (e: SimulationEngine) => members(e).map((d) => d.database!.tables);

describe('SQL service with majority-confirmed operations (R08)', () => {
  it('initializes atomically only with empty, synchronized databases and matching credentials', () => {
    for (const fault of ['data', 'key', 'offline', 'unsynced'] as const) {
      const e = new SimulationEngine(makeTemplate('quorum')),
        peers = e.state.devices;
      for (const d of peers) e.configureDatabase(d.id, { enabled: true, port: 8080, key: 'database-key' });
      if (fault === 'data') executeDatabase(peers[1], 'CREATE TABLE existing (id)');
      if (fault === 'key')
        e.configureDatabase(peers[1].id, { enabled: true, port: 8080, key: 'another-key' });
      if (fault === 'offline') e.setDevicePower(peers[1].id, false);
      if (fault === 'unsynced') {
        e.advanceTo(2000);
        const active = peers.find((d) => d.quorum!.node.role === 'leader')!;
        e.proposeQuorumLab(active.id, { kind: 'put', key: 'in-flight', value: 'value' });
      }
      const before = e.snapshot();
      expect(() => e.configureDatabaseHa(peers[0].id)).toThrow('Vincule');
      expect(e.snapshot()).toEqual(before);
      validateSnapshot(e.snapshot());
    }
  });

  it('replies over real HTTP/TCP only after commit and replicates ordered CRUD and SQL rejections', () => {
    const e = fixture(),
      active = leader(e),
      before = e.snapshot(),
      id = start(e, active.id, 'CREATE TABLE sensores (id, valor)');
    // A proposal and local role do not change the application database yet.
    while (!active.databaseHa!.pending.length) e.advanceTo(e.state.clock + 1);
    expect(response(e, id)).not.toContain('200 OK');
    expect(active.database!.tables).toEqual([]);
    expect(active.databaseHa!.pending[0].index).toBeGreaterThan(active.quorum!.node.commit);
    e.advanceTo(e.state.clock + 300);
    expect(response(e, id)).toContain('200 OK');
    expect(query(e, active.id, "INSERT INTO sensores (id, valor) VALUES (1, 'ação')")).toContain(
      '"affected":1'
    );
    expect(query(e, active.id, 'UPDATE sensores SET valor = 24 WHERE id = 1')).toContain('"affected":1');
    expect(query(e, active.id, 'UPDATE sensores SET missing = 7')).toContain('400 Bad Request');
    expect(query(e, active.id, 'SELECT * FROM sensores')).toContain('"valor":24');
    for (const tables of rows(e)) expect(tables).toEqual(active.database!.tables);
    expect(configurationDiff(before, e.snapshot())).toEqual([]);
    expect(query(e, active.id, 'DELETE FROM sensores WHERE id = 1')).toContain('"affected":1');
    expect(rows(e).every((tables) => tables[0].rows.length === 0)).toBe(true);
    validateSnapshot(e.snapshot());
  });

  it('refuses follower reads/writes, wrong credentials and local SQL bypass without proposing anything', () => {
    const e = fixture(),
      active = leader(e),
      follower = members(e).find((d) => d !== active)!;
    const length = active.quorum!.node.log.length;
    expect(query(e, follower.id, 'CREATE TABLE unsafe (id)')).toContain('503 Service Unavailable');
    expect(query(e, follower.id, 'SELECT * FROM unsafe')).toContain('503 Service Unavailable');
    expect(query(e, active.id, 'CREATE TABLE unsafe (id)', 'wrong-key')).toContain('401 Unauthorized');
    expect(() => executeDatabase(active, 'CREATE TABLE unsafe (id)')).toThrow('rede');
    expect(() =>
      e.proposeQuorumLab(active.id, { kind: 'database', query: 'CREATE TABLE unsafe (id)' })
    ).toThrow('autenticação');
    expect(() => e.proposeQuorumLab(active.id, { kind: 'put', key: 'bypass', value: 'x' })).toThrow('SQL');
    expect(active.quorum!.node.log).toHaveLength(length);
    expect(rows(e).every((tables) => !tables.length)).toBe(true);
    validateSnapshot(e.snapshot());
  });

  it('never serves stale reads or acknowledges isolated writes; the majority progresses and heals the old suffix', () => {
    const e = fixture(),
      old = leader(e);
    expect(query(e, old.id, 'CREATE TABLE sensores (id, valor)')).toContain('200 OK');
    expect(query(e, old.id, 'INSERT INTO sensores (id, valor) VALUES (1, 10)')).toContain('200 OK');
    isolate(e, old.id, false);
    const write = start(e, old.id, 'UPDATE sensores SET valor = 999'),
      read = start(e, old.id, 'SELECT * FROM sensores');
    e.advanceTo(e.state.clock + 2200);
    expect(response(e, write)).not.toContain('200 OK');
    expect(response(e, read)).not.toContain('200 OK');
    const replacement = leader(e, old.id);
    expect(replacement).toBeDefined();
    expect(query(e, replacement.id, 'UPDATE sensores SET valor = 20')).toContain('200 OK');
    expect(query(e, replacement.id, 'SELECT * FROM sensores')).toContain('"valor":20');
    e.advanceTo(e.state.clock + 1000);
    expect(response(e, write)).toContain('resultado indeterminado');
    expect(response(e, read)).toContain('503 Service Unavailable');
    expect(old.database!.tables[0].rows[0].valor).toBe(10);
    isolate(e, old.id, true);
    e.advanceTo(e.state.clock + 2000);
    for (const tables of rows(e)) expect(tables[0].rows[0].valor).toBe(20);
    expect(old.databaseHa!.pending).toEqual([]);
    validateSnapshot(e.snapshot());
  });

  it('preserves confirmed data through leader power loss and rejoining replicas', () => {
    const e = fixture(),
      old = leader(e);
    expect(query(e, old.id, 'CREATE TABLE durable (id)')).toContain('200 OK');
    expect(query(e, old.id, 'INSERT INTO durable (id) VALUES (7)')).toContain('200 OK');
    e.setDevicePower(old.id, false);
    e.advanceTo(e.state.clock + 2200);
    const replacement = leader(e);
    expect(replacement.id).not.toBe(old.id);
    expect(query(e, replacement.id, 'SELECT * FROM durable')).toContain('"id":7');
    expect(query(e, replacement.id, 'INSERT INTO durable (id) VALUES (8)')).toContain('200 OK');
    e.setDevicePower(old.id, true);
    e.advanceTo(e.state.clock + 2000);
    for (const tables of rows(e)) expect(tables[0].rows).toEqual([{ id: 7 }, { id: 8 }]);
    validateSnapshot(e.snapshot());
  });

  it('restores pending TCP responses and in-flight quorum messages deterministically', () => {
    const e = fixture(),
      active = leader(e),
      id = start(e, active.id, 'CREATE TABLE restored (id)');
    while (!active.databaseHa!.pending.length) e.advanceTo(e.state.clock + 1);
    const restored = new SimulationEngine(e.snapshot()),
      at = e.state.clock + 500;
    e.advanceTo(at);
    restored.advanceTo(at);
    expect(response(restored, id)).toContain('200 OK');
    expect(restored.snapshot()).toEqual(e.snapshot());
    validateSnapshot(restored.snapshot());
  });

  it('keeps the reply half open after FIN and bounds pending requests during loss of quorum', () => {
    const e = fixture(),
      active = leader(e);
    isolate(e, active.id, false);
    const ids = Array.from({ length: 33 }, (_, i) =>
      start(e, active.id, 'CREATE TABLE queued_' + i + ' (id)')
    );
    e.advanceTo(e.state.clock + 500);
    expect(active.databaseHa!.pending).toHaveLength(32);
    expect(active.tcpConnections!.filter((c) => c.state === 'CLOSE-WAIT' && !c.closeRequested)).toHaveLength(
      32
    );
    expect(ids.filter((id) => response(e, id).includes('consulta não proposta'))).toHaveLength(1);
    validateSnapshot(e.snapshot());
    e.advanceTo(e.state.clock + 3300);
    expect(active.databaseHa!.pending).toEqual([]);
    expect(ids.filter((id) => response(e, id).includes('resultado indeterminado'))).toHaveLength(32);
    expect(active.database!.tables).toEqual([]);
    validateSnapshot(e.snapshot());
  });

  it('exposes timeout as unknown outcome and can subsequently apply the timed-out command', () => {
    const e = fixture(),
      old = leader(e),
      peers = members(e).filter((d) => d !== old);
    for (const p of peers) e.setDevicePower(p.id, false);
    const id = start(e, old.id, 'CREATE TABLE uncertain (id)');
    e.advanceTo(e.state.clock + 3500);
    expect(response(e, id)).toContain('resultado indeterminado');
    expect(old.database!.tables).toEqual([]);
    for (const p of peers) e.setDevicePower(p.id, true);
    e.advanceTo(e.state.clock + 4000);
    expect(query(e, leader(e).id, 'SELECT * FROM uncertain')).toContain('200 OK');
    for (const tables of rows(e)) expect(tables[0].name).toBe('uncertain');
    validateSnapshot(e.snapshot());
  });

  it('applies committed operations while its SQL listener is administratively disabled', () => {
    const e = fixture(),
      active = leader(e),
      follower = members(e).find((d) => d !== active)!;
    e.configureDatabase(follower.id, { enabled: false, port: 8080, key: 'database-key' });
    expect(query(e, active.id, 'CREATE TABLE replicated (id)')).toContain('200 OK');
    expect(follower.database!.tables[0].name).toBe('replicated');
    e.configureDatabase(follower.id, { enabled: true, port: 8080, key: 'database-key' });
    expect(() =>
      e.configureDatabase(follower.id, { enabled: true, port: 9090, key: 'database-key' })
    ).toThrow('fixas');
    expect(() => e.configureTcpService(follower.id, { enabled: true, port: 8080, kind: 'echo' })).toThrow(
      'reservada'
    );
    e.configureTcpService(follower.id, { enabled: false, port: 8080, kind: 'database' });
    expect(follower.database!.enabled).toBe(false);
    validateSnapshot(e.snapshot());
    e.configureTcpService(follower.id, { enabled: true, port: 8080, kind: 'database' });
    validateSnapshot(e.snapshot());
  });

  it('refuses forged tables, application cursors, membership and pending responses', () => {
    const e = fixture(),
      active = leader(e),
      id = start(e, active.id, 'CREATE TABLE validated (id)');
    while (!active.databaseHa!.pending.length) e.advanceTo(e.state.clock + 1);
    const badPending = e.snapshot();
    badPending.devices.find((d) => d.id === active.id)!.databaseHa!.pending[0].connection = id;
    expect(() => validateSnapshot(badPending)).toThrow('pendente');
    e.advanceTo(e.state.clock + 400);
    const badData = e.snapshot();
    badData.devices.find((d) => d.id === active.id)!.database!.tables[0].rows.push({ id: 99 });
    expect(() => validateSnapshot(badData)).toThrow('histórico confirmado');
    const badIndex = e.snapshot();
    badIndex.devices.find((d) => d.id === active.id)!.databaseHa!.applied--;
    expect(() => validateSnapshot(badIndex)).toThrow('índice');
    const badMembers = e.snapshot();
    delete badMembers.devices.find((d) => d.id === active.id)!.databaseHa;
    expect(() => validateSnapshot(badMembers)).toThrow();
  });

  it('clones the complete configuration with empty independent data and disables isolated copies', () => {
    const e = fixture(),
      active = leader(e);
    query(e, active.id, 'CREATE TABLE private_data (id)');
    const before = e.snapshot(),
      ids = members(e).map((d) => d.id),
      cloned = cloneTopology(before, ids),
      copies = cloned.snapshot.devices.filter((d) => !before.devices.some((p) => p.id === d.id));
    expect(copies).toHaveLength(3);
    expect(copies.every((d) => d.databaseHa && d.database!.enabled && !d.database!.tables.length)).toBe(true);
    expect(copies.every((d) => d.quorum!.node.cluster !== active.quorum!.node.cluster)).toBe(true);
    expect(e.snapshot()).toEqual(before);
    validateSnapshot(cloned.snapshot);
    const copy = duplicateDevice(e, active).device;
    expect(copy.databaseHa).toBeUndefined();
    expect(copy.database!.enabled).toBe(false);
    expect(copy.database!.tables).toEqual([]);
    const partial = cloneTopology(before, [active.id]);
    expect(partial.warnings.join(' ')).toContain('vazios');
    validateSnapshot(partial.snapshot);
  });

  it('fails closed when the fixed group or a member is removed, preserving historical tables', () => {
    for (const removeMember of [false, true]) {
      const e = fixture(),
        active = leader(e);
      query(e, active.id, 'CREATE TABLE history (id)');
      if (removeMember) e.removeDevice(active.id);
      else e.removeQuorumLab(active.id);
      const databases = e.state.devices.filter((d) => d.database);
      expect(databases.length).toBe(removeMember ? 2 : 3);
      expect(databases.every((d) => !d.databaseHa && !d.quorum && !d.database!.enabled)).toBe(true);
      expect(databases.every((d) => d.database!.tables[0].name === 'history')).toBe(true);
      validateSnapshot(e.snapshot());
    }
  });

  it('rejects new requests at the explicit log bound without silently deleting confirmed data', () => {
    const e = fixture(),
      active = leader(e);
    // A valid bounded history of barriers avoids hundreds of unrelated TCP lifetimes.
    for (const d of members(e)) {
      const n = d.quorum!.node;
      n.log = Array.from({ length: 256 }, () => ({ term: n.term, command: { kind: 'barrier' as const } }));
      n.commit = 256;
      d.databaseHa!.applied = 256;
    }
    validateSnapshot(e.snapshot());
    expect(query(e, active.id, 'CREATE TABLE overflow (id)')).toContain('consulta não proposta');
    expect(rows(e).every((t) => !t.length)).toBe(true);
    validateSnapshot(e.snapshot());
  });
});
