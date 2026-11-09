import type { SimulationEngine } from '../core/engine';
import type { Device } from '../model';
import { aaaQuerySchema, type AaaQuery, type RadiusResponse } from './aaa-model';
import { openTcp, closeTcp, flushTcp } from './tcp';
import { queueTcpText } from './tcp-services';
import { tcpBytes, type TcpConnection } from './tcp-model';
import { radiusRequest, authorizeAaa, completeAaa } from './aaa';
import {
  decodeTacacs,
  encodeTacacs,
  tacacsSession,
  tacacsStart,
  readTacacsStart,
  tacacsArguments,
  readTacacsArguments,
  tacacsAuthorizationReply,
  readTacacsAuthorization,
  type TacacsPacket,
} from './aaa-codec';
function send(e: SimulationEngine, d: Device, c: TcpConnection, m: TacacsPacket, key: string) {
  queueTcpText(c, encodeTacacs(m, key) + '\n');
  flushTcp(e, d, c);
}
/** Login exchange, last phase: the exec accounting START record. */
function sendAccountingStart(e: SimulationEngine, d: Device, c: TcpConnection, q: AaaQuery, key: string) {
  send(
    e,
    d,
    c,
    {
      type: 3,
      sequence: 1,
      session: tacacsSession(q.id, 3),
      body: tacacsArguments(q.username, ['service=shell', 'task_id=' + q.id], 2),
    },
    key
  );
}
function result(q: AaaQuery, accepted: boolean): RadiusResponse {
  return {
    type: accepted ? 'Access-Accept' : 'Access-Reject',
    id: q.id,
    requestAuthenticator: q.requestAuthenticator,
    privilege: accepted ? (q.privilege ?? 0) : 0,
    ...(accepted && q.vlan ? { vlan: q.vlan } : {}),
    commands: accepted ? (q.commands ?? ['*']) : [],
    sessionMs: accepted ? Math.max(5000, (q.expiresAt ?? q.startedAt + 60000) - q.startedAt) : 5000,
    authenticator: '0'.repeat(32),
    wire: '00',
  };
}
export interface TacacsOptions {
  port?: number;
  timeoutMs?: number;
  purpose?: AaaQuery['purpose'];
  // Login: run the authorization (exec) and accounting (start) phases after authentication.
  authorize?: boolean;
  account?: boolean;
  // Command authorization: "cmd=WORD cmd-arg=..." for one command line.
  command?: string;
}
/** TACACS+ arguments of a command line, as IOS sends them for command authorization. */
export function tacacsCommandArgs(command: string) {
  const [cmd, ...args] = command.trim().split(/\s+/);
  return ['service=shell', 'cmd=' + cmd, ...args.map((a) => 'cmd-arg=' + a), 'cmd-arg=<cr>'];
}
export function openTacacs(
  e: SimulationEngine,
  d: Device,
  input: Pick<AaaQuery, 'username' | 'key' | 'server' | 'sourceIp' | 'challenge' | 'proof'>,
  options: TacacsOptions = {}
) {
  d.aaaQueries ??= [];
  if (d.aaaQueries.length >= 128) {
    const index = d.aaaQueries.findIndex(
      (q) =>
        q.status !== 'pending' &&
        d.networkAuth?.query !== q.id &&
        !d.interfaces.some((p) => p.dot1x?.query === q.id)
    );
    if (index < 0) throw new Error('Limite de consultas AAA.');
    d.aaaQueries.splice(index, 1);
  }
  const timeoutMs = options.timeoutMs ?? 10000,
    authorizing = options.command !== undefined;
  const q = aaaQuerySchema.parse({
    ...input,
    id: e.id('tacacs'),
    method: 'tacacs',
    status: 'pending',
    startedAt: e.state.clock,
    deadline: e.state.clock + timeoutMs,
    attempts: 1,
    requestAuthenticator: '0'.repeat(32),
    tacacsPhase: authorizing ? 'authorization' : 'authentication',
    ...(options.port !== undefined && options.port !== 49 ? { serverPort: options.port } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(options.purpose ? { purpose: options.purpose } : {}),
    ...(options.authorize !== undefined ? { authorize: options.authorize } : {}),
    ...(options.account !== undefined ? { account: options.account } : {}),
    ...(authorizing ? { command: options.command!.slice(0, 512) } : {}),
  });
  q.requestAuthenticator = radiusRequest(q).authenticator;
  d.aaaQueries.push(q);
  const first: TacacsPacket = authorizing
    ? {
        type: 2,
        sequence: 1,
        session: tacacsSession(q.id, 2),
        body: tacacsArguments(q.username, tacacsCommandArgs(q.command!)),
      }
    : {
        type: 1,
        sequence: 1,
        session: tacacsSession(q.id, 1),
        body: tacacsStart(q.username, q.challenge, q.proof),
      };
  openTcp(
    e,
    d,
    q.server,
    options.port ?? 49,
    encodeTacacs(first, q.key) + '\n',
    false,
    (c) => {
      c.service = 'aaa';
      c.stream = { readBytes: 0, writtenBytes: 0 };
      q.connection = c.id;
    },
    undefined,
    undefined,
    q.sourceIp
  );
  e.schedule(timeoutMs, { kind: 'aaa-timeout', device: d.id, query: q.id, at: q.deadline });
  e.emit(
    'AAA_SENT',
    d.id,
    authorizing
      ? 'TACACS+ autorização de comando TCP/' + (options.port ?? 49) + ': ' + q.command + '.'
      : 'TACACS+ CHAP, autorização e accounting TCP/' + (options.port ?? 49) + ': ' + q.id + '.'
  );
  return q.id;
}
/** An IOS accounting record (exec start/stop or a command) sent to a TACACS+ server; no answer is awaited. */
export function sendTacacsAccounting(
  e: SimulationEngine,
  d: Device,
  target: { address: string; key: string; port: number; sourceIp: string },
  username: string,
  args: string[],
  flag: 2 | 4 | 8
) {
  const id = e.id('tacacs-accounting');
  try {
    openTcp(
      e,
      d,
      target.address,
      target.port,
      encodeTacacs(
        { type: 3, sequence: 1, session: tacacsSession(id, 3), body: tacacsArguments(username, args, flag) },
        target.key
      ) + '\n',
      false,
      (c) => {
        c.service = 'aaa';
        c.stream = { readBytes: 0, writtenBytes: 0 };
      },
      undefined,
      undefined,
      target.sourceIp
    );
  } catch (cause) {
    e.drop(d, 'Accounting TACACS+: ' + (cause as Error).message);
  }
}
export function accountTacacs(e: SimulationEngine, d: Device, command?: string) {
  const config = d.aaaClient,
    auth = d.networkAuth;
  if (config?.method !== 'tacacs' || !auth || auth.expiresAt <= e.state.clock) return;
  const id = e.id('tacacs-accounting'),
    args = ['service=shell', 'task_id=' + auth.query, ...(command ? ['cmd=' + command] : [])];
  try {
    openTcp(
      e,
      d,
      config.server,
      49,
      encodeTacacs(
        {
          type: 3,
          sequence: 1,
          session: tacacsSession(id, 3),
          body: tacacsArguments(auth.username, args, command ? 8 : 4),
        },
        config.key
      ) + '\n',
      false,
      (c) => {
        c.service = 'aaa';
        c.stream = { readBytes: 0, writtenBytes: 0 };
      }
    );
  } catch (cause) {
    e.drop(d, 'Accounting TACACS+: ' + (cause as Error).message);
  }
}
export function receiveTacacs(e: SimulationEngine, d: Device, c: TcpConnection) {
  try {
    while (c.received.includes('\n')) {
      const at = c.received.indexOf('\n'),
        line = c.received.slice(0, at),
        bytes = tcpBytes(c.received.slice(0, at + 1));
      c.received = c.received.slice(at + 1);
      c.bytesReceived -= bytes;
      c.stream!.readBytes += bytes;
      const q = d.aaaQueries?.find(
        (q) => q.connection === c.id && q.status === 'pending' && q.method === 'tacacs'
      );
      // The answer to an accounting record (or to a query already decided) needs no processing.
      if (c.role !== 'server' && !q) {
        c.closeRequested = true;
        continue;
      }
      const key = c.role === 'server' ? d.aaaServer?.key : q!.key;
      if (!key) throw new Error('Sessão TACACS+ sem chave.');
      const m = decodeTacacs(line, key);
      if (c.role === 'server') {
        const server = d.aaaServer;
        if (
          !server?.enabled ||
          !server.tacacs ||
          (server.clients.length && !server.clients.includes(c.remoteIp)) ||
          m.sequence !== 1
        )
          throw new Error('NAS/sequência TACACS+ não autorizado.');
        if (m.type === 1) {
          const start = readTacacsStart(m.body),
            r = authorizeAaa(e, d, c.remoteIp, 'tacacs', {
              ...start,
              id: String(m.session),
              type: 'Access-Request',
              authenticator: '0'.repeat(32),
              wire: '00',
            });
          send(
            e,
            d,
            c,
            { ...m, sequence: 2, body: new Uint8Array([r.type === 'Access-Accept' ? 1 : 2, 0, 0, 0, 0, 0]) },
            key
          );
        } else {
          const request = readTacacsArguments(m.body, m.type === 3),
            user = server.users.find((u) => u.enabled && u.username === request.username),
            authenticated = server.accounting.some(
              (a) =>
                a.stage === 'authentication' &&
                a.accepted &&
                a.username === request.username &&
                a.source === c.remoteIp &&
                e.state.clock - a.at <= (user?.sessionMs ?? 0)
            );
          if (m.type === 2) {
            if (!request.args.includes('service=shell')) throw new Error('Serviço TACACS+ não suportado.');
            const cmd = request.args.find((a) => a.startsWith('cmd='))?.slice(4);
            if (cmd) {
              // Command authorization: the user's command set decides, as on ISE/ACS.
              const line = [
                cmd,
                ...request.args
                  .filter((a) => a.startsWith('cmd-arg=') && a !== 'cmd-arg=<cr>')
                  .map((a) => a.slice(8)),
              ].join(' ');
              const permitted =
                !!user &&
                (user.commands.includes('*') ||
                  user.commands.some((p) => line === p || line.startsWith(p + ' ')));
              const shown = line.slice(0, 120);
              e.emit(
                'AAA_RESULT',
                d.id,
                permitted
                  ? `TACACS+: comando "${shown}" de ${request.username} autorizado.`
                  : `TACACS+: comando "${shown}" de ${request.username} negado.`
              );
              send(e, d, c, { ...m, sequence: 2, body: tacacsAuthorizationReply(permitted, []) }, key);
              continue;
            }
            const args =
              user && authenticated
                ? [
                    'service=shell',
                    'priv-lvl=' + user.privilege,
                    'session-ms=' + user.sessionMs,
                    ...(user.vlan ? ['vlan=' + user.vlan] : []),
                    ...user.commands.map((cmd) => 'cmd-prefix=' + cmd),
                  ]
                : [];
            send(
              e,
              d,
              c,
              { ...m, sequence: 2, body: tacacsAuthorizationReply(!!user && authenticated, args) },
              key
            );
          } else {
            const command = request.args.find((a) => a.startsWith('cmd='))?.slice(4),
              // Accounting records from an authorized NAS are always acknowledged and logged.
              accepted = true;
            server.accounting.push({
              at: e.state.clock,
              username: request.username,
              method: 'tacacs',
              source: c.remoteIp,
              accepted,
              privilege: user?.privilege ?? 0,
              stage: request.flag === 2 ? 'start' : request.flag === 4 ? 'stop' : 'command',
              ...(command ? { command: command.slice(0, 512) } : {}),
            });
            server.accounting = server.accounting.slice(-128);
            send(e, d, c, { ...m, sequence: 2, body: new Uint8Array([0, 0, 0, 0, accepted ? 1 : 2]) }, key);
            c.closeRequested = true;
          }
        }
      } else {
        if (!q) continue;
        if (m.sequence !== 2) throw new Error('Sequência de resposta TACACS+ inválida.');
        const expected = q.tacacsPhase === 'authentication' ? 1 : q.tacacsPhase === 'authorization' ? 2 : 3;
        if (m.type !== expected || m.session !== tacacsSession(q.id, expected))
          throw new Error('Resposta TACACS+ fora da sessão/fase.');
        if (m.type === 1) {
          if (m.body.length !== 6 || ![1, 2].includes(m.body[0]) || m.body.slice(1).some(Boolean))
            throw new Error('Authentication REPLY inválido.');
          if (m.body[0] !== 1) {
            completeAaa(e, d, q, result(q, false));
            c.closeRequested = true;
            continue;
          }
          // An IOS login without exec authorization by this server only needs the authentication.
          if (q.authorize === false) {
            if (q.account === false) {
              completeAaa(e, d, q, result(q, true));
              c.closeRequested = true;
            } else {
              q.tacacsPhase = 'accounting';
              sendAccountingStart(e, d, c, q, key);
            }
            continue;
          }
          q.tacacsPhase = 'authorization';
          send(
            e,
            d,
            c,
            {
              type: 2,
              sequence: 1,
              session: tacacsSession(q.id, 2),
              body: tacacsArguments(q.username, ['service=shell']),
            },
            key
          );
        } else if (m.type === 2) {
          const authorization = readTacacsAuthorization(m.body);
          if (!authorization.accepted || q.purpose === 'authorization') {
            completeAaa(e, d, q, result(q, authorization.accepted));
            c.closeRequested = true;
            continue;
          }
          const arg = (name: string) =>
              authorization.args.find((a) => a.startsWith(name + '='))?.slice(name.length + 1),
            privilege = Number(arg('priv-lvl')),
            sessionMs = Number(arg('session-ms')),
            vlan = arg('vlan');
          if (
            !Number.isInteger(privilege) ||
            privilege < 0 ||
            privilege > 15 ||
            !Number.isInteger(sessionMs) ||
            sessionMs < 5000 ||
            sessionMs > 3600000 ||
            (vlan && (!Number.isInteger(Number(vlan)) || Number(vlan) < 1 || Number(vlan) > 4094))
          )
            throw new Error('Política TACACS+ inválida.');
          q.privilege = privilege;
          q.expiresAt = q.startedAt + sessionMs;
          q.commands = authorization.args.filter((a) => a.startsWith('cmd-prefix=')).map((a) => a.slice(11));
          q.vlan = vlan ? Number(vlan) : undefined;
          if (q.account === false) {
            completeAaa(e, d, q, result(q, true));
            c.closeRequested = true;
            continue;
          }
          q.tacacsPhase = 'accounting';
          sendAccountingStart(e, d, c, q, key);
        } else {
          if (m.body.length !== 5 || m.body.slice(0, 4).some(Boolean) || ![1, 2].includes(m.body[4]))
            throw new Error('Accounting REPLY inválido.');
          completeAaa(e, d, q, result(q, m.body[4] === 1));
          c.closeRequested = true;
        }
      }
    }
  } catch (cause) {
    e.drop(d, 'TACACS+: ' + (cause as Error).message);
    closeTcp(e, d, c.id, true);
  }
}
