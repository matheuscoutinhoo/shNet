import { publicKey } from './security-crypto';
import type { Snapshot } from '../model';
import { isUnicast } from './dhcp-config';
export function validateRemote(s: Snapshot) {
  const timers = s.queue.filter(
    (q) => q.action.kind === 'remote-timeout' || q.action.kind === 'automation-next'
  );
  for (const d of s.devices) {
    const config = d.remoteManagement;
    if (config) {
      if (
        d.type === 'pc' ||
        (!!config.identity &&
          (publicKey(config.identity.seed) !== config.identity.certificate.publicKey ||
            config.identity.certificate.usage !== 'server')) ||
        new Set(config.sessions.map((t) => t.connection)).size !== config.sessions.length ||
        new Set(config.users.map((u) => u.username)).size !== config.users.length ||
        new Set(config.clients).size !== config.clients.length ||
        config.clients.some((ip) => !isUnicast(ip)) ||
        config.seen.some(
          (n) =>
            n.at > s.clock ||
            !isUnicast(n.source) ||
            n.id !== n.response.id ||
            n.response.revision > config.revision
        ) ||
        (config.enabled &&
          d.tcpServices?.some(
            (t) => t.enabled && ((config.netconf && t.port === 830) || (config.restconf && t.port === 443))
          ))
      )
        throw new Error('Servidor NETCONF/RESTCONF inválido.');
      for (const t of config.sessions) {
        const connection = d.tcpConnections?.find((c) => c.id === t.connection);
        if (
          (t.stage !== 'closed' && !connection) ||
          (connection &&
            (connection.role !== 'server' || !['netconf', 'restconf'].includes(connection.service))) ||
          t.tls.role !== 'server' ||
          (['hello', 'rpc'].includes(t.stage) && (t.tls.phase !== 'ESTABLISHED' || !t.tls.master))
        )
          throw new Error('Sessão TLS de gerenciamento inválida.');
      }
      const c = config.candidate?.config;
      if (
        c &&
        (new Set(c.interfaces.map((p) => p.id)).size !== c.interfaces.length ||
          c.interfaces.length !== d.interfaces.length ||
          c.interfaces.some(
            (p) =>
              !d.interfaces.some((n) => n.id === p.id) || (p.ip === undefined) !== (p.prefix === undefined)
          ))
      )
        throw new Error('Candidate inválido.');
    }
    const queries = d.remoteQueries ?? [],
      jobs = d.automationJobs ?? [];
    if (
      new Set(queries.map((q) => q.id)).size !== queries.length ||
      new Set(jobs.map((j) => j.id)).size !== jobs.length
    )
      throw new Error('ID de RPC/job duplicado.');
    for (const q of queries) {
      const connection = d.tcpConnections?.find((c) => c.id === q.connection),
        ts = timers.filter(
          (t) => t.action.kind === 'remote-timeout' && t.action.device === d.id && t.action.query === q.id
        );
      if (
        !isUnicast(q.target) ||
        (!!q.transport &&
          (q.transport.connection !== q.connection ||
            q.transport.tls.role !== 'client' ||
            (['hello', 'rpc'].includes(q.transport.stage) &&
              (q.transport.tls.phase !== 'ESTABLISHED' || !q.transport.tls.master)))) ||
        q.startedAt > s.clock ||
        q.deadline < q.startedAt ||
        (connection &&
          (connection.role !== 'client' ||
            connection.service !== q.protocol ||
            connection.remoteIp !== q.target ||
            connection.remotePort !== (q.protocol === 'netconf' ? 830 : 443))) ||
        (q.status === 'pending' && !connection) ||
        (q.response && (q.response.id !== q.id || (q.status === 'success') !== q.response.ok)) ||
        ['success', 'error'].includes(q.status) !== !!q.response ||
        (q.status === 'pending'
          ? ts.length !== 1 ||
            ts[0].at !== q.deadline ||
            ts[0].action.kind !== 'remote-timeout' ||
            ts[0].action.at !== q.deadline
          : ts.length !== 0)
      )
        throw new Error('Consulta/timer NETCONF/RESTCONF inválido.');
      if (q.response?.data) JSON.parse(q.response.data);
    }
    for (const j of jobs) {
      const next = timers.filter(
          (t) => t.action.kind === 'automation-next' && t.action.device === d.id && t.action.job === j.id
        ),
        qs = j.queries.map((id) => queries.find((q) => q.id === id));
      if (
        j.updatedAt > s.clock ||
        j.startedAt > j.updatedAt ||
        j.index > j.steps.length ||
        j.queries.length > j.steps.length ||
        qs.some(
          (q, i) =>
            !q ||
            q.job !== j.id ||
            q.target !== j.steps[i].target ||
            q.protocol !== j.steps[i].protocol ||
            q.rpc.operation !== j.steps[i].operation
        ) ||
        qs.slice(0, j.index).some((q) => q?.status !== 'success') ||
        (j.status === 'success' && (j.index !== j.steps.length || next.length)) ||
        (j.status === 'error' && next.length) ||
        (j.status === 'running' &&
          (j.index >= j.steps.length || next.length + qs.filter((q) => q?.status === 'pending').length !== 1))
      )
        throw new Error('Estado da automação inválido.');
    }
  }
  for (const t of timers) {
    const a = t.action;
    if (
      (a.kind === 'remote-timeout' &&
        !s.devices
          .find((d) => d.id === a.device)
          ?.remoteQueries?.some((q) => q.id === a.query && q.status === 'pending')) ||
      (a.kind === 'automation-next' &&
        !s.devices
          .find((d) => d.id === a.device)
          ?.automationJobs?.some((j) => j.id === a.job && j.status === 'running'))
    )
      throw new Error('Timer remoto/automação órfão.');
  }
}
