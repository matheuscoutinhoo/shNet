import type { Device } from '../model';
import { iosSecretSchema } from '../protocols/local-security-model';
import type { IosLine, IosSystem } from '../protocols/ios-system-model';
import { scheduleErrdisableRecovery } from '../protocols/errdisable';
import { hashIosSecret } from './local-security';
import { interfaceName } from './operational';
import { CONFIG_MODES, currentPort, type CommandRegistry, type Context } from './registry';
import { printSecret, readSecret, type7Encode } from './secrets';
import { startBanner } from './banner';
import { iosLogLine } from './ios-time';

/** IOS management plane: identity, AAA, SSH, lines, logging, SNMP, NTP options and campus defaults. */
export const SYSLOG_LEVELS = [
  'emergencies',
  'alerts',
  'critical',
  'errors',
  'warnings',
  'notifications',
  'informational',
  'debugging',
] as const;
const FACILITIES = [
  'kern',
  'user',
  'mail',
  'daemon',
  'auth',
  'syslog',
  'lpr',
  'news',
  'uucp',
  'cron',
  'sys10',
  'sys11',
  'sys12',
  'sys13',
  'sys14',
  'sys9',
  'local0',
  'local1',
  'local2',
  'local3',
  'local4',
  'local5',
  'local6',
  'local7',
];
const SERVICES =
  'pad|tcp-keepalives-in|tcp-keepalives-out|config|sequence-numbers|call-home|finger|tcp-small-servers|udp-small-servers|compress-config|internal';
// IOS defaults: service pad is on, the others off. Only differences are configuration.
const SERVICE_DEFAULTS: Record<string, boolean> = { pad: true };
const IP_FLAGS: Record<string, string> = {
  'source-route': 'ip-source-route',
  'bootp server': 'ip-bootp-server',
  finger: 'ip-finger',
  'gratuitous-arps': 'ip-gratuitous-arps',
};
const IP_FLAG_DEFAULTS: Record<string, boolean> = {
  'ip-source-route': true,
  'ip-bootp-server': true,
  'ip-finger': false,
  'ip-gratuitous-arps': true,
};
const ERRDISABLE_CAUSES = [
  'all',
  'arp-inspection',
  'bpduguard',
  'channel-misconfig',
  'dhcp-rate-limit',
  'link-flap',
  'loopback',
  'psecure-violation',
  'security-violation',
  'storm-control',
  'udld',
];
export function parseLevel(value: string) {
  if (/^[0-7]$/.test(value)) return Number(value);
  const index = SYSLOG_LEVELS.indexOf(value.toLowerCase() as (typeof SYSLOG_LEVELS)[number]);
  if (index < 0) throw new Error('Use a severity 0-7 or a level name (errors, warnings, informational...).');
  return index;
}
export const levelName = (level: number) => SYSLOG_LEVELS[level];
export function parseFacility(value: string) {
  if (/^\d+$/.test(value) && Number(value) <= 23) return Number(value);
  const index = FACILITIES.indexOf(value.toLowerCase());
  if (index < 0) throw new Error('Unknown syslog facility.');
  return index;
}
export const facilityName = (facility: number) => FACILITIES[facility] ?? String(facility);
const sys = (d: Device): IosSystem => (d.iosSystem ??= {});
/** Canonical IOS name of an interface reference; an existing interface keeps its exact name. */
export function interfaceReference(d: Device, raw: string) {
  const name = interfaceName(raw)
    .replace(/^lo(?:opback)?(?=\d)/i, 'Loopback')
    .replace(/^vl(?:an)?(?=\d)/i, 'Vlan')
    .replace(/^po(?:rt-channel)?(?=\d)/i, 'Port-channel')
    .replace(/^tu(?:nnel)?(?=\d)/i, 'Tunnel');
  return d.interfaces.find((p) => p.name.toLowerCase() === name.toLowerCase())?.name ?? name;
}
/** The interface a stored name refers to, if it exists (names may be configured before it). */
export function referencedInterface(d: Device, name?: string) {
  return name ? d.interfaces.find((p) => p.name.toLowerCase() === name.toLowerCase()) : undefined;
}
function parseMethods(tokens: string[]) {
  const methods: string[] = [];
  let ifAuthenticated = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].toLowerCase();
    if (token === 'group') {
      const group = tokens[++i];
      if (!group || !/^[\w.+-]{1,32}$/.test(group))
        throw new Error('Specify the server group after "group".');
      methods.push('group ' + group);
    } else if (['local', 'local-case', 'enable', 'line', 'none', 'krb5'].includes(token)) methods.push(token);
    else if (token === 'if-authenticated') ifAuthenticated = true;
    else throw new Error('Invalid AAA method: ' + tokens[i] + '.');
  }
  if (methods.length > 5) throw new Error('A method list has at most 4 methods.');
  return { methods, ifAuthenticated };
}
function aaa(d: Device) {
  const a = sys(d).aaa;
  if (!a?.newModel) throw new Error('AAA is not enabled: configure "aaa new-model" first.');
  return a;
}
function parseSecretAfterType(type: string | undefined, value: string) {
  if (type === '6') throw new Error('Type 6 keys need the AES master key; use type 0 or 7.');
  return readSecret(type, value);
}
/** Each line of "line vty 0 4" is configured individually, as on IOS. */
function lineEntries(d: Device, c: Context): IosLine[] {
  const range = c.lineRange;
  if (!range) throw new Error('Select a line first.');
  const lines = (sys(d).lines ??= []);
  const out: IosLine[] = [];
  for (let n = range.first; n <= range.last; n++) {
    let line = lines.find((l) => l.kind === range.kind && l.first === n);
    if (!line) lines.push((line = { kind: range.kind, first: n, last: n }));
    out.push(line);
  }
  lines.sort(
    (a, b) =>
      ['con', 'aux', 'vty'].indexOf(a.kind) - ['con', 'aux', 'vty'].indexOf(b.kind) || a.first - b.first
  );
  return out;
}
function eachLine(d: Device, c: Context, change: (line: IosLine) => void) {
  for (const line of lineEntries(d, c)) change(line);
}
const transports = (value: string) => {
  const list = value.toLowerCase().split(/\s+/);
  if (list.some((t) => !['ssh', 'telnet', 'none', 'all'].includes(t)) || new Set(list).size !== list.length)
    throw new Error('Use transport input ssh, telnet, ssh telnet, all or none.');
  return list as ('ssh' | 'telnet' | 'none' | 'all')[];
};

