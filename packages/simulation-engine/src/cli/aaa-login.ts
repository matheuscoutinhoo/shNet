import type { SimulationEngine } from '../core/engine';
import type { Device } from '../model';
import type { AaaServerStats } from '../protocols/aaa-model';
import type { IosLine } from '../protocols/ios-system-model';
import { aaaGroupKind, aaaGroupServers, type AaaTarget } from '../protocols/aaa-servers';
import { completeAaa, eapProof, startRadius } from '../protocols/aaa';
import { openTacacs, sendTacacsAccounting } from '../protocols/tacacs';
import { waitFor } from './ping';
import { ALL_MODES, type CommandRegistry } from './registry';

export type AaaOutcome =
  | { status: 'pass'; kind: 'tacacs' | 'radius'; privilege?: number }
  | { status: 'fail' }
  | { status: 'error' };

function stats(e: SimulationEngine, d: Device, t: Pick<AaaTarget, 'kind' | 'name'>): AaaServerStats {
  const list = (d.aaaStats ??= []);
  let s = list.find((x) => x.kind === t.kind && x.name === t.name);
  if (!s) {
    s = {
      kind: t.kind,
      name: t.name,
      since: e.state.clock,
      authen: { request: 0, timeouts: 0, accept: 0, reject: 0 },
      author: { request: 0, timeouts: 0, pass: 0, fail: 0 },
      account: { request: 0 },
    };
    list.push(s);
    if (list.length > 16) list.shift();
  }
  return s;
}
/**
 * Runs the simulation until the server answers, the request times out (with its retransmissions)
 * or the TACACS+ connection is refused or reset, which IOS treats as an error at once.
 */
function awaitQuery(e: SimulationEngine, deviceId: string, id: string, limitMs: number) {
  const query = () => e.device(deviceId).aaaQueries?.find((q) => q.id === id);
  const refused = () => {
    const q = query();
    if (q?.method !== 'tacacs' || !q.connection) return false;
    const c = e.device(deviceId).tcpConnections?.find((x) => x.id === q.connection);
    return !c || ['RESET', 'CLOSED', 'TIMED-OUT'].includes(c.state);
  };
  waitFor(e, () => query()?.status !== 'pending' || refused(), limitMs);
  const q = query();
  if (q?.status === 'pending') completeAaa(e, e.device(deviceId), q);
  return q;
}
/**
 * One AAA method "group ..." for a login: each server of the group is asked in turn. A reject ends
 * the login (FAIL); a server that does not answer passes to the next one, and when none answers
 * the method is an ERROR and IOS tries the next method of the list.
 */
export function aaaAuthenticate(
  e: SimulationEngine,
  d: Device,
  method: string,
  username: string,
  password: string,
  authorize = false
): AaaOutcome {
  for (const target of aaaGroupServers(e, d, method)) {
    stats(e, e.device(d.id), target).authen.request++;
    if (!target.sourceIp) {
      stats(e, e.device(d.id), target).authen.timeouts++;
      continue;
    }
    const challenge = e.id('aaa-challenge'),
      proof = eapProof(username, password, challenge),
      started = e.state.clock;
    let id: string;
    try {
      const input = {
        username,
        key: target.key,
        server: target.address,
        sourceIp: target.sourceIp,
        challenge,
        proof,
      };
      id =
        target.kind === 'tacacs'
          ? openTacacs(e, e.device(d.id), input, {
              port: target.port,
              timeoutMs: target.timeoutMs,
              purpose: 'login',
              authorize,
              account: false,
            })
          : startRadius(e, e.device(d.id), {
              ...input,
              serverPort: target.port,
              timeoutMs: target.timeoutMs,
              maxAttempts: target.attempts,
              purpose: 'login',
            }).id;
    } catch {
      stats(e, e.device(d.id), target).authen.timeouts++;
      continue;
    }
    const q = awaitQuery(e, d.id, id, target.timeoutMs * target.attempts + 500),
      s = stats(e, e.device(d.id), target);
    if (q?.status === 'accepted' || q?.status === 'rejected') s.lastMs = Math.round(e.state.clock - started);
    if (q?.status === 'accepted') {
      s.authen.accept++;
      // RADIUS carries the privilege in the Access-Accept; TACACS+ only with exec authorization.
      const privilege = target.kind === 'radius' || authorize ? q.privilege : undefined;
      return { status: 'pass', kind: target.kind, ...(privilege !== undefined ? { privilege } : {}) };
    }
    if (q?.status === 'rejected') {
      s.authen.reject++;
      return { status: 'fail' };
    }
    s.authen.timeouts++;
  }
  return { status: 'error' };
}
const localUser = (d: Device, name?: string) =>
  name ? d.iosSystem?.users?.find((u) => u.name === name) : undefined;
