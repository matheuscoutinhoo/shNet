import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkInterface } from '../model';
import type { DynamicRoute } from '../protocols/ospf-model';
import { interfaceOperational, routingEnabled } from '../protocols/layer3';
import {
  ipNumber,
  resolveDefaultRoutes,
  resolveRoute,
  sameSubnet,
  staticRouteInstalled,
  subnet,
} from '../protocols/ipv4';
import { ripRoutes } from '../protocols/rip';
import { eigrpRoutes, eigrpSummaryRoutes } from '../protocols/eigrp';
import { RIP } from '../protocols/rip-model';
import { routeInstalledAt } from '../protocols/route-age';
import { canonicalInterfaceName } from '../protocols/interface-name';
import { terminalIdentity } from './device-commands';
import { TUNNEL_BANDWIDTH_KBPS } from '../protocols/ios-tunnel';
import { iosTunnelShowLines } from './ios-tunnel';

export const interfaceName = (name: string) => canonicalInterfaceName(name);

export function interfaceStatus(e: SimulationEngine, d: Device, p: NetworkInterface) {
  return !p.adminUp
    ? 'administratively down'
    : p.errDisabled
      ? 'err-disabled'
      : // A tunnel interface is up once enabled; its line protocol follows the transport.
        p.iosTunnel || interfaceOperational(e.state, d, p)
        ? 'up'
        : 'down';
}
const shortName = (name: string) =>
  name
    .replace(/^Vlan/, 'Vl')
    .replace(/^Port-channel/, 'Po')
    .replace(/^Loopback/, 'Lo');
