import type { SimulationEngine } from '../core/engine';
import type { AclRule, Device, NetworkInterface } from '../model';
import { bgpCandidates, bestBgpPaths } from '../protocols/bgp-routing';
import { bgpPrefixKey } from '../protocols/bgp-model';
import { bridgeId, portCost } from '../protocols/stp-election';
import { ipNumber, ipString, mask } from '../protocols/ipv4';
import { interfaceOperational } from '../protocols/layer3';
import { aclAddress } from './acl';
import { longInterfaceName } from './operational';

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
};
const dottedMac = (mac: string) => {
  const hex = mac.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return hex.slice(0, 4) + '.' + hex.slice(4, 8) + '.' + hex.slice(8, 12);
};
const portName = (d: Device, id: string) => d.interfaces.find((p) => p.id === id)?.name ?? id;
const classful = (network: string) => {
  const first = ipNumber(network) >>> 24;
  return first < 128 ? 8 : first < 192 ? 16 : 24;
};

/** show ip ospf neighbor */
export function showOspfNeighbors(e: SimulationEngine, d: Device) {
  const state = d.ospf!;
  const role = (n: (typeof state.neighbors)[number]) => {
    const config = state.interfaces.find((entry) => entry.port === n.port);
    if (config?.networkType === 'point-to-point') return '  -';
    const port = state.ports.find((entry) => entry.port === n.port);
    return n.ip === port?.dr ? 'DR' : n.ip === port?.bdr ? 'BDR' : 'DROTHER';
  };
  const label: Record<string, string> = {
    Init: 'INIT',
    '2-Way': '2WAY',
    ExStart: 'EXSTART',
    Exchange: 'EXCHANGE',
    Loading: 'LOADING',
    Full: 'FULL',
  };
  return [
    '',
    'Neighbor ID     Pri   State           Dead Time   Address         Interface',
    ...state.neighbors.map(
      (n) =>
        n.routerId.padEnd(15) +
        ' ' +
        String(n.priority).padStart(3) +
        '   ' +
        (label[n.state] + '/' + role(n)).padEnd(15) +
        ' ' +
        clock(n.deadAt - e.state.clock).padEnd(11) +
        ' ' +
        n.ip.padEnd(15) +
        ' ' +
        longInterfaceName(portName(d, n.port))
    ),
  ].join('\n');
}

/** show ip bgp */
export function showBgpTable(d: Device) {
  const state = d.bgp!;
  const best = new Set(bestBgpPaths(d).map((p) => bgpPrefixKey(p) + '|' + (p.peer ?? 'local')));
  const origin = { IGP: 'i', EGP: 'e', INCOMPLETE: '?' } as const;
  const rows = bgpCandidates(d)
    .sort((a, b) => ipNumber(a.network) - ipNumber(b.network) || a.prefix - b.prefix)
    .map((p, i, list) => {
      const sameAsPrevious = i > 0 && bgpPrefixKey(list[i - 1]) === bgpPrefixKey(p);
      const network = sameAsPrevious
        ? ''
        : p.prefix === classful(p.network) || p.prefix === 0
          ? p.network
          : p.network + '/' + p.prefix;
      const local = !p.peer,
        internal = !!p.peer && !p.external;
      return (
        ' *' +
        (best.has(bgpPrefixKey(p) + '|' + (p.peer ?? 'local')) ? '>' : ' ') +
        (internal ? 'i' : ' ') +
        ' ' +
        network.padEnd(17) +
        (local ? '0.0.0.0' : p.nextHop).padEnd(16) +
        String(p.med).padStart(9) +
        ' ' +
        (internal || p.localPref !== 100 ? String(p.localPref) : '').padStart(6) +
        ' ' +
        String(local ? 32768 : 0).padStart(6) +
        ' ' +
        [...p.asPath, origin[p.origin]].join(' ')
      );
    });
  return [
    `BGP table version is ${rows.length + 1}, local router ID is ${state.routerId}`,
    'Status codes: s suppressed, d damped, h history, * valid, > best, i - internal,',
    '              r RIB-failure, S Stale, m multipath, b backup-path, f RT-Filter,',
    '              x best-external, a additional-path, c RIB-compressed,',
    '              t secondary path, L long-lived-stale,',
    'Origin codes: i - IGP, e - EGP, ? - incomplete',
    'RPKI validation codes: V valid, I invalid, N Not found',
    '',
    '     Network          Next Hop            Metric LocPrf Weight Path',
    ...rows,
  ].join('\n');
}

