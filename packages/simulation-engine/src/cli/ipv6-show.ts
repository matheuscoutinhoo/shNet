import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkInterface } from '../model';
import { ipv6Number, linkLocal6, network6, solicitedNode6 } from '../protocols/ipv6-address';
import { usable6 } from '../protocols/ipv6-routing';
import { interfaceOperational, interfaceUp } from '../protocols/layer3';
import { ospf3Routes } from '../protocols/ospf3';
import { dottedMac, findInterface, longInterfaceName, shortInterfaceName } from '../protocols/interface-name';
import { interfaceStatus } from './operational';

const up6 = (ip: string) => ip.toUpperCase();
const compare6 = (a: string, b: string) => {
  const x = ipv6Number(a),
    y = ipv6Number(b);
  return x < y ? -1 : x > y ? 1 : 0;
};
const CODES = [
  'Codes: C - Connected, L - Local, S - Static, U - Per-user Static route',
  '       B - BGP, R - RIP, H - NHRP, I1 - ISIS L1',
  '       I2 - ISIS L2, IA - ISIS interarea, IS - ISIS summary, D - EIGRP',
  '       EX - EIGRP external, ND - ND Default, NDp - ND Prefix, DCE - Destination',
  '       NDr - Redirect, RL - RPL, O - OSPF Intra, OI - OSPF Inter',
  '       OE1 - OSPF ext 1, OE2 - OSPF ext 2, ON1 - OSPF NSSA ext 1',
  '       ON2 - OSPF NSSA ext 2, a - Application, m - OMP',
];
type Entry = {
  code: string;
  network: string;
  prefix: number;
  distance: number;
  metric: number;
  via: string[];
};
/** IOS "show ipv6 route [vrf NAME] [connected|local|static|ospf]". */
export function showIpv6Route(e: SimulationEngine, d: Device, filter?: string, vrf?: string) {
  const name = (id: string) => longInterfaceName(d.interfaces.find((p) => p.id === id)?.name ?? id);
  const entries = new Map<string, Entry>();
  const add = (x: Entry) => {
    const key = x.code + ' ' + x.network + '/' + x.prefix;
    const old = entries.get(key);
    if (old) old.via.push(...x.via);
    else entries.set(key, x);
  };
  for (const p of d.interfaces) {
    if (!p.ipv6 || p.vrf !== vrf || !interfaceUp(d, p)) continue;
    for (const a of usable6(p)) {
      if (linkLocal6(a.ip)) continue;
      if (a.onLink && a.prefix < 128)
        add({
          code: 'C',
          network: network6(a.ip, a.prefix),
          prefix: a.prefix,
          distance: 0,
          metric: 0,
          via: [`via ${name(p.id)}, directly connected`],
        });
      add({
        code: 'L',
        network: a.ip,
        prefix: 128,
        distance: 0,
        metric: 0,
        via: [`via ${name(p.id)}, receive`],
      });
    }
    for (const r of p.ipv6.routers)
      if (r.expiresAt > e.state.clock)
        add({
          code: 'ND',
          network: '::',
          prefix: 0,
          distance: 2,
          metric: 0,
          via: [`via ${up6(r.ip)}, ${name(p.id)}`],
        });
  }
  for (const r of d.routes6 ?? [])
    if (r.vrf === vrf)
      add({
        code: 'S',
        network: r.network,
        prefix: r.prefix,
        distance: 1,
        metric: 0,
        via: [
          r.nextHop === '::'
            ? `via ${name(r.port)}, directly connected`
            : `via ${up6(r.nextHop)}, ${name(r.port)}`,
        ],
      });
  if (!vrf)
    for (const r of ospf3Routes(d))
      add({
        code: r.pathType === 'inter' ? 'OI' : 'O',
        network: r.network,
        prefix: r.prefix,
        distance: 110,
        metric: r.metric,
        via: [`via ${up6(r.nextHop)}, ${name(r.port)}`],
      });
  add({ code: 'L', network: 'ff00::', prefix: 8, distance: 0, metric: 0, via: ['via Null0, receive'] });
  const wanted = (code: string) =>
    !filter ||
    (filter === 'connected' && code === 'C') ||
    (filter === 'local' && code === 'L') ||
    (filter === 'static' && code === 'S') ||
    (filter === 'ospf' && code.startsWith('O'));
  const list = [...entries.values()]
    .filter((x) => wanted(x.code))
    .sort((a, b) => compare6(a.network, b.network) || a.prefix - b.prefix || a.distance - b.distance);
  return [
    `IPv6 Routing Table - ${vrf ?? 'default'} - ${list.length} entries`,
    ...CODES,
    ...list.flatMap((x) => [
      `${x.code.padEnd(4)}${up6(x.network)}/${x.prefix} [${x.distance}/${x.metric}]`,
      ...x.via.map((v) => '     ' + v),
    ]),
  ].join('\n');
}

