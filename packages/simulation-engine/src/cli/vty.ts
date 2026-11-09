import type { SimulationEngine } from '../core/engine';
import type { Device } from '../model';
import type { IosLine } from '../protocols/ios-system-model';
import { ipv4Schema } from '../schemas';
import { vtyLineFor, vtyLines, type VtyTransport } from '../protocols/vty';
import { ALL_MODES, type CommandRegistry, type Context } from './registry';
import { waitFor } from './ping';
import { verifyIosSecret } from './local-security';
import { findInterface } from '../protocols/interface-name';
import { openTcp } from '../protocols/tcp';
import { aaaAuthenticate, execPrivilege, wantsServerExecAuthorization } from './aaa-login';

/** A Telnet/SSH connection opened from a terminal, waiting for its login to complete. */
export interface VtyConnection {
  // Device the session reaches (owner of the server end of the TCP connection).
  target: string;
  address: string;
  // Client end of the TCP connection, on the device that opened it.
  connection: string;
  transport: VtyTransport;
  username?: string;
}
type Method = 'local' | 'line' | 'enable' | 'none' | `group ${string}`;
/**
 * How a line authenticates: IOS "login" (line password), "login local" or an AAA method list.
 * With "aaa new-model" a line without "login authentication" uses the default list; without a
 * default list VTY lines use the local database and the console needs no login. Without AAA the
 * console asks for nothing unless "login" (with a password) or "login local" is configured, while
 * VTY lines default to "login" with the line password.
 */
export function vtyLogin(d: Device, line: IosLine | undefined): { methods: Method[]; noLogin?: boolean } {
  const aaa = d.iosSystem?.aaa,
    console = line?.kind === 'con';
  const list = (name: string) =>
    aaa?.authentication
      .find((a) => a.kind === 'login' && a.list === name)
      ?.methods.map((m) => (m === 'local-case' ? 'local' : m) as Method);
  if (aaa?.newModel) {
    const named = typeof line?.login === 'object' ? list(line.login.list) : undefined;
    const methods = named ?? list('default');
    if (methods) return { methods };
    return console ? { methods: ['none'], noLogin: true } : { methods: ['local'] };
  }
  if (console) {
    if (line?.login === 'local') return { methods: ['local'] };
    if (line?.login === 'line' && line.password) return { methods: ['line'] };
    return { methods: ['none'], noLogin: true };
  }
  if (line?.noLogin) return { methods: ['none'], noLogin: true };
  if (line?.login === 'local') return { methods: ['local'] };
  // A VTY line defaults to "login" with the line password.
  return { methods: ['line'] };
}
/** Whether the login asks for a username first (local database or AAA servers). */
export const vtyNeedsUsername = (d: Device, line: IosLine | undefined) => {
  const first = vtyLogin(d, line).methods[0];
  return first === 'local' || first.startsWith('group ');
};
export type LoginResult = { privilege: number; via: string } | 'invalid' | 'unauthorized';
/**
 * Checks a login against the methods in order. A method that cannot answer (no local users, no
 * line password, AAA servers that do not respond) passes to the next one; a wrong password or a
 * server reject fails the login. The EXEC privilege then follows IOS exec authorization.
 */
