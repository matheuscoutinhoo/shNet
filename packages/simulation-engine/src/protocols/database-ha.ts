import type { SimulationEngine } from '../core/engine';
import type { Device, Snapshot, TcpConnection } from '../model';
import { canonicalScenarioJson } from '../canonical-json';
import { executeSql } from './database-sql';
import { proposeQuorumLab } from './quorum-lab';
import { httpMessage, respondHttp } from './applications-http';
import { tcpFinished } from './tcp-model';

const deadlineMs = 3000;
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Consulta inválida.');
function answer(e: SimulationEngine, d: Device, connection: string, status: string, body: unknown) {
  const c = d.tcpConnections?.find((c) => c.id === connection);
  if (d.power && c && !tcpFinished(c)) respondHttp(e, d, c, status, JSON.stringify(body), 'application/json');
}

// Administrative initialization may inspect the selected configuration. Runtime
// application and responses below use ONLY the local committed message log.
export function configureDatabaseHa(e: SimulationEngine, d: Device) {
  if (!d.quorum) throw new Error('Configure um grupo de quorum antes de vincular o banco.');
  const members = d.quorum.node.members.map((id) => e.device(id)),
    commit = d.quorum.node.commit;
  for (const peer of members)
    if (
      !peer.power ||
      !peer.quorum ||
      peer.databaseHa ||
      !peer.database?.enabled ||
      peer.database.port !== d.database?.port ||
      peer.database.key !== d.database?.key ||
      peer.database.tables.length ||
      peer.quorum.node.commit !== commit ||
      peer.quorum.node.log.length !== commit ||
      peer.quorum.node.log.some((entry) => entry.command.kind === 'database')
    )
      throw new Error('Vincule réplicas ligadas, sincronizadas, com bancos vazios e mesma porta/chave.');
  for (const peer of members)
    peer.databaseHa = { cluster: peer.quorum!.node.cluster, start: commit, applied: commit, pending: [] };
  e.emit('CONFIG_CHANGED', d.id, 'Banco SQL vinculado ao quorum; respostas exigem confirmação de maioria.');
}

export function submitDatabaseHa(e: SimulationEngine, d: Device, c: TcpConnection, query: string) {
  const ha = d.databaseHa!,
    n = d.quorum?.node;
  if (!d.database?.enabled || !n || n.cluster !== ha.cluster || n.role !== 'leader') {
    if (d.database) d.database.rejected++;
    answer(e, d, c.id, '503 Service Unavailable', { error: 'Este servidor não é o líder do banco.' });
    return;
  }
  if (ha.pending.length >= 32 || n.log.length >= 256) {
    d.database.rejected++;
    answer(e, d, c.id, '503 Service Unavailable', {
      error: 'Limite do banco replicado; consulta não proposta.',
    });
    return;
  }
  // SELECT is also logged: its own current-term majority ACK provides the fresh
  // read barrier. Historical data or a local leader role is never sufficient.
  const receipt = proposeQuorumLab(e, d, { kind: 'database', query });
  ha.pending.push({ connection: c.id, ...receipt, deadline: e.state.clock + deadlineMs });
}

export function applyDatabaseHa(e: SimulationEngine, d: Device) {
  const ha = d.databaseHa,
    n = d.quorum?.node,
    db = d.database;
  if (!ha || !n || !db) return;
  for (let index = ha.applied + 1; index <= n.commit; index++) {
    const entry = n.log[index - 1];
    if (entry.command.kind === 'database') {
      let status = '200 OK',
        body: unknown;
      try {
        body = executeSql(db, entry.command.query);
        db.queries++;
      } catch (error) {
        status = '400 Bad Request';
        body = { error: errorText(error) };
        db.rejected++;
      }
      const pending = ha.pending.find((p) => p.index === index && p.term === entry.term);
      if (pending && e.state.clock < pending.deadline) {
        answer(e, d, pending.connection, status, body);
        ha.pending = ha.pending.filter((p) => p !== pending);
      }
    }
    ha.applied = index;
  }
  // A timeout means unknown outcome: the command may still be committed after
  // the connection closes. Never automatically retry a mutation or undo a log.
  ha.pending = ha.pending.filter((p) => {
    const entry = n.log[p.index - 1],
      c = d.tcpConnections?.find((c) => c.id === p.connection);
    if (entry?.term === p.term && e.state.clock < p.deadline && c && !tcpFinished(c)) return true;
    if (e.state.clock >= p.deadline || entry?.term !== p.term) {
      db.rejected++;
      answer(e, d, p.connection, '503 Service Unavailable', {
        error:
          'Sem confirmação de maioria; resultado indeterminado. Consulte o líder antes de repetir uma alteração.',
      });
    }
    return false;
  });
}