/** show ip bgp summary */
export function showBgpSummary(e: SimulationEngine, d: Device) {
  const state = d.bgp!;
  const candidates = bgpCandidates(d),
    networks = new Set(candidates.map(bgpPrefixKey)).size;
  return [
    `BGP router identifier ${state.routerId}, local AS number ${state.asn}`,
    `BGP table version is ${candidates.length + 1}, main routing table version ${candidates.length + 1}`,
    `${networks} network entries using ${networks * 248} bytes of memory`,
    `${candidates.length} path entries using ${candidates.length * 136} bytes of memory`,
    '',
    'Neighbor        V           AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd',
    ...state.peers.map((peer) => {
      const config = state.neighbors.find((n) => n.ip === peer.ip)!;
      const up = peer.state === 'Established';
      const since = up ? peer.establishedAt : peer.changedAt;
      return (
        peer.ip.padEnd(15) +
        ' 4' +
        String(config.remoteAs).padStart(13) +
        String(peer.received).padStart(8) +
        String(peer.sent).padStart(8) +
        String(candidates.length + 1).padStart(9) +
        '    0    0 ' +
        (since === undefined ? 'never' : clock(e.state.clock - since)).padEnd(9) +
        (up ? String(state.rib.filter((p) => p.peer === peer.ip).length).padStart(8) : peer.state)
      );
    }),
  ].join('\n');
}

/** show ip bgp neighbors */
export function showBgpNeighbors(e: SimulationEngine, d: Device) {
  const state = d.bgp!;
  return state.peers
    .map((peer) => {
      const config = state.neighbors.find((n) => n.ip === peer.ip)!;
      const since = peer.state === 'Established' ? peer.establishedAt : peer.changedAt;
      return [
        `BGP neighbor is ${peer.ip},  remote AS ${config.remoteAs}, ${config.remoteAs === state.asn ? 'internal' : 'external'} link`,
        `  BGP version 4, remote router ID ${peer.remoteId ?? '0.0.0.0'}`,
        `  BGP state = ${peer.state}` +
          (since !== undefined
            ? `, ${peer.state === 'Established' ? 'up' : 'down'} for ${clock(e.state.clock - since)}`
            : ''),
        `  Message statistics: ${peer.sent} sent, ${peer.received} received`,
        `  Prefixes received ${state.rib.filter((p) => p.peer === peer.ip).length}, advertised ${peer.advertised.length}`,
      ].join('\n');
    })
    .join('\n\n');
}