export function verifyVtyLogin(
  e: SimulationEngine,
  d: Device,
  line: IosLine | undefined,
  username: string | undefined,
  password: string
): LoginResult {
  const grant = (how: Parameters<typeof execPrivilege>[2]): LoginResult => {
    const privilege = execPrivilege(e.device(d.id), line, how);
    return privilege === undefined ? 'unauthorized' : { privilege, via: how.via };
  };
  for (const method of vtyLogin(d, line).methods) {
    if (method === 'none') return grant({ via: 'none', user: username });
    if (method.startsWith('group ')) {
      if (!username) continue;
      const result = aaaAuthenticate(
        e,
        d,
        method,
        username,
        password,
        wantsServerExecAuthorization(d, line, method)
      );
      if (result.status === 'error') continue;
      if (result.status === 'fail') return 'invalid';
      return grant({ via: result.kind, user: username, privilege: result.privilege });
    }
    if (method === 'line') {
      if (!line?.password) continue;
      return line.password === password ? grant({ via: 'line' }) : 'invalid';
    }
    if (method === 'enable') {
      if (!d.enableSecret) continue;
      return verifyIosSecret(password, d.enableSecret) ? grant({ via: 'enable' }) : 'invalid';
    }
    const users = d.iosSystem?.users ?? [];
    if (!users.length) continue;
    const user = users.find((u) => u.name === username);
    const ok =
      !!user &&
      (user.secret
        ? /^\$[89]\$/.test(user.secret) && verifyIosSecret(password, user.secret)
        : user.password === password);
    return ok ? grant({ via: 'local', user: username }) : 'invalid';
  }
  return 'invalid';
}

function resolveHost(e: SimulationEngine, target: string) {
  if (ipv4Schema.safeParse(target).success) return target;
  const host = e.state.devices
    .find((v) => v.hostname.toLowerCase() === target.toLowerCase())
    ?.interfaces.find((i) => i.ip)?.ip;
  if (!host) throw new Error('% Unknown command or computer name, or unable to find computer address');
  return host;
}
/** Opens the TCP connection and waits for the handshake, like IOS before printing "Open". */
function connect(
  e: SimulationEngine,
  d: Device,
  host: string,
  port: number,
  transport: VtyTransport,
  vrf?: string,
  source?: string
): VtyConnection {
  const address = resolveHost(e, host);
  if (!d.power) throw new Error('% Connection timed out; remote host not responding');
  let id: string;
  try {
    const from = source ? findInterface(d, source) : undefined;
    if (source && !from?.ip) throw new Error('% Invalid source interface');
    id = openTcp(e, d, address, port, '', false, undefined, vrf, undefined, from?.ip);
  } catch (error) {
    const text = error instanceof Error ? error.message : '';
    if (text.startsWith('%')) throw error;
    throw new Error('% Destination unreachable; gateway or host down', { cause: error });
  }
  const connection = () => e.device(d.id).tcpConnections?.find((c) => c.id === id);
  waitFor(e, () => connection()?.state !== 'SYN-SENT', 30000);
  const c = connection();
  if (c?.state === 'RESET') throw new Error('% Connection refused by remote host');
  if (!c || c.state !== 'ESTABLISHED') {
    if (c && c.state === 'SYN-SENT') e.closeTcp(d.id, id, true);
    throw new Error('% Connection timed out; remote host not responding');
  }
  const serverEnd = () => {
    for (const v of e.state.devices) {
      const s = v.tcpConnections?.find(
        (x) =>
          x.service === 'vty' &&
          x.role === 'server' &&
          x.localPort === port &&
          x.remotePort === c.localPort &&
          (x.remoteIp === c.localIp || x.localIp === c.remoteIp) &&
          ['SYN-RECEIVED', 'ESTABLISHED'].includes(x.state)
      );
      if (s) return { device: v, connection: s };
    }
    return undefined;
  };
  // The handshake's last ACK is still on its way to the server.
  waitFor(e, () => serverEnd()?.connection.state === 'ESTABLISHED', 5000);
  const server = serverEnd();
  if (server?.connection.state !== 'ESTABLISHED') {
    e.closeTcp(d.id, id, true);
    throw new Error('% Connection refused by remote host');
  }
  return { target: server.device.id, address, connection: id, transport };
}
/** The server end of a VTY session on the target device. */
export function vtyServerConnection(e: SimulationEngine, origin: Device, v: VtyConnection) {
  const client = e.device(origin.id).tcpConnections?.find((c) => c.id === v.connection);
  if (!client) return undefined;
  return e
    .device(v.target)
    .tcpConnections?.find(
      (s) =>
        s.service === 'vty' &&
        s.role === 'server' &&
        s.remotePort === client.localPort &&
        s.localPort === client.remotePort
    );
}
export const vtyLine = (e: SimulationEngine, v: VtyConnection) => vtyLineFor(e.device(v.target), v.transport);

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
};
/** IOS "show users": the console and every Telnet/SSH session on the VTY lines. */
function showUsers(e: SimulationEngine, d: Device, c: Context) {
  const vtyBase = d.type === 'router' ? 2 : 1;
  const sessions = (d.tcpConnections ?? []).filter(
    (s) => s.service === 'vty' && s.role === 'server' && s.state === 'ESTABLISHED'
  );
  const first = vtyLines(d)[0]?.first ?? 0;
  return [
    '    Line       User       Host(s)              Idle       Location',
    `${c.vtySession ? ' ' : '*'}  0 con 0                idle                 00:00:00   `,
    ...sessions.map((s, i) => {
      const n = first + i;
      return (
        (c.vtySession === s.id ? '*' : ' ') +
        String(vtyBase + n).padStart(3) +
        ' ' +
        ('vty ' + n).padEnd(10) +
        ' ' +
        (s.vtyUser ?? '').padEnd(10) +
        ' idle                 ' +
        clock(e.state.clock - s.updatedAt).padEnd(11) +
        s.remoteIp
      );
    }),
    '',
    '  Interface    User               Mode         Idle     Peer Address',
    '',
  ].join('\n');
}