const listed = (p: NetworkInterface) => p.media !== 'console' && p.media !== 'wifi' && p.media !== 'mesh';
const status = (e: SimulationEngine, d: Device, p: NetworkInterface) => {
  const admin = interfaceStatus(e, d, p);
  return { admin, protocol: admin === 'up' && interfaceOperational(e.state, d, p) ? 'up' : 'down' };
};
/** IOS "show ipv6 interface brief". */
export function showIpv6InterfaceBrief(e: SimulationEngine, d: Device) {
  return d.interfaces
    .filter(listed)
    .flatMap((p) => {
      const s = status(e, d, p);
      const addresses = (p.ipv6?.addresses ?? []).filter((a) => a.state !== 'duplicate');
      const local = addresses.filter((a) => linkLocal6(a.ip));
      return [
        longInterfaceName(p.name).padEnd(23) + `[${s.admin}/${s.protocol}]`,
        ...(addresses.length
          ? [...local, ...addresses.filter((a) => !linkLocal6(a.ip))].map((a) => '    ' + up6(a.ip))
          : ['    unassigned']),
      ];
    })
    .join('\n');
}
/** IOS "show ipv6 interface [NAME]". */
export function showIpv6Interface(e: SimulationEngine, d: Device, selected?: string) {
  const ports = selected ? [findInterface(d, selected)] : d.interfaces.filter((p) => p.ipv6 && listed(p));
  if (selected && !ports[0]) throw new Error('% Invalid input detected at interface ' + selected);
  return ports
    .map((p) => {
      const s = status(e, d, p!);
      const head = `${longInterfaceName(p!.name)} is ${s.admin}, line protocol is ${s.protocol}`;
      const v6 = p!.ipv6;
      if (!v6) return head + '\n  IPv6 is disabled';
      const local = v6.addresses.find((a) => linkLocal6(a.ip));
      const flag = (state: string) =>
        state === 'tentative'
          ? ' [TEN]'
          : state === 'duplicate'
            ? ' [DUP]'
            : state === 'deprecated'
              ? ' [DEP]'
              : '';
      const global = v6.addresses.filter((a) => !linkLocal6(a.ip));
      const router = !!d.ipv6Routing && (d.type === 'router' || (d.type === 'switch' && !!d.ipRouting));
      const ospf3 = d.ospf3?.enabled && d.ospf3.interfaces.some((i) => i.port === p!.id);
      const ospfPort = d.ospf3?.ports.find((r) => r.port === p!.id);
      const rid = d.ospf3?.rid;
      const groups = [
        'FF02::1',
        ...(router ? ['FF02::2'] : []),
        ...(ospf3 ? ['FF02::5'] : []),
        ...(ospf3 && rid && (ospfPort?.dr === rid || ospfPort?.bdr === rid) ? ['FF02::6'] : []),
        ...[...new Set(v6.addresses.map((a) => up6(solicitedNode6(a.ip))))],
      ];
      return [
        head,
        local
          ? `  IPv6 is enabled, link-local address is ${up6(local.ip)}${flag(local.state)}`
          : '  IPv6 is enabled, link-local address is unassigned',
        '  No Virtual link-local address(es):',
        ...(global.length
          ? [
              '  Global unicast address(es):',
              ...global.map(
                (a) =>
                  `    ${up6(a.ip)}, subnet is ${up6(network6(a.ip, a.prefix))}/${a.prefix}${flag(a.state)}${a.origin === 'slaac' ? ' [EUI/CAL/PRE]' : ''}`
              ),
            ]
          : []),
        '  Joined group address(es):',
        ...groups.map((g) => '    ' + g),
        `  MTU is ${p!.mtu} bytes`,
        '  ICMP error messages limited to one every 100 milliseconds',
        '  ICMP redirects are enabled',
        '  ICMP unreachables are sent',
        '  ND DAD is enabled, number of DAD attempts: 1',
        '  ND reachable time is 30000 milliseconds (using 30000)',
        ...(router
          ? [
              '  ND advertised reachable time is 0 (unspecified)',
              '  ND advertised retransmit interval is 0 (unspecified)',
              ...(v6.ra
                ? [
                    `  ND router advertisements are sent every ${Math.round(v6.ra.intervalMs / 1000)} seconds`,
                    `  ND router advertisements live for ${Math.round(v6.ra.lifetimeMs / 1000)} seconds`,
                    '  ND advertised default router preference is Medium',
                  ]
                : ['  ND RAs are suppressed (periodic)']),
              '  Hosts use stateless autoconfig for addresses.',
            ]
          : []),
        ...(p!.ipv6FilterIn || p!.ipv6FilterOut
          ? [
              '  Input features: ' + (p!.ipv6FilterIn ? 'Access List' : ''),
              ...(p!.ipv6FilterIn ? ['  Inbound access list ' + p!.ipv6FilterIn] : []),
              ...(p!.ipv6FilterOut ? ['  Outgoing access list ' + p!.ipv6FilterOut] : []),
            ].filter((line) => line !== '  Input features: ')
          : []),
      ].join('\n');
    })
    .join('\n');
}
const ndState = {
  REACHABLE: 'REACH',
  STALE: 'STALE',
  DELAY: 'DELAY',
  PROBE: 'PROBE',
  FAILED: 'INCMP',
} as const;
/** IOS "show ipv6 neighbors". */
export function showIpv6Neighbors(e: SimulationEngine, d: Device) {
  const name = (id: string) => shortInterfaceName(d.interfaces.find((p) => p.id === id)?.name ?? id);
  const rows = [
    ...(d.neighbors6 ?? []).map((n) => {
      const age =
        n.state && n.state !== 'REACHABLE'
          ? Math.max(0, Math.floor((e.state.clock - (n.expiresAt - 30000)) / 60000))
          : 0;
      return (
        up6(n.ip).padEnd(42) +
        String(age).padStart(3) +
        ' ' +
        dottedMac(n.mac).padEnd(15) +
        ' ' +
        ndState[n.state ?? 'REACHABLE'].padEnd(5) +
        ' ' +
        name(n.port)
      );
    }),
    ...(d.resolutions6 ?? []).map(
      (r) =>
        up6(r.ip).padEnd(42) +
        '  0'.padStart(3) +
        ' ' +
        '-'.padEnd(15) +
        ' ' +
        'INCMP'.padEnd(5) +
        ' ' +
        name(r.port)
    ),
  ];
  return ['IPv6 Address                              Age Link-layer Addr State Interface', ...rows].join(
    '\n'
  );
}
