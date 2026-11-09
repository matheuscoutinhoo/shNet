import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkInterface } from '../model';
import type { OspfLsa } from '../protocols/ospf-model';
import { interfaceOperational } from '../protocols/layer3';
import { dottedMac, longInterfaceName, shortInterfaceName } from '../protocols/interface-name';
import { vrrpMac, type VrrpTrack } from '../protocols/vrrp-model';
import { vrrpTrackUp } from '../protocols/vrrp';
import { networkTime } from '../protocols/ntp';
import { ALL_MODES, type CommandRegistry } from './registry';
import { interfaceName } from './operational';
import { stpTrees } from './ios-show';

/** IOS views of routing, redundancy and system state that complement ios-show.ts. */
const hms = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
};
const hex = (n: number, digits: number) => '0x' + n.toString(16).toUpperCase().padStart(digits, '0');
const portOf = (d: Device, id: string) => d.interfaces.find((p) => p.id === id);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// The virtual calendar starts on Mar 1 2026, like the console timestamps (ios-time.ts).
const BOOT_CALENDAR = Date.UTC(2026, 2, 1);
/** "12:00:05.123 UTC Sun Mar 1 2026" in the device's time zone. */
function calendar(d: Device, clockMs: number) {
  const zone = d.iosSystem?.timezone,
    offset = zone ? (zone.hours * 60 + (zone.hours < 0 ? -1 : 1) * zone.minutes) * 60000 : 0;
  const t = new Date(BOOT_CALENDAR + Math.max(0, Math.floor(clockMs)) + offset);
  const two = (n: number) => String(n).padStart(2, '0');
  return (
    `${two(t.getUTCHours())}:${two(t.getUTCMinutes())}:${two(t.getUTCSeconds())}.${String(t.getUTCMilliseconds()).padStart(3, '0')} ` +
    `${zone?.name ?? 'UTC'} ${DAYS[t.getUTCDay()]} ${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()} ${t.getUTCFullYear()}`
  );
}