export function registerIosManagementCommands(r: CommandRegistry) {
  // --- identity --------------------------------------------------------------------------------
  r.register({
    pattern: /^(no )?ip domain[- ]name(?: (\S+))?$/i,
    syntax: ['ip domain name <domain>', 'ip domain-name <domain>', 'no ip domain name'],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      if (m[1]) delete sys(d).domainName;
      else if (!m[2] || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,63}$/.test(m[2]))
        throw new Error('Invalid domain name.');
      else sys(d).domainName = m[2];
    },
  });
  r.register({
    pattern: /^(no )?ip domain[- ]lookup$/i,
    syntax: ['ip domain lookup', 'no ip domain lookup', 'no ip domain-lookup'],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      if (m[1]) sys(d).domainLookup = false;
      else delete sys(d).domainLookup;
    },
  });
  r.register({
    pattern: /^username (\S+)(?: privilege (\d+))?(?: (secret|password) (?:([05789]) )?(.+))?$/i,
    syntax: [
      'username <name> privilege <level> secret <secret...>',
      'username <name> secret <secret...>',
      'username <name> privilege <level> password <password...>',
      'username <name> password <password...>',
    ],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const name = m[1];
      if (!/^[\w.@-]{1,64}$/.test(name)) throw new Error('Invalid username.');
      const privilege = m[2] === undefined ? undefined : Number(m[2]);
      if (privilege !== undefined && privilege > 15) throw new Error('Privilege level is 0-15.');
      const users = (sys(d).users ??= []),
        old = users.find((u) => u.name === name);
      const entry: NonNullable<IosSystem['users']>[number] = {
        name,
        ...(privilege !== undefined && privilege !== 1 ? { privilege } : {}),
      };
      if (m[3]?.toLowerCase() === 'secret') {
        const type = Number(m[4] ?? 0);
        if (type === 0) entry.secret = hashIosSecret(m[5]);
        else if (type === 8 || type === 9) {
          const hash = iosSecretSchema.parse(m[5]);
          if (hash[1] !== String(type)) throw new Error('Secret type does not match the encoded hash.');
          entry.secret = hash;
        } else if (type === 5) {
          if (!/^\$1\$[./0-9A-Za-z]{0,8}\$[./0-9A-Za-z]{22}$/.test(m[5]))
            throw new Error('Invalid type 5 (MD5) secret.');
          entry.secret = m[5];
        } else throw new Error('Secret type must be 0, 5, 8 or 9.');
      } else if (m[3]) {
        if (m[4] && !['0', '7'].includes(m[4])) throw new Error('Password type must be 0 or 7.');
        entry.password = parseSecretAfterType(m[4], m[5]);
      } else if (old) {
        // "username NAME privilege N" alone changes the level of an existing user.
        Object.assign(old, { privilege: privilege === 1 ? undefined : privilege });
        if (old.privilege === undefined) delete old.privilege;
        return;
      } else throw new Error('Specify a secret or password for the new user.');
      if (old) users.splice(users.indexOf(old), 1, entry);
      else if (users.length >= 64) throw new Error('At most 64 local users.');
      else users.push(entry);
    },
  });
  r.register({
    pattern: /^no username (\S+)(?: .*)?$/i,
    syntax: 'no username <name>',
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      sys(d).users = sys(d).users?.filter((u) => u.name !== m[1]);
    },
  });
  // --- AAA ---------------------------------------------------------------------------------------
  r.register({
    pattern: /^(no )?aaa new-model$/i,
    syntax: ['aaa new-model', 'no aaa new-model'],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      if (m[1]) delete sys(d).aaa;
      else sys(d).aaa ??= { newModel: true, authentication: [], authorization: [], accounting: [] };
    },
  });
  r.register({
    pattern: /^aaa authentication (login|enable|dot1x|ppp) (\S+) (.+)$/i,
    syntax: [
      'aaa authentication login <list> <methods...>',
      'aaa authentication enable default <methods...>',
      'aaa authentication dot1x <list> <methods...>',
    ],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const a = aaa(d),
        kind = m[1].toLowerCase() as 'login' | 'enable' | 'dot1x' | 'ppp',
        list = m[2];
      if (kind === 'enable' && list !== 'default')
        throw new Error('Enable authentication uses the default list.');
      if (!/^[\w.-]{1,32}$/.test(list)) throw new Error('Invalid method list name.');
      const { methods, ifAuthenticated } = parseMethods(m[3].trim().split(/\s+/));
      if (ifAuthenticated || !methods.length) throw new Error('Invalid authentication methods.');
      a.authentication = [
        ...a.authentication.filter((x) => !(x.kind === kind && x.list === list)),
        { kind, list, methods },
      ];
    },
  });
  r.register({
    pattern: /^no aaa authentication (login|enable|dot1x|ppp) (\S+)(?: .*)?$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const a = aaa(d);
      a.authentication = a.authentication.filter((x) => !(x.kind === m[1].toLowerCase() && x.list === m[2]));
    },
  });
  r.register({
    pattern:
      /^aaa authorization (exec|network|config-commands|console|commands (\d+))(?: (\S+)(?: (.+))?)?$/i,
    syntax: [
      'aaa authorization exec <list> <methods...>',
      'aaa authorization commands <level> <list> <methods...>',
      'aaa authorization network <list> <methods...>',
      'aaa authorization console',
      'aaa authorization config-commands',
    ],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const a = aaa(d);
      const kind = m[1].toLowerCase().startsWith('commands')
        ? 'commands'
        : (m[1].toLowerCase() as 'exec' | 'network' | 'config-commands' | 'console');
      const level = m[2] === undefined ? undefined : Number(m[2]);
      if (level !== undefined && level > 15) throw new Error('Privilege level is 0-15.');
      const entry: (typeof a.authorization)[number] = { kind, ...(level !== undefined ? { level } : {}) };
      if (kind === 'console' || kind === 'config-commands') {
        if (m[3]) throw new Error('aaa authorization ' + kind + ' takes no method list.');
      } else {
        if (!m[3] || !m[4]) throw new Error('Specify a method list name and its methods.');
        const { methods, ifAuthenticated } = parseMethods(m[4].trim().split(/\s+/));
        Object.assign(entry, { list: m[3], methods, ...(ifAuthenticated ? { ifAuthenticated } : {}) });
      }
      a.authorization = [
        ...a.authorization.filter(
          (x) => !(x.kind === entry.kind && x.level === entry.level && x.list === entry.list)
        ),
        entry,
      ];
    },
  });
  r.register({
    pattern:
      /^no aaa authorization (exec|network|config-commands|console|commands (\d+))(?: (\S+))?(?: .*)?$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const a = aaa(d),
        kind = m[1].toLowerCase().startsWith('commands') ? 'commands' : m[1].toLowerCase(),
        level = m[2] === undefined ? undefined : Number(m[2]);
      a.authorization = a.authorization.filter(
        (x) => !(x.kind === kind && x.level === level && (m[3] === undefined || x.list === m[3]))
      );
    },
  });
  r.register({
    pattern:
      /^aaa accounting (exec|network|connection|system|dot1x|commands (\d+)) (\S+) (start-stop|stop-only|none)(?: (.+))?$/i,
    syntax: [
      'aaa accounting exec <list> start-stop <methods...>',
      'aaa accounting commands <level> <list> start-stop <methods...>',
      'aaa accounting network <list> start-stop <methods...>',
    ],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const a = aaa(d);
      const kind = m[1].toLowerCase().startsWith('commands')
        ? 'commands'
        : (m[1].toLowerCase() as 'exec' | 'network' | 'connection' | 'system' | 'dot1x');
      const level = m[2] === undefined ? undefined : Number(m[2]);
      const record = m[4].toLowerCase() as 'start-stop' | 'stop-only' | 'none';
      const parsed = m[5] ? parseMethods(m[5].trim().split(/\s+/)) : undefined;
      if (record !== 'none' && !parsed?.methods.length) throw new Error('Specify the accounting methods.');
      const entry = {
        kind: kind as 'exec' | 'network' | 'connection' | 'system' | 'dot1x' | 'commands',
        ...(level !== undefined ? { level } : {}),
        list: m[3],
        record,
        ...(parsed?.methods.length ? { methods: parsed.methods } : {}),
      };
      a.accounting = [
        ...a.accounting.filter((x) => !(x.kind === kind && x.level === level && x.list === m[3])),
        entry,
      ];
    },
  });
  r.register({
    pattern: /^no aaa accounting (exec|network|connection|system|dot1x|commands (\d+)) (\S+)(?: .*)?$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const a = aaa(d),
        kind = m[1].toLowerCase().startsWith('commands') ? 'commands' : m[1].toLowerCase(),
        level = m[2] === undefined ? undefined : Number(m[2]);
      a.accounting = a.accounting.filter((x) => !(x.kind === kind && x.level === level && x.list === m[3]));
    },
  });
  r.register({
    pattern: /^(no )?aaa session-id common$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const a = aaa(d);
      if (m[1]) delete a.sessionIdCommon;
      else a.sessionIdCommon = true;
    },
  });
  r.register({
    pattern: /^(no )?(tacacs|radius) server (\S+)$/i,
    syntax: [
      'tacacs server <name>',
      'radius server <name>',
      'no tacacs server <name>',
      'no radius server <name>',
    ],
    modes: CONFIG_MODES,
    run: (m, _e, d, c) => {
      const kind = m[2].toLowerCase() as 'tacacs' | 'radius',
        name = m[3],
        servers = (sys(d).aaaServers ??= []);
      if (!/^[\w.+@-]{1,64}$/.test(name)) throw new Error('Invalid server name.');
      if (m[1]) {
        sys(d).aaaServers = servers.filter((s) => !(s.kind === kind && s.name === name));
        return;
      }
      if (!servers.some((s) => s.kind === kind && s.name === name)) {
        if (servers.length >= 16) throw new Error('At most 16 AAA servers.');
        servers.push({ kind, name });
      }
      c.mode = 'aaa-server';
      c.aaaKind = kind;
      c.name = name;
    },
  });
  const server = (d: Device, c: Context) => {
    const s = sys(d).aaaServers?.find((x) => x.kind === c.aaaKind && x.name === c.name);
    if (!s) throw new Error('Select a tacacs or radius server.');
    return s;
  };
  r.register({
    pattern: /^(no )?address ipv4(?: ([\d.]+)(?: auth-port (\d+))?(?: acct-port (\d+))?)?$/i,
    syntax: ['address ipv4 <address>', 'address ipv4 <address> auth-port <port> acct-port <port>'],
    modes: ['aaa-server'],
    run: (m, _e, d, c) => {
      const s = server(d, c);
      if (m[1]) {
        delete s.address;
        return;
      }
      if (!m[2]) throw new Error('Specify the server address.');
      if ((m[3] || m[4]) && s.kind !== 'radius') throw new Error('auth-port and acct-port apply to RADIUS.');
      s.address = m[2];
      if (m[3]) s.authPort = Number(m[3]);
      if (m[4]) s.acctPort = Number(m[4]);
    },
  });
  r.register({
    pattern: /^(no )?key(?: ([067]))?(?: (\S+))?$/i,
    syntax: ['key <key>', 'key 0 <key>', 'key 7 <encrypted>', 'no key'],
    modes: ['aaa-server'],
    run: (m, _e, d, c) => {
      const s = server(d, c);
      if (m[1]) delete s.key;
      else if (!m[3]) throw new Error('Specify the shared key.');
      else s.key = parseSecretAfterType(m[2], m[3]);
    },
  });
  r.register({
    pattern: /^(no )?(port|timeout|retransmit)(?: (\d+))?$/i,
    syntax: ['port <port>', 'timeout <seconds>', 'retransmit <count>'],
    modes: ['aaa-server'],
    run: (m, _e, d, c) => {
      const s = server(d, c),
        field = m[2].toLowerCase() as 'port' | 'timeout' | 'retransmit';
      if (field === 'port' && s.kind !== 'tacacs') throw new Error('RADIUS uses address ipv4 ... auth-port.');
      if (field === 'retransmit' && s.kind !== 'radius') throw new Error('retransmit applies to RADIUS.');
      if (m[1]) delete s[field];
      else if (!m[3]) throw new Error('Specify a value.');
      else s[field] = Number(m[3]);
    },
  });
  r.register({
    pattern: /^(no )?single-connection$/i,
    modes: ['aaa-server'],
    run: (m, _e, d, c) => {
      const s = server(d, c);
      if (s.kind !== 'tacacs') throw new Error('single-connection applies to TACACS+.');
      if (m[1]) delete s.singleConnection;
      else s.singleConnection = true;
    },
  });
  r.register({
    // Legacy global syntax, still common in older configurations.
    pattern:
      /^(no )?(tacacs|radius)-server host ([\d.]+)(?: auth-port (\d+))?(?: acct-port (\d+))?(?: key (?:([07]) )?(\S+))?$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const kind = m[2].toLowerCase() as 'tacacs' | 'radius',
        servers = (sys(d).aaaServers ??= []);
      sys(d).aaaServers = servers.filter((s) => !(s.kind === kind && s.legacy && s.name === m[3]));
      if (m[1]) return;
      if (sys(d).aaaServers!.length >= 16) throw new Error('At most 16 AAA servers.');
      sys(d).aaaServers!.push({
        kind,
        name: m[3],
        address: m[3],
        legacy: true,
        ...(m[4] ? { authPort: Number(m[4]) } : {}),
        ...(m[5] ? { acctPort: Number(m[5]) } : {}),
        ...(m[7] ? { key: readSecret(m[6], m[7]) } : {}),
      });
    },
  });
  r.register({
    pattern: /^(no )?aaa group server (tacacs\+|radius) (\S+)$/i,
    syntax: ['aaa group server tacacs+ <name>', 'aaa group server radius <name>'],
    modes: CONFIG_MODES,
    run: (m, _e, d, c) => {
      const kind = m[2].toLowerCase() === 'radius' ? 'radius' : 'tacacs',
        groups = (sys(d).aaaGroups ??= []);
      if (!/^[\w.+@-]{1,64}$/.test(m[3])) throw new Error('Invalid group name.');
      if (m[1]) {
        sys(d).aaaGroups = groups.filter((g) => !(g.kind === kind && g.name === m[3]));
        return;
      }
      if (!groups.some((g) => g.kind === kind && g.name === m[3])) {
        if (groups.length >= 16) throw new Error('At most 16 server groups.');
        groups.push({ kind, name: m[3], servers: [] });
      }
      c.mode = 'aaa-group';
      c.aaaKind = kind;
      c.name = m[3];
    },
  });
  const group = (d: Device, c: Context) => {
    const g = sys(d).aaaGroups?.find((x) => x.kind === c.aaaKind && x.name === c.name);
    if (!g) throw new Error('Select an AAA server group.');
    return g;
  };
  r.register({
    // Servers may be defined after the group (show running-config prints groups first).
    pattern: /^(no )?server (?:name (\S+)|([\d.]+)(?: .*)?)$/i,
    syntax: ['server name <name>', 'no server name <name>'],
    modes: ['aaa-group'],
    run: (m, _e, d, c) => {
      const g = group(d, c),
        name = m[2] ?? m[3];
      g.servers = g.servers.filter((s) => s !== name);
      if (m[1]) return;
      if (g.servers.length >= 8) throw new Error('At most 8 servers per group.');
      g.servers.push(name);
    },
  });
  r.register({
    pattern: /^(no )?ip (tacacs|radius) source-interface(?: (\S+))?$/i,
    syntax: ['ip tacacs source-interface <interface>', 'ip radius source-interface <interface>'],
    modes: [...CONFIG_MODES],
    run: (m, _e, d, c) => {
      const kind = m[2].toLowerCase() as 'tacacs' | 'radius';
      const value = m[1] ? undefined : m[3] ? interfaceReference(d, m[3]) : undefined;
      if (!m[1] && !value) throw new Error('Specify the source interface.');
      if (c.mode === 'aaa-group') {
        const g = group(d, c);
        if (g.kind !== kind) throw new Error('The group is not a ' + kind + ' group.');
        if (value) g.sourceInterface = value;
        else delete g.sourceInterface;
        return;
      }
      const source = (sys(d).aaaSourceInterface ??= {});
      if (value) source[kind] = value;
      else delete source[kind];
    },
  });
  // --- SSH and keys ------------------------------------------------------------------------------
  r.register({
    pattern: /^(no )?ip ssh (version|time-out|authentication-retries|source-interface)(?: (\S+))?$/i,
    syntax: [
      'ip ssh version 2',
      'ip ssh time-out <seconds>',
      'ip ssh authentication-retries <count>',
      'ip ssh source-interface <interface>',
    ],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const ssh = (sys(d).ssh ??= {}),
        option = m[2].toLowerCase();
      if (m[1]) {
        if (option === 'version') delete ssh.version;
        else if (option === 'time-out') delete ssh.timeout;
        else if (option === 'authentication-retries') delete ssh.retries;
        else delete ssh.sourceInterface;
        return;
      }
      if (!m[3]) throw new Error('Specify a value.');
      if (option === 'source-interface') ssh.sourceInterface = interfaceReference(d, m[3]);
      else {
        const value = Number(m[3]);
        if (option === 'version') {
          if (value !== 1 && value !== 2) throw new Error('SSH version is 1 or 2.');
          ssh.version = value;
        } else if (option === 'time-out') {
          if (!Number.isInteger(value) || value < 1 || value > 120)
            throw new Error('Timeout is 1-120 seconds.');
          ssh.timeout = value;
        } else {
          if (!Number.isInteger(value) || value > 5) throw new Error('Retries are 0-5.');
          ssh.retries = value;
        }
      }
    },
  });
  r.register({
    pattern: /^(no )?ip scp server enable$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const ssh = (sys(d).ssh ??= {});
      if (m[1]) delete ssh.scp;
      else ssh.scp = true;
    },
  });
  r.register({
    pattern:
      /^crypto key generate rsa(?: general-keys)?(?: label (\S+))?(?: modulus (\d+))?(?: exportable)?$/i,
    syntax: ['crypto key generate rsa modulus <bits>', 'crypto key generate rsa general-keys modulus <bits>'],
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      if (/^(?:Router|Switch)$/i.test(d.hostname))
        throw new Error('Please define a hostname other than ' + d.hostname + '.');
      if (!sys(d).domainName) throw new Error('Please define a domain-name first.');
      // IOS asks for the size when it is omitted; 2048 is the value recommended for SSH v2.
      const modulus = Number(m[2] ?? 2048);
      if (!Number.isInteger(modulus) || modulus < 360 || modulus > 4096)
        throw new Error('The modulus must be 360-4096 bits.');
      sys(d).rsaModulus = modulus;
      const label = m[1] ?? d.hostname + '.' + sys(d).domainName;
      return [
        'The name for the keys will be: ' + label,
        '% The key modulus size is ' + modulus + ' bits',
        '% Generating ' + modulus + ' bit RSA keys, keys will be non-exportable...',
        '[OK] (elapsed time was 1 seconds)',
        iosLogLine(e.state.clock, 'SSH-5-ENABLED', 'SSH 2.0 has been enabled'),
      ].join('\n');
    },
  });
  r.register({
    pattern: /^crypto key zeroize rsa(?: \S+)?$/i,
    syntax: 'crypto key zeroize rsa',
    modes: CONFIG_MODES,
    run: (_m, e, d) => {
      if (!sys(d).rsaModulus) return '% No RSA keys to remove.';
      delete sys(d).rsaModulus;
      return (
        '% All keys will be removed.\n' +
        iosLogLine(e.state.clock, 'SSH-5-DISABLED', 'SSH 2.0 has been disabled')
      );
    },
  });
  // --- lines -------------------------------------------------------------------------------------
  r.register({
    pattern: /^line (con(?:sole)?|aux|vty) (\d+)(?: (\d+))?$/i,
    syntax: ['line con 0', 'line aux 0', 'line vty <first> <last>'],
    modes: CONFIG_MODES,
    run: (m, _e, d, c) => {
      const word = m[1].toLowerCase(),
        kind = word.startsWith('con') ? 'con' : (word as 'aux' | 'vty');
      const first = Number(m[2]),
        last = Number(m[3] ?? m[2]);
      if (first > last || last > (kind === 'vty' ? 15 : 0))
        throw new Error(kind === 'vty' ? 'VTY lines are numbered 0-15.' : 'Use line ' + kind + ' 0.');
      c.mode = 'line';
      c.lineRange = { kind, first, last };
      lineEntries(d, c);
    },
  });
  r.register({
    pattern: /^(no )?exec-timeout(?: (\d+)(?: (\d+))?)?$/i,
    syntax: ['exec-timeout <minutes> <seconds>', 'no exec-timeout'],
    modes: ['line'],
    run: (m, _e, d, c) => {
      const minutes = Number(m[2] ?? 10),
        seconds = Number(m[3] ?? 0);
      eachLine(d, c, (line) => {
        // 10 minutes is the IOS default and is not configuration.
        if (m[1] || (minutes === 10 && seconds === 0)) delete line.execTimeout;
        else line.execTimeout = { minutes, seconds };
      });
    },
  });
  r.register({
    pattern: /^(no )?logging synchronous$/i,
    modes: ['line'],
    run: (m, _e, d, c) =>
      eachLine(d, c, (line) => {
        if (m[1]) delete line.loggingSynchronous;
        else line.loggingSynchronous = true;
      }),
  });
  r.register({
    pattern: /^(no )?login(?: (local|authentication (\S+)))?$/i,
    syntax: ['login', 'login local', 'login authentication <list>', 'no login'],
    modes: ['line'],
    run: (m, _e, d, c) =>
      eachLine(d, c, (line) => {
        delete line.noLogin;
        if (m[1]) {
          delete line.login;
          if (line.kind === 'vty') line.noLogin = true;
        } else if (m[3]) line.login = { list: m[3] };
        else line.login = m[2] ? 'local' : 'line';
      }),
  });
  r.register({
    pattern: /^(no )?password(?: (?:([07]) )?(\S+))?$/i,
    syntax: ['password <password>', 'password 7 <encrypted>', 'no password'],
    modes: ['line'],
    run: (m, _e, d, c) =>
      eachLine(d, c, (line) => {
        if (m[1]) delete line.password;
        else if (!m[3]) throw new Error('Specify the line password.');
        else line.password = readSecret(m[2], m[3]);
      }),
  });
  r.register({
    pattern: /^(no )?transport (input|output)(?: (.+))?$/i,
    syntax: [
      'transport input ssh',
      'transport input telnet ssh',
      'transport input none',
      'transport output ssh',
    ],
    modes: ['line'],
    run: (m, _e, d, c) =>
      eachLine(d, c, (line) => {
        const field = m[2].toLowerCase() === 'input' ? 'transportInput' : 'transportOutput';
        if (m[1]) delete line[field];
        else if (!m[3]) throw new Error('Specify ssh, telnet, all or none.');
        else line[field] = transports(m[3]);
      }),
  });
  r.register({
    pattern: /^(no )?access-class (\S+) in( vrf-also)?$/i,
    syntax: ['access-class <acl> in', 'access-class <acl> in vrf-also'],
    modes: ['line'],
    run: (m, _e, d, c) =>
      eachLine(d, c, (line) => {
        if (m[1]) delete line.accessClass;
        else line.accessClass = { acl: m[2], vrfAlso: !!m[3] };
      }),
  });
  r.register({
    pattern: /^(no )?privilege level(?: (\d+))?$/i,
    syntax: 'privilege level <level>',
    modes: ['line'],
    run: (m, _e, d, c) =>
      eachLine(d, c, (line) => {
        if (m[1]) delete line.privilege;
        else if (m[2] === undefined || Number(m[2]) > 15) throw new Error('Privilege level is 0-15.');
        else line.privilege = Number(m[2]);
      }),
  });
  r.register({
    pattern: /^(no )?(authorization|accounting) exec(?: (\S+))?$/i,
    syntax: ['authorization exec <list>', 'accounting exec <list>'],
    modes: ['line'],
    run: (m, _e, d, c) =>
      eachLine(d, c, (line) => {
        const field = m[2].toLowerCase() === 'authorization' ? 'authorizationExec' : 'accountingExec';
        if (m[1]) delete line[field];
        else if (!m[3]) throw new Error('Specify the method list.');
        else line[field] = m[3];
      }),
  });
  r.register({
    pattern: /^(no )?history size(?: (\d+))?$/i,
    modes: ['line'],
    run: (m, _e, d, c) =>
      eachLine(d, c, (line) => {
        if (m[1] || Number(m[2] ?? 20) === 20) delete line.historySize;
        else if (Number(m[2]) > 256) throw new Error('History size is 0-256.');
        else line.historySize = Number(m[2]);
      }),
  });
  r.register({
    pattern: /^(no )?exec$/i,
    modes: ['line'],
    run: (m, _e, d, c) =>
      eachLine(d, c, (line) => {
        if (m[1]) line.noExec = true;
        else delete line.noExec;
      }),
  });
  r.register({
    // Physical console settings with the default value: accepted, nothing to simulate.
    pattern: /^(?:stopbits 1|speed 9600|flowcontrol none|databits 8|parity none)$/i,
    modes: ['line'],
    run: () => undefined,
  });
  // --- banners and services ----------------------------------------------------------------------
  r.register({
    pattern: /^banner (motd|login|exec) (.+)$/i,
    syntax: ['banner motd <text...>', 'banner login <text...>', 'banner exec <text...>'],
    modes: CONFIG_MODES,
    run: (m, _e, d, c) =>
      startBanner(d, c, m[1].toLowerCase() as 'motd' | 'login' | 'exec', m[2]) || undefined,
  });
  r.register({
    pattern: /^no banner (motd|login|exec)$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const banners = sys(d).banners;
      if (banners) delete banners[m[1].toLowerCase() as 'motd' | 'login' | 'exec'];
    },
  });
  r.register({
    pattern:
      /^(no )?service timestamps (log|debug)(?: (datetime(?: (?:msec|localtime|show-timezone|year))*|uptime))?$/i,
    syntax: [
      'service timestamps log datetime msec',
      'service timestamps debug datetime msec',
      'service timestamps log uptime',
    ],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const stamps = (sys(d).timestamps ??= {}),
        kind = m[2].toLowerCase() as 'log' | 'debug';
      if (m[1]) delete stamps[kind];
      else stamps[kind] = (m[3] ?? 'uptime').toLowerCase().replace(/\s+/g, ' ');
    },
  });
  r.register({
    pattern: new RegExp('^(no )?service (' + SERVICES + ')$', 'i'),
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const name = m[2].toLowerCase(),
        value = !m[1],
        services = (sys(d).services ??= {});
      if (value === (SERVICE_DEFAULTS[name] ?? false)) delete services[name];
      else services[name] = value;
    },
  });
  r.register({
    pattern: /^(no )?ip (source-route|bootp server|finger|gratuitous-arps)$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const key = IP_FLAGS[m[2].toLowerCase()],
        value = !m[1],
        services = (sys(d).services ??= {});
      if (value === IP_FLAG_DEFAULTS[key]) delete services[key];
      else services[key] = value;
    },
  });
  r.register({
    pattern: /^(no )?ip http (server|secure-server)$/i,
    syntax: ['ip http server', 'no ip http server', 'ip http secure-server', 'no ip http secure-server'],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const http = (sys(d).http ??= {});
      http[m[2].toLowerCase() === 'server' ? 'server' : 'secureServer'] = !m[1];
    },
  });
  r.register({
    pattern: /^(no )?ip http authentication(?: (local|enable|aaa))?$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const http = (sys(d).http ??= {});
      if (m[1]) delete http.authentication;
      else if (!m[2]) throw new Error('Use local, enable or aaa.');
      else http.authentication = m[2].toLowerCase() as 'local' | 'enable' | 'aaa';
    },
  });
  r.register({
    // Platform and housekeeping lines present in real show running-config output.
    pattern:
      /^(?:version \d+\.\d+|boot-start-marker|boot-end-marker|no platform punt-keepalive disable-kernel-core|multilink bundle-name authenticated|diagnostic bootup level (?:minimal|complete)|memory free low-watermark processor \d+)$/i,
    modes: CONFIG_MODES,
    run: () => undefined,
  });
  // --- logging -----------------------------------------------------------------------------------
  r.register({
    pattern: /^(no )?logging buffered(?: (\d+))?(?: (\S+))?$/i,
    syntax: ['logging buffered <size> <level>', 'no logging buffered'],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const logging = (sys(d).logging ??= {});
      if (m[1]) {
        delete logging.buffered;
        return;
      }
      // "logging buffered warnings" (level only) is also valid.
      const sizeText = m[2] !== undefined && !m[3] && Number(m[2]) <= 7 ? undefined : m[2],
        levelText = m[3] ?? (sizeText === undefined ? m[2] : undefined);
      const size = Number(sizeText ?? 4096);
      if (size < 4096 || size > 2147483647) throw new Error('Buffer size is 4096-2147483647 bytes.');
      logging.buffered = { size, level: levelText ? parseLevel(levelText) : 7 };
    },
  });
  r.register({
    pattern: /^(no )?logging (console|monitor)(?: (\S+))?$/i,
    syntax: ['logging console <level>', 'logging monitor <level>', 'no logging console'],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const logging = (sys(d).logging ??= {}),
        field = m[2].toLowerCase() as 'console' | 'monitor';
      if (m[1]) logging[field] = false;
      else if (!m[3] || parseLevel(m[3]) === 7) delete logging[field];
      else logging[field] = parseLevel(m[3]);
    },
  });
  r.register({
    pattern: /^(no )?logging trap(?: (\S+))?$/i,
    syntax: ['logging trap <level>', 'no logging trap'],
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const level = m[1] || !m[2] ? 6 : parseLevel(m[2]);
      const logging = (sys(d).logging ??= {});
      if (d.syslogClient) {
        delete logging.trap;
        e.configureSyslog(d.id, { ...d.syslogClient, severity: level });
      } else if (level === 6) delete logging.trap;
      else logging.trap = level;
    },
  });
  r.register({
    pattern: /^(no )?logging facility(?: (\w+))?$/i,
    syntax: 'logging facility <facility>',
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const facility = m[1] || !m[2] ? 23 : parseFacility(m[2]);
      const logging = (sys(d).logging ??= {});
      if (d.syslogClient) {
        delete logging.facility;
        e.configureSyslog(d.id, { ...d.syslogClient, facility });
      } else if (facility === 23) delete logging.facility;
      else logging.facility = facility;
    },
  });
  r.register({
    pattern: /^(no )?logging source-interface(?: (\S+))?$/i,
    syntax: 'logging source-interface <interface>',
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const logging = (sys(d).logging ??= {});
      if (m[1]) delete logging.sourceInterface;
      else if (!m[2]) throw new Error('Specify the source interface.');
      else logging.sourceInterface = interfaceReference(d, m[2]);
    },
  });
  r.register({
    // "logging host IP transport udp port 514" and the legacy "logging IP". Each host is a collector.
    pattern: /^logging (?:host )?([\d.]+)(?: transport udp(?: port (\d+))?)?$/i,
    syntax: ['logging host <address>', 'logging host <address> transport udp port 514'],
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      if (m[2] && Number(m[2]) !== 514) throw new Error('The syslog collector listens on UDP 514.');
      const client = d.syslogClient,
        server = m[1];
      if (client?.enabled && client.server !== server) {
        if (client.additional?.includes(server)) return;
        if ((client.additional?.length ?? 0) >= 7)
          throw new Error('% A maximum of 8 logging hosts is supported.');
        e.configureSyslog(d.id, { ...client, additional: [...(client.additional ?? []), server] });
        return;
      }
      const pending = sys(d).logging;
      e.configureSyslog(d.id, {
        ...client,
        server,
        enabled: true,
        severity: client?.severity ?? pending?.trap ?? 6,
        facility: client?.facility ?? pending?.facility ?? 23,
      });
      if (pending) {
        delete pending.trap;
        delete pending.facility;
      }
    },
  });
  r.register({
    pattern: /^no logging (?:host )?([\d.]+)(?: .*)?$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const client = d.syslogClient,
        server = m[1];
      if (!client?.enabled) return;
      const { additional = [], ...rest } = client;
      if (additional.includes(server)) {
        const remaining = additional.filter((x) => x !== server);
        e.configureSyslog(d.id, { ...rest, ...(remaining.length ? { additional: remaining } : {}) });
      } else if (client.server === server) {
        const [next, ...others] = additional;
        e.configureSyslog(
          d.id,
          next
            ? { ...rest, server: next, ...(others.length ? { additional: others } : {}) }
            : { ...rest, enabled: false }
        );
      }
    },
  });
  // --- SNMP --------------------------------------------------------------------------------------
  r.register({
    pattern: /^(no )?snmp-server (location|contact)(?: (.+))?$/i,
    syntax: ['snmp-server location <text...>', 'snmp-server contact <text...>'],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const snmp = (sys(d).snmp ??= {}),
        field = m[2].toLowerCase() as 'location' | 'contact';
      if (m[1]) delete snmp[field];
      else if (!m[3]) throw new Error('Specify the text.');
      else snmp[field] = m[3].slice(0, 255);
    },
  });
  r.register({
    pattern:
      /^snmp-server host ([\d.]+)(?: (informs|traps))?(?: version (1|2c|3)(?: (auth|noauth|priv))?)? ([\w@.-]{1,64})(?: udp-port \d+)?(?: [\w-]+)*$/i,
    syntax: [
      'snmp-server host <address> version 2c <community>',
      'snmp-server host <address> version 3 priv <user>',
    ],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const snmp = (sys(d).snmp ??= {}),
        version = (m[3] ?? '1') as '1' | '2c' | '3';
      if (version === '3' && !m[4]) throw new Error('SNMPv3 hosts need auth, noauth or priv.');
      if (version !== '3' && m[4]) throw new Error('Security levels apply to SNMPv3.');
      const hosts = (snmp.hosts ?? []).filter((h) => h.address !== m[1]);
      if (hosts.length >= 16) throw new Error('At most 16 notification hosts.');
      snmp.hosts = [
        ...hosts,
        {
          address: m[1],
          version,
          community: m[5],
          ...(m[4] ? { security: m[4].toLowerCase() as 'auth' | 'noauth' | 'priv' } : {}),
          ...(m[2]?.toLowerCase() === 'informs' ? { informs: true } : {}),
        },
      ];
    },
  });
  r.register({
    pattern: /^no snmp-server host ([\d.]+)(?: .*)?$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const snmp = sys(d).snmp;
      if (snmp?.hosts) snmp.hosts = snmp.hosts.filter((h) => h.address !== m[1]);
    },
  });
  r.register({
    pattern: /^(no )?snmp-server enable traps(?: (.+))?$/i,
    syntax: ['snmp-server enable traps', 'snmp-server enable traps snmp linkdown linkup coldstart'],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const snmp = (sys(d).snmp ??= {});
      if (m[1]) {
        delete snmp.traps;
        return;
      }
      if (!m[2]) {
        snmp.traps = true;
        return;
      }
      const types = m[2].toLowerCase().split(/\s+/);
      if (types.some((t) => !/^[\w-]{1,32}$/.test(t))) throw new Error('Invalid notification type.');
      if (snmp.traps !== true) snmp.traps = [...new Set([...(snmp.traps ?? []), ...types])].slice(0, 32);
    },
  });
  r.register({
    pattern: /^(no )?snmp-server trap-source(?: (\S+))?$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const snmp = (sys(d).snmp ??= {});
      if (m[1]) delete snmp.trapSource;
      else if (!m[2]) throw new Error('Specify the source interface.');
      else snmp.trapSource = interfaceReference(d, m[2]);
    },
  });
  r.register({
    pattern:
      /^snmp-server group (\S+) v3 (auth|noauth|priv)(?: read (\S+))?(?: write (\S+))?(?: access (\S+))?$/i,
    syntax: 'snmp-server group <name> v3 priv',
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const snmp = (sys(d).snmp ??= {}),
        groups = (snmp.groups ?? []).filter((g) => g.name !== m[1]);
      if (groups.length >= 16) throw new Error('At most 16 SNMP groups.');
      snmp.groups = [
        ...groups,
        {
          name: m[1],
          security: m[2].toLowerCase() as 'auth' | 'noauth' | 'priv',
          ...(m[3] ? { read: m[3] } : {}),
          ...(m[4] ? { write: m[4] } : {}),
          ...(m[5] ? { access: m[5] } : {}),
        },
      ];
    },
  });
  r.register({
    pattern: /^no snmp-server group (\S+)(?: v3(?: \S+)?)?$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const snmp = sys(d).snmp;
      if (snmp?.groups) snmp.groups = snmp.groups.filter((g) => g.name !== m[1]);
    },
  });
  r.register({
    // SNMPv3 users are kept outside running-config (IOS stores them in private configuration).
    pattern:
      /^snmp-server user (\S+) (\S+) v3(?: auth (md5|sha) (\S+)(?: priv (des|3des|aes (?:128|192|256)) (\S+))?)?$/i,
    syntax: 'snmp-server user <name> <group> v3 auth sha <password> priv aes 128 <password>',
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const snmp = (sys(d).snmp ??= {});
      if (!snmp.groups?.some((g) => g.name === m[2]))
        throw new Error('Configure snmp-server group ' + m[2] + ' first.');
      if ((m[4] && m[4].length < 8) || (m[6] && m[6].length < 8))
        throw new Error('SNMPv3 passwords need at least 8 characters.');
      const users = (snmp.users ?? []).filter((u) => u.name !== m[1]);
      if (users.length >= 16) throw new Error('At most 16 SNMPv3 users.');
      snmp.users = [
        ...users,
        {
          name: m[1],
          group: m[2],
          ...(m[3] ? { auth: { algorithm: m[3].toLowerCase() as 'md5' | 'sha', key: m[4] } } : {}),
          ...(m[5]
            ? {
                priv: {
                  algorithm: m[5].toLowerCase().replace(/\s+/, ' ') as 'des' | '3des' | 'aes 128',
                  key: m[6],
                },
              }
            : {}),
        },
      ];
    },
  });
  r.register({
    pattern: /^no snmp-server user (\S+)(?: \S+ v3)?$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const snmp = sys(d).snmp;
      if (snmp?.users) snmp.users = snmp.users.filter((u) => u.name !== m[1]);
    },
  });
  r.register({
    pattern: /^(no )?snmp-server ifindex persist$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const snmp = (sys(d).snmp ??= {});
      if (m[1]) delete snmp.ifindexPersist;
      else snmp.ifindexPersist = true;
    },
  });
  // --- NTP options -------------------------------------------------------------------------------
  r.register({
    pattern: /^(no )?ntp source(?: (\S+))?$/i,
    syntax: 'ntp source <interface>',
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const ntp = (sys(d).ntp ??= {});
      if (m[1]) delete ntp.sourceInterface;
      else if (!m[2]) throw new Error('Specify the source interface.');
      else ntp.sourceInterface = interfaceReference(d, m[2]);
    },
  });
  r.register({
    pattern: /^(no )?ntp authenticate$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const ntp = (sys(d).ntp ??= {});
      if (m[1]) delete ntp.authenticate;
      else ntp.authenticate = true;
    },
  });
  r.register({
    // IOS prints the encryption type after the key: "ntp authentication-key 1 md5 <key> 7".
    pattern: /^(no )?ntp authentication-key (\d+)(?: md5 (\S+)(?: ([07]))?)?$/i,
    syntax: 'ntp authentication-key <id> md5 <key>',
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const ntp = (sys(d).ntp ??= {}),
        id = Number(m[2]);
      if (id < 1 || id > 65535) throw new Error('Key number is 1-65535.');
      const keys = (ntp.keys ?? []).filter((k) => k.id !== id);
      if (!m[1]) {
        if (!m[3]) throw new Error('Specify md5 and the key.');
        if (keys.length >= 16) throw new Error('At most 16 NTP keys.');
        keys.push({ id, key: readSecret(m[4], m[3]).slice(0, 32) });
      }
      ntp.keys = keys;
    },
  });
  r.register({
    pattern: /^(no )?ntp trusted-key (\d+)$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const ntp = (sys(d).ntp ??= {}),
        id = Number(m[2]),
        keys = (ntp.trustedKeys ?? []).filter((k) => k !== id);
      if (!m[1]) keys.push(id);
      ntp.trustedKeys = keys.sort((a, b) => a - b).slice(0, 16);
    },
  });
  // --- errdisable, login protection, VTP ---------------------------------------------------------
  r.register({
    pattern: /^(no )?errdisable recovery cause (\S+)$/i,
    syntax: 'errdisable recovery cause <cause>',
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const cause = m[2].toLowerCase();
      if (!ERRDISABLE_CAUSES.includes(cause)) throw new Error('Unknown errdisable cause: ' + m[2] + '.');
      const current = sys(d).errdisableRecovery ?? { causes: [], intervalS: 300 };
      const causes = cause === 'all' ? ERRDISABLE_CAUSES.filter((c) => c !== 'all') : [cause];
      current.causes = m[1]
        ? current.causes.filter((c) => !causes.includes(c))
        : [...new Set([...current.causes, ...causes])];
      if (!current.causes.length && current.intervalS === 300) delete sys(d).errdisableRecovery;
      else sys(d).errdisableRecovery = current;
      for (const p of d.interfaces) if (p.errDisabled) scheduleErrdisableRecovery(e, d, p);
    },
  });
  r.register({
    pattern: /^(no )?errdisable recovery interval(?: (\d+))?$/i,
    syntax: 'errdisable recovery interval <seconds>',
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const interval = m[1] ? 300 : Number(m[2] ?? NaN);
      if (!Number.isInteger(interval) || interval < 30 || interval > 86400)
        throw new Error('The interval is 30-86400 seconds.');
      const current = sys(d).errdisableRecovery ?? { causes: [], intervalS: 300 };
      current.intervalS = interval;
      if (!current.causes.length && interval === 300) delete sys(d).errdisableRecovery;
      else sys(d).errdisableRecovery = current;
      for (const p of d.interfaces) if (p.errDisabled) scheduleErrdisableRecovery(e, d, p);
    },
  });
  r.register({
    pattern: /^login block-for (\d+) attempts (\d+) within (\d+)$/i,
    syntax: 'login block-for <seconds> attempts <tries> within <seconds>',
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const [forS, attempts, withinS] = [m[1], m[2], m[3]].map(Number);
      if ([forS, attempts, withinS].some((n) => n < 1 || n > 65535)) throw new Error('Values are 1-65535.');
      sys(d).loginBlock = { forS, attempts, withinS };
    },
  });
  r.register({
    pattern: /^no login block-for$/i,
    modes: CONFIG_MODES,
    run: (_m, _e, d) => {
      delete sys(d).loginBlock;
    },
  });
  r.register({
    pattern: /^vtp (mode|domain|version|password) (\S+)$/i,
    syntax: ['vtp mode transparent', 'vtp mode off', 'vtp domain <name>', 'vtp version <1-3>'],
    modes: CONFIG_MODES,
    available: (d) => d.type === 'switch',
    run: (m, _e, d) => {
      const vtp = (sys(d).vtp ??= { mode: 'server' }),
        option = m[1].toLowerCase(),
        value = m[2];
      if (option === 'mode') {
        if (!['server', 'client', 'transparent', 'off'].includes(value.toLowerCase()))
          throw new Error('VTP mode is server, client, transparent or off.');
        vtp.mode = value.toLowerCase() as 'server' | 'client' | 'transparent' | 'off';
        return 'Setting device to VTP ' + vtp.mode.toUpperCase() + ' mode for VLANS.';
      }
      if (option === 'domain') {
        if (!/^[\w.-]{1,32}$/.test(value)) throw new Error('Invalid VTP domain name.');
        vtp.domain = value;
        return 'Changing VTP domain name from ' + (vtp.domain ?? 'NULL') + ' to ' + value;
      }
      if (option === 'version') {
        if (!/^[123]$/.test(value)) throw new Error('VTP version is 1, 2 or 3.');
        vtp.version = Number(value);
        return;
      }
      vtp.password = value.slice(0, 64);
    },
  });
  r.register({
    pattern: /^no vtp (domain|version|password)$/i,
    modes: CONFIG_MODES,
    available: (d) => d.type === 'switch',
    run: (m, _e, d) => {
      const vtp = sys(d).vtp;
      if (vtp) delete vtp[m[1].toLowerCase() as 'domain' | 'version' | 'password'];
    },
  });
  // --- spanning-tree defaults, UDLD, switchport options ------------------------------------------
  r.register({
    pattern: /^(no )?spanning-tree portfast(?: edge)? (default|bpduguard default)$/i,
    syntax: [
      'spanning-tree portfast default',
      'spanning-tree portfast bpduguard default',
      'spanning-tree portfast edge default',
      'spanning-tree portfast edge bpduguard default',
    ],
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const field = m[2].toLowerCase() === 'default' ? 'portfastDefault' : 'bpduguardDefault';
      if (m[1]) delete sys(d)[field];
      else sys(d)[field] = true;
      // Edge status changes the role of access ports: let STP re-evaluate them.
      e.rebuildSpanningTree(d.id);
    },
  });
  r.register({
    // The extended system ID is always used by this platform.
    pattern: /^spanning-tree extend system-id$/i,
    modes: CONFIG_MODES,
    run: () => undefined,
  });
  r.register({
    pattern: /^spanning-tree portfast (disable|trunk|edge(?: trunk)?)$/i,
    syntax: ['spanning-tree portfast disable', 'spanning-tree portfast trunk', 'spanning-tree portfast edge'],
    modes: ['interface'],
    run: (m, e, d, c) =>
      e.setSpanningTreePort(d.id, currentPort(d, c).id, { edge: m[1].toLowerCase() !== 'disable' }),
  });
  r.register({
    pattern: /^(no )?udld (enable|aggressive)$/i,
    syntax: ['udld enable', 'udld aggressive'],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      if (m[1]) delete sys(d).udld;
      else sys(d).udld = m[2].toLowerCase() === 'enable' ? 'normal' : 'aggressive';
    },
  });
  r.register({
    pattern: /^(no )?switchport nonegotiate$/i,
    modes: ['interface'],
    run: (m, _e, d, c) => {
      const p = currentPort(d, c);
      if (p.mode === 'routed' || p.logical) throw new Error('nonegotiate applies to switchports.');
      if (m[1]) delete p.nonegotiate;
      else p.nonegotiate = true;
    },
  });
  r.register({
    pattern: /^(no )?switchport trunk encapsulation(?: (dot1q|isl|negotiate))?$/i,
    syntax: ['switchport trunk encapsulation dot1q'],
    modes: ['interface'],
    run: (m, _e, d, c) => {
      const p = currentPort(d, c);
      if (m[1]) {
        delete p.trunkEncapsulation;
        return;
      }
      if (!m[2]) throw new Error('Specify dot1q.');
      if (m[2].toLowerCase() === 'isl') throw new Error('ISL trunking is not supported; use dot1q.');
      p.trunkEncapsulation = m[2].toLowerCase() as 'dot1q' | 'negotiate';
    },
  });
  r.register({
    pattern: /^storm-control (broadcast|multicast|unicast) level (\d+(?:\.\d+)?)(?: (\d+(?:\.\d+)?))?$/i,
    syntax: ['storm-control broadcast level <percent>', 'storm-control multicast level <percent>'],
    modes: ['interface'],
    run: (m, _e, d, c) => {
      const p = currentPort(d, c);
      if (p.mode === 'routed' || p.logical) throw new Error('storm-control applies to switchports.');
      const level = Number(m[2]);
      if (level > 100 || (m[3] && Number(m[3]) > level))
        throw new Error('Levels are percentages; the falling level cannot exceed the rising level.');
      p.stormControl = { ...p.stormControl, [m[1].toLowerCase()]: level };
    },
  });
  r.register({
    pattern: /^no storm-control (broadcast|multicast|unicast)(?: level)?$/i,
    modes: ['interface'],
    run: (m, _e, d, c) => {
      const p = currentPort(d, c);
      if (!p.stormControl) return;
      delete p.stormControl[m[1].toLowerCase() as 'broadcast' | 'multicast' | 'unicast'];
      if (!p.stormControl.broadcast && !p.stormControl.multicast && !p.stormControl.unicast)
        delete p.stormControl;
    },
  });
  r.register({
    pattern: /^(no )?storm-control action(?: (shutdown|trap))?$/i,
    syntax: ['storm-control action shutdown', 'storm-control action trap'],
    modes: ['interface'],
    run: (m, _e, d, c) => {
      const p = currentPort(d, c);
      if (m[1]) {
        if (p.stormControl) delete p.stormControl.action;
        return;
      }
      if (!m[2]) throw new Error('Specify shutdown or trap.');
      p.stormControl = { ...p.stormControl, action: m[2].toLowerCase() as 'shutdown' | 'trap' };
    },
  });
  r.register({
    pattern: /^monitor session (\d+) (source|destination) (interface|vlan) (.+?)(?: (rx|tx|both))?$/i,
    syntax: [
      'monitor session <id> source interface <interfaces...>',
      'monitor session <id> source vlan <vlans>',
      'monitor session <id> destination interface <interface>',
    ],
    modes: CONFIG_MODES,
    available: (d) => d.type === 'switch',
    run: (m, _e, d) => {
      const id = Number(m[1]);
      if (id < 1 || id > 66) throw new Error('Session number is 1-66.');
      const sessions = (sys(d).monitorSessions ??= []);
      let s = sessions.find((x) => x.id === id);
      if (!s) {
        if (sessions.length >= 4) throw new Error('At most 4 SPAN sessions on this switch.');
        sessions.push((s = { id, sources: [] }));
        sessions.sort((a, b) => a.id - b.id);
      }
      const names = m[4].split(/\s*,\s*/).flatMap((part) => {
        const range = /^(.*?)(\d+)\s*-\s*(\d+)$/.exec(part.trim());
        if (!range || m[3].toLowerCase() === 'vlan') return [part.trim()];
        return Array.from(
          { length: Number(range[3]) - Number(range[2]) + 1 },
          (_, i) => range[1] + (Number(range[2]) + i)
        );
      });
      if (m[3].toLowerCase() === 'vlan') {
        if (m[2].toLowerCase() !== 'source') throw new Error('A VLAN can only be a SPAN source.');
        const vlans = names.map(Number);
        if (vlans.some((v) => !Number.isInteger(v) || v < 1 || v > 4094)) throw new Error('Invalid VLAN.');
        s.vlans = [...new Set([...(s.vlans ?? []), ...vlans])];
        return;
      }
      const ports = names.map((n) => {
        const p = d.interfaces.find((x) => x.name.toLowerCase() === interfaceReference(d, n).toLowerCase());
        if (!p || p.logical || p.loopback) throw new Error('Invalid SPAN interface: ' + n + '.');
        return p;
      });
      if (m[2].toLowerCase() === 'destination') {
        if (ports.length !== 1) throw new Error('Specify one destination interface.');
        if (sessions.some((x) => x !== s && x.destination === ports[0].name))
          throw new Error('The interface is already a SPAN destination.');
        if (s.sources.some((src) => src.port === ports[0].name))
          throw new Error('A SPAN destination cannot also be a source.');
        s.destination = ports[0].name;
        return;
      }
      const direction = (m[5]?.toLowerCase() ?? 'both') as 'rx' | 'tx' | 'both';
      for (const p of ports) {
        if (s.destination === p.name) throw new Error('A SPAN destination cannot also be a source.');
        s.sources = [...s.sources.filter((src) => src.port !== p.name), { port: p.name, direction }];
      }
    },
  });
  r.register({
    pattern: /^no monitor session (\d+|all)$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const s = sys(d);
      if (m[1].toLowerCase() === 'all') delete s.monitorSessions;
      else s.monitorSessions = s.monitorSessions?.filter((x) => x.id !== Number(m[1]));
    },
  });
}