/** The exec authorization list of a line ("authorization exec LIST" or default). */
function execAuthorization(d: Device, line: IosLine | undefined) {
  const aaa = d.iosSystem?.aaa;
  if (!aaa?.newModel) return undefined;
  // IOS never authorizes console sessions unless "aaa authorization console" is configured.
  if (line?.kind === 'con' && !aaa.authorization.some((x) => x.kind === 'console')) return undefined;
  const list = line?.authorizationExec ?? 'default';
  return aaa.authorization.find((x) => x.kind === 'exec' && (x.list ?? 'default') === list);
}
/** Whether a TACACS+ login must also ask the server for the exec authorization (priv-lvl). */
export function wantsServerExecAuthorization(d: Device, line: IosLine | undefined, method: string) {
  const kind = aaaGroupKind(d, method);
  return !!execAuthorization(d, line)?.methods?.some((m) => aaaGroupKind(d, m) === kind);
}
/**
 * The EXEC privilege of an authenticated login. Without "aaa new-model", "login local" applies the
 * user's privilege and the line password gives the line's level. With AAA, the privilege comes
 * from "aaa authorization exec" only (local database or the server's priv-lvl); without it every
 * session starts at the line's level (1). Returns undefined when exec authorization fails.
 */
export function execPrivilege(
  d: Device,
  line: IosLine | undefined,
  how: { via: 'local' | 'line' | 'enable' | 'none' | 'tacacs' | 'radius'; user?: string; privilege?: number }
) {
  const base = line?.privilege ?? 1,
    aaa = d.iosSystem?.aaa,
    local = localUser(d, how.user);
  if (!aaa?.newModel) return how.via === 'local' ? (local?.privilege ?? base) : base;
  const author = execAuthorization(d, line);
  if (!author) return base;
  for (const method of author.methods ?? []) {
    if (method === 'none') return base;
    if (method === 'local' || method === 'local-case') {
      if (local) return local.privilege ?? 1;
      continue;
    }
    if (aaaGroupKind(d, method) === how.via && how.privilege !== undefined) return how.privilege;
  }
  return author.ifAuthenticated ? base : undefined;
}
/** A command typed at privilege 15, checked by "aaa authorization commands 15" before it runs. */
export function authorizeCommand(
  e: SimulationEngine,
  d: Device,
  session: { console: boolean; user?: string },
  command: string
): boolean {
  const aaa = d.iosSystem?.aaa;
  if (!aaa?.newModel) return true;
  if (session.console && !aaa.authorization.some((x) => x.kind === 'console')) return true;
  const entry = aaa.authorization.find(
    (x) => x.kind === 'commands' && x.level === 15 && (x.list ?? 'default') === 'default'
  );
  if (!entry) return true;
  for (const method of entry.methods ?? []) {
    if (method === 'none') return true;
    if (method === 'local' || method === 'local-case') {
      const user = localUser(d, session.user);
      if (!user) continue;
      return (user.privilege ?? 1) >= 15;
    }
    // Only TACACS+ authorizes individual commands.
    if (aaaGroupKind(d, method) !== 'tacacs' || !session.user) continue;
    const verdict = tacacsCommand(e, d, method, session.user, command);
    if (verdict !== 'error') return verdict === 'permit';
  }
  return !!entry.ifAuthenticated;
}
function tacacsCommand(e: SimulationEngine, d: Device, method: string, user: string, command: string) {
  for (const target of aaaGroupServers(e, d, method)) {
    stats(e, e.device(d.id), target).author.request++;
    if (!target.sourceIp) {
      stats(e, e.device(d.id), target).author.timeouts++;
      continue;
    }
    let id: string;
    try {
      id = openTacacs(
        e,
        e.device(d.id),
        {
          username: user,
          key: target.key,
          server: target.address,
          sourceIp: target.sourceIp,
          challenge: e.id('aaa-challenge'),
          proof: '0'.repeat(32),
        },
        { port: target.port, timeoutMs: target.timeoutMs, purpose: 'authorization', command }
      );
    } catch {
      stats(e, e.device(d.id), target).author.timeouts++;
      continue;
    }
    const q = awaitQuery(e, d.id, id, target.timeoutMs + 500),
      s = stats(e, e.device(d.id), target);
    if (q?.status === 'accepted') {
      s.author.pass++;
      return 'permit';
    }
    if (q?.status === 'rejected') {
      s.author.fail++;
      return 'deny';
    }
    s.author.timeouts++;
  }
  return 'error';
}
/** The first reachable TACACS+ server of an accounting list (IOS accounting is sent, not awaited). */
function accountingTarget(e: SimulationEngine, d: Device, kind: 'exec' | 'commands', list: string) {
  const aaa = d.iosSystem?.aaa;
  if (!aaa?.newModel) return undefined;
  const entry = aaa.accounting.find(
    (x) => x.kind === kind && x.list === list && (kind === 'exec' || x.level === 15)
  );
  if (!entry || entry.record === 'none') return undefined;
  for (const method of entry.methods ?? []) {
    if (aaaGroupKind(d, method) !== 'tacacs') continue;
    const target = aaaGroupServers(e, d, method).find((t) => t.sourceIp);
    if (target) return { target: target as AaaTarget & { sourceIp: string }, record: entry.record };
  }
  return undefined;
}
/** "aaa accounting exec ... start-stop group ...": START at login, STOP when the session ends. */
export function accountExec(
  e: SimulationEngine,
  d: Device,
  line: IosLine | undefined,
  user: string | undefined,
  stage: 'start' | 'stop',
  task: string
) {
  const found = user ? accountingTarget(e, d, 'exec', line?.accountingExec ?? 'default') : undefined;
  if (!found || (stage === 'start' && found.record === 'stop-only')) return;
  stats(e, d, found.target).account.request++;
  sendTacacsAccounting(
    e,
    d,
    found.target,
    user!,
    ['service=shell', 'task_id=' + task],
    stage === 'start' ? 2 : 4
  );
}
/** "aaa accounting commands 15 ...": one record per command run at privilege 15. */
export function accountCommand(e: SimulationEngine, d: Device, user: string | undefined, command: string) {
  const found = user ? accountingTarget(e, d, 'commands', 'default') : undefined;
  if (!found) return;
  stats(e, d, found.target).account.request++;
  sendTacacsAccounting(
    e,
    d,
    found.target,
    user!,
    ['service=shell', 'task_id=' + e.id('task'), 'priv-lvl=15', 'cmd=' + command.slice(0, 240)],
    8
  );
}
const seconds = (ms: number) => Math.max(0, Math.floor(ms / 1000));
function elapsed(ms: number) {
  const s = seconds(ms);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  return Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm';
}
/** IOS "show aaa servers": every configured server with its counters. */
export function showAaaServers(e: SimulationEngine, d: Device) {
  const servers = d.iosSystem?.aaaServers ?? [];
  return servers
    .map((server, index) => {
      const s = d.aaaStats?.find((x) => x.kind === server.kind && x.name === server.name),
        since = s?.since ?? d.bootStartedAt ?? 0,
        authen = s?.authen ?? { request: 0, timeouts: 0, accept: 0, reject: 0 },
        author = s?.author ?? { request: 0, timeouts: 0, pass: 0, fail: 0 },
        account = s?.account ?? { request: 0 },
        host = server.address ?? 'not configured';
      return [
        server.kind === 'radius'
          ? `RADIUS: id ${index + 1}, priority ${index + 1}, host ${host}, auth-port ${server.authPort ?? 1645}, acct-port ${server.acctPort ?? 1646}, hostname ${server.name}`
          : `TACACS+: id ${index + 1}, priority ${index + 1}, host ${host}, auth-port ${server.port ?? 49}, hostname ${server.name}`,
        `     State: current UP, duration ${seconds(e.state.clock - since)}s, previous duration 0s`,
        '     Dead: total time 0s, count 0',
        '     Quarantined: No',
        `     Authen: request ${authen.request}, timeouts ${authen.timeouts}, failover 0, retransmission 0`,
        `             Response: accept ${authen.accept}, reject ${authen.reject}, challenge 0`,
        `             Response: unexpected 0, server error 0, incorrect 0, time ${s?.lastMs ?? 0}ms`,
        `             Transaction: success ${authen.accept + authen.reject}, failure ${authen.timeouts}`,
        `     Author: request ${author.request}, timeouts ${author.timeouts}, failover 0, retransmission 0`,
        `             Response: accept ${author.pass}, reject ${author.fail}, challenge 0`,
        `             Transaction: success ${author.pass + author.fail}, failure ${author.timeouts}`,
        `     Account: request ${account.request}, timeouts 0, failover 0, retransmission 0`,
        `             Transaction: success ${account.request}, failure 0`,
        `     Elapsed time since counters last cleared: ${elapsed(e.state.clock - since)}`,
      ].join('\n');
    })
    .join('\n\n');
}
export function registerAaaLoginCommands(r: CommandRegistry) {
  r.register({
    pattern: /^show aaa servers$/i,
    syntax: 'show aaa servers',
    modes: ALL_MODES,
    run: (_m, e, d) => showAaaServers(e, d),
  });
  r.register({
    pattern: /^clear aaa counters servers(?: all)?$/i,
    syntax: 'clear aaa counters servers all',
    modes: ['privileged'],
    run: (_m, _e, d) => {
      delete d.aaaStats;
      return '';
    },
  });
  r.register({
    // IOS troubleshooting: an authentication against a server group, outside any login.
    pattern: /^test aaa group (\S+) (\S+) (\S+)(?: (legacy|new-code))?$/i,
    syntax: 'test aaa group <group> <username> <password> legacy',
    modes: ['privileged'],
    run: (m, e, d) => {
      if (!d.iosSystem?.aaa?.newModel)
        throw new Error('AAA is not enabled: configure "aaa new-model" first.');
      const method = 'group ' + m[1],
        kind = aaaGroupKind(d, method);
      if (!kind) throw new Error('% Server group ' + m[1] + ' not found');
      const result = aaaAuthenticate(e, d, method, m[2], m[3]);
      return [
        'Attempting authentication test to server-group ' +
          m[1] +
          ' using ' +
          (kind === 'tacacs' ? 'tacacs+' : 'radius'),
        result.status === 'pass'
          ? 'User was successfully authenticated.'
          : result.status === 'fail'
            ? 'User authentication request was rejected by server.'
            : 'No authoritative response from any server.',
      ].join('\n');
    },
  });
}