// --- OSPF -----------------------------------------------------------------------------------------
type Ospf = NonNullable<Device['ospf']>;
type OspfPort = Ospf['interfaces'][number];
const NEIGHBOR_STATE: Record<string, string> = {
  Init: 'INIT',
  '2-Way': '2WAY',
  ExStart: 'EXSTART',
  Exchange: 'EXCHANGE',
  Loading: 'LOADING',
  Full: 'FULL',
};
function ospfState(e: SimulationEngine, d: Device, s: Ospf, config: OspfPort) {
  const p = portOf(d, config.port)!,
    runtime = s.ports.find((r) => r.port === config.port);
  if (p.loopback) return 'LOOP';
  if (!runtime?.operational || !interfaceOperational(e.state, d, p)) return 'DOWN';
  if (config.networkType === 'point-to-point') return 'P2P';
  if (runtime.waitUntil > e.state.clock) return 'WAIT';
  // The election records router IDs.
  return runtime.dr === s.routerId ? 'DR' : runtime.bdr === s.routerId ? 'BDR' : 'DROTH';
}
function areaOptions(s: Ospf, area: number) {
  const type = s.areas.find((a) => a.id === area)?.type ?? 'normal';
  return type === 'stub'
    ? { hello: '0x10 in Hello (L-bit)', dbd: '0x50 in DBD (L-bit, O-bit)' }
    : type === 'nssa'
      ? { hello: '0x18 in Hello (N-bit, L-bit)', dbd: '0x58 in DBD (N-bit, L-bit, O-bit)' }
      : { hello: '0x12 in Hello (E-bit, L-bit)', dbd: '0x52 in DBD (E-bit, L-bit, O-bit)' };
}
export function showOspfProcess(d: Device) {
  const s = d.ospf;
  if (!s) return '';
  const areas = [...new Set(s.interfaces.map((i) => i.area))].sort((a, b) => a - b);
  const kind = (id: number) => s.areas.find((a) => a.id === id);
  const count = { normal: 0, stub: 0, nssa: 0 };
  for (const id of areas) count[kind(id)?.type ?? 'normal']++;
  const live = s.lsdb.filter((l) => !l.withdrawn);
  const checksum = (list: OspfLsa[]) =>
    hex(
      list.reduce((n, l) => n + (l.checksum ?? 0), 0),
      6
    );
  const externals = live.filter((l) => l.type === 'external');
  const throttle = s.spfThrottle ?? { startMs: 50, holdMs: 200, maxMs: 5000 };
  const asbr = !!s.redistribute?.length || !!s.defaultOriginate;
  return [
    ` Routing Process "ospf ${s.processId ?? 1}" with ID ${s.routerId}`,
    ' Supports only single TOS(TOS0) routes',
    ' Supports opaque LSA',
    ' Supports Link-local Signaling (LLS)',
    ' Supports area transit capability',
    ' Supports NSSA (compatible with RFC 3101)',
    ' Supports Database Exchange Summary List Optimization (RFC 5243)',
    ' Event-log enabled, Maximum number of events: 1000, Mode: cyclic',
    ...(areas.length > 1 && areas.includes(0) ? [' It is an area border router'] : []),
    ...(asbr
      ? [
          ' It is an autonomous system boundary router',
          ' Redistributing External Routes from,',
          ...(s.redistribute ?? []).map(
            (r) => '    ' + r.source + (r.process !== undefined ? ' ' + r.process : '')
          ),
        ]
      : []),
    ' Router is not originating router-LSAs with maximum metric',
    ` Initial SPF schedule delay ${throttle.startMs} msecs`,
    ` Minimum hold time between two consecutive SPFs ${throttle.holdMs} msecs`,
    ` Maximum wait time between two consecutive SPFs ${throttle.maxMs} msecs`,
    ' Incremental-SPF disabled',
    ' Minimum LSA interval 5 secs',
    ' Minimum LSA arrival 1000 msecs',
    ' LSA group pacing timer 240 secs',
    ' Interface flood pacing timer 33 msecs',
    ' Retransmission pacing timer 66 msecs',
    ' EXCHANGE/LOADING adjacency limit: initial 300, process maximum 300',
    ` Number of external LSA ${externals.length}. Checksum Sum ${checksum(externals)}`,
    ' Number of opaque AS LSA 0. Checksum Sum 0x000000',
    ' Number of DCbitless external and opaque AS LSA 0',
    ' Number of DoNotAge external and opaque AS LSA 0',
    ` Number of areas in this router is ${areas.length}. ${count.normal} normal ${count.stub} stub ${count.nssa} nssa`,
    ' Number of areas transit capable is 0',
    ' External flood list length 0',
    ' IETF NSF helper support enabled',
    ' Cisco NSF helper support enabled',
    ` Reference bandwidth unit is ${s.referenceBandwidth} mbps`,
    ...areas.flatMap((id) => {
      const area = kind(id),
        ports = s.interfaces.filter((i) => i.area === id),
        loopbacks = ports.filter((i) => portOf(d, i.port)?.loopback).length,
        lsas = live.filter((l) => l.area === id && l.type !== 'external');
      return [
        `    Area ${id === 0 ? 'BACKBONE(0)' : id}`,
        `        Number of interfaces in this area is ${ports.length}${loopbacks ? ` (${loopbacks} loopback)` : ''}`,
        ...(area?.type === 'stub' || area?.type === 'nssa'
          ? [
              `        It is a ${area.type === 'stub' ? 'stub' : 'NSSA'} area${area.noSummary ? ', no summary LSA in this area' : ''}`,
            ]
          : []),
        `        Area has ${area?.authentication ? 'message digest authentication' : 'no authentication'}`,
        `        SPF algorithm executed ${s.spfRuns} times`,
        '        Area ranges are',
        ...s.summaryRanges
          .filter((r) => r.area === id)
          .map((r) => `           ${r.network}/${r.prefix} Active(${r.cost ?? 1}) Advertise`),
        `        Number of LSA ${lsas.length}. Checksum Sum ${checksum(lsas)}`,
        '        Number of opaque link LSA 0. Checksum Sum 0x000000',
        '        Number of DCbitless LSA 0',
        '        Number of indication LSA 0',
        '        Number of DoNotAge LSA 0',
        '        Flood list length 0',
      ];
    }),
  ].join('\n');
}
export function showOspfInterfaceBrief(e: SimulationEngine, d: Device) {
  const s = d.ospf;
  if (!s) return '';
  const rows = d.interfaces.flatMap((p) => {
    const config = s.interfaces.find((i) => i.port === p.id);
    if (!config) return [];
    const neighbors = s.neighbors.filter((n) => n.port === p.id);
    return [
      shortInterfaceName(p.name).padEnd(13) +
        String(s.processId ?? 1).padEnd(6) +
        String(config.area).padEnd(16) +
        `${p.ip ?? '0.0.0.0'}/${p.prefix ?? 0}`.padEnd(19) +
        String(config.cost).padEnd(6) +
        ospfState(e, d, s, config).padEnd(6) +
        `${neighbors.filter((n) => n.state === 'Full').length}/${neighbors.length}`,
    ];
  });
  return ['Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C', ...rows].join('\n');
}
export function showOspfInterface(e: SimulationEngine, d: Device, only?: NetworkInterface) {
  const s = d.ospf;
  if (!s) return '';
  const now = e.state.clock;
  return d.interfaces
    .filter((p) => (!only || p.id === only.id) && s.interfaces.some((i) => i.port === p.id))
    .map((p) => {
      const config = s.interfaces.find((i) => i.port === p.id)!,
        runtime = s.ports.find((r) => r.port === p.id),
        state = ospfState(e, d, s, config),
        up = interfaceOperational(e.state, d, p);
      const network = p.loopback
        ? 'LOOPBACK'
        : config.networkType === 'broadcast'
          ? 'BROADCAST'
          : 'POINT_TO_POINT';
      const head = [
        `${longInterfaceName(p.name)} is ${p.adminUp ? 'up' : 'administratively down'}, line protocol is ${up ? 'up' : 'down'} `,
        `  Internet Address ${p.ip ?? '0.0.0.0'}/${p.prefix ?? 0}, Area ${config.area}, Attached via ${config.networkManaged ? 'Network Statement' : 'Interface Enable'}`,
        `  Process ID ${s.processId ?? 1}, Router ID ${s.routerId}, Network Type ${network}, Cost: ${config.cost}`,
        '  Topology-MTID    Cost    Disabled    Shutdown      Topology Name',
        `        0           ${String(config.cost).padEnd(10)}no          no            Base`,
        ...(config.networkManaged ? [] : ['  Enabled by interface config, including secondary ip addresses']),
      ];
      if (p.loopback) return [...head, '  Loopback interface is treated as a stub Host'].join('\n');
      if (state === 'DOWN') return [...head, '  Transmit Delay is 1 sec, State DOWN'].join('\n');
      const neighbors = s.neighbors.filter((n) => n.port === p.id),
        full = neighbors.filter((n) => n.state === 'Full');
      // DR/BDR are elected by router ID; IOS also shows their interface address.
      const addressOf = (id: string) =>
        id === s.routerId ? (p.ip ?? id) : (neighbors.find((n) => n.routerId === id)?.ip ?? id);
      const broadcast = config.networkType === 'broadcast';
      const dr = runtime && runtime.dr !== '0.0.0.0' ? runtime.dr : undefined,
        bdr = runtime && runtime.bdr !== '0.0.0.0' ? runtime.bdr : undefined;
      const role = (n: (typeof neighbors)[number]) =>
        n.routerId === dr
          ? '  (Designated Router)'
          : n.routerId === bdr
            ? '  (Backup Designated Router)'
            : '';
      return [
        ...head,
        `  Transmit Delay is 1 sec, State ${broadcast ? state : 'POINT_TO_POINT'}${broadcast ? ', Priority ' + config.priority : ''}`,
        ...(broadcast
          ? [
              dr
                ? `  Designated Router (ID) ${dr}, Interface address ${addressOf(dr)}`
                : '  No designated router on this network',
              bdr
                ? `  Backup Designated router (ID) ${bdr}, Interface address ${addressOf(bdr)}`
                : '  No backup designated router on this network',
            ]
          : []),
        `  Timer intervals configured, Hello ${config.helloMs / 1000}, Dead ${config.deadMs / 1000}, Wait ${config.deadMs / 1000}, Retransmit 5`,
        `    oob-resync timeout ${config.deadMs / 1000}`,
        config.passive
          ? '    No Hellos (Passive interface)'
          : `    Hello due in ${hms(Math.max(0, (runtime?.helloAt ?? now) - now))}`,
        '  Supports Link-local Signaling (LLS)',
        '  Cisco NSF helper support enabled',
        '  IETF NSF helper support enabled',
        ...(config.authenticationKey
          ? [
              '  Cryptographic authentication enabled',
              `    Youngest key id is ${config.authenticationKeyId ?? 1}`,
            ]
          : []),
        '  Index 1/1/1, flood queue length 0',
        '  Next 0x0(0)/0x0(0)/0x0(0)',
        '  Last flood scan length is 1, maximum is 1',
        '  Last flood scan time is 0 msec, maximum is 0 msec',
        `  Neighbor Count is ${neighbors.length}, Adjacent neighbor count is ${full.length} `,
        ...full.map((n) => `    Adjacent with neighbor ${n.routerId}${role(n)}`),
        '  Suppress hello for 0 neighbor(s)',
      ].join('\n');
    })
    .join('\n');
}
export function showOspfNeighborDetail(e: SimulationEngine, d: Device) {
  const s = d.ospf;
  if (!s) return '';
  const now = e.state.clock;
  return s.neighbors
    .map((n, index) => {
      const config = s.interfaces.find((i) => i.port === n.port),
        options = areaOptions(s, config?.area ?? 0),
        own = portOf(d, n.port)?.ip;
      // IOS lists the DR and BDR by interface address; the election records router IDs.
      const address = (id: string) =>
        id === '0.0.0.0'
          ? id
          : id === s.routerId
            ? (own ?? id)
            : (s.neighbors.find((x) => x.port === n.port && x.routerId === id)?.ip ?? id);
      return [
        ` Neighbor ${n.routerId}, interface address ${n.ip}`,
        `    In the area ${config?.area ?? 0} via interface ${longInterfaceName(portOf(d, n.port)?.name ?? n.port)}`,
        `    Neighbor priority is ${n.priority}, State is ${NEIGHBOR_STATE[n.state] ?? n.state}`,
        `    DR is ${address(n.dr)} BDR is ${address(n.bdr)}`,
        `    Options is ${options.hello}`,
        `    Options is ${options.dbd}`,
        '    LLS Options is 0x1 (LR)',
        `    Dead timer due in ${hms(n.deadAt - now)}`,
        `    Index ${index + 1}/${index + 1}/${index + 1}, retransmission queue length ${n.pending.length}, number of retransmission 0`,
        '    First 0x0(0)/0x0(0)/0x0(0) Next 0x0(0)/0x0(0)/0x0(0)',
        '    Last retransmission scan length is 0, maximum is 0',
        '    Last retransmission scan time is 0 msec, maximum is 0 msec',
      ].join('\n');
    })
    .join('\n');
}
const LSA_SECTIONS: { type: OspfLsa['type']; title: string; columns: string }[] = [
  { type: 'router', title: 'Router Link States', columns: ' Link count' },
  { type: 'network', title: 'Net Link States', columns: '' },
  { type: 'summary', title: 'Summary Net Link States', columns: '' },
  { type: 'asbr-summary', title: 'Summary ASB Link States', columns: '' },
  { type: 'nssa', title: 'Type-7 AS External Link States', columns: ' Tag' },
];
export function showOspfDatabase(e: SimulationEngine, d: Device) {
  const s = d.ospf;
  if (!s) return '';
  const now = e.state.clock,
    live = s.lsdb.filter((l) => !l.withdrawn);
  const linkId = (l: OspfLsa) =>
    l.type === 'summary' || l.type === 'external' || l.type === 'nssa'
      ? l.network
      : l.type === 'asbr-summary'
        ? l.routerId
        : l.id;
  const row = (l: OspfLsa) =>
    linkId(l).padEnd(16) +
    l.advertisingRouter.padEnd(16) +
    String(Math.min(3600, Math.max(0, Math.floor((now - l.originatedAt) / 1000)))).padEnd(12) +
    '0x' +
    ((0x80000000 + l.sequence) >>> 0).toString(16).toUpperCase().padStart(8, '0') +
    ' ' +
    hex(l.checksum ?? 0, 6) +
    (l.type === 'router'
      ? ' ' + (l.links.length + l.prefixes.length)
      : l.type === 'external' || l.type === 'nssa'
        ? ' ' + l.tag
        : '');
  const section = (title: string, columns: string, list: OspfLsa[]) =>
    list.length
      ? [
          '',
          `                ${title}`,
          '',
          'Link ID         ADV Router      Age         Seq#       Checksum' + columns,
          ...list.map(row),
        ]
      : [];
  const areas = [...new Set(live.filter((l) => l.type !== 'external').map((l) => l.area))].sort(
    (a, b) => a - b
  );
  return [
    '',
    `            OSPF Router with ID (${s.routerId}) (Process ID ${s.processId ?? 1})`,
    ...areas.flatMap((area) =>
      LSA_SECTIONS.flatMap((x) =>
        section(
          `${x.title} (Area ${area})`,
          x.columns,
          live.filter((l) => l.area === area && l.type === x.type)
        )
      )
    ),
    ...section(
      'Type-5 AS External Link States',
      ' Tag',
      live.filter((l) => l.type === 'external')
    ),
  ].join('\n');
}