const ROLE: Record<string, string> = {
  root: 'Root',
  designated: 'Desg',
  alternate: 'Altn',
  backup: 'Back',
  disabled: 'Disa',
};
const STATE: Record<string, string> = { forwarding: 'FWD', learning: 'LRN', discarding: 'BLK' };
type Tree = NonNullable<Device['spanningTree']>;
type PortState = NonNullable<NetworkInterface['spanningTree']>;
function stpBlock(
  e: SimulationEngine,
  d: Device,
  title: string,
  protocol: string,
  tree: Tree,
  sysId: number,
  ports: { port: NetworkInterface; state: PortState }[]
) {
  const own = bridgeId(d),
    isRoot = !tree.rootPort;
  const rootPort = tree.rootPort ? d.interfaces.find((p) => p.id === tree.rootPort) : undefined;
  const timers = '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec';
  return [
    title,
    '  Spanning tree enabled protocol ' + protocol,
    '  Root ID    Priority    ' + (tree.root.priority + (tree.root.instance ?? 0)),
    '             Address     ' + dottedMac(tree.root.mac),
    ...(isRoot
      ? ['             This bridge is the root']
      : [
          '             Cost        ' + tree.cost,
          `             Port        ${d.interfaces.indexOf(rootPort!) + 1} (${longInterfaceName(rootPort!.name)})`,
        ]),
    timers,
    '',
    `  Bridge ID  Priority    ${tree.priority + sysId}  (priority ${tree.priority} sys-id-ext ${sysId})`,
    '             Address     ' + dottedMac(own.mac),
    timers,
    '             Aging Time  300 sec',
    '',
    'Interface           Role Sts Cost      Prio.Nbr Type',
    '------------------- ---- --- --------- -------- --------------------------------',
    ...ports
      .filter(({ port, state }) => state.role !== 'disabled' && interfaceOperational(e.state, d, port))
      .map(
        ({ port, state }) =>
          port.name.padEnd(20) +
          (ROLE[state.role] ?? state.role).padEnd(5) +
          (STATE[state.state] ?? state.state).padEnd(4) +
          String(portCost(port)).padEnd(10) +
          ('128.' + (d.interfaces.indexOf(port) + 1)).padEnd(9) +
          'P2p' +
          (port.stpEdge ? ' Edge' : '')
      ),
  ].join('\n');
}
/** show spanning-tree [vlan N]: one IOS block per VLAN (PVST) or MST instance. */
export function showSpanningTree(e: SimulationEngine, d: Device, vlan?: number) {
  const c = d.multiSpanningTree;
  if (!d.spanningTree?.enabled) return 'No spanning tree instance exists.';
  const member = (p: NetworkInterface, vlans: number[]) =>
    p.mode === 'trunk' ? vlans.some((v) => p.allowedVlans.includes(v)) : vlans.includes(p.accessVlan);
  if (!c) {
    const ports = d.interfaces
      .filter((p) => p.spanningTree)
      .map((p) => ({ port: p, state: p.spanningTree! }));
    return stpBlock(
      e,
      d,
      'VLAN0001',
      d.spanningTree.mode === 'rstp' ? 'rstp' : 'ieee',
      d.spanningTree,
      0,
      ports
    );
  }
  const protocol = c.mode === 'mstp' ? 'mstp' : c.protocol === 'stp' ? 'ieee' : 'rstp';
  const blocks = c.instances
    .filter((instance) =>
      vlan === undefined
        ? true
        : c.mode === 'pvst'
          ? instance.id === vlan
          : c.mappings.some((m) => m.vlan === vlan && m.instance === instance.id)
    )
    .sort((a, b) => a.id - b.id)
    .map((instance) => {
      const vlans =
        c.mode === 'pvst'
          ? [instance.id]
          : c.mappings.filter((m) => m.instance === instance.id).map((m) => m.vlan);
      const ports = d.interfaces
        .filter((p) => member(p, vlans))
        .flatMap((p) => {
          const state = p.spanningInstances?.find((i) => i.id === instance.id)?.state;
          return state ? [{ port: p, state }] : [];
        });
      const title =
        c.mode === 'pvst'
          ? 'VLAN' + String(instance.id).padStart(4, '0')
          : 'MST' + String(instance.id).padStart(4, '0');
      return stpBlock(e, d, title, protocol, instance.tree, c.mode === 'pvst' ? instance.id : 0, ports);
    });
  if (!blocks.length)
    throw new Error(
      vlan === undefined
        ? 'No spanning tree instance exists.'
        : `Spanning tree instance(s) for vlan ${vlan} does not exist.`
    );
  return blocks.join('\n\n');
}