// --- running-config ---------------------------------------------------------------------------------
function methodText(methods?: string[]) {
  return methods?.length ? ' ' + methods.join(' ') : '';
}
/** Global lines IOS prints near the top, before interfaces. */
export function iosManagementHead(d: Device) {
  const s = d.iosSystem;
  if (!s) return [];
  const a = s.aaa,
    services = s.services ?? {};
  return [
    ...(['debug', 'log'] as const).flatMap((kind) =>
      s.timestamps?.[kind] ? ['service timestamps ' + kind + ' ' + s.timestamps[kind]] : []
    ),
    ...Object.entries(services)
      .filter(([name]) => !name.startsWith('ip-'))
      .map(([name, on]) => (on ? '' : 'no ') + 'service ' + name),
    ...(s.logging?.buffered
      ? ['logging buffered ' + s.logging.buffered.size + ' ' + levelName(s.logging.buffered.level)]
      : []),
    ...(s.logging?.console === false
      ? ['no logging console']
      : s.logging?.console !== undefined
        ? ['logging console ' + levelName(s.logging.console)]
        : []),
    ...(s.logging?.monitor === false
      ? ['no logging monitor']
      : s.logging?.monitor !== undefined
        ? ['logging monitor ' + levelName(s.logging.monitor)]
        : []),
    ...(a
      ? [
          'aaa new-model',
          ...(s.aaaGroups ?? []).flatMap((g) => [
            'aaa group server ' + (g.kind === 'tacacs' ? 'tacacs+' : 'radius') + ' ' + g.name,
            ...g.servers.map((name) => (/^[\d.]+$/.test(name) ? ' server ' + name : ' server name ' + name)),
            ...(g.sourceInterface ? [' ip ' + g.kind + ' source-interface ' + g.sourceInterface] : []),
            'exit',
          ]),
          ...a.authentication.map((x) => `aaa authentication ${x.kind} ${x.list}${methodText(x.methods)}`),
          ...a.authorization.map(
            (x) =>
              'aaa authorization ' +
              x.kind +
              (x.level !== undefined ? ' ' + x.level : '') +
              (x.list ? ' ' + x.list : '') +
              methodText(x.methods) +
              (x.ifAuthenticated ? ' if-authenticated' : '')
          ),
          ...a.accounting.map(
            (x) =>
              'aaa accounting ' +
              x.kind +
              (x.level !== undefined ? ' ' + x.level : '') +
              ' ' +
              x.list +
              ' ' +
              x.record +
              methodText(x.methods)
          ),
          ...(a.sessionIdCommon ? ['aaa session-id common'] : []),
        ]
      : []),
    ...(s.domainName ? ['ip domain name ' + s.domainName] : []),
    ...(s.domainLookup === false ? ['no ip domain lookup'] : []),
    ...Object.entries(services)
      .filter(([name]) => name.startsWith('ip-'))
      .map(
        ([name, on]) =>
          (on ? '' : 'no ') + 'ip ' + Object.keys(IP_FLAGS).find((key) => IP_FLAGS[key] === name)!
      ),
    ...(s.loginBlock
      ? [
          `login block-for ${s.loginBlock.forS} attempts ${s.loginBlock.attempts} within ${s.loginBlock.withinS}`,
        ]
      : []),
    ...(s.users ?? []).map(
      (u) =>
        'username ' +
        u.name +
        (u.privilege !== undefined ? ' privilege ' + u.privilege : '') +
        (u.secret
          ? ' secret ' + (u.secret.startsWith('$1$') ? '5' : u.secret[1]) + ' ' + u.secret
          : ' password ' + (s.passwordEncryption ? '7 ' + type7Encode(u.password!) : '0 ' + u.password))
    ),
    // VTP is kept in vlan.dat; IOS shows it in running-config only in transparent or off mode.
    ...(s.vtp && ['transparent', 'off'].includes(s.vtp.mode)
      ? [...(s.vtp.domain ? ['vtp domain ' + s.vtp.domain] : []), 'vtp mode ' + s.vtp.mode]
      : []),
    ...(s.portfastDefault ? ['spanning-tree portfast default'] : []),
    ...(s.bpduguardDefault ? ['spanning-tree portfast bpduguard default'] : []),
    ...(s.udld ? ['udld ' + (s.udld === 'normal' ? 'enable' : 'aggressive')] : []),
    ...(s.errdisableRecovery
      ? [
          ...s.errdisableRecovery.causes.map((cause) => 'errdisable recovery cause ' + cause),
          ...(s.errdisableRecovery.intervalS !== 300
            ? ['errdisable recovery interval ' + s.errdisableRecovery.intervalS]
            : []),
        ]
      : []),
  ];
}
function lineSettings(d: Device, line: IosLine) {
  return [
    ...(line.accessClass
      ? [' access-class ' + line.accessClass.acl + ' in' + (line.accessClass.vrfAlso ? ' vrf-also' : '')]
      : []),
    ...(line.execTimeout
      ? [' exec-timeout ' + line.execTimeout.minutes + ' ' + line.execTimeout.seconds]
      : []),
    ...(line.privilege !== undefined ? [' privilege level ' + line.privilege] : []),
    ...(line.password ? [' password ' + printSecret(d, line.password)] : []),
    ...(line.authorizationExec ? [' authorization exec ' + line.authorizationExec] : []),
    ...(line.accountingExec ? [' accounting exec ' + line.accountingExec] : []),
    ...(line.loggingSynchronous ? [' logging synchronous'] : []),
    ...(line.noLogin
      ? [' no login']
      : line.login
        ? [
            ' login' +
              (line.login === 'line'
                ? ''
                : line.login === 'local'
                  ? ' local'
                  : ' authentication ' + line.login.list),
          ]
        : []),
    ...(line.historySize !== undefined ? [' history size ' + line.historySize] : []),
    ...(line.noExec ? [' no exec'] : []),
    ...(line.transportInput ? [' transport input ' + line.transportInput.join(' ')] : []),
    ...(line.transportOutput ? [' transport output ' + line.transportOutput.join(' ')] : []),
  ];
}
/** "line" blocks: consecutive VTY lines with the same settings are printed together (0-4, 5-15). */
function linesRunningConfig(d: Device) {
  const lines = d.iosSystem?.lines ?? [],
    out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i],
      settings = lineSettings(d, line);
    let last = line.first;
    if (line.kind === 'vty')
      while (
        i + 1 < lines.length &&
        lines[i + 1].kind === 'vty' &&
        lines[i + 1].first === last + 1 &&
        !(last === 4 && line.first <= 4) &&
        JSON.stringify(lineSettings(d, lines[i + 1])) === JSON.stringify(settings)
      ) {
        last = lines[++i].first;
      }
    out.push(
      'line ' + line.kind + ' ' + line.first + (last !== line.first ? ' ' + last : ''),
      ...settings,
      'exit'
    );
  }
  return out;
}
/** Global lines IOS prints after the interfaces (they may name interfaces and ACLs). */
export function iosManagementTail(d: Device, banners: string[] = []) {
  const s = d.iosSystem;
  if (!s) return banners;
  const snmp = s.snmp;
  return [
    ...(s.http?.server !== undefined ? [(s.http.server ? '' : 'no ') + 'ip http server'] : []),
    ...(s.http?.secureServer !== undefined
      ? [(s.http.secureServer ? '' : 'no ') + 'ip http secure-server']
      : []),
    ...(s.http?.authentication ? ['ip http authentication ' + s.http.authentication] : []),
    ...(s.ssh?.version ? ['ip ssh version ' + s.ssh.version] : []),
    ...(s.ssh?.timeout ? ['ip ssh time-out ' + s.ssh.timeout] : []),
    ...(s.ssh?.retries !== undefined ? ['ip ssh authentication-retries ' + s.ssh.retries] : []),
    ...(s.ssh?.sourceInterface ? ['ip ssh source-interface ' + s.ssh.sourceInterface] : []),
    ...(s.ssh?.scp ? ['ip scp server enable'] : []),
    ...(s.aaaSourceInterface?.tacacs ? ['ip tacacs source-interface ' + s.aaaSourceInterface.tacacs] : []),
    ...(s.aaaSourceInterface?.radius ? ['ip radius source-interface ' + s.aaaSourceInterface.radius] : []),
    ...(s.logging?.trap !== undefined ? ['logging trap ' + levelName(s.logging.trap)] : []),
    ...(s.logging?.facility !== undefined ? ['logging facility ' + facilityName(s.logging.facility)] : []),
    ...(s.logging?.sourceInterface ? ['logging source-interface ' + s.logging.sourceInterface] : []),
    ...(snmp?.location ? ['snmp-server location ' + snmp.location] : []),
    ...(snmp?.contact ? ['snmp-server contact ' + snmp.contact] : []),
    ...(snmp?.ifindexPersist ? ['snmp-server ifindex persist'] : []),
    ...(snmp?.groups ?? []).map(
      (g) =>
        'snmp-server group ' +
        g.name +
        ' v3 ' +
        g.security +
        (g.read ? ' read ' + g.read : '') +
        (g.write ? ' write ' + g.write : '') +
        (g.access ? ' access ' + g.access : '')
    ),
    ...(snmp?.trapSource ? ['snmp-server trap-source ' + snmp.trapSource] : []),
    ...(snmp?.traps === true
      ? ['snmp-server enable traps']
      : snmp?.traps?.length
        ? ['snmp-server enable traps ' + snmp.traps.join(' ')]
        : []),
    ...(snmp?.hosts ?? []).map(
      (h) =>
        'snmp-server host ' +
        h.address +
        (h.informs ? ' informs' : '') +
        ' version ' +
        h.version +
        (h.security ? ' ' + h.security : '') +
        ' ' +
        h.community
    ),
    ...(s.aaaServers ?? []).flatMap((x) =>
      x.legacy
        ? [
            x.kind +
              '-server host ' +
              x.address +
              (x.authPort ? ' auth-port ' + x.authPort : '') +
              (x.acctPort ? ' acct-port ' + x.acctPort : '') +
              (x.key ? ' key ' + printSecret(d, x.key) : ''),
          ]
        : [
            x.kind + ' server ' + x.name,
            ...(x.address
              ? [
                  ' address ipv4 ' +
                    x.address +
                    (x.authPort ? ' auth-port ' + x.authPort : '') +
                    (x.acctPort ? ' acct-port ' + x.acctPort : ''),
                ]
              : []),
            ...(x.key ? [' key ' + printSecret(d, x.key)] : []),
            ...(x.port ? [' port ' + x.port] : []),
            ...(x.timeout ? [' timeout ' + x.timeout] : []),
            ...(x.retransmit !== undefined ? [' retransmit ' + x.retransmit] : []),
            ...(x.singleConnection ? [' single-connection'] : []),
            'exit',
          ]
    ),
    ...(s.monitorSessions ?? []).flatMap((m) => [
      ...(['both', 'rx', 'tx'] as const).flatMap((direction) => {
        const ports = m.sources.filter((src) => src.direction === direction).map((src) => src.port);
        return ports.length
          ? [
              'monitor session ' +
                m.id +
                ' source interface ' +
                ports.join(' , ') +
                (direction === 'both' ? '' : ' ' + direction),
            ]
          : [];
      }),
      ...(m.vlans?.length ? ['monitor session ' + m.id + ' source vlan ' + m.vlans.join(' , ')] : []),
      ...(m.destination ? ['monitor session ' + m.id + ' destination interface ' + m.destination] : []),
    ]),
    ...banners,
    ...linesRunningConfig(d),
    ...(s.ntp?.sourceInterface ? ['ntp source ' + s.ntp.sourceInterface] : []),
    ...(s.ntp?.authenticate ? ['ntp authenticate'] : []),
    ...(s.ntp?.keys ?? []).map((k) =>
      s.passwordEncryption
        ? 'ntp authentication-key ' + k.id + ' md5 ' + type7Encode(k.key) + ' 7'
        : 'ntp authentication-key ' + k.id + ' md5 ' + k.key
    ),
    ...(s.ntp?.trustedKeys ?? []).map((k) => 'ntp trusted-key ' + k),
  ];
}
export function stormControlRunningConfig(p: Device['interfaces'][number]) {
  const s = p.stormControl;
  if (!s) return [];
  return [
    ...(['broadcast', 'multicast', 'unicast'] as const).flatMap((kind) =>
      s[kind] !== undefined ? [' storm-control ' + kind + ' level ' + s[kind]!.toFixed(2)] : []
    ),
    ...(s.action ? [' storm-control action ' + s.action] : []),
  ];
}
/** Banners IOS shows when a session opens: MOTD first, then (for this console) the exec banner. */
export function sessionBanners(d: Device) {
  const b = d.iosSystem?.banners;
  return [b?.motd, b?.exec].filter((text): text is string => text !== undefined);
}