// --- Spanning tree --------------------------------------------------------------------------------
function showSpanningTreeSummary(d: Device) {
  const trees = stpTrees(d);
  if (!trees.length) return 'No spanning tree instance exists.';
  const c = d.multiSpanningTree;
  const mode =
    c?.mode === 'mstp'
      ? 'mst'
      : c?.protocol === 'stp'
        ? 'pvst'
        : c
          ? 'rapid-pvst'
          : (d.spanningTree?.mode ?? 'rstp');
  const flag = (on: boolean | undefined) => (on ? 'enabled' : 'disabled');
  const counts = trees.map((t) => {
    const states = t.ports.filter((x) => x.state.role !== 'disabled').map((x) => x.state.state);
    return {
      name: t.title,
      blocking: states.filter((s) => s === 'discarding').length,
      listening: 0,
      learning: states.filter((s) => s === 'learning').length,
      forwarding: states.filter((s) => s === 'forwarding').length,
    };
  });
  const roots = trees.filter((t) => !t.tree.rootPort).map((t) => t.title);
  const line = (
    name: string,
    x: { blocking: number; listening: number; learning: number; forwarding: number }
  ) =>
    name.padEnd(22) +
    String(x.blocking).padStart(9) +
    String(x.listening).padStart(10) +
    String(x.learning).padStart(9) +
    String(x.forwarding).padStart(11) +
    String(x.blocking + x.listening + x.learning + x.forwarding).padStart(11);
  const total = counts.reduce(
    (t, x) => ({
      blocking: t.blocking + x.blocking,
      listening: t.listening + x.listening,
      learning: t.learning + x.learning,
      forwarding: t.forwarding + x.forwarding,
    }),
    { blocking: 0, listening: 0, learning: 0, forwarding: 0 }
  );
  return [
    `Switch is in ${mode} mode`,
    'Root bridge for: ' + (roots.join(', ') || 'none'),
    'Extended system ID           is enabled',
    'Portfast Default             is ' + flag(d.iosSystem?.portfastDefault),
    'PortFast BPDU Guard Default  is ' + flag(d.iosSystem?.bpduguardDefault),
    'Portfast BPDU Filter Default is disabled',
    'Loopguard Default            is ' + flag(d.loopGuardDefault),
    'EtherChannel misconfig guard is enabled',
    'UplinkFast                   is disabled',
    'BackboneFast                 is disabled',
    'Configured Pathcost method used is short',
    '',
    'Name                   Blocking Listening Learning Forwarding STP Active',
    '---------------------- -------- --------- -------- ---------- ----------',
    ...counts.map((x) => line(x.name, x)),
    '---------------------- -------- --------- -------- ---------- ----------',
    line(`${counts.length} ${c?.mode === 'mstp' ? 'msts' : counts.length === 1 ? 'vlan' : 'vlans'}`, total),
  ].join('\n');
}
function showSpanningTreeRoot(d: Device) {
  const trees = stpTrees(d);
  if (!trees.length) return 'No spanning tree instance exists.';
  return [
    '                                        Root    Hello Max Fwd',
    'Vlan                   Root ID          Cost    Time  Age Dly  Root Port',
    '---------------- -------------------- --------- ----- --- ---  ------------',
    ...trees.map((t) => {
      const root = t.tree.root,
        port = t.tree.rootPort ? portOf(d, t.tree.rootPort) : undefined;
      return (
        t.title.padEnd(17) +
        `${root.priority + (root.instance ?? 0)} ${dottedMac(root.mac)}`.padEnd(21) +
        String(t.tree.cost).padStart(9) +
        '    2   20  15  ' +
        (port ? shortInterfaceName(port.name) : '')
      ).trimEnd();
    }),
  ].join('\n');
}

