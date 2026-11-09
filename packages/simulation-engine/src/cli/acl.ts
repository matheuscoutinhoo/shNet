import type { AccessList, AclRule } from '../model';
import { ipNumber, ipString, mask, parsePrefix, subnet } from '../protocols/ipv4';
import type { CommandRegistry } from './registry';

// IOS port keywords; show commands print these names instead of the numbers.
const TCP_PORTS: Record<string, number> = {
  bgp: 179,
  chargen: 19,
  cmd: 514,
  daytime: 13,
  discard: 9,
  domain: 53,
  echo: 7,
  exec: 512,
  finger: 79,
  ftp: 21,
  'ftp-data': 20,
  gopher: 70,
  hostname: 101,
  ident: 113,
  irc: 194,
  klogin: 543,
  kshell: 544,
  login: 513,
  lpd: 515,
  nntp: 119,
  pop2: 109,
  pop3: 110,
  smtp: 25,
  sunrpc: 111,
  tacacs: 49,
  talk: 517,
  telnet: 23,
  time: 37,
  uucp: 540,
  whois: 43,
  www: 80,
};
const UDP_PORTS: Record<string, number> = {
  biff: 512,
  bootpc: 68,
  bootps: 67,
  discard: 9,
  dnsix: 195,
  domain: 53,
  echo: 7,
  isakmp: 500,
  'mobile-ip': 434,
  nameserver: 42,
  'netbios-dgm': 138,
  'netbios-ns': 137,
  'netbios-ss': 139,
  'non500-isakmp': 4500,
  ntp: 123,
  'pim-auto-rp': 496,
  rip: 520,
  snmp: 161,
  snmptrap: 162,
  sunrpc: 111,
  syslog: 514,
  tacacs: 49,
  talk: 517,
  tftp: 69,
  time: 37,
  who: 513,
  xdmcp: 177,
};
// Accepted as input for convenience; IOS prints these ports as numbers.
const PORT_ALIASES: Record<string, number> = { http: 80, https: 443, ssh: 22 };
// IOS ICMP message keywords: [type] or [type, code].
const ICMP_TYPES: Record<string, [number, number?]> = {
  'administratively-prohibited': [3, 13],
  echo: [8],
  'echo-reply': [0],
  'host-unreachable': [3, 1],
  'information-reply': [16],
  'information-request': [15],
  'mask-reply': [18],
  'mask-request': [17],
  'net-unreachable': [3, 0],
  'packet-too-big': [3, 4],
  'parameter-problem': [12],
  'port-unreachable': [3, 3],
  'protocol-unreachable': [3, 2],
  redirect: [5],
  'router-advertisement': [9],
  'router-solicitation': [10],
  'source-quench': [4],
  'time-exceeded': [11],
  'timestamp-reply': [14],
  'timestamp-request': [13],
  traceroute: [30],
  'ttl-exceeded': [11, 0],
  unreachable: [3],
};
// IP protocol numbers IOS accepts in place of a keyword.
const protocolNumbers: Record<string, string> = {
  '1': 'icmp',
  '6': 'tcp',
  '17': 'udp',
  '47': 'gre',
  '50': 'esp',
  '88': 'eigrp',
  '89': 'ospf',
  '112': 'vrrp',
};
function address(tokens: string[]) {
  const value = tokens.shift();
  if (value?.toLowerCase() === 'any') return { range: { network: '0.0.0.0', prefix: 0 } };
  if (value?.toLowerCase() === 'host') {
    const ip = tokens.shift();
    if (!ip) throw new Error('Incomplete host address.');
    ipNumber(ip);
    return { range: { network: ip, prefix: 32 } };
  }
  if (!value) throw new Error('Incomplete address.');
  ipNumber(value);
  if (!tokens[0] || !/^[\d.]+$/.test(tokens[0])) return { range: { network: value, prefix: 32 } };
  const wildcard = tokens.shift()!;
  const bits = ~ipNumber(wildcard) >>> 0;
  try {
    const prefix = parsePrefix(ipString(bits));
    return { range: { network: subnet(value, prefix).network, prefix } };
  } catch {
    return { range: { network: ipString(ipNumber(value) & bits), prefix: 32 }, wildcard };
  }
}
type PortMatch = { port: number; op?: AclRule['sourcePortOp']; end?: number };
function portNumber(token: string | undefined, protocol: string) {
  const key = token?.toLowerCase() ?? '';
  const value =
    (protocol === 'udp' ? UDP_PORTS : TCP_PORTS)[key] ??
    PORT_ALIASES[key] ??
    (/^\d+$/.test(key) ? Number(key) : NaN);
  if (!Number.isInteger(value) || value < 0 || value > 65535)
    throw new Error('Invalid input detected at: ' + (token ?? 'port'));
  return value;
}
/** eq|neq|gt|lt PORT or range LOW HIGH, with IOS port keywords. */
function port(tokens: string[], protocol: string): PortMatch | undefined {
  const op = tokens[0]?.toLowerCase();
  if (!op || !['eq', 'neq', 'gt', 'lt', 'range'].includes(op)) return undefined;
  if (protocol !== 'tcp' && protocol !== 'udp') throw new Error('Invalid input detected at: ' + tokens[0]);
  tokens.shift();
  const low = portNumber(tokens.shift(), protocol);
  if (op !== 'range') return { port: low, ...(op === 'eq' ? {} : { op: op as 'neq' | 'gt' | 'lt' }) };
  const high = portNumber(tokens.shift(), protocol);
  if (high < low) throw new Error('Invalid port range: ' + low + ' ' + high);
  return { port: low, op: 'range', end: high };
}
function portFields(side: 'source' | 'destination', match?: PortMatch) {
  if (!match) return {};
  return {
    [`${side}Port`]: match.port,
    ...(match.op ? { [`${side}PortOp`]: match.op } : {}),
    ...(match.end !== undefined ? { [`${side}PortEnd`]: match.end } : {}),
  };
}
/** Optional ICMP message: a keyword (echo, unreachable...) or TYPE [CODE]. */
function icmpMessage(tokens: string[]): Pick<AclRule, 'icmpType' | 'icmpCode'> {
  const token = tokens[0]?.toLowerCase();
  const named = token === undefined ? undefined : ICMP_TYPES[token];
  if (named) {
    tokens.shift();
    return { icmpType: named[0], ...(named[1] !== undefined ? { icmpCode: named[1] } : {}) };
  }
  if (!token || !/^\d+$/.test(token)) return {};
  tokens.shift();
  const type = Number(token),
    code = tokens[0] && /^\d+$/.test(tokens[0]) ? Number(tokens.shift()) : undefined;
  if (type > 255 || (code !== undefined && code > 255)) throw new Error('Invalid ICMP type or code.');
  return { icmpType: type, ...(code !== undefined ? { icmpCode: code } : {}) };
}
function portText(protocol: string, port?: number, op?: AclRule['sourcePortOp'], end?: number) {
  if (port === undefined) return '';
  const table = Object.entries(protocol === 'udp' ? UDP_PORTS : TCP_PORTS);
  const name = (value: number) => table.find(([, number]) => number === value)?.[0] ?? String(value);
  return ' ' + (op ?? 'eq') + ' ' + name(port) + (op === 'range' ? ' ' + name(end!) : '');
}
function icmpText(rule: AclRule) {
  if (rule.icmpType === undefined) return '';
  const name = Object.entries(ICMP_TYPES).find(
    ([, [type, code]]) => type === rule.icmpType && code === rule.icmpCode
  )?.[0];
  return ' ' + (name ?? rule.icmpType + (rule.icmpCode !== undefined ? ' ' + rule.icmpCode : ''));
}
/** An ACL entry as IOS prints it after the sequence number ("permit tcp any any eq www log"). */
export function aclEntryText(
  rule: AclRule,
  kind: AccessList['kind'],
  standardAddress: (range: AclRule['source'], wildcard?: string) => string = aclAddress
) {
  const body =
    kind === 'standard'
      ? standardAddress(rule.source, rule.sourceWildcard)
      : rule.protocol +
        ' ' +
        aclAddress(rule.source, rule.sourceWildcard) +
        portText(rule.protocol, rule.sourcePort, rule.sourcePortOp, rule.sourcePortEnd) +
        ' ' +
        aclAddress(rule.destination, rule.destinationWildcard) +
        portText(rule.protocol, rule.destinationPort, rule.destinationPortOp, rule.destinationPortEnd) +
        icmpText(rule) +
        (rule.established ? ' established' : '');
  return rule.action + ' ' + body + (rule.log ? ' ' + rule.log : '');
}
/** Running-config lines of an ACL: entries with their remarks, then trailing remarks. */
export function aclRunningLines(acl: AccessList) {
  return [
    ...acl.rules.flatMap((rule) => [
      ...(rule.remarks ?? []).map((text) => ' remark ' + text),
      ' ' + rule.sequence + ' ' + aclEntryText(rule, acl.kind),
    ]),
    ...(acl.remarks ?? []).map((text) => ' remark ' + text),
  ];
}
export function aclAddress(range: AclRule['source'], wildcard?: string) {
  return wildcard
    ? `${range.network} ${wildcard}`
    : range.prefix === 0
      ? 'any'
      : range.prefix === 32
        ? `host ${range.network}`
        : `${range.network} ${ipString(~mask(range.prefix))}`;
}
export function registerNativeAclCommands(r: CommandRegistry) {
  r.register({
    pattern: /^access-list (\d+) (permit|deny|remark) (.+)$/i,
    syntax: ['access-list <number> permit|deny <rule...>', 'access-list <number> remark <text>'],
    modes: ['config'],
    run: (m, e, d) => {
      const n = Number(m[1]),
        kind =
          (n >= 1 && n <= 99) || (n >= 1300 && n <= 1999)
            ? 'standard'
            : (n >= 100 && n <= 199) || (n >= 2000 && n <= 2699)
              ? 'extended'
              : undefined;
      if (!kind) throw new Error('Invalid numbered IPv4 ACL range.');
      const context = { mode: 'config' as const };
      r.execute(`ip access-list ${kind} ${n}`, e, d, context);
      r.execute(`${m[2]} ${m[3]}`, e, d, context);
    },
  });
  r.register({
    pattern: /^(no )?ip access-list (standard|extended) ([\w-]{1,32})$/i,
    syntax: [
      'ip access-list standard <name>',
      'ip access-list extended <name>',
      'no ip access-list standard <name>',
      'no ip access-list extended <name>',
    ],
    modes: ['config'],
    run: (m, e, d, c) => {
      if (m[1]) {
        e.removeAcl(d.id, m[3], true);
        return;
      }
      const kind = m[2].toLowerCase() as 'standard' | 'extended',
        previous = d.accessLists?.find((a) => a.name === m[3]);
      if (previous?.kind && previous.kind !== kind) throw new Error('ACL type cannot be changed in place.');
      e.configureAcl(d.id, { ...previous, name: m[3], kind, rules: previous?.rules ?? [] });
      c.mode = 'acl';
      c.acl = m[3];
      c.aclType = kind;
    },
  });
  r.register({
    pattern: /^(?:(\d+) )?(permit|deny) (.+)$/i,
    syntax: [
      'permit <rule...>',
      'deny <rule...>',
      '<sequence> permit <rule...>',
      '<sequence> deny <rule...>',
    ],
    modes: ['acl'],
    run: (m, e, d, c) => {
      const acl = d.accessLists?.find((a) => a.name === c.acl);
      if (!acl) throw new Error('Select an ACL.');
      const tokens = m[3].trim().split(/\s+/),
        standard = c.aclType === 'standard';
      const keyword = standard ? 'ip' : tokens.shift()!.toLowerCase(),
        protocol = protocolNumbers[keyword] ?? keyword;
      if (!['ip', 'icmp', 'udp', 'tcp', 'ospf', 'eigrp', 'vrrp', 'gre', 'esp'].includes(protocol))
        throw new Error('Unsupported ACL protocol.');
      const source = address(tokens),
        sourcePort = standard ? undefined : port(tokens, protocol);
      const destination = standard ? { range: { network: '0.0.0.0', prefix: 0 } } : address(tokens);
      const destinationPort = standard ? undefined : port(tokens, protocol);
      const icmp = protocol === 'icmp' ? icmpMessage(tokens) : {};
      const established = !standard && tokens[0]?.toLowerCase() === 'established';
      if (established) tokens.shift();
      if (established && protocol !== 'tcp') throw new Error('established requires TCP.');
      const log = ['log', 'log-input'].includes(tokens[0]?.toLowerCase() ?? '')
        ? (tokens.shift()!.toLowerCase() as 'log' | 'log-input')
        : undefined;
      if (log === 'log-input' && standard) throw new Error('Invalid input detected at: log-input');
      if (tokens.length) throw new Error('Invalid input detected at: ' + tokens[0]);
      const sequence = m[1] ? Number(m[1]) : Math.max(0, ...acl.rules.map((r) => r.sequence)) + 10;
      const previous = acl.rules.find((r) => r.sequence === sequence);
      const { remarks: pending, ...list } = acl;
      // Remarks typed before an entry describe it, as in the running-config.
      const remarks = pending?.length ? pending : previous?.remarks;
      const rule = {
        sequence,
        action: m[2].toLowerCase(),
        protocol,
        source: source.range,
        destination: destination.range,
        sourceWildcard: source.wildcard,
        destinationWildcard: 'wildcard' in destination ? destination.wildcard : undefined,
        ...portFields('source', sourcePort),
        ...portFields('destination', destinationPort),
        ...icmp,
        ...(established ? { established: true } : {}),
        ...(log ? { log } : {}),
        ...(remarks?.length ? { remarks } : {}),
      };
      e.configureAcl(d.id, { ...list, rules: [...acl.rules.filter((r) => r.sequence !== sequence), rule] });
    },
  });
  r.register({
    pattern: /^(?:(\d+) )?remark(?: (.*))?$/i,
    syntax: 'remark <text>',
    modes: ['acl'],
    run: (m, e, d, c) => {
      const acl = d.accessLists?.find((a) => a.name === c.acl);
      if (!acl) throw new Error('Select an ACL.');
      const text = m[2]?.trim() ?? '';
      if (!text) throw new Error('Incomplete command.');
      if (text.length > 100) throw new Error('Remark text exceeds 100 characters.');
      const target = m[1] ? acl.rules.find((rule) => rule.sequence === Number(m[1])) : undefined;
      if (target) {
        target.remarks = [...(target.remarks ?? []), text].slice(-8);
        e.configureAcl(d.id, acl);
        return;
      }
      e.configureAcl(d.id, { ...acl, remarks: [...(acl.remarks ?? []), text].slice(-8) });
    },
  });
  r.register({
    pattern: /^no (\d+)$/i,
    syntax: 'no <sequence>',
    modes: ['acl'],
    run: (m, e, d, c) => {
      const acl = d.accessLists?.find((a) => a.name === c.acl);
      if (!acl) throw new Error('Select an ACL.');
      e.configureAcl(d.id, { ...acl, rules: acl.rules.filter((r) => r.sequence !== Number(m[1])) });
    },
  });
}