export function registerVtyCommands(r: CommandRegistry) {
  r.register({
    pattern: /^telnet (\S+)(?: (\d+))?((?: \/(?:vrf \S+|source-interface \S+))*)$/i,
    syntax: ['telnet <host> [port] [/vrf NAME] [/source-interface INTERFACE]'],
    modes: ['user', 'privileged'],
    run: (m, e, d, c) => {
      const options = m[3] ?? '';
      const vrf = /\/vrf (\S+)/i.exec(options)?.[1];
      const source = /\/source-interface (\S+)/i.exec(options)?.[1];
      const port = m[2] ? Number(m[2]) : 23;
      if (!(port >= 1 && port <= 65535)) throw new Error('% Invalid port number');
      const address = ipv4Schema.safeParse(m[1]).success ? m[1] : undefined;
      const lines = ['Trying ' + (address ?? m[1]) + (port !== 23 ? ', ' + port : '') + ' ... '];
      try {
        c.vty = connect(e, d, m[1], port, 'telnet', vrf, source);
      } catch (error) {
        return lines.join('') + '\n' + (error instanceof Error ? error.message : String(error));
      }
      return lines.join('') + 'Open';
    },
  });
  r.register({
    pattern: /^ssh((?: -(?:l \S+|v [12]|p \d+|c \S+|m \S+|vrf \S+))*) (\S+)$/i,
    syntax: ['ssh -l <user> [-v 2] [-p port] [-vrf NAME] <host>'],
    modes: ['user', 'privileged'],
    run: (m, e, d, c) => {
      const options = m[1] ?? '';
      const user = /-l (\S+)/i.exec(options)?.[1];
      const port = Number(/-p (\d+)/i.exec(options)?.[1] ?? 22);
      const vrf = /-vrf (\S+)/i.exec(options)?.[1];
      if (!user) throw new Error('% No user specified nor available for SSH client');
      if (!(port >= 1 && port <= 65535)) throw new Error('% Invalid port number');
      c.vty = { ...connect(e, d, m[2], port, 'ssh', vrf, d.iosSystem?.ssh?.sourceInterface), username: user };
      return '';
    },
  });
  r.register({
    pattern: /^show users(?: all)?$/i,
    syntax: 'show users',
    modes: ALL_MODES,
    run: (_m, e, d, c) => showUsers(e, d, c),
  });
}