// --- VRRP -----------------------------------------------------------------------------------------
function masterDownMs(advertMs: number, priority: number) {
  return 3 * advertMs + Math.round(((256 - priority) * advertMs) / 256);
}
function vrrpTrackLabel(d: Device, t: VrrpTrack) {
  if (t.object !== undefined) return 'object ' + t.object;
  if (t.port) return 'interface ' + longInterfaceName(portOf(d, t.port)?.name ?? t.port);
  if (t.route) return 'route ' + t.route;
  return 'service ' + t.service + (t.servicePort === undefined ? '' : ':' + t.servicePort);
}
function showVrrp(e: SimulationEngine, d: Device, brief: boolean) {
  e.refreshVrrp();
  const groups = d.vrrp?.groups ?? [];
  const state = (s: string) => (s === 'ACTIVE' ? 'Master' : s === 'BACKUP' ? 'Backup' : 'Init');
  if (brief)
    return [
      'Interface          Grp Pri Time  Own Pre State   Master addr     Group addr',
      ...groups.map((g) => {
        const p = portOf(d, g.port)!,
          priority = g.effectivePriority ?? g.priority;
        return (
          shortInterfaceName(p.name).padEnd(19) +
          String(g.vrid).padEnd(4) +
          String(priority).padEnd(4) +
          String(masterDownMs(g.advertMs, priority)).padEnd(6) +
          (priority === 255 ? ' Y  ' : '    ') +
          (g.preempt ? ' Y  ' : '    ') +
          state(g.state).padEnd(8) +
          (g.state === 'ACTIVE' ? (p.ip ?? '') : (g.activeIp ?? 'unknown')).padEnd(16) +
          g.vip
        );
      }),
    ].join('\n');
  return groups
    .map((g) => {
      const p = portOf(d, g.port)!,
        priority = g.effectivePriority ?? g.priority,
        master = g.state === 'ACTIVE';
      const down = masterDownMs(g.activeAdvertMs ?? g.advertMs, priority);
      return [
        `${longInterfaceName(p.name)} - Group ${g.vrid}`,
        '  State is ' + state(g.state),
        '  Virtual IP address is ' + g.vip,
        '  Virtual MAC address is ' + dottedMac(vrrpMac(g.vrid)),
        `  Advertisement interval is ${(g.advertMs / 1000).toFixed(3)} sec`,
        '  Preemption ' + (g.preempt ? 'enabled' : 'disabled'),
        `  Priority is ${priority}${priority !== g.priority ? ` (configured ${g.priority})` : ''}`,
        ...(g.track ?? []).map(
          (t) =>
            `    Track ${vrrpTrackLabel(d, t)} state ${vrrpTrackUp(e.state, d, t) ? 'Up' : 'Down'} decrement ${t.decrement}`
        ),
        master
          ? `  Master Router is ${p.ip} (local), priority is ${priority}`
          : `  Master Router is ${g.activeIp ?? 'unknown'}, priority is ${g.activePriority ?? 'unknown'}`,
        `  Master Advertisement interval is ${((g.activeAdvertMs ?? g.advertMs) / 1000).toFixed(3)} sec`,
        `  Master Down interval is ${(down / 1000).toFixed(3)} sec` +
          (!master && g.downAt !== undefined
            ? ` (expires in ${(Math.max(0, g.downAt - e.state.clock) / 1000).toFixed(3)} sec)`
            : ''),
      ].join('\n');
    })
    .join('\n\n');
}

