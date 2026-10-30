import { z } from 'zod';
import type { SimulationEngine } from '../core/engine';
import type { Action, Device, Snapshot, TcpConnection } from '../model';
import { quorumId } from './quorum-data';
import {
  databaseClusterConfigSchema,
  databaseRequestActive,
  type DatabaseClientRequest,
} from './database-client-model';
import { httpMessage } from './applications-http';
import { openTcp, closeTcp } from './tcp';
import { tcpBytes, tcpFinished } from './tcp-model';
import { normalize6 } from './ipv6-address';

const discoveryMs = 3000,
  queryMs = 5000,
  tickMs = 100;
const proofSchema = z
  .object({
    cluster: quorumId,
    term: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    index: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const canonicalAddress = (ip: string) => (ip.includes(':') ? normalize6(ip) : ip);
export function configureDatabaseClient(e: SimulationEngine, d: Device, input: unknown) {
  const config = databaseClusterConfigSchema.parse(input);
  config.targets = config.targets.map(canonicalAddress);
  if (d.databaseClient) d.databaseClient.config = config;
  else d.databaseClient = { config, requests: [], token: e.id('database-client') };
  return config;
}
function schedule(e: SimulationEngine, d: Device) {
  const state = d.databaseClient!;
  e.state.queue = e.state.queue.filter(
    (q) => q.action.kind !== 'database-client-tick' || q.action.device !== d.id
  );
  delete state.nextAt;
  if (state.requests.some(databaseRequestActive)) {
    state.nextAt = e.state.clock + tickMs;
    e.schedule(tickMs, { kind: 'database-client-tick', device: d.id, token: state.token });
  }
}
function finish(
  e: SimulationEngine,
  d: Device,
  r: DatabaseClientRequest,
  phase: 'complete' | 'failed' | 'unknown',
  error?: string
) {
  r.phase = phase;
  r.finished = e.state.clock;
  if (error) r.error = error.slice(0, 512);
  e.emit('APPLICATION_DATA', d.id, `SQL ${r.id}: ${phase}${error ? ' · ' + error : ''}`);
  schedule(e, d);
}
export function databaseClientWire(r: DatabaseClientRequest, discovery = r.phase === 'discovering') {
  const target = r.config.targets[r.cursor],
    host = target.includes(':') ? `[${target}]` : target;
  if (discovery)
    return `GET /leader HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${r.config.key}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
  const body = JSON.stringify({ query: r.query });
  return `POST /query HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nAuthorization: Bearer ${r.config.key}\r\nX-ShLab-Cluster: ${r.config.cluster}\r\nX-ShLab-Term: ${r.term}\r\nContent-Length: ${tcpBytes(body)}\r\nConnection: close\r\n\r\n${body}`;
}
function discover(e: SimulationEngine, d: Device, r: DatabaseClientRequest, next = false) {
  if (r.connection) {
    const old = d.tcpConnections?.find((c) => c.id === r.connection);
    if (old && !tcpFinished(old)) closeTcp(e, d, old.id, true);
  }
  delete r.connection;
  if (next) r.cursor++;
  while (r.cursor < r.config.targets.length) {
    r.phase = 'discovering';
    r.deadline = e.state.clock + discoveryMs;
    try {
      openTcp(e, d, r.config.targets[r.cursor], r.config.port, databaseClientWire(r), true, (c) => {
        r.connection = c.id;
      });
      return;
    } catch (error) {
      e.emit(
        'APPLICATION_DATA',
        d.id,
        `Descoberta SQL em ${r.config.targets[r.cursor]}: ${error instanceof Error ? error.message : 'falha de conexão'}`
      );
      r.cursor++;
      delete r.connection;
    }
  }
  r.cursor = r.config.targets.length - 1;
  finish(e, d, r, 'failed', 'Nenhuma réplica confirmou autoridade de líder. Consulta não enviada.');
}
export function queryDatabaseCluster(e: SimulationEngine, d: Device, query: string, input?: unknown) {
  z.string().min(1).max(2048).parse(query);
  const config = databaseClusterConfigSchema.parse(input ?? d.databaseClient?.config);
  if (!d.power) throw new Error('Cliente SQL desligado.');
  if ((d.databaseClient?.requests.filter(databaseRequestActive).length ?? 0) >= 8)
    throw new Error('Até oito consultas automáticas simultâneas por cliente.');
  configureDatabaseClient(e, d, config);
  const state = d.databaseClient!;
  if (state.requests.length >= 32)
    state.requests.splice(
      state.requests.findIndex((r) => !databaseRequestActive(r)),
      1
    );
  const r: DatabaseClientRequest = {
    id: e.id('sql-request'),
    config: structuredClone(state.config),
    query,
    phase: 'discovering',
    cursor: 0,
    started: e.state.clock,
    deadline: e.state.clock + discoveryMs,
  };
  state.requests.push(r);
  discover(e, d, r);
  schedule(e, d);
  return r.id;
}
export function receiveDatabaseClient(e: SimulationEngine, d: Device, c: TcpConnection) {
  if (c.role !== 'client') return false;
  const r = d.databaseClient?.requests.find((r) => databaseRequestActive(r) && r.connection === c.id);
  if (!r) return false;
  try {
    const response = httpMessage(c.received);
    if (!response) return true;
    const status = /^HTTP\/1\.1 (\d{3}) /.exec(response.line)?.[1];
    if (!status) throw new Error('Resposta HTTP inválida.');
    if (e.state.clock >= r.deadline) return true;
    if (r.phase === 'querying') {
      r.response = c.received;
      finish(
        e,
        d,
        r,
        status === '200' ? 'complete' : Number(status) >= 500 ? 'unknown' : 'failed',
        status === '200'
          ? undefined
          : Number(status) >= 500
            ? 'Resultado indeterminado; alteração não será repetida automaticamente.'
            : 'Consulta recusada pelo servidor.'
      );
    } else if (status === '401' || status === '403')
      finish(e, d, r, 'failed', 'Credenciais recusadas na descoberta; consulta não enviada.');
    else if (status !== '200') discover(e, d, r, true);
    else {
      const proof = proofSchema.parse(JSON.parse(response.body));
      if (proof.cluster !== r.config.cluster) {
        discover(e, d, r, true);
        return true;
      }
      r.term = proof.term;
      r.index = proof.index;
      r.phase = 'querying';
      r.deadline = e.state.clock + queryMs;
      // Exactly one POST per logical request. A lost response never replays it.
      try {
        openTcp(
          e,
          d,
          r.config.targets[r.cursor],
          r.config.port,
          databaseClientWire(r),
          true,
          (connection) => {
            r.connection = connection.id;
          }
        );
      } catch {
        finish(
          e,
          d,
          r,
          'unknown',
          'Falha ao enviar consulta; resultado indeterminado, sem repetição automática.'
        );
      }
    }
  } catch {
    if (r.phase === 'discovering') discover(e, d, r, true);
    else finish(e, d, r, 'unknown', 'Resposta inválida; resultado indeterminado, sem repetição automática.');
  }
  schedule(e, d);
  return true;
}
export function handleDatabaseClientTick(
  e: SimulationEngine,
  a: Extract<Action, { kind: 'database-client-tick' }>
) {
  const d = e.state.devices.find((d) => d.id === a.device),
    state = d?.databaseClient;
  if (!d || !state || state.token !== a.token) return;
  if (d.power)
    for (const r of state.requests.filter(databaseRequestActive)) {
      const c = d.tcpConnections?.find((c) => c.id === r.connection);
      if (e.state.clock >= r.deadline || !c || tcpFinished(c)) {
        if (r.phase === 'discovering') discover(e, d, r, true);
        else {
          finish(
            e,
            d,
            r,
            'unknown',
            'Conexão perdida ou timeout; resultado indeterminado, sem repetição automática.'
          );
          if (c && !tcpFinished(c)) closeTcp(e, d, c.id, true);
        }
      }
    }
  schedule(e, d);
}
export function validateDatabaseClient(s: Snapshot) {
  const ticks = new Map<string, Snapshot['queue']>();
  for (const q of s.queue)
    if (q.action.kind === 'database-client-tick') {
      const list = ticks.get(q.action.device);
      if (list) list.push(q);
      else ticks.set(q.action.device, [q]);
    }
  for (const d of s.devices) {
    const state = d.databaseClient;
    const timers = ticks.get(d.id) ?? [];
    if (!state) {
      if (timers.length) throw new Error('Cliente SQL sem estado.');
      continue;
    }
    const active = state.requests.filter(databaseRequestActive);
    if (
      active.length > 8 ||
      new Set(active.map((r) => r.connection)).size !== active.length ||
      new Set(state.requests.map((r) => r.id)).size !== state.requests.length ||
      (active.length
        ? timers.length !== 1 ||
          state.nextAt === undefined ||
          state.nextAt < s.clock ||
          state.nextAt > s.clock + tickMs ||
          timers[0].at !== state.nextAt ||
          timers[0].action.kind !== 'database-client-tick' ||
          timers[0].action.token !== state.token
        : timers.length !== 0 || state.nextAt !== undefined)
    )
      throw new Error('Timer ou capacidade do cliente SQL inválido.');
    for (const r of state.requests) {
      const c = d.tcpConnections?.find((c) => c.id === r.connection);
      if (
        r.cursor >= r.config.targets.length ||
        r.started > s.clock ||
        r.deadline < r.started ||
        r.deadline > s.clock + (r.phase === 'querying' ? queryMs : Math.max(discoveryMs, queryMs)) ||
        (databaseRequestActive(r)
          ? r.finished !== undefined ||
            !c ||
            c.role !== 'client' ||
            canonicalAddress(c.remoteIp) !== canonicalAddress(r.config.targets[r.cursor]) ||
            c.remotePort !== r.config.port ||
            c.bytesSent + tcpBytes(c.sendBuffer) !== tcpBytes(databaseClientWire(r)) ||
            !databaseClientWire(r).endsWith(c.sendBuffer) ||
            (r.phase === 'querying' && (!r.term || !r.index))
          : r.finished === undefined || r.finished > s.clock || r.finished < r.started) ||
        (r.phase === 'complete' && (!r.response || !/^HTTP\/1\.1 200 /.test(r.response)))
      )
        throw new Error('Requisição de descoberta SQL incoerente.');
    }
  }
}
