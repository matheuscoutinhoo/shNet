import type { Device, NetworkInterface } from '../model';
import { LOAD_BALANCE_METHODS } from '../protocols/lacp-model';
import { linksAt } from '../core/topology-index';
import { linkOperational } from '../links/physical';
import { dottedMac, shortInterfaceName } from '../protocols/interface-name';
import { ALL_MODES, CONFIG_MODES, currentPort, type CommandRegistry } from './registry';

const DEFAULT_LOAD_BALANCE = 'src-dst-ip';
// "show etherchannel load-balance": addresses hashed for non-IP, IPv4 and IPv6 frames.
const LOAD_BALANCE_FIELDS: Record<string, [string, string]> = {
  'src-mac': ['Source MAC address', 'Source MAC address'],
  'dst-mac': ['Destination MAC address', 'Destination MAC address'],
  'src-dst-mac': ['Source XOR Destination MAC address', 'Source XOR Destination MAC address'],
  'src-ip': ['Source MAC address', 'Source IP address'],
  'dst-ip': ['Destination MAC address', 'Destination IP address'],
  'src-dst-ip': ['Source XOR Destination MAC address', 'Source XOR Destination IP address'],
  'src-port': ['Source MAC address', 'Source TCP/UDP (layer-4) port number'],
  'dst-port': ['Destination MAC address', 'Destination TCP/UDP (layer-4) port number'],
  'src-dst-port': [
    'Source XOR Destination MAC address',
    'Source XOR Destination TCP/UDP (layer-4) port number',
  ],
  'src-dst-mixed-ip-port': [
    'Source XOR Destination MAC address',
    'Source XOR Destination IP address and TCP/UDP (layer-4) port number',
  ],
};
const SUMMARY_FLAGS = [
  'Flags:  D - down        P - bundled in port-channel',
  '        I - stand-alone s - suspended',
  '        H - Hot-standby (LACP only)',
  '        R - Layer3      S - Layer2',
  '        U - in use      f - failed to allocate aggregator',
  '',
  '        M - not in use, minimum links not met',
  '        u - unsuitable for bundling',
  '        w - waiting to be aggregated',
  '        d - default port',
  '',
  '        A - formed by Auto LAG',
  '',
];
function showSummary(d: Device, now: number, carrier: (port: string) => boolean) {
  const groups = d.interfaces.filter((p) => p.aggregate);
  const row = (p: NetworkInterface) => {
    const agg = p.aggregate!,
      selected = agg.selected,
      up = agg.members.filter((id) => carrier(id));
    const state = selected.length ? 'U' : p.adminUp && up.length && up.length < agg.minLinks ? 'M' : 'D';
    const members = agg.members.map((id) => {
      const member = d.interfaces.find((m) => m.id === id)!;
      const flag = selected.includes(id)
        ? 'P'
        : !carrier(id) || !p.adminUp
          ? 'D'
          : agg.mode !== 'on' && !agg.received.some((r) => r.port === id && r.expiresAt > now)
            ? 'I'
            : 's';
      return (shortInterfaceName(member.name) + '(' + flag + ')').padEnd(12);
    });
    return (
      String(agg.number).padEnd(7) +
      (shortInterfaceName(p.name) + '(' + (p.mode === 'routed' ? 'R' : 'S') + state + ')').padEnd(16) +
      (agg.mode === 'on' ? '-' : 'LACP').padEnd(12) +
      members.join('')
    ).trimEnd();
  };
  return [
    ...SUMMARY_FLAGS,
    '',
    'Number of channel-groups in use: ' + groups.length,
    'Number of aggregators:           ' + groups.length,
    '',
    'Group  Port-channel  Protocol    Ports',
    '------+-------------+-----------+-----------------------------------------------',
    ...groups.map(row),
  ].join('\n');
}
function showNeighbors(d: Device, now: number) {
  const groups = d.interfaces.filter((p) => p.aggregate && p.aggregate.mode !== 'on');
  return [
    'Flags:  S - Device is requesting Slow LACPDUs',
    '        F - Device is requesting Fast LACPDUs',
    '        A - Device is in Active mode       P - Device is in Passive mode',
    ...groups.flatMap((p) => {
      const agg = p.aggregate!;
      return [
        '',
        `Channel group ${agg.number} neighbors`,
        '',
        "Partner's information:",
        '',
        '                  LACP port                        Admin  Oper   Port    Port',
        'Port      Flags   Priority  Dev ID          Age    key    Key    Number  State',
        ...agg.received
          .filter((r) => r.expiresAt > now)
          .map((r) => {
            const actor = r.pdu.actor,
              member = d.interfaces.find((m) => m.id === r.port)!;
            return (
              shortInterfaceName(member.name).padEnd(10) +
              ('S' + (r.pdu.active ? 'A' : 'P')).padEnd(8) +
              String(actor.portPriority ?? 32768).padEnd(10) +
              dottedMac(actor.system).padEnd(16) +
              (Math.floor((now - r.at) / 1000) + 's').padEnd(7) +
              '0x0'.padEnd(7) +
              ('0x' + actor.key.toString(16).toUpperCase()).padEnd(7) +
              ('0x' + (actor.portNumber ?? 0).toString(16).toUpperCase()).padEnd(8) +
              '0x' +
              (actor.state ?? 0).toString(16).toUpperCase()
            );
          }),
      ];
    }),
  ].join('\n');
}
export function registerLacpCommands(r: CommandRegistry) {
  r.register({
    pattern: /^channel-group (\d+) mode (active|passive|on)$/i,
    syntax: [
      'channel-group <number> mode active',
      'channel-group <number> mode passive',
      'channel-group <number> mode on',
    ],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const member = currentPort(d, c),
        number = Number(m[1]),
        mode = m[2].toLowerCase() as 'active' | 'passive' | 'on',
        old = d.interfaces.find((p) => p.aggregate?.number === number);
      // LACP and static members cannot share a channel-group.
      if (old?.aggregate && (old.aggregate.mode === 'on') !== (mode === 'on'))
        throw new Error(
          `Command rejected (${shortInterfaceName(old.name)}, ${shortInterfaceName(member.name)}): Invalid etherchnl mode`
        );
      e.configureLacp(
        d.id,
        number,
        mode,
        [...new Set([...(old?.aggregate?.members ?? []), member.id])],
        old?.aggregate?.minLinks ?? 1
      );
    },
  });
  r.register({
    pattern: /^no channel-group$/i,
    modes: ['interface'],
    run: (_m, e, d, c) => {
      const member = currentPort(d, c),
        port = d.interfaces.find((p) => p.id === member.channel);
      if (!port?.aggregate) throw new Error('Interface sem grupo.');
      const agg = port.aggregate,
        remaining = agg.members.filter((p) => p !== member.id);
      if (remaining.length) e.configureLacp(d.id, agg.number, agg.mode, remaining, agg.minLinks);
      else e.removeLacp(d.id, port.id);
    },
  });
  r.register({
    pattern: /^lacp min-links (\d+)$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      const agg = currentPort(d, c).aggregate;
      if (!agg) throw new Error('Selecione Port-channel.');
      e.configureLacp(d.id, agg.number, agg.mode, agg.members, Number(m[1]));
    },
  });
  r.register({
    pattern: /^no port-channel (\d+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const p = d.interfaces.find((p) => p.aggregate?.number === Number(m[1]));
      if (!p) throw new Error('Grupo inexistente.');
      e.removeLacp(d.id, p.id);
    },
  });
  r.register({
    pattern: /^(no )?port-channel load-balance(?: (\S+))?$/i,
    syntax: LOAD_BALANCE_METHODS.map((method) => 'port-channel load-balance ' + method),
    modes: ['config'],
    run: (m, _e, d) => {
      if (d.type !== 'switch') throw new Error("Invalid input detected at '^' marker.");
      const method = m[2]?.toLowerCase();
      if (m[1]) delete d.portChannelLoadBalance;
      else if (!method) throw new Error('% Incomplete command.');
      else if (!(LOAD_BALANCE_METHODS as readonly string[]).includes(method))
        throw new Error("Invalid input detected at '^' marker.");
      else if (method === DEFAULT_LOAD_BALANCE) delete d.portChannelLoadBalance;
      else d.portChannelLoadBalance = method as (typeof LOAD_BALANCE_METHODS)[number];
    },
  });
  r.register({
    pattern: /^show etherchannel summary$/i,
    syntax: 'show etherchannel summary',
    modes: ALL_MODES,
    run: (_m, e, d) => {
      e.refreshSpanningTree();
      return showSummary(d, e.state.clock, (id) =>
        linksAt(e.state, d.id, id).some((l) => linkOperational(e.state, l))
      );
    },
  });
  r.register({
    pattern: /^show etherchannel load-balance$/i,
    syntax: 'show etherchannel load-balance',
    modes: ALL_MODES,
    run: (_m, _e, d) => {
      const method = d.portChannelLoadBalance ?? DEFAULT_LOAD_BALANCE,
        [mac, ip] = LOAD_BALANCE_FIELDS[method];
      return [
        'EtherChannel Load-Balancing Configuration:',
        '        ' + method,
        '',
        'EtherChannel Load-Balancing Addresses Used Per-Protocol:',
        'Non-IP: ' + mac,
        '  IPv4: ' + ip,
        '  IPv6: ' + ip,
      ].join('\n');
    },
  });
  r.register({
    pattern: /^show lacp neighbors?$/i,
    syntax: 'show lacp neighbor',
    modes: ALL_MODES,
    run: (_m, e, d) => showNeighbors(d, e.state.clock),
  });
}
export function lacpRunningConfig(d: Device) {
  return [
    ...(d.portChannelLoadBalance ? ['port-channel load-balance ' + d.portChannelLoadBalance] : []),
    ...d.interfaces
      .filter((p) => p.aggregate)
      .flatMap((p) => [
        ...p.aggregate!.members.flatMap((id) => [
          'interface ' + d.interfaces.find((m) => m.id === id)!.name,
          ` channel-group ${p.aggregate!.number} mode ${p.aggregate!.mode}`,
          'exit',
        ]),
        // IOS shows min-links only when it differs from the default (1).
        ...(p.aggregate!.minLinks > 1
          ? ['interface ' + p.name, ' lacp min-links ' + p.aggregate!.minLinks, 'exit']
          : []),
      ]),
  ];
}