// --- IP SLA and object tracking -------------------------------------------------------------------
const slaCode = (status: string) => (status === 'up' ? 'OK' : status === 'down' ? 'Timeout' : 'Unknown');
function showIpSlaSummary(e: SimulationEngine, d: Device) {
  const ops = d.monitoring?.operations ?? [];
  return [
    'IPSLAs Latest Operation Summary',
    'Codes: * active, ^ inactive, ~ pending',
    'All Stats are in milliseconds. Stats with u are in microseconds',
    '',
    'ID           Type        Destination       Stats       Return      Last',
    '                                                       Code        Run',
    '-----------------------------------------------------------------------',
    ...ops.map(
      (o) =>
        ((o.scheduled ? (o.lastRun === undefined ? '~' : '*') : '^') + o.id).padEnd(13) +
        'icmp-echo'.padEnd(12) +
        (o.target ?? '-').padEnd(18) +
        (o.rtt === undefined || o.status !== 'up' ? '-' : 'RTT=' + Math.max(1, Math.round(o.rtt))).padEnd(
          12
        ) +
        slaCode(o.status).padEnd(12) +
        (o.lastRun === undefined ? 'never' : `${Math.floor((e.state.clock - o.lastRun) / 1000)} seconds ago`)
    ),
  ].join('\n');
}
function showIpSlaStatistics(d: Device, id?: number) {
  const ops = (d.monitoring?.operations ?? []).filter((o) => id === undefined || o.id === id);
  return [
    'IPSLAs Latest Operation Statistics',
    ...ops.flatMap((o) => [
      '',
      `IPSLA operation id: ${o.id}`,
      // IOS reports whole milliseconds; sub-millisecond lab RTTs show as 1.
      `        Latest RTT: ${o.rtt === undefined || o.status !== 'up' ? 'NoConnection/Busy/Timeout' : Math.max(1, Math.round(o.rtt)) + ' milliseconds'}`,
      `Latest operation start time: ${o.lastRun === undefined ? 'Unknown' : calendar(d, o.lastRun)}`,
      `Latest operation return code: ${slaCode(o.status)}`,
      `Number of successes: ${o.successes ?? 0}`,
      `Number of failures: ${o.failures ?? 0}`,
      `Operation time to live: ${o.scheduled ? 'Forever' : '0'}`,
    ]),
  ].join('\n');
}
function showTrack(e: SimulationEngine, d: Device, id?: number) {
  const s = d.monitoring;
  const tracks = (s?.tracks ?? []).filter((t) => id === undefined || t.id === id);
  return tracks
    .map((t) => {
      const op = t.kind === 'sla' ? s!.operations.find((o) => o.id === t.operation) : undefined,
        port = t.port ? portOf(d, t.port) : undefined;
      const clients = [
        ...(d.hsrp?.groups ?? [])
          .filter((g) => g.objectTrack.some((x) => x.object === t.id))
          .map((g) => `    HSRP ${longInterfaceName(portOf(d, g.port)!.name)} ${g.group}`),
        ...(d.routes.some((r) => r.track === t.id) ? ['    Static IP Routing 0'] : []),
      ];
      const changes = t.changes ?? 0;
      return [
        `Track ${t.id}`,
        t.kind === 'sla'
          ? `  IP SLA ${t.operation} reachability`
          : `  Interface ${longInterfaceName(port?.name ?? '')} line-protocol`,
        `  ${t.kind === 'sla' ? 'Reachability' : 'Line protocol'} is ${t.state ? 'Up' : 'Down'}`,
        `    ${changes} change${changes === 1 ? '' : 's'}, last change ${hms(e.state.clock - t.changedAt)}`,
        ...(op
          ? [
              `  Latest operation return code: ${slaCode(op.status)}`,
              ...(op.rtt !== undefined && op.status === 'up'
                ? [`  Latest RTT (millisecs) ${Math.max(1, Math.round(op.rtt))}`]
                : []),
            ]
          : []),
        ...(clients.length ? ['  Tracked by:', ...clients] : []),
      ].join('\n');
    })
    .join('\n');
}

