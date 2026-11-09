import type { Device } from '../model';
import { acl6ListSchema, ACL6_ICMP_TYPES } from '../protocols/ipv6-model';
import type { Acl6Entry } from '../protocols/acl6';
import { normalize6 } from '../protocols/ipv6-address';
import { PORT_ALIASES, TCP_PORTS, UDP_PORTS } from './acl';
import { ALL_MODES, currentPort, type CommandRegistry, type Context } from './registry';

type List = NonNullable<Device['ipv6AccessLists']>[number];
type PortMatch = NonNullable<Acl6Entry['sourcePort']>;
const PROTOCOLS: Record<string, Acl6Entry['protocol']> = {
  ipv6: 'ipv6',
  icmp: 'icmp',
  '58': 'icmp',
  tcp: 'tcp',
  '6': 'tcp',
  udp: 'udp',
  '17': 'udp',
  ospf: 'ospf',
  '89': 'ospf',
};
const ICMP_NUMBERS: Record<string, Acl6Entry['icmpType']> = {
  '128': 'echo-request',
  '129': 'echo-reply',
  '135': 'nd-ns',
  '136': 'nd-na',
  '133': 'router-solicitation',
  '134': 'router-advertisement',
  '1': 'unreachable',
  '3': 'time-exceeded',
  '2': 'packet-too-big',
};
const invalid = (token?: string) => new Error('% Invalid input detected at: ' + (token ?? '<cr>'));
/** any | host X:X::X | X:X::X/<0-128> */
function address(tokens: string[]) {
  const value = tokens.shift();
  if (!value) throw new Error('% Incomplete command.');
  if (value.toLowerCase() === 'any') return { ip: '::', prefix: 0 };
  if (value.toLowerCase() === 'host') {
    const ip = tokens.shift();
    if (!ip) throw new Error('% Incomplete command.');
    return { ip: normalize6(ip), prefix: 128 };
  }
  const [ip, length] = value.split('/'),
    prefix = Number(length);
  if (length === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 128) throw invalid(value);
  try {
    return { ip: normalize6(ip), prefix };
  } catch {
    throw invalid(value);
  }
}
function portNumber(token: string | undefined, protocol: string) {
  const key = token?.toLowerCase() ?? '';
  const value =
    (protocol === 'udp' ? UDP_PORTS : TCP_PORTS)[key] ??
    PORT_ALIASES[key] ??
    (/^\d+$/.test(key) ? Number(key) : NaN);
  if (!Number.isInteger(value) || value > 65535) throw invalid(token);
  return value;
}
function port(tokens: string[], protocol: string): PortMatch | undefined {
  const op = tokens[0]?.toLowerCase();
  if (!op || !['eq', 'neq', 'gt', 'lt', 'range'].includes(op)) return undefined;
  if (protocol !== 'tcp' && protocol !== 'udp') throw invalid(tokens[0]);
  tokens.shift();
  const low = portNumber(tokens.shift(), protocol);
  if (op !== 'range') return { op: op as PortMatch['op'], port: low };
  const high = portNumber(tokens.shift(), protocol);
  if (high < low) throw invalid(String(high));
  return { op: 'range', port: low, end: high };
}
function compressed(ip: string, prefix: number) {
  return prefix === 0 ? 'any' : prefix === 128 ? 'host ' + ip.toUpperCase() : ip.toUpperCase() + '/' + prefix;
}
function portText(protocol: string, match?: PortMatch) {
  if (!match) return '';
  const table = Object.entries(protocol === 'udp' ? UDP_PORTS : TCP_PORTS);
  const name = (value: number) => table.find(([, n]) => n === value)?.[0] ?? String(value);
  return ' ' + match.op + ' ' + name(match.port) + (match.op === 'range' ? ' ' + name(match.end!) : '');
}
/** An entry as IOS prints it: "permit tcp 2001:DB8::/32 any eq www log". */
export function acl6EntryText(rule: Omit<Acl6Entry, 'sequence'>) {
  return (
    rule.action +
    ' ' +
    rule.protocol +
    ' ' +
    compressed(rule.source, rule.sourcePrefix) +
    portText(rule.protocol, rule.sourcePort) +
    ' ' +
    compressed(rule.destination, rule.destinationPrefix) +
    portText(rule.protocol, rule.destinationPort) +
    (rule.icmpType ? ' ' + rule.icmpType : '') +
    (rule.established ? ' established' : '') +
    (rule.log ? ' log' : '')
  );
}
/** Parses "PROTOCOL SRC [PORT] DST [PORT] [ICMP-TYPE] [established] [log] [sequence N]". */
export function parseAcl6Entry(action: 'permit' | 'deny', text: string) {
  const tokens = text.trim().split(/\s+/),
    keyword = tokens.shift()!.toLowerCase(),
    protocol = PROTOCOLS[keyword];
  if (!protocol) throw invalid(keyword);
  const source = address(tokens),
    sourcePort = port(tokens, protocol),
    destination = address(tokens),
    destinationPort = port(tokens, protocol);
  let icmpType: Acl6Entry['icmpType'];
  if (protocol === 'icmp' && tokens[0]) {
    const token = tokens[0].toLowerCase();
    icmpType = (ACL6_ICMP_TYPES as readonly string[]).includes(token)
      ? (token as Acl6Entry['icmpType'])
      : ICMP_NUMBERS[token];
    if (icmpType) tokens.shift();
  }
  const established = tokens[0]?.toLowerCase() === 'established';
  if (established) {
    if (protocol !== 'tcp') throw invalid(tokens[0]);
    tokens.shift();
  }
  const log = ['log', 'log-input'].includes(tokens[0]?.toLowerCase() ?? '');
  if (log) tokens.shift();
  let sequence: number | undefined;
  if (tokens[0]?.toLowerCase() === 'sequence') {
    tokens.shift();
    sequence = Number(tokens.shift());
    if (!Number.isInteger(sequence) || sequence < 1) throw invalid(String(sequence));
  }
  if (tokens.length) throw invalid(tokens[0]);
  return {
    sequence,
    rule: {
      action,
      protocol,
      source: source.ip,
      sourcePrefix: source.prefix,
      destination: destination.ip,
      destinationPrefix: destination.prefix,
      ...(sourcePort ? { sourcePort } : {}),
      ...(destinationPort ? { destinationPort } : {}),
      ...(icmpType ? { icmpType } : {}),
      ...(established ? { established: true } : {}),
      ...(log ? { log: true } : {}),
      hits: 0,
    },
  };
}
function store(d: Device, list: List) {
  const valid = acl6ListSchema.parse({
    ...list,
    rules: [...list.rules].sort((a, b) => a.sequence - b.sequence),
  });
  if (new Set(valid.rules.map((r) => r.sequence)).size !== valid.rules.length)
    throw new Error('% Duplicate sequence number');
  d.ipv6AccessLists = [...(d.ipv6AccessLists ?? []).filter((a) => a.name !== list.name), valid];
  if (d.ipv6AccessLists.length > 64) throw new Error('% IPv6 access-list limit reached');
}
function selected(d: Device, c: Context) {
  const list = d.ipv6AccessLists?.find((a) => a.name === c.acl);
  if (!list) throw new Error('% IPv6 access-list not selected');
  return list;
}
export function showIpv6AccessLists(d: Device, name?: string) {
  return (d.ipv6AccessLists ?? [])
    .filter((a) => !name || a.name === name)
    .map((list) =>
      [
        'IPv6 access list ' + list.name,
        ...list.rules.map(
          (r) =>
            '    ' +
            acl6EntryText(r) +
            (r.hits ? ` (${r.hits} match${r.hits === 1 ? '' : 'es'})` : '') +
            ' sequence ' +
            r.sequence
        ),
      ].join('\n')
    )
    .join('\n');
}
export function acl6RunningConfig(d: Device) {
  return (d.ipv6AccessLists ?? []).flatMap((list) => [
    'ipv6 access-list ' + list.name,
    ...list.rules.flatMap((r) => [
      ...(r.remarks ?? []).map((text) => ' remark ' + text),
      ' sequence ' + r.sequence + ' ' + acl6EntryText(r),
    ]),
    ...(list.remarks ?? []).map((text) => ' remark ' + text),
    'exit',
  ]);
}
export function acl6InterfaceLines(p: Device['interfaces'][number]) {
  return [
    ...(p.ipv6FilterIn ? [' ipv6 traffic-filter ' + p.ipv6FilterIn + ' in'] : []),
    ...(p.ipv6FilterOut ? [' ipv6 traffic-filter ' + p.ipv6FilterOut + ' out'] : []),
  ];
}
export function registerAcl6Commands(r: CommandRegistry) {
  r.register({
    pattern: /^(no )?ipv6 access-list ([A-Za-z0-9_.-]{1,64})$/i,
    syntax: ['ipv6 access-list <name>', 'no ipv6 access-list <name>'],
    modes: ['config'],
    run: (m, e, d, c) => {
      const name = m[2];
      if (m[1]) {
        d.ipv6AccessLists = d.ipv6AccessLists?.filter((a) => a.name !== name);
        e.emit('CONFIG_CHANGED', d.id, 'IPv6 access-list ' + name + ' removed.');
        return;
      }
      if (!d.ipv6AccessLists?.some((a) => a.name === name)) store(d, { name, rules: [] });
      c.mode = 'ipv6-acl';
      c.acl = name;
    },
  });
  r.register({
    pattern: /^(?:sequence (\d+) )?(permit|deny) (.+)$/i,
    syntax: [
      'permit <protocol> <source> <destination>',
      'deny <protocol> <source> <destination>',
      'sequence <number> permit|deny <rule...>',
    ],
    modes: ['ipv6-acl'],
    run: (m, e, d, c) => {
      const list = selected(d, c),
        parsed = parseAcl6Entry(m[2].toLowerCase() as 'permit' | 'deny', m[3]);
      if (m[1] && parsed.sequence !== undefined) throw invalid('sequence');
      const sequence =
        Number(m[1] ?? NaN) || parsed.sequence || Math.max(0, ...list.rules.map((v) => v.sequence)) + 10;
      const previous = list.rules.find((v) => v.sequence === sequence);
      // Remarks typed before an entry describe it, as in the running-config.
      const remarks = list.remarks?.length ? list.remarks : previous?.remarks;
      store(d, {
        name: list.name,
        rules: [
          ...list.rules.filter((v) => v.sequence !== sequence),
          { ...parsed.rule, sequence, ...(remarks?.length ? { remarks } : {}) },
        ],
      });
      e.emit('CONFIG_CHANGED', d.id, `IPv6 access-list ${list.name} sequence ${sequence} configured.`);
    },
  });
  r.register({
    pattern: /^remark (.+)$/i,
    syntax: 'remark <text>',
    modes: ['ipv6-acl'],
    run: (m, _e, d, c) => {
      const list = selected(d, c),
        text = m[1].trim();
      if (text.length > 100) throw new Error('% Remark text exceeds 100 characters.');
      store(d, { ...list, remarks: [...(list.remarks ?? []), text].slice(-8) });
    },
  });
  r.register({
    pattern: /^no (?:sequence (\d+)|(permit|deny) (.+))$/i,
    syntax: ['no sequence <number>', 'no permit <rule...>', 'no deny <rule...>'],
    modes: ['ipv6-acl'],
    run: (m, e, d, c) => {
      const list = selected(d, c);
      let rules = list.rules;
      if (m[1]) rules = rules.filter((v) => v.sequence !== Number(m[1]));
      else {
        const target = acl6EntryText(parseAcl6Entry(m[2].toLowerCase() as 'permit' | 'deny', m[3]).rule);
        rules = rules.filter((v) => acl6EntryText(v) !== target);
      }
      store(d, { ...list, rules });
      e.emit('CONFIG_CHANGED', d.id, 'IPv6 access-list ' + list.name + ' entry removed.');
    },
  });
  r.register({
    pattern: /^(no )?ipv6 traffic-filter ([A-Za-z0-9_.-]{1,64}) (in|out)$/i,
    syntax: ['ipv6 traffic-filter <name> in|out', 'no ipv6 traffic-filter <name> in|out'],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c),
        key = m[3].toLowerCase() === 'in' ? 'ipv6FilterIn' : 'ipv6FilterOut';
      if (m[1]) {
        if (p[key] === m[2]) delete p[key];
      } else p[key] = m[2];
      e.emit(
        'CONFIG_CHANGED',
        d.id,
        `IPv6 traffic-filter ${m[2]} ${m[3].toLowerCase()} ${m[1] ? 'removed from' : 'applied to'} ${p.name}.`,
        { port: p.id }
      );
    },
  });
  r.register({
    pattern: /^show ipv6 access-list(?: ([A-Za-z0-9_.-]{1,64}))?$/i,
    syntax: ['show ipv6 access-list', 'show ipv6 access-list <name>'],
    modes: ALL_MODES,
    run: (m, _e, d) => showIpv6AccessLists(d, m[1]),
  });
  r.register({
    pattern: /^clear ipv6 access-list(?: counters)?(?: ([A-Za-z0-9_.-]{1,64}))?$/i,
    syntax: ['clear ipv6 access-list', 'clear ipv6 access-list <name>'],
    modes: ['privileged'],
    run: (m, _e, d) => {
      for (const list of d.ipv6AccessLists ?? [])
        if (!m[1] || list.name === m[1]) for (const rule of list.rules) rule.hits = 0;
      return '';
    },
  });
}