function portType(p: NetworkInterface) {
  if (p.aggregate) return '';
  if (p.media === 'rj45') return p.speed >= 10000 ? '100/1000/2.5G/5G/10GBaseTX' : '10/100/1000BaseTX';
  const mode = p.transceiver === 'multi-mode' ? 'S' : p.transceiver === 'dac' ? 'CU' : 'L';
  if (p.media === 'qsfp') return p.transceiver === 'dac' ? '40GBase-CR4' : '40GBase-' + mode + 'R4';
  if (p.media === 'sfp') return p.speed >= 10000 ? '10GBase-' + mode + 'R' : '1000Base' + mode + 'X SFP';
  return p.media;
}
/** IOS "show interfaces status": physical switch/router ports and port-channels. */
export function showInterfacesStatus(e: SimulationEngine, d: Device, selected?: string) {
  const ports = d.interfaces.filter(
    (p) =>
      !p.logical &&
      !p.loopback &&
      !p.tunnel &&
      !p.vxlan &&
      !['wifi', 'console', 'mesh'].includes(p.media) &&
      (!selected || p.name.toLowerCase() === interfaceName(selected).toLowerCase())
  );
  if (!ports.length) throw new Error('% Invalid input detected: interface not found.');
  const rows = ports.map((p) => {
    const up = interfaceOperational(e.state, d, p);
    const status = p.errDisabled ? 'err-disabled' : !p.adminUp ? 'disabled' : up ? 'connected' : 'notconnect';
    const vlan = p.mode === 'routed' ? 'routed' : p.mode === 'trunk' ? 'trunk' : String(p.accessVlan);
    const auto = p.speedAuto !== false && p.media === 'rj45';
    const duplex = up && auto ? 'a-' + p.duplex : auto ? 'auto' : p.duplex;
    const speed = up && auto ? 'a-' + p.speed : auto ? 'auto' : String(p.speed);
    return (
      shortName(p.name).padEnd(10) +
      ' ' +
      (p.description ?? '').slice(0, 18).padEnd(18) +
      ' ' +
      status.padEnd(12) +
      ' ' +
      vlan.padEnd(10) +
      ' ' +
      duplex.padStart(6) +
      ' ' +
      speed.padStart(6) +
      ' ' +
      portType(p)
    ).trimEnd();
  });
  return ['Port       Name               Status       Vlan       Duplex  Speed Type', ...rows].join('\n');
}
/** IOS "show interfaces description". */
export function showInterfacesDescription(e: SimulationEngine, d: Device) {
  return [
    'Interface                      Status         Protocol Description',
    ...d.interfaces
      .filter((p) => !['wifi', 'console', 'mesh'].includes(p.media))
      .map((p) => {
        const up = interfaceOperational(e.state, d, p);
        const status = !p.adminUp ? 'admin down' : up ? 'up' : 'down';
        return (
          shortName(p.name).padEnd(31) +
          status.padEnd(15) +
          (up ? 'up' : 'down').padEnd(9) +
          (p.description ?? '')
        ).trimEnd();
      }),
  ].join('\n');
}
export function showInterfaces(e: SimulationEngine, d: Device, brief = false, selected?: string) {
  const ports = selected
    ? d.interfaces.filter((p) => p.name.toLowerCase() === interfaceName(selected).toLowerCase())
    : d.interfaces;
  if (!ports.length) throw new Error('Interface inexistente');
  if (brief)
    return (
      'Interface              IP-Address      OK? Method Status                 Protocol\n' +
      ports
        .map(
          (p) =>
            `${p.name.padEnd(23)}${(p.ip ?? 'unassigned').padEnd(16)}YES ${p.ipv4Mode === 'dhcp' ? 'DHCP  ' : 'manual'} ${interfaceStatus(e, d, p).padEnd(23)}${interfaceOperational(e.state, d, p) ? 'up' : 'down'}`
        )
        .join('\n')
    );
  return ports
    .map(
      (p) =>
        `${p.name} is ${interfaceStatus(e, d, p)}, line protocol is ${interfaceOperational(e.state, d, p) ? 'up' : 'down'}\n` +
        `  Hardware is ${p.iosTunnel ? 'Tunnel' : p.media}, address is ${p.mac}\n` +
        (p.description ? `  Description: ${p.description}\n` : '') +
        (p.ip ? `  Internet address is ${p.ip}/${p.prefix}\n` : '') +
        `  MTU ${p.mtu} bytes, BW ${p.bandwidthKbps ?? (p.iosTunnel ? TUNNEL_BANDWIDTH_KBPS : p.speed * 1000)} Kbit/sec, ${p.duplex}-duplex\n` +
        iosTunnelShowLines(d, p)
          .map((line) => line + '\n')
          .join('') +
        `  ${p.rx} packets input, ${p.tx} packets output, ${p.errors} errors`
    )
    .join('\n\n');
}