// --- NTP and clock --------------------------------------------------------------------------------
/** NTP timestamp (seconds and fraction since 1900) with its calendar form, as IOS prints it. */
function ntpTime(d: Device, clockMs: number) {
  const unix = (BOOT_CALENDAR + clockMs) / 1000,
    seconds = Math.floor(unix) + 2208988800,
    fraction = Math.floor((unix - Math.floor(unix)) * 2 ** 32);
  const hex8 = (n: number) => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
  return `${hex8(seconds)}.${hex8(fraction)} (${calendar(d, clockMs)})`;
}
function showNtpStatus(e: SimulationEngine, d: Device) {
  const n = d.ntp,
    master = !!d.networkClock?.server;
  if (!n?.enabled && !master) return '%NTP is not enabled.';
  const synced = !!n?.synchronized,
    last = n?.samples.at(-1);
  const stratum = synced ? n!.stratum : master ? d.networkClock!.stratum : 16;
  const reference = synced ? (last?.server ?? n!.servers[0]) : master ? '127.127.1.1' : undefined;
  const now = e.state.clock;
  return [
    synced || master
      ? `Clock is synchronized, stratum ${stratum}, reference is ${reference}`
      : 'Clock is unsynchronized, stratum 16, no reference clock',
    'nominal freq is 250.0000 Hz, actual freq is 250.0000 Hz, precision is 2**10',
    `ntp uptime is ${Math.floor(now / 10)} (1/100 of seconds), resolution is 4000`,
    `reference time is ${synced && n!.lastSync !== undefined ? ntpTime(d, networkTime(e, d) - (now - n!.lastSync)) : master ? ntpTime(d, networkTime(e, d)) : '00000000.00000000 (00:00:00.000 UTC Mon Jan 1 1900)'}`,
    `clock offset is ${(last?.offsetMs ?? 0).toFixed(4)} msec, root delay is ${(last?.delayMs ?? 0).toFixed(2)} msec`,
    'root dispersion is 0.00 msec, peer dispersion is 0.00 msec',
    "loopfilter state is 'CTRL' (Normal Controlled Loop), drift is 0.000000000 s/s",
    `system poll interval is ${Math.round((n?.intervalMs ?? 64000) / 1000)}, last update was ${n?.lastSync === undefined ? 'never' : Math.floor((now - n.lastSync) / 1000) + ' sec ago'}.`,
  ].join('\n');
}
function showNtpAssociations(e: SimulationEngine, d: Device) {
  const n = d.ntp;
  if (!n?.enabled && !d.networkClock?.server) return '%NTP is not enabled.';
  const now = e.state.clock;
  const row = (
    mark: string,
    address: string,
    reference: string,
    stratum: number,
    when: string,
    poll: number,
    reach: string,
    delay: number,
    offset: number,
    dispersion: string
  ) =>
    mark +
    address.padEnd(16) +
    reference.padEnd(16) +
    String(stratum).padStart(2) +
    when.padStart(7) +
    String(poll).padStart(7) +
    reach.padStart(6) +
    delay.toFixed(3).padStart(7) +
    offset.toFixed(3).padStart(8) +
    dispersion.padStart(7);
  // The reference clock of a server is its own synchronization source.
  const referenceOf = (server: string) => {
    const peer = e.state.devices.find((x) => x.interfaces.some((p) => p.ip === server));
    if (peer?.ntp?.synchronized) return peer.ntp.samples.at(-1)?.server ?? '.INIT.';
    return peer?.networkClock?.server ? '127.127.1.1' : '.INIT.';
  };
  return [
    '  address         ref clock       st   when   poll reach  delay  offset   disp',
    ...(d.networkClock?.server && !n?.synchronized
      ? [row('*~', '127.127.1.1', '.LOCL.', d.networkClock.stratum - 1, '1', 16, '377', 0, 0, '0.240')]
      : []),
    ...(n?.enabled ? n.servers : []).map((server) => {
      const sample = [...n!.samples].reverse().find((x) => x.server === server),
        selected = n!.synchronized && n!.samples.at(-1)?.server === server;
      return sample
        ? row(
            selected ? '*~' : '+~',
            server,
            referenceOf(server),
            Math.max(1, n!.stratum - 1),
            String(Math.floor((now - sample.at) / 1000)),
            Math.round(n!.intervalMs / 1000),
            '377',
            sample.delayMs,
            sample.offsetMs,
            '0.120'
          )
        : row(' ~', server, '.INIT.', 16, '-', Math.round(n!.intervalMs / 1000), '0', 0, 0, '15937.');
    }),
    ' * sys.peer, # selected, + candidate, - outlyer, x falseticker, ~ configured',
  ].join('\n');
}

