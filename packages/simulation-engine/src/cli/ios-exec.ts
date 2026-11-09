import type { SimulationEngine } from '../core/engine';
import { LIMITS, type Device, type NetworkInterface } from '../model';
import { EXEC_MODES, ALL_MODES, type CommandRegistry, type Context } from './registry';
import {
  interfaceName,
  longInterfaceName,
  showRouteEntry,
  showRouteSummary,
  showRoutes,
  type RouteFilter,
} from './operational';
import { interfaceOperational } from '../protocols/layer3';
import { arpAgeMs } from '../protocols/arp';
import { ipNumber, parsePrefix } from '../protocols/ipv4';
import { clearOspfProcess } from '../protocols/ospf';
import { ospfAreaType } from '../protocols/ospf-security';
import { RIP } from '../protocols/rip-model';
import { withConfigHeader } from './running-config';

// ---------------------------------------------------------------------------------------------
// Output modifiers: "show ... | include|exclude|begin|section|count REGEX".
const MODIFIERS = ['begin', 'count', 'exclude', 'include', 'section'] as const;
export type OutputModifier = {
  command: string;
  kind: (typeof MODIFIERS)[number];
  pattern: RegExp;
  // "| section exclude REGEX" drops the matching sections instead.
  invert?: boolean;
};
/** IOS regular expressions: "_" matches a delimiter (start, end, space, comma, braces, parentheses). */
function iosRegex(source: string) {
  if (!source) throw new Error('Incomplete command.');
  if (source.length > 256) throw new Error('Regular expression is too long.');
  try {
    return new RegExp(source.replace(/(?<!\\)_/g, '(?:^|$|[ ,{}()])'));
  } catch {
    throw new Error('Invalid regular expression: ' + source);
  }
}
/**
 * Splits a show command from its output modifier. IOS takes the first "|" as the modifier and any
 * later "|" as part of the regular expression (alternatives).
 */
