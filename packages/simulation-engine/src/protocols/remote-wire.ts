import type { SimulationEngine } from '../core/engine';
import type { Action, Device } from '../model';
import { z } from 'zod';
import type { TcpConnection } from './tcp-model';
import { closeTcp } from './tcp';
import { openRemoteSession, receiveRemoteSession } from './remote-session';
import { tlsClientConfigSchema } from './tls-model';
import {
  remoteRpcSchema,
  remoteQuerySchema,
  automationConfigSchema,
  type RemoteResponse,
  type RemoteQuery,
} from './remote-model';
import { isUnicast } from './dhcp-config';
export const remoteInputSchema = remoteRpcSchema
  .extend({
    target: z.ipv4(),
    protocol: z.enum(['netconf', 'restconf']),
    username: z.string().regex(/^[a-zA-Z0-9_.@-]{1,64}$/),
    password: z.string().min(1).max(64),
    key: z.string().min(8).max(64),
    tls: tlsClientConfigSchema.optional(),
  })
  .strict();
export function requestRemote(e: SimulationEngine, d: Device, input: unknown, job?: string) {
  const c = remoteInputSchema.parse(input);
  if (!isUnicast(c.target)) throw new Error('Gerenciamento exige destino unicast.');
  if (
    c.protocol === 'restconf' &&
    !['hello', 'get', 'get-config', 'patch', 'replace', 'create', 'delete'].includes(c.operation)
  )
    throw new Error('RESTCONF suporta hello/get/get-config/patch.');
  if (c.protocol === 'netconf' && ['patch', 'replace', 'create', 'delete'].includes(c.operation))
    throw new Error('NETCONF usa edit-config e commit.');
  d.remoteQueries ??= [];
  if (d.remoteQueries.length >= 128) {
    const i = d.remoteQueries.findIndex(
      (q) => q.status !== 'pending' && !d.automationJobs?.some((j) => j.queries.includes(q.id))
    );
    if (i < 0) throw new Error('Limite de consultas remotas; remova jobs concluídos.');
    d.remoteQueries.splice(i, 1);
  }
  const rpc = remoteRpcSchema.parse({
      operation: c.operation,
      datastore: c.datastore,
      patch: c.patch,
      source: c.source,
      config: c.config,
      resource: c.resource,
      offset: c.offset,
      ifMatch: c.ifMatch,
    }),
    id = e.id('remote');
  const q: RemoteQuery = remoteQuerySchema.parse({
    id,
    target: c.target,
    protocol: c.protocol,
    key: c.key,
    username: c.username,
    rpc,
    connection: 'pending',
    status: 'pending',
    startedAt: e.state.clock,
    deadline: e.state.clock + 10000,
    ...(job ? { job } : {}),
  });
  d.remoteQueries.push(q);
  const automation = d.automationJobs?.find((j) => j.id === job);
  automation?.queries.push(id);
  e.schedule(10000, { kind: 'remote-timeout', device: d.id, query: id, at: q.deadline });
  try {
    openRemoteSession(e, d, c, q);
  } catch (error) {
    d.remoteQueries = d.remoteQueries.filter((n) => n !== q);
    if (automation) automation.queries = automation.queries.filter((n) => n !== id);
    e.state.queue = e.state.queue.filter(
      (x) => x.action.kind !== 'remote-timeout' || x.action.device !== d.id || x.action.query !== id
    );
    throw error;
  }
  e.emit('REMOTE_REQUEST', d.id, c.protocol.toUpperCase() + ' ' + rpc.operation + ' → ' + c.target + '.');
  return id;
}
function complete(e: SimulationEngine, d: Device, q: RemoteQuery, response?: RemoteResponse) {
  if (q.status !== 'pending') return;
  q.status = response ? (response.ok ? 'success' : 'error') : 'timeout';
  q.response = response;
  e.state.queue = e.state.queue.filter(
    (x) => x.action.kind !== 'remote-timeout' || x.action.device !== d.id || x.action.query !== q.id
  );
  e.emit(
    'REMOTE_RESPONSE',
    d.id,
    q.protocol.toUpperCase() +
      ' ' +
      q.rpc.operation +
      ': ' +
      q.status +
      (response?.error ? ' — ' + response.error : '') +
      '.'
  );
  const job = d.automationJobs?.find((j) => j.id === q.job && j.status === 'running');
  if (job) {
    job.updatedAt = e.state.clock;
    if (q.status !== 'success') job.status = 'error';
    else {
      job.index++;
      if (job.index === job.steps.length) job.status = 'success';
      else e.schedule(0.001, { kind: 'automation-next', device: d.id, job: job.id });
    }
    e.emit(
      'AUTOMATION_STATE',
      d.id,
      job.name + ': ' + job.index + '/' + job.steps.length + ' ' + job.status + '.'
    );
  }
}
export function handleRemoteTimeout(e: SimulationEngine, a: Extract<Action, { kind: 'remote-timeout' }>) {
  const d = e.device(a.device),
    q = d.remoteQueries?.find((q) => q.id === a.query && q.status === 'pending' && q.deadline === a.at);
  if (q) {
    complete(e, d, q);
    closeTcp(e, d, q.connection, true);
  }
}
export function receiveRemote(e: SimulationEngine, d: Device, c: TcpConnection) {
  receiveRemoteSession(e, d, c, complete);
}
export function runAutomation(e: SimulationEngine, d: Device, input: unknown) {
  const config = automationConfigSchema.parse(input);
  d.automationJobs ??= [];
  if (d.automationJobs.length >= 16) {
    const i = d.automationJobs.findIndex((j) => j.status !== 'running');
    if (i < 0) throw new Error('Limite de jobs ativos.');
    d.automationJobs.splice(i, 1);
  }
  const job = {
    ...config,
    id: e.id('automation'),
    status: 'running' as const,
    index: 0,
    queries: [] as string[],
    startedAt: e.state.clock,
    updatedAt: e.state.clock,
  };
  d.automationJobs.push(job);
  e.schedule(0.001, { kind: 'automation-next', device: d.id, job: job.id });
  e.emit('AUTOMATION_STATE', d.id, job.name + ': job iniciado.');
  return job.id;
}
export function handleAutomation(e: SimulationEngine, a: Extract<Action, { kind: 'automation-next' }>) {
  const d = e.device(a.device),
    j = d.automationJobs?.find((j) => j.id === a.job && j.status === 'running');
  if (!j) return;
  try {
    const step = j.steps[j.index];
    requestRemote(e, d, { ...step, key: j.key, username: j.username, password: j.password }, j.id);
  } catch (error) {
    j.status = 'error';
    e.emit('AUTOMATION_STATE', d.id, j.name + ': ' + (error as Error).message);
  }
  j.updatedAt = e.state.clock;
}