// --- System ---------------------------------------------------------------------------------------
function showProcessesCpu(d: Device, sorted: boolean) {
  const cpu = Math.round(d.system?.cpuPercent ?? 0);
  const running = [
    { name: 'IP Input', share: 0.6 },
    { name: 'ARP Input', share: 0.1 },
    ...(d.ospf ? [{ name: 'OSPF-' + (d.ospf.processId ?? 1) + ' Router', share: 0.1 }] : []),
    ...(d.bgp ? [{ name: 'BGP Router', share: 0.1 }] : []),
    ...(d.spanningTree?.enabled ? [{ name: 'Spanning Tree', share: 0.05 }] : []),
    ...(d.hsrp?.groups.length ? [{ name: 'HSRP Common', share: 0.02 }] : []),
    { name: 'Chunk Manager', share: 0 },
    { name: 'Exec', share: 0.03 },
  ];
  const rows = running.map((p, i) => ({ pid: i + 1, ...p, load: cpu * p.share }));
  if (sorted) rows.sort((a, b) => b.load - a.load);
  const percent = (n: number) => n.toFixed(2) + '%';
  return [
    `CPU utilization for five seconds: ${cpu}%/0%; one minute: ${cpu}%; five minutes: ${cpu}%`,
    ' PID Runtime(ms)     Invoked      uSecs   5Sec   1Min   5Min TTY Process',
    ...rows.map(
      (p) =>
        String(p.pid).padStart(4) +
        String(Math.round((d.system?.processed ?? 0) * p.share)).padStart(12) +
        String(Math.round((d.system?.processed ?? 0) * p.share)).padStart(12) +
        '0'.padStart(11) +
        percent(p.load).padStart(7) +
        percent(p.load).padStart(7) +
        percent(p.load).padStart(7) +
        '   0 ' +
        p.name
    ),
  ].join('\n');
}
function showClock(e: SimulationEngine, d: Device, detail: boolean) {
  // IOS marks a clock that NTP has not synchronized as not authoritative.
  const synced = !!d.ntp?.synchronized;
  return (
    (synced ? '' : '*') +
    calendar(d, networkTime(e, d)) +
    (detail ? '\n' + (synced ? 'Time source is NTP' : 'No time source') : '')
  );
}
function iosImage(d: Device) {
  return d.type === 'switch' ? 'cat9k_iosxe.17.09.04a.SPA.bin' : 'isr4300-universalk9.17.09.04a.SPA.bin';
}
function showFlash(d: Device) {
  const files = [
    { name: iosImage(d), bytes: 520_000_000 },
    { name: 'packages.conf', bytes: 7_512 },
    ...(d.type === 'switch' ? [{ name: 'vlan.dat', bytes: 3_436 }] : []),
    ...(d.iosSystem?.archive?.copies ?? []).map((c) => ({
      name: c.name.replace(/^flash:\/?/, ''),
      bytes: c.configuration.length,
    })),
  ];
  const used = files.reduce((n, f) => n + f.bytes, 0),
    total = 7_194_550_272;
  return [
    'Directory of flash:/',
    '',
    ...files.map(
      (f, i) =>
        `${String(i + 1).padStart(6)}  -rw-${String(f.bytes).padStart(13)}  Mar 1 2026 00:00:00 +00:00  ${f.name}`
    ),
    '',
    `${total} bytes total (${total - used} bytes free)`,
  ].join('\n');
}
function showBoot(d: Device) {
  return [
    'BOOT variable = flash:packages.conf;',
    'CONFIG_FILE variable does not exist',
    'BAUD variable = 9600',
    'ENABLE_BREAK variable does not exist',
    'MANUAL_BOOT variable = no',
    ...(d.type === 'switch' ? ['HELPER variable does not exist'] : []),
    'Configuration register is 0x2102',
  ].join('\n');
}