export function parseOutputModifier(line: string): OutputModifier | undefined {
  const match = /^((?:do\s+)?(?:sh|sho|show|more)\s.*?)\s*\|\s*([a-z]+)(?:\s+(.*))?$/i.exec(line);
  if (!match) return;
  const kind = MODIFIERS.find((name) => name.startsWith(match[2].toLowerCase()));
  if (!kind) throw new Error('Invalid input detected at: ' + match[2]);
  let text = (match[3] ?? '').trim(),
    invert = false;
  if (kind === 'section') {
    const sub = /^(include|exclude)\s+(.*)$/i.exec(text);
    if (sub) {
      invert = sub[1].toLowerCase() === 'exclude';
      text = sub[2];
    }
  }
  return { command: match[1].trim(), kind, pattern: iosRegex(text), ...(invert ? { invert } : {}) };
}
const indentOf = (line: string) => line.length - line.trimStart().length;
export function applyOutputModifier(output: string, modifier: OutputModifier) {
  const lines = output.split('\n'),
    test = (line: string) => modifier.pattern.test(line);
  switch (modifier.kind) {
    case 'include':
      return lines.filter(test).join('\n');
    case 'exclude':
      return lines.filter((line) => !test(line)).join('\n');
    case 'begin': {
      const start = lines.findIndex(test);
      return start < 0 ? '' : lines.slice(start).join('\n');
    }
    case 'count':
      return 'Number of lines which match regexp = ' + lines.filter(test).length;
    case 'section': {
      // A section is a matching line and every line indented below it.
      const shown: string[] = [];
      for (let i = 0; i < lines.length;) {
        const depth = indentOf(lines[i]);
        let end = i + 1;
        while (end < lines.length && lines[end].trim() && indentOf(lines[end]) > depth) end++;
        const block = lines.slice(i, end);
        if (modifier.invert ? !block.some(test) : test(lines[i])) {
          shown.push(...block);
          i = end;
        } else i++;
      }
      return shown.join('\n');
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Clear commands confirmed in the terminal dialog.
export function answerClear(
  e: SimulationEngine,
  d: Device,
  kind: 'clear-counters' | 'clear-logging' | 'clear-ospf',
  port?: string
) {
  if (kind === 'clear-logging') {
    delete d.syslogBuffer;
    return;
  }
  if (kind === 'clear-ospf') {
    clearOspfProcess(e, d);
    return;
  }
  const ports = d.interfaces.filter((p) => !port || p.id === port);
  for (const p of ports) Object.assign(p, { rx: 0, tx: 0, errors: 0 });
  const target = port ? 'interface ' + longInterfaceName(ports[0]?.name ?? port) : 'all interfaces';
  e.emit('CONFIG_CHANGED', d.id, `%CLEAR-5-COUNTERS: Clear counter on ${target} by console`);
}
function findPort(d: Device, name: string) {
  const port = d.interfaces.find((p) => p.name.toLowerCase() === interfaceName(name).toLowerCase());
  if (!port) throw new Error('Invalid input detected at: ' + name);
  return port;
}
const dotted = (mac: string) => {
  const hex = mac.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return hex.slice(0, 4) + '.' + hex.slice(4, 8) + '.' + hex.slice(8, 12);
};
const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
};

// ---------------------------------------------------------------------------------------------
/** "show ip arp" / "show arp" as IOS prints them: own addresses (age "-"), learned and incomplete. */
export function showIosArp(e: SimulationEngine, d: Device, filter?: string) {
  const rows: { ip: string; age: string; mac: string; port?: NetworkInterface }[] = [];
  // Only Ethernet interfaces resolve addresses with ARP (no loopbacks, tunnels or serial links).
  for (const p of d.interfaces)
    if (
      p.ip &&
      !p.loopback &&
      !p.tunnel &&
      !p.iosTunnel &&
      p.media !== 'serial' &&
      interfaceOperational(e.state, d, p)
    )
      rows.push({ ip: p.ip, age: '-', mac: dotted(p.mac), port: p });
  for (const entry of d.arpTable) {
    const learned = entry.expires - arpAgeMs(d);
    rows.push({
      ip: entry.ip,
      age: String(Math.max(0, Math.floor((e.state.clock - learned) / 60000))),
      mac: dotted(entry.mac),
      port: d.interfaces.find((p) => p.id === entry.port),
    });
  }
  for (const entry of d.arpResolutions ?? [])
    if (!rows.some((row) => row.ip === entry.ip)) rows.push({ ip: entry.ip, age: '0', mac: 'Incomplete' });
  let shown = rows.sort((a, b) => ipNumber(a.ip) - ipNumber(b.ip));
  if (filter) {
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(filter)) shown = shown.filter((row) => row.ip === filter);
    else {
      const port = findPort(d, filter);
      shown = shown.filter((row) => row.port?.id === port.id);
    }
  }
  return [
    'Protocol  Address          Age (min)  Hardware Addr   Type   Interface',
    ...shown.map(
      (row) =>
        'Internet  ' +
        row.ip.padEnd(17) +
        row.age.padStart(8) +
        '   ' +
        row.mac.padEnd(16) +
        'ARPA'.padEnd(7) +
        (row.port ? longInterfaceName(row.port.name) : '')
    ),
  ].join('\n');
}
// Catalyst switches forward these reserved addresses to the CPU in every VLAN.
const CPU_MACS = [
  '0100.0ccc.cccc',
  '0100.0ccc.cccd',
  ...Array.from({ length: 16 }, (_, i) => '0180.c200.' + i.toString(16).padStart(4, '0')),
  '0180.c200.0010',
  'ffff.ffff.ffff',
];
/** "show mac address-table [dynamic|static] [address M] [interface X] [vlan N]" in Catalyst format. */
export function showIosMacTable(d: Device, args: string) {
  const tokens = args.trim() ? args.trim().split(/\s+/) : [];
  let type: 'dynamic' | 'static' | undefined, address: string | undefined, port: NetworkInterface | undefined;
  let vlan: number | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i].toLowerCase();
    if (word === 'dynamic' || word === 'static') type = word;
    else if (word === 'address' && tokens[i + 1]) address = dotted(tokens[++i]);
    else if (word === 'interface' && tokens[i + 1]) port = findPort(d, tokens[++i]);
    else if (word === 'vlan' && /^\d+$/.test(tokens[i + 1] ?? '')) vlan = Number(tokens[++i]);
    else throw new Error('Invalid input detected at: ' + tokens[i]);
  }
  const secure = (p: NetworkInterface | undefined, mac: string) =>
    !!p?.portSecurity?.enabled &&
    [...p.portSecurity.macs, ...(p.portSecurity.stickyMacs ?? []), ...p.portSecurity.learned].includes(mac);
  const entries = d.macTable.map((entry) => {
    const p = d.interfaces.find((i) => i.id === entry.port);
    return {
      vlan: String(entry.vlan),
      mac: dotted(entry.mac),
      type: secure(p, entry.mac) ? 'STATIC' : 'DYNAMIC',
      port: p,
      ports: p ? p.name : '',
    };
  });
  const cpu =
    !port && vlan === undefined && type !== 'dynamic'
      ? CPU_MACS.map((mac) => ({ vlan: 'All', mac, type: 'STATIC', port: undefined, ports: 'CPU' }))
      : [];
  const shown = [
    ...cpu,
    ...entries.sort((a, b) => Number(a.vlan) - Number(b.vlan) || a.mac.localeCompare(b.mac)),
  ].filter(
    (row) =>
      (!type || row.type === type.toUpperCase()) &&
      (!address || row.mac === address) &&
      (!port || row.port?.id === port.id) &&
      (vlan === undefined || row.vlan === String(vlan))
  );
  return [
    '          Mac Address Table',
    '-------------------------------------------',
    '',
    'Vlan    Mac Address       Type        Ports',
    '----    -----------       --------    -----',
    ...shown.map(
      (row) => row.vlan.padStart(4) + '    ' + row.mac.padEnd(18) + row.type.padEnd(12) + row.ports
    ),
    'Total Mac Addresses for this criterion: ' + shown.length,
  ].join('\n');
}
function showMacCount(d: Device) {
  const vlans = [...new Set(d.macTable.map((entry) => entry.vlan))].sort((a, b) => a - b);
  return [
    ...vlans.flatMap((v) => {
      const total = d.macTable.filter((entry) => entry.vlan === v).length;
      return [
        `Mac Entries for Vlan ${v}:`,
        '---------------------------',
        `Dynamic Address Count  : ${total}`,
        'Static  Address Count  : 0',
        `Total Mac Addresses    : ${total}`,
        '',
      ];
    }),
    `Total Mac Address Space Available: ${Math.max(0, 8192 - d.macTable.length)}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
/** "show ip protocols" for the OSPF, BGP and RIP processes. */
export function showIpProtocols(e: SimulationEngine, d: Device) {
  const blocks: string[][] = [
    [
      'Routing Protocol is "application"',
      '  Sending updates every 0 seconds',
      '  Invalid after 0 seconds, hold down 0, flushed after 0',
      '  Outgoing update filter list for all interfaces is not set',
      '  Incoming update filter list for all interfaces is not set',
      '  Maximum path: 32',
      '  Routing for Networks:',
      '  Routing Information Sources:',
      '    Gateway         Distance      Last Update',
      '  Distance: (default is 4)',
    ],
  ];
  const sources = (list: { gateway: string; distance: number; at?: number }[]) => [
    '  Routing Information Sources:',
    '    Gateway         Distance      Last Update',
    ...list.map(
      (s) =>
        '    ' +
        s.gateway.padEnd(16) +
        String(s.distance).padStart(8) +
        '      ' +
        (s.at === undefined ? 'never' : elapsed(e.state.clock - s.at))
    ),
  ];
  const ospf = d.ospf;
  if (ospf) {
    const areas = [...new Set(ospf.interfaces.map((i) => i.area))].sort((a, b) => a - b);
    const count = (type: string) => areas.filter((a) => ospfAreaType(d, a) === type).length;
    const explicit = ospf.interfaces.filter((i) => !i.networkManaged);
    const name = (port: string) => longInterfaceName(d.interfaces.find((p) => p.id === port)?.name ?? port);
    const latest = new Map<string, number>();
    for (const lsa of ospf.lsdb)
      if (!lsa.withdrawn && lsa.advertisingRouter !== ospf.routerId)
        latest.set(lsa.advertisingRouter, Math.max(latest.get(lsa.advertisingRouter) ?? 0, lsa.originatedAt));
    const asbr = !!ospf.redistribute?.length || !!ospf.defaultOriginate;
    blocks.push([
      `Routing Protocol is "ospf ${ospf.processId ?? 1}"`,
      '  Outgoing update filter list for all interfaces is not set',
      '  Incoming update filter list for all interfaces is not set',
      `  Router ID ${ospf.routerId}`,
      ...(areas.includes(0) && areas.length > 1 ? ['  It is an area border router'] : []),
      ...(asbr ? ['  It is an autonomous system boundary router'] : []),
      ...(ospf.redistribute?.length
        ? [
            ' Redistributing External Routes from,',
            ...ospf.redistribute.map((r) => '    ' + r.source + (r.process ? ' ' + r.process : '')),
          ]
        : []),
      `  Number of areas in this router is ${areas.length}. ${count('normal')} normal ${count('stub')} stub ${count('nssa')} nssa`,
      `  Maximum path: ${ospf.maximumPaths}`,
      '  Routing for Networks:',
      ...(ospf.networks ?? []).map((n) => `    ${n.address} ${n.wildcard} area ${n.area}`),
      ...[...new Set(explicit.map((i) => i.area))].flatMap((area) => [
        `  Routing on Interfaces Configured Explicitly (Area ${area}):`,
        ...explicit.filter((i) => i.area === area).map((i) => '    ' + name(i.port)),
      ]),
      ...(ospf.interfaces.some((i) => i.passive)
        ? [
            '  Passive Interface(s):',
            ...ospf.interfaces.filter((i) => i.passive).map((i) => '    ' + name(i.port)),
          ]
        : []),
      ...sources([...latest].map(([gateway, at]) => ({ gateway, distance: 110, at }))),
      '  Distance: (default is 110)',
    ]);
  }
  const bgp = d.bgp;
  if (bgp) {
    blocks.push([
      `Routing Protocol is "bgp ${bgp.asn}"`,
      '  Outgoing update filter list for all interfaces is not set',
      '  Incoming update filter list for all interfaces is not set',
      '  IGP synchronization is disabled',
      '  Automatic route summarization is disabled',
      ...(bgp.redistribute?.length
        ? [
            '  Redistributing: ' +
              bgp.redistribute.map((r) => r.source + (r.process ? ' ' + r.process : '')).join(', '),
          ]
        : []),
      '  Neighbor(s):',
      '    Address          FiltIn FiltOut DistIn DistOut Weight RouteMap',
      ...bgp.neighbors.map(
        (n) =>
          '    ' +
          n.ip.padEnd(17) +
          ' '.repeat(39) +
          [n.importRouteMap, n.exportRouteMap].filter(Boolean).join(' ')
      ),
      '  Maximum path: 1',
      ...sources(
        bgp.peers
          .filter((p) => p.state === 'Established')
          .map((p) => ({
            gateway: p.ip,
            distance: bgp.neighbors.find((n) => n.ip === p.ip)?.remoteAs === bgp.asn ? 200 : 20,
            at: p.establishedAt,
          }))
      ),
      '  Distance: external 20 internal 200 local 200',
    ]);
  }
  const rip = d.rip;
  if (rip) {
    const learned = new Map<string, number>();
    for (const route of rip.table)
      if (route.learnedFrom && route.expiresAt !== undefined)
        learned.set(
          route.learnedFrom,
          Math.max(learned.get(route.learnedFrom) ?? 0, route.expiresAt - RIP.timeoutMs)
        );
    blocks.push([
      'Routing Protocol is "rip"',
      '  Outgoing update filter list for all interfaces is not set',
      '  Incoming update filter list for all interfaces is not set',
      `  Sending updates every 30 seconds, next due in ${Math.max(0, Math.ceil((rip.updateAt - e.state.clock) / 1000))} seconds`,
      '  Invalid after 180 seconds, hold down 180, flushed after 240',
      '  Redistributing: rip',
      '  Default version control: send version 2, receive version 2',
      `  Automatic network summarization is not in effect`,
      '  Maximum path: 4',
      ...sources([...learned].map(([gateway, at]) => ({ gateway, distance: 120, at }))),
      '  Distance: (default is 120)',
    ]);
  }
  return ['*** IP Routing is NSF aware ***', ...blocks.map((b) => b.join('\n'))].join('\n\n');
}

export function registerIosExec(r: CommandRegistry) {
  r.register({
    pattern: /^terminal (?:(length|width) (\d+)|no (length|width)|(no )?monitor)$/i,
    syntax: [
      'terminal length <lines>',
      'terminal width <columns>',
      'terminal monitor',
      'terminal no monitor',
      'terminal no length',
    ],
    modes: EXEC_MODES,
    // The web terminal scrolls instead of paging, so these settings only need validating.
    run: (m) => {
      if (m[1] && Number(m[2]) > 512) throw new Error('Invalid input detected at: ' + m[2]);
      return '';
    },
  });
  r.register({
    pattern: /^show ip route (connected|static|ospf|bgp|rip)(?: \d+)?$/i,
    syntax: [
      'show ip route connected',
      'show ip route static',
      'show ip route ospf',
      'show ip route bgp',
      'show ip route rip',
    ],
    modes: ALL_MODES,
    run: (m, e, d) => showRoutes(e, d, undefined, m[1].toLowerCase() as RouteFilter),
  });
  r.register({
    pattern: /^show ip route summary$/i,
    syntax: 'show ip route summary',
    modes: ALL_MODES,
    run: (_m, e, d) => showRouteSummary(e, d),
  });
  r.register({
    pattern: /^show ip route ((?:\d{1,3}\.){3}\d{1,3})(?: ((?:\d{1,3}\.){3}\d{1,3}|\/\d{1,2}))?$/i,
    syntax: ['show ip route <address>', 'show ip route <network> <mask>'],
    modes: ALL_MODES,
    run: (m, e, d) => {
      ipNumber(m[1]);
      const prefix = m[2] ? parsePrefix(m[2].replace('/', '')) : undefined;
      return showRouteEntry(e, d, m[1], prefix);
    },
  });
  r.register({
    pattern: /^show ip protocols$/i,
    syntax: 'show ip protocols',
    modes: ALL_MODES,
    run: (_m, e, d) => showIpProtocols(e, d),
  });
  r.register({
    pattern: /^show (?:running-config|run) interface (\S+(?: \S+)?)$/i,
    syntax: 'show running-config interface <interface>',
    modes: ['privileged'],
    run: (m, e, d) => {
      const port = findPort(d, m[1].replace(/\s+/g, ''));
      const lines = String(r.execute('show running-config', e, d, { mode: 'privileged' })).split('\n');
      const header = 'interface ' + longInterfaceName(port.name);
      const start = lines.findIndex((line) => line === header);
      const block = start < 0 ? [header] : [lines[start]];
      for (let i = start + 1; start >= 0 && i < lines.length && lines[i].startsWith(' '); i++)
        block.push(lines[i]);
      return withConfigHeader(['!', ...block, 'end'].join('\n'));
    },
  });
  r.register({
    pattern: /^show mac address-table count$/i,
    syntax: 'show mac address-table count',
    modes: ALL_MODES,
    run: (_m, _e, d) => showMacCount(d),
  });
  r.register({
    pattern: /^show mac address-table aging-time$/i,
    syntax: 'show mac address-table aging-time',
    modes: ALL_MODES,
    run: () => `Global Aging Time:  ${LIMITS.macAge / 1000}\nVlan    Aging Time\n----    ----------`,
  });
  r.register({
    pattern: /^clear counters(?: (\S+(?: \S+)?))?$/i,
    syntax: ['clear counters', 'clear counters <interface>'],
    modes: ['privileged'],
    run: (m, _e, d, c) => {
      const port = m[1] ? findPort(d, m[1].replace(/\s+/g, '')) : undefined;
      c.confirm = { kind: 'clear-counters', ...(port ? { port: port.id } : {}) };
      return '';
    },
  });
  r.register({
    pattern: /^clear logging$/i,
    syntax: 'clear logging',
    modes: ['privileged'],
    run: (_m, _e, _d, c) => {
      c.confirm = { kind: 'clear-logging' };
      return '';
    },
  });
  r.register({
    pattern: /^clear ip ospf(?: (\d+))? process$/i,
    syntax: ['clear ip ospf process', 'clear ip ospf <process-id> process'],
    modes: ['privileged'],
    run: (m, _e, d, c: Context) => {
      if (!d.ospf || (m[1] && Number(m[1]) !== (d.ospf.processId ?? 1)))
        throw new Error('OSPF: No router process' + (m[1] ? ' ' + m[1] : '') + ' found');
      c.confirm = { kind: 'clear-ospf' };
      return '';
    },
  });
  r.register({
    pattern: /^clear arp-cache(?: interface (\S+))?$/i,
    syntax: ['clear arp-cache', 'clear arp-cache interface <interface>'],
    modes: ['privileged'],
    run: (m, e, d) => {
      const port = m[1] ? findPort(d, m[1]) : undefined;
      d.arpTable = d.arpTable.filter((entry) => port && entry.port !== port.id);
      e.emit('CONFIG_CHANGED', d.id, 'ARP cache cleared' + (port ? ' on ' + port.name : '') + '.');
      return '';
    },
  });
  r.register({
    pattern: /^clear mac address-table dynamic((?: (?:address \S+|interface \S+|vlan \d+))*)$/i,
    syntax: [
      'clear mac address-table dynamic',
      'clear mac address-table dynamic address <mac>',
      'clear mac address-table dynamic interface <interface>',
      'clear mac address-table dynamic vlan <vlan>',
    ],
    modes: ['privileged'],
    run: (m, e, d) => {
      const option = (name: string) => new RegExp(`${name} (\\S+)`, 'i').exec(m[1])?.[1];
      const address = option('address'),
        port = option('interface') ? findPort(d, option('interface')!) : undefined,
        vlan = option('vlan') ? Number(option('vlan')) : undefined;
      d.macTable = d.macTable.filter(
        (entry) =>
          !(
            (!address || dotted(entry.mac) === dotted(address)) &&
            (!port || entry.port === port.id) &&
            (vlan === undefined || entry.vlan === vlan)
          )
      );
      e.emit('CONFIG_CHANGED', d.id, 'MAC address table entries cleared.');
      return '';
    },
  });
  r.register({
    pattern: /^clear ip route (?:\*|(?:\d{1,3}\.){3}\d{1,3}(?: (?:\d{1,3}\.){3}\d{1,3})?)$/i,
    syntax: ['clear ip route *', 'clear ip route <network> <mask>'],
    modes: ['privileged'],
    // Routing tables are recomputed continuously from the protocol state.
    run: () => '',
  });
}