/** show vlan [brief] */
export function showVlan(d: Device, brief: boolean) {
  const access = (id: number) =>
    d.interfaces
      .filter((p) => !p.logical && !p.loopback && !p.channel && p.mode === 'access' && p.accessVlan === id)
      .map((p) => p.name);
  const wrap = (ports: string[]) => {
    const lines: string[] = [];
    let line = '';
    for (const port of ports) {
      const next = line ? line + ', ' + port : port;
      if (next.length > 31 && line) {
        lines.push(line + ',');
        line = port;
      } else line = next;
    }
    return [...lines, line];
  };
  const legacy: [number, string][] = [
    [1002, 'fddi-default'],
    [1003, 'token-ring-default'],
    [1004, 'fddinet-default'],
    [1005, 'trnet-default'],
  ];
  const rows = [
    ...[...d.vlans]
      .sort((a, b) => a.id - b.id)
      .flatMap((v) => {
        const [first, ...rest] = wrap(access(v.id));
        return [
          (String(v.id).padEnd(5) + v.name.slice(0, 32).padEnd(33) + 'active'.padEnd(10) + first).trimEnd(),
          ...rest.map((line) => ' '.repeat(48) + line),
        ];
      }),
    ...legacy.map(([id, name]) => String(id).padEnd(5) + name.padEnd(33) + 'act/unsup'),
  ];
  const table = [
    '',
    'VLAN Name                             Status    Ports',
    '---- -------------------------------- --------- -------------------------------',
    ...rows,
  ];
  if (brief) return table.join('\n');
  return [
    ...table,
    '',
    'VLAN Type  SAID       MTU   Parent RingNo BridgeNo Stp  BrdgMode Trans1 Trans2',
    '---- ----- ---------- ----- ------ ------ -------- ---- -------- ------ ------',
    ...[...d.vlans]
      .sort((a, b) => a.id - b.id)
      .map(
        (v) =>
          String(v.id).padEnd(5) +
          'enet  ' +
          String(100000 + v.id).padEnd(11) +
          '1500  -      -      -        -    -        0      0'
      ),
  ].join('\n');
}

/** show ip nat translations */
export function showNatTranslations(d: Device) {
  const nat = d.nat;
  const proto = (p: string) => (p === 'ip' ? '---' : p.toLowerCase());
  const at = (ip: string, token?: string) => (token ? ip + ':' + token : ip);
  return [
    'Pro  Inside global         Inside local          Outside local         Outside global',
    ...(nat?.bindings ?? []).map((b) => {
      const outside = b.remote ? at(b.remote, b.remotePort?.toString()) : '---';
      return (
        proto(b.protocol).padEnd(5) +
        at(b.global, b.globalToken).padEnd(22) +
        at(b.inside, b.insideToken).padEnd(22) +
        outside.padEnd(22) +
        outside
      );
    }),
    ...(nat?.statics ?? []).map(
      (s) => '---  ' + s.global.padEnd(22) + s.inside.padEnd(22) + '---'.padEnd(22) + '---'
    ),
  ].join('\n');
}

/** show access-lists [name] */
export function showAccessLists(d: Device, name?: string) {
  const lists = (d.accessLists ?? []).filter((acl) => !name || acl.name === name);
  const standard = (range: AclRule['source'], wildcard?: string) =>
    wildcard
      ? `${range.network}, wildcard bits ${wildcard}`
      : range.prefix === 0
        ? 'any'
        : range.prefix === 32
          ? range.network
          : `${range.network}, wildcard bits ${ipString(~mask(range.prefix))}`;
  return lists
    .map((acl) => {
      const kind = acl.kind ?? 'extended';
      return [
        `${kind === 'standard' ? 'Standard' : 'Extended'} IP access list ${acl.name}`,
        ...acl.rules.map(
          (rule) =>
            `    ${rule.sequence} ${rule.action} ` +
            (kind === 'standard'
              ? standard(rule.source, rule.sourceWildcard)
              : `${rule.protocol} ${aclAddress(rule.source, rule.sourceWildcard)}${rule.sourcePort ? ' eq ' + rule.sourcePort : ''} ${aclAddress(rule.destination, rule.destinationWildcard)}${rule.destinationPort ? ' eq ' + rule.destinationPort : ''}${rule.established ? ' established' : ''}`) +
            (rule.hits ? ` (${rule.hits} match${rule.hits === 1 ? '' : 'es'})` : '')
        ),
      ].join('\n');
    })
    .join('\n');
}