export function registerIosShow2(r: CommandRegistry) {
  r.register({
    pattern: /^show ip ospf$/i,
    syntax: 'show ip ospf',
    modes: ALL_MODES,
    run: (_m, _e, d) => showOspfProcess(d),
  });
  r.register({
    pattern: /^show ip ospf interface(?: (brief|\S+(?: \S+)?))?$/i,
    syntax: ['show ip ospf interface', 'show ip ospf interface brief', 'show ip ospf interface <interface>'],
    modes: ALL_MODES,
    run: (m, e, d) => {
      if (m[1]?.toLowerCase() === 'brief') return showOspfInterfaceBrief(e, d);
      const only = m[1]
        ? d.interfaces.find(
            (p) => p.name.toLowerCase() === interfaceName(m[1].replace(/\s+/g, '')).toLowerCase()
          )
        : undefined;
      if (m[1] && !only) throw new Error("Invalid input detected at '^' marker.");
      return showOspfInterface(e, d, only);
    },
  });
  r.register({
    pattern: /^show ip ospf neighbor detail$/i,
    syntax: 'show ip ospf neighbor detail',
    modes: ALL_MODES,
    run: (_m, e, d) => showOspfNeighborDetail(e, d),
  });
  r.register({
    pattern: /^show ip ospf database$/i,
    syntax: 'show ip ospf database',
    modes: ALL_MODES,
    run: (_m, e, d) => showOspfDatabase(e, d),
  });
  r.register({
    pattern: /^show spanning-tree (summary|root)$/i,
    syntax: ['show spanning-tree summary', 'show spanning-tree root'],
    modes: ALL_MODES,
    run: (m, _e, d) =>
      m[1].toLowerCase() === 'summary' ? showSpanningTreeSummary(d) : showSpanningTreeRoot(d),
  });
  r.register({
    pattern: /^show vrrp(?: (brief))?$/i,
    syntax: ['show vrrp', 'show vrrp brief'],
    modes: ALL_MODES,
    run: (m, e, d) => showVrrp(e, d, !!m[1]),
  });
  r.register({
    pattern: /^show ip sla summary$/i,
    syntax: 'show ip sla summary',
    modes: ALL_MODES,
    run: (_m, e, d) => showIpSlaSummary(e, d),
  });
  r.register({
    pattern: /^show ip sla statistics(?: (\d+))?$/i,
    syntax: ['show ip sla statistics', 'show ip sla statistics <id>'],
    modes: ALL_MODES,
    run: (m, _e, d) => showIpSlaStatistics(d, m[1] ? Number(m[1]) : undefined),
  });
  r.register({
    pattern: /^show track(?: (\d+))?$/i,
    syntax: ['show track', 'show track <id>'],
    modes: ALL_MODES,
    run: (m, e, d) => showTrack(e, d, m[1] ? Number(m[1]) : undefined),
  });
  r.register({
    pattern: /^show ntp (status|associations)$/i,
    syntax: ['show ntp status', 'show ntp associations'],
    modes: ALL_MODES,
    run: (m, e, d) => (m[1].toLowerCase() === 'status' ? showNtpStatus(e, d) : showNtpAssociations(e, d)),
  });
  r.register({
    pattern: /^show processes cpu(?: (sorted))?$/i,
    syntax: ['show processes cpu', 'show processes cpu sorted'],
    modes: ALL_MODES,
    run: (m, _e, d) => showProcessesCpu(d, !!m[1]),
  });
  r.register({
    pattern: /^show clock(?: (detail))?$/i,
    syntax: ['show clock', 'show clock detail'],
    modes: ALL_MODES,
    run: (m, e, d) => showClock(e, d, !!m[1]),
  });
  r.register({
    pattern: /^(?:dir(?: flash:\/?)?|show flash:?)$/i,
    syntax: ['dir', 'dir flash:', 'show flash:'],
    modes: ['user', 'privileged'],
    run: (_m, _e, d) => showFlash(d),
  });
  r.register({
    pattern: /^show (?:boot|bootvar)$/i,
    syntax: ['show boot', 'show bootvar'],
    modes: ALL_MODES,
    run: (_m, _e, d) => showBoot(d),
  });
}