interface RouteRow {
  code: string;
  network: string;
  prefix: number;
  distance: number;
  metric: number;
  nextHop?: string;
  port?: string;
  connected?: boolean;
  learnedAt?: number;
  // The protocol entry behind a dynamic route, for "show ip route <address>".
  origin?:
    | { kind: 'ospf' | 'rip' | 'eigrp'; route: DynamicRoute }
    | { kind: 'bgp'; route: NonNullable<Device['bgp']>['routes'][number] };
  legacy: string;
}
/** Installed IPv4 routes of a device (best administrative distance, then metric, per prefix). */
function routeRows(e: SimulationEngine, d: Device, vrf?: string): RouteRow[] {
  const rows: RouteRow[] = [];
  const usable = (p: NetworkInterface) =>
    p.vrf === vrf && p.ip && p.prefix !== undefined && interfaceOperational(e.state, d, p);
  for (const p of d.interfaces.filter(usable)) {
    const network = subnet(p.ip!, p.prefix!).network;
    rows.push({
      code: 'C',
      network,
      prefix: p.prefix!,
      distance: 0,
      metric: 0,
      port: p.name,
      connected: true,
      legacy: `C ${network}/${p.prefix} directly connected, ${p.name}`,
    });
    // A /32 interface is its own connected route; IOS adds no separate local entry.
    if (p.prefix === 32) continue;
    rows.push({
      code: 'L',
      network: p.ip!,
      prefix: 32,
      distance: 0,
      metric: 0,
      port: p.name,
      connected: true,
      legacy: `L ${p.ip}/32 directly connected, ${p.name}`,
    });
  }
  for (const r of d.routes.filter((r) => r.vrf === vrf)) {
    if (!staticRouteInstalled(d, r, e.state)) continue;
    const port = r.discard ? 'Null0' : r.port ? d.interfaces.find((p) => p.id === r.port)!.name : undefined;
    rows.push({
      code: 'S',
      network: r.network,
      prefix: r.prefix,
      distance: r.distance ?? 1,
      metric: r.metric,
      ...(r.nextHop !== '0.0.0.0' ? { nextHop: r.nextHop } : {}),
      ...(port ? { port } : {}),
      legacy: `S ${r.network}/${r.prefix} [${r.distance ?? 1}/${r.metric}] ${r.nextHop === '0.0.0.0' ? 'directly connected' : 'via ' + r.nextHop}${port ? ', ' + port : ''}`,
    });
  }
  for (const r of vrf
    ? []
    : [
        ...(d.ospf?.enabled ? d.ospf.routes : []),
        ...(d.bgp?.enabled ? d.bgp.routes : []),
        ...ripRoutes(d),
        ...eigrpRoutes(d),
      ]) {
    const p = d.interfaces.find((p) => p.id === r.port && usable(p));
    if (!p || !resolveRoute(d, r.nextHop, vrf, e.state)) continue;
    const code = !('protocol' in r)
      ? 'B'
      : r.protocol === 'RIP'
        ? 'R'
        : r.protocol === 'EIGRP'
          ? r.distance === (d.eigrp?.distance?.external ?? 170)
            ? 'D EX'
            : 'D'
          : 'O' +
            (r.pathType === 'inter' ? ' IA' : r.pathType && r.pathType !== 'intra' ? ' ' + r.pathType : '');
    const learnedAt = !('protocol' in r)
      ? d.bgp?.rib.find(
          (path) => path.peer === r.peer && path.network === r.network && path.prefix === r.prefix
        )?.learnedAt
      : r.protocol === 'RIP'
        ? ripLastUpdate(d, r)
        : routeInstalledAt(d, r.protocol === 'EIGRP' ? 'eigrp' : 'ospf', r, e.state.clock);
    rows.push({
      code,
      network: r.network,
      prefix: r.prefix,
      distance: r.distance,
      metric: r.metric,
      nextHop: r.nextHop,
      port: p.name,
      ...(learnedAt !== undefined ? { learnedAt } : {}),
      origin: !('protocol' in r)
        ? { kind: 'bgp', route: r }
        : { kind: r.protocol === 'RIP' ? 'rip' : r.protocol === 'EIGRP' ? 'eigrp' : 'ospf', route: r },
      legacy: `${code} ${r.network}/${r.prefix} [${r.distance}/${r.metric}] via ${r.nextHop}, ${p.name}`,
    });
  }
  // An EIGRP summary is installed to Null0 with distance 5.
  for (const r of vrf ? [] : eigrpSummaryRoutes(d))
    rows.push({
      code: 'D',
      network: r.network,
      prefix: r.prefix,
      distance: 5,
      metric: 0,
      port: 'Null0',
      connected: true,
      legacy: `D ${r.network}/${r.prefix} is a summary, Null0`,
    });
  // Prefixes learned from a simulator IPsec tunnel peer are installed like reverse-route injection.
  if (routingEnabled(d))
    for (const p of d.interfaces.filter((p) => p.tunnel?.status === 'up' && usable(p)))
      for (const r of p.tunnel!.remotePrefixes)
        rows.push({
          code: 'S',
          network: r.network,
          prefix: r.prefix,
          distance: 200,
          metric: 1,
          nextHop: p.tunnel!.peerIp,
          port: p.name,
          legacy: `S ${r.network}/${r.prefix} [200/1] via ${p.tunnel!.peerIp}, ${p.name}`,
        });
  for (const r of resolveDefaultRoutes(d, vrf).filter((r) => interfaceOperational(e.state, d, r.port))) {
    const dhcp = r.port.ipv4Mode === 'dhcp';
    rows.push({
      // IOS shows a DHCP-learned default as a static route with distance 254.
      code: 'S',
      network: '0.0.0.0',
      prefix: 0,
      // IOS installs a DHCP-learned default route with distance 254.
      distance: dhcp ? 254 : 1,
      metric: r.metric,
      nextHop: r.nextHop,
      port: r.port.name,
      legacy: `${dhcp ? 'D' : 'S'} 0.0.0.0/0 via ${r.nextHop}, ${r.port.name}`,
    });
  }
  const installed = rows.filter(
    (r) =>
      !rows.some(
        (other) =>
          other.network === r.network &&
          other.prefix === r.prefix &&
          (other.distance < r.distance || (other.distance === r.distance && other.metric < r.metric))
      )
  );
  const seen = new Set<string>();
  return installed.filter((r) => !seen.has(r.legacy) && !!seen.add(r.legacy));
}

