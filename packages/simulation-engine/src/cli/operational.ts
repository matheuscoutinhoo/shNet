import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkInterface } from '../model';
import { interfaceOperational, routingEnabled } from '../protocols/layer3';
import { ipNumber, resolveDefaultRoutes, resolveRoute, subnet } from '../protocols/ipv4';
import { ripRoutes } from '../protocols/rip';
import { terminalIdentity } from './device-commands';

export const interfaceName = (name: string) =>
  name
    .replace(/\s/g, '')
    .replace(/^gigabitethernet/i, 'Gi')
    .replace(/^tengigabitethernet/i, 'Te')
    .replace(/^fortygigabitethernet/i, 'Fo')
    .replace(/^hundredgigabitethernet/i, 'Hu')
    .replace(/^port-channel/i, 'Port-channel');

export function interfaceStatus(e: SimulationEngine, d: Device, p: NetworkInterface) {
  return !p.adminUp
    ? 'administratively down'
    : p.errDisabled
      ? 'err-disabled'
      : interfaceOperational(e.state, d, p)
        ? 'up'
        : 'down';
}
const shortName = (name: string) => name.replace(/^Vlan/, 'Vl').replace(/^Port-channel/, 'Po').replace(/^Loopback/, 'Lo');
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
      (!p.logical && !p.loopback && !p.tunnel && !p.vxlan && !['wifi', 'console', 'mesh'].includes(p.media)) &&
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
        `  Hardware is ${p.media}, address is ${p.mac}\n` +
        (p.description ? `  Description: ${p.description}\n` : '') +
        (p.ip ? `  Internet address is ${p.ip}/${p.prefix}\n` : '') +
        `  MTU ${p.mtu} bytes, BW ${p.speed * 1000} Kbit/sec, ${p.duplex}-duplex\n` +
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
  for (const r of d.routes.filter((r) => r.vrf === vrf && r.distance !== 255)) {
    if (r.track && !d.monitoring?.tracks.find((t) => t.id === r.track)?.state) continue;
    const next = r.port
      ? d.interfaces.find(
          (p) =>
            p.id === r.port &&
            usable(p) &&
            (r.nextHop === '0.0.0.0' ||
              subnet(p.ip!, p.prefix!).network === subnet(r.nextHop, p.prefix!).network)
        )
      : resolveRoute(
          d,
          r.nextHop,
          vrf,
          e.state,
          new Set([JSON.stringify([vrf, r.network, r.prefix, r.nextHop, r.port])])
        );
    if (!next) continue;
    const port = r.port ? d.interfaces.find((p) => p.id === r.port)!.name : undefined;
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
    : [...(d.ospf?.enabled ? d.ospf.routes : []), ...(d.bgp?.enabled ? d.bgp.routes : []), ...ripRoutes(d)]) {
    const p = d.interfaces.find((p) => p.id === r.port && usable(p));
    if (!p || !resolveRoute(d, r.nextHop, vrf, e.state)) continue;
    const code = !('protocol' in r)
      ? 'B'
      : r.protocol === 'RIP'
        ? 'R'
        : 'O' +
          (r.pathType === 'inter'
            ? ' IA'
            : r.pathType && r.pathType !== 'intra'
              ? ' ' + r.pathType
              : '');
    const learnedAt = !('protocol' in r)
      ? d.bgp?.rib.find((path) => path.peer === r.peer && path.network === r.network && path.prefix === r.prefix)
          ?.learnedAt
      : undefined;
    rows.push({
      code,
      network: r.network,
      prefix: r.prefix,
      distance: r.distance,
      metric: r.metric,
      nextHop: r.nextHop,
      port: p.name,
      ...(learnedAt !== undefined ? { learnedAt } : {}),
      legacy: `${code} ${r.network}/${r.prefix} [${r.distance}/${r.metric}] via ${r.nextHop}, ${p.name}`,
    });
  }
  for (const r of resolveDefaultRoutes(d, vrf).filter((r) => interfaceOperational(e.state, d, r.port))) {
    const dhcp = r.port.ipv4Mode === 'dhcp';
    rows.push({
      code: dhcp ? 'D' : 'S',
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

/** IOS uses full interface names in routing output. */
export function longInterfaceName(name: string) {
  return name
    .replace(/^Gi(?=\d)/, 'GigabitEthernet')
    .replace(/^Te(?=\d)/, 'TenGigabitEthernet')
    .replace(/^Fo(?=\d)/, 'FortyGigabitEthernet')
    .replace(/^Hu(?=\d)/, 'HundredGigE')
    .replace(/^Fa(?=\d)/, 'FastEthernet')
    .replace(/^Se(?=\d)/, 'Serial')
    .replace(/^Po(?=\d)/, 'Port-channel');
}
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
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}
function routeTail(e: SimulationEngine, r: RouteRow) {
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

export function showRoutes(e: SimulationEngine, d: Device, vrf?: string) {
  const rows = routeRows(e, d, vrf);
  if (terminalIdentity(d).host) return rows.map((r) => r.legacy).join('\n') || 'Nenhuma rota';
  // A switch without IP routing only has a default gateway, as on IOS.
  if (d.type === 'switch' && !routingEnabled(d) && !vrf)
    return (
      (d.gateway ? 'Default gateway is ' + d.gateway : 'Default gateway is not set') +
      '\n\nHost               Gateway           Last Use    Total Uses  Interface\nICMP redirect cache is empty'
    );
  const defaults = rows.filter((r) => r.prefix === 0);
  const lines: string[] = [];
  const render = (r: RouteRow, indent: number, continuation: boolean) => {
    const target = `${r.network}/${r.prefix} `;
    const code = r.prefix === 0 ? r.code.replace(/^(\S+)/, '$1*') : r.code;
    lines.push(
      continuation
        ? ' '.repeat(indent + target.length) + routeTail(e, r)
        : code.padEnd(indent) + target + routeTail(e, r)
    );
  };
  const renderAll = (list: RouteRow[], indent: number) => {
    list.forEach((r, i) => {
      const previous = list[i - 1];
      render(r, indent, !!previous && previous.network === r.network && previous.prefix === r.prefix);
    });
  };
  const order = (a: RouteRow, b: RouteRow) =>
    ipNumber(a.network) - ipNumber(b.network) || a.prefix - b.prefix || a.code.localeCompare(b.code);
  renderAll(defaults.sort(order), 6);
  const majors = new Map<string, RouteRow[]>();
  for (const r of rows.filter((r) => r.prefix > 0)) {
    const classful = classfulPrefix(r.network);
    // Supernets are listed on their own, outside a classful network.
    const key = r.prefix < classful ? 'supernet:' + r.network + '/' + r.prefix : subnet(r.network, classful).network;
    majors.set(key, [...(majors.get(key) ?? []), r]);
  }
  for (const [key, list] of [...majors].sort(([, a], [, b]) => order(a[0], b[0]))) {
    list.sort(order);
    const classful = classfulPrefix(list[0].network);
    const subnets = new Set(list.map((r) => r.network + '/' + r.prefix)).size,
      masks = new Set(list.map((r) => r.prefix)).size;
    if (key.startsWith('supernet:') || (subnets === 1 && list[0].prefix === classful)) {
      renderAll(list, 6);
      continue;
    }
    lines.push(
      masks > 1
        ? `      ${key}/${classful} is variably subnetted, ${subnets} subnets, ${masks} masks`
        : `      ${key}/${list[0].prefix} is subnetted, ${subnets} subnet${subnets === 1 ? '' : 's'}`
    );
    renderAll(list, 9);
  }
  const gateway = defaults[0]
    ? `Gateway of last resort is ${defaults[0].nextHop ?? '0.0.0.0'} to network 0.0.0.0`
    : 'Gateway of last resort is not set';
  return [...(vrf ? ['', 'Routing Table: ' + vrf] : []), ...ROUTE_CODES, '', gateway, '', ...lines].join('\n');
}