export function detachDatabaseHa(e: SimulationEngine, d: Device) {
  if (!d.databaseHa) return;
  for (const p of d.databaseHa.pending)
    answer(e, d, p.connection, '503 Service Unavailable', {
      error: 'Grupo removido; resultado indeterminado.',
    });
  delete d.databaseHa;
  // Removing a fixed membership must never create independent active writers.
  if (d.database) {
    d.database.enabled = false;
    for (const listener of d.tcpServices ?? [])
      if (listener.kind === 'database' && listener.port === d.database.port) listener.enabled = false;
  }
}

export function validateDatabaseHa(s: Snapshot) {
  for (const d of s.devices) {
    const ha = d.databaseHa,
      n = d.quorum?.node;
    if (!ha) {
      if (n?.log.some((entry) => entry.command.kind === 'database'))
        throw new Error('Histórico SQL exige adaptador do banco replicado.');
      continue;
    }
    if (!n || !d.database || ha.cluster !== n.cluster || ha.applied !== n.commit || ha.start > ha.applied)
      throw new Error('Banco replicado: identidade ou índice aplicado inválido.');
    for (const id of n.members) {
      const peer = s.devices.find((p) => p.id === id);
      if (
        !peer?.databaseHa ||
        peer.databaseHa.start !== ha.start ||
        peer.databaseHa.cluster !== ha.cluster ||
        peer.database?.port !== d.database.port ||
        peer.database?.key !== d.database.key
      )
        throw new Error('Banco replicado: associação dos membros incompatível.');
    }
    if (n.log.slice(0, ha.start).some((entry) => entry.command.kind === 'database'))
      throw new Error('Banco replicado: início posterior a operações SQL.');
    const expected = { tables: [] as NonNullable<Device['database']>['tables'] };
    for (const entry of n.log.slice(ha.start, ha.applied))
      if (entry.command.kind === 'database') {
        try {
          executeSql(expected, entry.command.query);
        } catch {
          /* Deterministic SQL rejection has no effect. */
        }
      }
    if (canonicalScenarioJson(expected.tables) !== canonicalScenarioJson(d.database.tables))
      throw new Error('Banco replicado: dados não correspondem ao histórico confirmado.');
    if (
      new Set(ha.pending.map((p) => p.connection)).size !== ha.pending.length ||
      new Set(ha.pending.map((p) => p.index)).size !== ha.pending.length
    )
      throw new Error('Banco replicado: respostas pendentes duplicadas.');
    for (const p of ha.pending) {
      const c = d.tcpConnections?.find((c) => c.id === p.connection),
        entry = n.log[p.index - 1];
      if (
        p.index <= ha.applied ||
        p.index <= ha.start ||
        entry?.term !== p.term ||
        entry.command.kind !== 'database' ||
        !c ||
        c.role !== 'server' ||
        c.service !== 'database' ||
        !c.httpHandled ||
        JSON.parse(httpMessage(c.received)?.body ?? 'null')?.query !== entry.command.query ||
        p.deadline > s.clock + deadlineMs
      )
        throw new Error('Banco replicado: operação pendente incoerente.');
    }
  }
}