import { longInterfaceName } from '../protocols/interface-name';
export { longInterfaceName };
const ROUTE_CODES = [
  'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
  '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area ',
  '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
  '       E1 - OSPF external type 1, E2 - OSPF external type 2',
  '       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2',
  '       ia - IS-IS inter area, * - candidate default, U - per-user static route',
  '       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP',
  '       a - application route',
  '       + - replicated route, % - next hop override, p - overrides from PfR',
];
const classfulPrefix = (network: string) => {
  const first = ipNumber(network) >>> 24;
  return first < 128 ? 8 : first < 192 ? 16 : 24;
};
function age(e: SimulationEngine, at?: number) {
  if (at === undefined) return undefined;
  const s = Math.max(0, Math.floor((e.state.clock - at) / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}
function routeTail(e: SimulationEngine, r: RouteRow) {
  if (r.code === 'D' && r.port === 'Null0') return 'is a summary, Null0';
  if (r.connected || (r.code === 'S' && !r.nextHop))
    return 'is directly connected, ' + longInterfaceName(r.port!);
  const when = age(e, r.learnedAt);
  return (
    // IOS static routes have metric 0.
    `[${r.distance}/${r.code === 'S' ? 0 : r.metric}] via ${r.nextHop}` +
    (when ? ', ' + when : '') +
    (r.port && r.code !== 'B' ? ', ' + longInterfaceName(r.port) : '')
  );
}
/** RIP routes show the time since the last update that refreshed them (invalid timer 180 s). */
function ripLastUpdate(d: Device, r: DynamicRoute) {
  const entry = d.rip?.table.find(
    (route) => route.network === r.network && route.prefix === r.prefix && route.nextHop === r.nextHop
  );
  return entry?.expiresAt !== undefined ? entry.expiresAt - RIP.timeoutMs : undefined;
}
export type RouteFilter = 'connected' | 'static' | 'ospf' | 'bgp' | 'rip' | 'eigrp';
const FILTER_CODES: Record<RouteFilter, RegExp> = {
  connected: /^[CL]$/,
  static: /^S/,
  ospf: /^O/,
  bgp: /^B/,
  rip: /^R/,
  eigrp: /^D/,
};

export function showRoutes(e: SimulationEngine, d: Device, vrf?: string, filter?: RouteFilter) {
  const rows = routeRows(e, d, vrf);
  if (terminalIdentity(d).host) return rows.map((r) => r.legacy).join('\n') || 'Nenhuma rota';
  // A switch without IP routing only has a default gateway, as on IOS.
  if (d.type === 'switch' && !routingEnabled(d) && !vrf)
    return (
      (d.gateway ? 'Default gateway is ' + d.gateway : 'Default gateway is not set') +
      '\n\nHost               Gateway           Last Use    Total Uses  Interface\nICMP redirect cache is empty'
    );
  const shown = (r: RouteRow) => !filter || FILTER_CODES[filter].test(r.code);
  const defaults = rows.filter((r) => r.prefix === 0);
  const lines: string[] = [];
  const render = (r: RouteRow, indent: number, continuation: boolean, withMask: boolean) => {
    const target = withMask ? `${r.network}/${r.prefix} ` : `${r.network} `;
    // IOS marks the candidate default right after the protocol code: S*, O*IA, O*E2.
    const code = r.prefix === 0 ? r.code.replace(/^(\S+) ?/, '$1*') : r.code;
    lines.push(
      continuation
        ? ' '.repeat(indent + target.length) + routeTail(e, r)
        : code.padEnd(indent) + target + routeTail(e, r)
    );
  };
  const renderAll = (list: RouteRow[], indent: number, withMask = true) => {
    list.forEach((r, i) => {
      const previous = list[i - 1];
      render(
        r,
        indent,
        !!previous && previous.network === r.network && previous.prefix === r.prefix,
        withMask
      );
    });
  };
  const order = (a: RouteRow, b: RouteRow) =>
    ipNumber(a.network) - ipNumber(b.network) || a.prefix - b.prefix || a.code.localeCompare(b.code);
  renderAll(defaults.filter(shown).sort(order), 6);
  const majors = new Map<string, RouteRow[]>();
  for (const r of rows.filter((r) => r.prefix > 0)) {
    const classful = classfulPrefix(r.network);
    // Supernets are listed on their own, outside a classful network.
    const key =
      r.prefix < classful ? 'supernet:' + r.network + '/' + r.prefix : subnet(r.network, classful).network;
    majors.set(key, [...(majors.get(key) ?? []), r]);
  }
  for (const [key, list] of [...majors].sort(([, a], [, b]) => order(a[0], b[0]))) {
    list.sort(order);
    const visible = list.filter(shown);
    if (!visible.length) continue;
    const classful = classfulPrefix(list[0].network);
    // The header describes the whole major network, also in a filtered view.
    const subnets = new Set(list.map((r) => r.network + '/' + r.prefix)).size,
      masks = new Set(list.map((r) => r.prefix)).size;
    if (key.startsWith('supernet:') || (subnets === 1 && list[0].prefix === classful)) {
      renderAll(visible, 6);
      continue;
    }
    // IOS always says "subnets" and omits the mask when every subnet shares it.
    lines.push(
      masks > 1
        ? `      ${key}/${classful} is variably subnetted, ${subnets} subnets, ${masks} masks`
        : `      ${key}/${list[0].prefix} is subnetted, ${subnets} subnets`
    );
    renderAll(visible, 9, masks > 1);
  }
  const gateway = defaults[0]
    ? `Gateway of last resort is ${defaults[0].nextHop ?? '0.0.0.0'} to network 0.0.0.0`
    : 'Gateway of last resort is not set';
  return [...(vrf ? ['', 'Routing Table: ' + vrf] : []), ...ROUTE_CODES, '', gateway, '', ...lines].join(
    '\n'
  );
}
const OSPF_TYPES: Record<string, string> = {
  intra: 'intra area',
  inter: 'inter area',
  E1: 'extern 1',
  E2: 'extern 2',
  N1: 'NSSA extern 1',
  N2: 'NSSA extern 2',
};
/** The router that originated an OSPF prefix (the "from" in show ip route <address>). */
function ospfOriginator(d: Device, r: DynamicRoute) {
  const lsa = d.ospf?.lsdb.find(
    (entry) =>
      !entry.withdrawn &&
      entry.advertisingRouter !== d.ospf!.routerId &&
      (entry.type === 'router'
        ? entry.prefixes.some((p) => p.network === r.network && p.prefix === r.prefix)
        : 'network' in entry && entry.network === r.network && entry.prefix === r.prefix)
  );
  return lsa?.advertisingRouter ?? d.ospf?.neighbors.find((n) => n.ip === r.nextHop)?.routerId ?? r.nextHop;
}
/** "show ip route A.B.C.D [mask]": the routing entry (longest match) with its descriptor blocks. */
export function showRouteEntry(e: SimulationEngine, d: Device, address: string, prefix?: number) {
  const rows = routeRows(e, d);
  const network = prefix === undefined ? address : subnet(address, prefix).network;
  const matches = rows.filter((r) =>
    prefix !== undefined
      ? r.network === network && r.prefix === prefix
      : (r.prefix > 0 || address === '0.0.0.0') && sameSubnet(r.network, address, r.prefix)
  );
  if (!matches.length) return prefix !== undefined ? '% Subnet not in table' : '% Network not in table';
  const longest = Math.max(...matches.map((r) => r.prefix));
  const paths = matches.filter((r) => r.prefix === longest);
  const best = paths[0];
  const classful = classfulPrefix(best.network);
  const lines = [
    `Routing entry for ${best.network}/${best.prefix}${best.prefix < classful ? ', supernet' : ''}`,
  ];
  const ago = (at?: number) => (at === undefined ? '' : `, ${age(e, at)} ago`);
  const via = (r: RouteRow) => (r.port ? `, via ${longInterfaceName(r.port)}` : '');
  const origin = best.origin;
  if (best.connected)
    lines.push(
      `  Known via "connected", distance 0, metric 0 (connected${best.code === 'C' ? ', via interface' : ''})`
    );
  else if (best.code.startsWith('S'))
    lines.push(
      `  Known via "static", distance ${best.distance}, metric 0` +
        (best.nextHop ? '' : ' (connected)') +
        (best.prefix === 0 ? ', candidate default path' : '')
    );
  else if (origin?.kind === 'ospf') {
    const route = origin.route,
      external = /^[EN]/.test(route.pathType ?? '');
    lines.push(
      `  Known via "ospf ${d.ospf?.processId ?? 1}", distance ${best.distance}, metric ${best.metric}, type ${OSPF_TYPES[route.pathType ?? 'intra']}` +
        (external ? `, forward metric ${route.internalCost ?? 0}` : '') +
        (best.prefix === 0 ? ', candidate default path' : ''),
      `  Last update from ${best.nextHop} on ${longInterfaceName(best.port!)}${ago(best.learnedAt)}`
    );
  } else if (origin?.kind === 'bgp') {
    const path = d.bgp?.rib.find(
      (entry) =>
        entry.peer === origin.route.peer &&
        entry.network === origin.route.network &&
        entry.prefix === origin.route.prefix
    );
    const internal = origin.route.distance === 200;
    lines.push(
      `  Known via "bgp ${d.bgp?.asn}", distance ${best.distance}, metric ${best.metric}${internal ? ', type internal' : ''}`,
      ...(path?.asPath.length ? [`  Tag ${path.asPath[0]}, type ${internal ? 'internal' : 'external'}`] : []),
      `  Last update from ${origin.route.peer}${ago(best.learnedAt)}`
    );
  } else if (origin?.kind === 'rip')
    lines.push(
      `  Known via "rip", distance ${best.distance}, metric ${best.metric}`,
      '  Redistributing via rip',
      `  Last update from ${best.nextHop} on ${longInterfaceName(best.port!)}${ago(best.learnedAt)}`
    );
  lines.push('  Routing Descriptor Blocks:');
  paths.forEach((r, index) => {
    const marker = index === 0 ? '  * ' : '    ';
    if (r.connected || !r.nextHop) lines.push(`${marker}directly connected${via(r)}`);
    else if (r.origin?.kind === 'ospf')
      lines.push(
        `${marker}${r.nextHop}, from ${ospfOriginator(d, r.origin.route)}${ago(r.learnedAt)}${via(r)}`
      );
    else if (r.origin?.kind === 'bgp' || r.origin?.kind === 'rip')
      lines.push(
        `${marker}${r.nextHop}, from ${r.origin.kind === 'bgp' ? r.origin.route.peer : r.nextHop}${ago(r.learnedAt)}` +
          (r.origin.kind === 'rip' ? via(r) : '')
      );
    else lines.push(`${marker}${r.nextHop}${r.port && !/^S/.test(r.code) ? via(r) : ''}`);
    lines.push(`      Route metric is ${r.code.startsWith('S') ? 0 : r.metric}, traffic share count is 1`);
    if (r.origin?.kind === 'bgp') {
      const bgp = r.origin.route;
      const path = d.bgp?.rib.find(
        (entry) => entry.peer === bgp.peer && entry.network === bgp.network && entry.prefix === bgp.prefix
      );
      lines.push(
        `      AS Hops ${path?.asPath.length ?? 0}`,
        ...(path?.asPath.length ? [`      Route tag ${path.asPath[0]}`] : []),
        '      MPLS label: none'
      );
    }
  });
  return lines.join('\n');
}
/** "show ip route summary": routes per source, split into major networks and subnets. */
export function showRouteSummary(e: SimulationEngine, d: Device) {
  const rows = routeRows(e, d);
  const sources: (readonly [string, (r: RouteRow) => boolean])[] = [
    ['application', () => false],
    ['connected', (r) => r.connected === true],
    ['static', (r) => r.code.startsWith('S')],
    ...(d.ospf ? [[`ospf ${d.ospf.processId ?? 1}`, (r: RouteRow) => r.code.startsWith('O')] as const] : []),
    ...(d.bgp ? [[`bgp ${d.bgp.asn}`, (r: RouteRow) => r.code.startsWith('B')] as const] : []),
    ...(d.rip ? [['rip', (r: RouteRow) => r.code.startsWith('R')] as const] : []),
  ];
  const isSubnet = (r: RouteRow) => r.prefix > classfulPrefix(r.network);
  const column = (value: string | number, width = 12) => String(value).padEnd(width);
  let networks = 0,
    subnets = 0;
  const lines = [
    'IP routing table name is default (0x0)',
    `IP routing table maximum-paths is 32`,
    'Route Source    Networks    Subnets     Replicates  Overhead    Memory (bytes)',
  ];
  for (const [name, test] of sources) {
    const list = rows.filter(test),
      sub = list.filter(isSubnet).length,
      net = list.length - sub;
    networks += net;
    subnets += sub;
    lines.push(
      column(name, 16) + column(net) + column(sub) + column(0) + column(list.length * 96) + list.length * 304
    );
    if (name.startsWith('ospf')) {
      const count = (type: string) =>
        list.filter((r) => r.origin?.kind === 'ospf' && (r.origin.route.pathType ?? 'intra') === type).length;
      lines.push(
        `  Intra-area: ${count('intra')} Inter-area: ${count('inter')} External-1: ${count('E1')} External-2: ${count('E2')}`,
        `  NSSA External-1: ${count('N1')} NSSA External-2: ${count('N2')}`
      );
    }
    if (name.startsWith('bgp'))
      lines.push(
        `  External: ${list.filter((r) => r.distance === 20).length} Internal: ${list.filter((r) => r.distance === 200).length} Local: 0`
      );
  }
  lines.push(
    column('internal', 16) +
      column(
        new Set(rows.map((r) => subnet(r.network, Math.min(r.prefix, classfulPrefix(r.network))).network))
          .size
      ) +
      ' '.repeat(36) +
      1412,
    column('Total', 16) +
      column(networks) +
      column(subnets) +
      column(0) +
      column(rows.length * 96) +
      (rows.length * 304 + 1412)
  );
  return lines.join('\n');
}
