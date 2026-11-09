import type { SimulationEngine } from '../core/engine';
import type { Device } from '../model';
import { ALL_MODES, CONFIG_MODES, currentPort, type CommandRegistry, type Context } from './registry';
import {
  clearEigrpNeighbors,
  configureEigrp,
  eigrpConfig,
  eigrpHelloMs,
  eigrpHoldMs,
  eigrpInterface,
  eigrpKeyChain,
  eigrpMetric,
  eigrpPassive,
  eigrpPorts,
  eigrpRouterId,
  eigrpTopologyView,
  removeEigrp,
} from '../protocols/eigrp';
import { EIGRP, type EigrpConfig, type EigrpStub } from '../protocols/eigrp-model';
import { findInterface, longInterfaceName, shortInterfaceName } from '../protocols/interface-name';
import { ipNumber, ipString, mask, parsePrefix, subnet } from '../protocols/ipv4';

type Config = EigrpConfig;
const inEigrp = (_d: Device, c: Context) => c.mode === 'router' && c.router === 'eigrp';
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
};
/** The configuration being edited: the running process, or a placeholder holding interface settings. */
function current(d: Device, asn?: number): Config {
  return (
    eigrpConfig(d) ?? {
      enabled: false,
      asn: asn ?? 1,
      networks: [],
      passiveDefault: false,
      passive: [],
      k: [1, 0, 1, 0, 0],
      variance: 1,
      maximumPaths: 4,
      redistribute: [],
      interfaces: [],
    }
  );
}
function save(e: SimulationEngine, d: Device, config: Config) {
  configureEigrp(e, d, config);
}
const classfulPrefix = (ip: string) => {
  const first = Number(ip.split('.')[0]);
  return first < 128 ? 8 : first < 192 ? 16 : 24;
};
const classful = (ip: string) => subnet(ip, classfulPrefix(ip)).network;
/** IOS accepts a wildcard or a subnet mask after "network" and stores the wildcard. */
function wildcardOf(value: string) {
  const n = ipNumber(value);
  const inverted = ~n >>> 0;
  const contiguousWildcard = ((n + 1) & n) === 0;
  if (contiguousWildcard) return value;
  if (((inverted + 1) & inverted) === 0) return ipString(inverted);
  throw new Error('Invalid wildcard mask ' + value);
}
function stubOf(words: string): EigrpStub {
  const list = words.toLowerCase().split(/\s+/).filter(Boolean);
  const stub = {
    connected: list.includes('connected'),
    summary: list.includes('summary'),
    static: list.includes('static'),
    redistributed: list.includes('redistributed'),
    receiveOnly: list.includes('receive-only'),
  };
  if (stub.receiveOnly && list.length > 1)
    throw new Error('receive-only cannot be combined with other options.');
  // "eigrp stub" alone advertises connected and summary routes.
  if (!list.length) return { ...stub, connected: true, summary: true };
  return stub;
}
const stubWords = (s: EigrpStub) =>
  s.receiveOnly
    ? 'receive-only'
    : (['connected', 'summary', 'static', 'redistributed'] as const).filter((k) => s[k]).join(' ');
function interfaceConfig(config: Config, port: string) {
  let entry = config.interfaces.find((i) => i.port === port);
  if (!entry) {
    entry = { port, summaries: [], splitHorizon: true };
    config.interfaces.push(entry);
  }
  return entry;
}
/** Drops interface entries that only hold defaults. */
function prune(config: Config) {
  config.interfaces = config.interfaces.filter(
    (i) =>
      i.helloMs !== undefined ||
      i.holdMs !== undefined ||
      i.summaries.length ||
      i.authenticationMode ||
      i.keyChain ||
      i.splitHorizon === false
  );
}
function asnFor(d: Device, value: string) {
  const asn = Number(value);
  if (!Number.isInteger(asn) || asn < 1 || asn > 65535) throw new Error('EIGRP AS number is 1-65535.');
  if (d.eigrp && d.eigrp.asn !== asn && (d.eigrp.enabled || d.eigrp.networks.length))
    throw new Error(`EIGRP AS ${d.eigrp.asn} is configured; this device runs one EIGRP process.`);
  return asn;
}
const metricOf = (m: string[]) => {
  const [bandwidth, delay, reliability, load, mtu] = m.map(Number);
  if (!(bandwidth >= 1) || !(delay >= 0) || reliability > 255 || !(load >= 1 && load <= 255) || !(mtu >= 1))
    throw new Error('Metric: bandwidth (kbit/s) delay (tens of usec) reliability (0-255) load (1-255) MTU.');
  return { bandwidth, delay, reliability, load, mtu };
};

// --- show views ---------------------------------------------------------------------------------
function showNeighbors(e: SimulationEngine, d: Device, detail: boolean) {
  const s = d.eigrp;
  if (!s?.enabled) return '';
  const now = e.state.clock;
  const rows = s.neighbors.flatMap((n, i) => {
    const port = d.interfaces.find((p) => p.id === n.port);
    const row =
      String(i).padEnd(4) +
      n.address.padEnd(24) +
      shortInterfaceName(port?.name ?? n.port).padEnd(23) +
      String(Math.max(0, Math.floor((n.expiresAt - now) / 1000))).padStart(4) +
      ' ' +
      clock(now - n.upAt).padEnd(8) +
      String(n.srtt).padStart(5) +
      String(Math.min(5000, Math.max(100, n.srtt * 6))).padStart(6) +
      String(n.pending.length).padStart(3) +
      '  ' +
      n.sequence;
    if (!detail) return [row];
    const prefixes = s.topology.filter((t) => t.via.some((v) => v.address === n.address)).length;
    return [
      row,
      `   Version 23.0/2.0, Retrans: ${n.pending.reduce((x, p) => x + p.retries, 0)}, Retries: ${n.pending[0]?.retries ?? 0}, Prefixes: ${prefixes}`,
      '   Topology-ids from peer - 0',
      ...(n.stub
        ? [`   Stub Peer Advertising (${stubWords(n.stub).toUpperCase()} ) Routes`, '   Suppressing queries']
        : []),
    ];
  });
  return [
    `EIGRP-IPv4 Neighbors for AS(${s.asn})`,
    'H   Address                 Interface              Hold Uptime   SRTT   RTO  Q  Seq',
    '                                                   (sec)         (ms)       Cnt Num',
    ...rows,
  ].join('\n');
}
function showTopology(e: SimulationEngine, d: Device, allLinks: boolean) {
  const s = d.eigrp;
  if (!s?.enabled) return '';
  const view = eigrpTopologyView(d).sort(
    (a, b) => ipNumber(a.entry.network) - ipNumber(b.entry.network) || a.entry.prefix - b.entry.prefix
  );
  const lines = [
    `EIGRP-IPv4 Topology Table for AS(${s.asn})/ID(${eigrpRouterId(d)})`,
    'Codes: P - Passive, A - Active, U - Update, Q - Query, R - Reply,',
    '       r - reply Status, s - sia Status ',
    '',
  ];
  for (const { entry, successors, scored, fd } of view) {
    const active = entry.state === 'active';
    lines.push(
      `${active ? 'A' : 'P'} ${entry.network}/${entry.prefix}, ${successors} successors, FD is ${fd >= EIGRP.infinity ? 'Inaccessible' : fd}`
    );
    if (active)
      lines.push(
        `    ${entry.replies.length} replies, active ${clock(e.state.clock - (entry.activeAt ?? e.state.clock))}, query-origin: ${entry.origin ? 'Successor Origin' : 'Local origin'}`
      );
    const local = entry.local;
    if (local) {
      const metric = eigrpMetric(local.vector, s.k);
      lines.push(
        local.kind === 'connected'
          ? `        via Connected, ${longInterfaceName(d.interfaces.find((p) => p.id === local.port)?.name ?? '')}`
          : local.kind === 'summary'
            ? `        via Summary (${metric}/0), Null0`
            : `        via R${local.external?.protocol ?? 'static'} (${metric}/0)`
      );
    }
    for (const x of scored
      .filter((x) => allLinks || x.reported < fd || active)
      .sort((a, b) => a.distance - b.distance || ipNumber(a.via.address) - ipNumber(b.via.address)))
      lines.push(
        `        via ${x.via.address} (${x.distance}/${x.reported})${entry.replies.includes(x.via.address) ? ', r' : ''}, ${longInterfaceName(x.port.name)}`
      );
  }
  return lines.join('\n');
}
function showInterfaces(e: SimulationEngine, d: Device, detail: boolean) {
  const s = d.eigrp;
  if (!s?.enabled) return '';
  const ports = eigrpPorts(d).filter((p) => !eigrpPassive(s, p.id) && p.adminUp);
  const lines = [
    `EIGRP-IPv4 Interfaces for AS(${s.asn})`,
    '                              Xmit Queue   PeerQ        Mean   Pacing Time   Multicast    Pending',
    'Interface              Peers  Un/Reliable  Un/Reliable  SRTT   Un/Reliable   Flow Timer   Routes',
  ];
  for (const p of ports) {
    const peers = s.neighbors.filter((n) => n.port === p.id);
    const srtt = peers.length ? Math.round(peers.reduce((x, n) => x + n.srtt, 0) / peers.length) : 0;
    const pending = peers.reduce((x, n) => x + n.pending.length, 0);
    lines.push(
      shortInterfaceName(p.name).padEnd(23) +
        String(peers.length).padStart(5) +
        `${'0/' + pending}`.padStart(12) +
        '0/0'.padStart(10) +
        String(srtt).padStart(12) +
        '0/0'.padStart(10) +
        String(peers.length ? 50 : 0).padStart(14) +
        String(pending).padStart(12)
    );
    if (detail) {
      const config = eigrpInterface(s, p.id);
      const keyChain = eigrpKeyChain(s, p.id);
      lines.push(
        `  Hello-interval is ${eigrpHelloMs(s, p.id) / 1000}, Hold-time is ${eigrpHoldMs(s, p.id) / 1000}`,
        `  Split-horizon is ${config?.splitHorizon === false ? 'disabled' : 'enabled'}`,
        '  Next xmit serial <none>',
        `  Hello's sent/expedited: ${s.counters.helloSent}/0`,
        `  Retransmissions sent: ${peers.reduce((x, n) => x + n.pending.reduce((y, q) => y + q.retries, 0), 0)}  Out-of-sequence rcvd: 0`,
        '  Topology-ids on interface - 0',
        keyChain
          ? `  Authentication mode is md5,  key-chain is "${keyChain}"`
          : '  Authentication mode is not set'
      );
    }
  }
  return lines.join('\n');
}
function showTraffic(d: Device) {
  const s = d.eigrp;
  if (!s?.enabled) return '';
  const c = s.counters;
  return [
    `EIGRP-IPv4 Traffic Statistics for AS(${s.asn})`,
    `  Hellos sent/received: ${c.helloSent}/${c.helloReceived}`,
    `  Updates sent/received: ${c.updateSent}/${c.updateReceived}`,
    `  Queries sent/received: ${c.querySent}/${c.queryReceived}`,
    `  Replies sent/received: ${c.replySent}/${c.replyReceived}`,
    `  Acks sent/received: ${c.ackSent}/${c.ackReceived}`,
    '  SIA-Queries sent/received: 0/0',
    '  SIA-Replies sent/received: 0/0',
    '  Hello Process ID: 112',
    '  PDM Process ID: 110',
  ].join('\n');
}
/** "show ip protocols" section of the EIGRP process. */
export function eigrpProtocolsSection(d: Device) {
  const s = d.eigrp;
  if (!s?.enabled) return [];
  const passive = d.interfaces.filter((p) => eigrpPorts(d).includes(p) && eigrpPassive(s, p.id));
  return [
    `Routing Protocol is "eigrp ${s.asn}"`,
    '  Outgoing update filter list for all interfaces is not set',
    '  Incoming update filter list for all interfaces is not set',
    '  Default networks flagged in outgoing updates',
    '  Default networks accepted from incoming updates',
    ...s.redistribute.map((r) => `  Redistributing: ${r.source}${r.process ? ' ' + r.process : ''}`),
    `  EIGRP-IPv4 Protocol for AS(${s.asn})`,
    `    Metric weight K1=${s.k[0]}, K2=${s.k[1]}, K3=${s.k[2]}, K4=${s.k[3]}, K5=${s.k[4]}`,
    '    Soft SIA disabled',
    '    NSF-aware route hold timer is 240',
    `    Router-ID: ${eigrpRouterId(d)}`,
    ...(s.stub ? [`    EIGRP stub, ${stubWords(s.stub)}`] : []),
    '    Topology : 0 (base) ',
    '      Active Timer: 3 min',
    `      Distance: internal ${s.distance?.internal ?? EIGRP.internalDistance} external ${s.distance?.external ?? EIGRP.externalDistance}`,
    `      Maximum path: ${s.maximumPaths}`,
    '      Maximum hopcount 100',
    `      Maximum metric variance ${s.variance}`,
    '',
    '  Automatic Summarization: disabled',
    `  Maximum path: ${s.maximumPaths}`,
    '  Routing for Networks:',
    ...s.networks.map(
      (n) =>
        '    ' +
        n.network +
        '/' +
        (n.wildcard ? 32 - Math.log2(ipNumber(n.wildcard) + 1) : classfulPrefix(n.network))
    ),
    ...(passive.length
      ? ['  Passive Interface(s):', ...passive.map((p) => '    ' + longInterfaceName(p.name))]
      : []),
    '  Routing Information Sources:',
    '    Gateway         Distance      Last Update',
    ...[...new Set(s.topology.flatMap((t) => t.via.map((v) => v.address)))].map(
      (a) => '    ' + a.padEnd(16) + String(s.distance?.internal ?? EIGRP.internalDistance).padEnd(14)
    ),
    `  Distance: internal ${s.distance?.internal ?? EIGRP.internalDistance} external ${s.distance?.external ?? EIGRP.externalDistance}`,
  ];
}

// --- running-config -------------------------------------------------------------------------------
export function eigrpRunningConfig(d: Device) {
  const s = d.eigrp;
  if (!s) return [];
  const name = (id: string) => d.interfaces.find((p) => p.id === id)?.name ?? id;
  const metric = (m: NonNullable<Config['defaultMetric']>) =>
    `${m.bandwidth} ${m.delay} ${m.reliability} ${m.load} ${m.mtu}`;
  return [
    ...(s.enabled
      ? [
          'router eigrp ' + s.asn,
          ...(s.k.join() !== '1,0,1,0,0' ? [' metric weights 0 ' + s.k.join(' ')] : []),
          ...(s.variance !== 1 ? [' variance ' + s.variance] : []),
          ...s.networks.map((n) => ' network ' + n.network + (n.wildcard ? ' ' + n.wildcard : '')),
          ...(s.defaultMetric ? [' default-metric ' + metric(s.defaultMetric)] : []),
          ...s.redistribute.map(
            (r) =>
              ' redistribute ' +
              r.source +
              (r.process !== undefined ? ' ' + r.process : '') +
              (r.metric ? ' metric ' + metric(r.metric) : '') +
              (r.routeMap ? ' route-map ' + r.routeMap : '')
          ),
          ...(s.passiveDefault ? [' passive-interface default'] : []),
          ...s.passive.map((p) => (s.passiveDefault ? ' no' : '') + ' passive-interface ' + name(p)),
          ...(s.distance ? [` distance eigrp ${s.distance.internal} ${s.distance.external}`] : []),
          ...(s.maximumPaths !== 4 ? [' maximum-paths ' + s.maximumPaths] : []),
          ...(s.routerId ? [' eigrp router-id ' + s.routerId] : []),
          ...(s.stub ? [' eigrp stub ' + stubWords(s.stub)] : []),
          'exit',
        ]
      : []),
    ...s.interfaces.flatMap((i) => [
      'interface ' + name(i.port),
      ...(i.helloMs !== undefined ? [` ip hello-interval eigrp ${s.asn} ${i.helloMs / 1000}`] : []),
      ...(i.holdMs !== undefined ? [` ip hold-time eigrp ${s.asn} ${i.holdMs / 1000}`] : []),
      ...(i.splitHorizon === false ? [` no ip split-horizon eigrp ${s.asn}`] : []),
      ...i.summaries.map(
        (sum) => ` ip summary-address eigrp ${s.asn} ${sum.network} ${ipString(mask(sum.prefix))}`
      ),
      ...(i.authenticationMode ? [` ip authentication mode eigrp ${s.asn} md5`] : []),
      ...(i.keyChain ? [` ip authentication key-chain eigrp ${s.asn} ${i.keyChain}`] : []),
      'exit',
    ]),
  ];
}

// --- commands -----------------------------------------------------------------------------------
export function registerEigrpCommands(r: CommandRegistry) {
  r.register({
    pattern: /^(no )?router eigrp (\d+)$/i,
    syntax: ['router eigrp <as-number>', 'no router eigrp <as-number>'],
    modes: CONFIG_MODES,
    run: (m, e, d, c) => {
      const asn = Number(m[2]);
      if (m[1]) {
        if (!d.eigrp || d.eigrp.asn !== asn) throw new Error(`EIGRP AS ${asn} is not configured.`);
        removeEigrp(e, d);
        return '';
      }
      asnFor(d, m[2]);
      if (!d.eigrp?.enabled) save(e, d, { ...current(d, asn), asn, enabled: true });
      c.mode = 'router';
      c.router = 'eigrp';
      c.process = asn;
      return '';
    },
  });
  r.register({
    pattern: /^(no )?network ([\d.]+)(?: ([\d.]+))?$/i,
    syntax: ['network <address>', 'network <address> <wildcard>', 'no network <address> <wildcard>'],
    modes: ['router'],
    available: inEigrp,
    run: (m, e, d) => {
      const config = current(d);
      const wildcard = m[3] ? wildcardOf(m[3]) : undefined;
      const network = wildcard ? ipString((ipNumber(m[2]) & ~ipNumber(wildcard)) >>> 0) : classful(m[2]);
      config.networks = config.networks.filter((n) => !(n.network === network && n.wildcard === wildcard));
      if (!m[1]) config.networks.push({ network, ...(wildcard ? { wildcard } : {}) });
      save(e, d, config);
      return '';
    },
  });
  r.register({
    pattern: /^(no )?passive-interface (default|.+)$/i,
    syntax: [
      'passive-interface default',
      'passive-interface <interface...>',
      'no passive-interface <interface...>',
    ],
    modes: ['router'],
    available: inEigrp,
    run: (m, e, d) => {
      const config = current(d);
      if (m[2].toLowerCase() === 'default') {
        config.passiveDefault = !m[1];
        config.passive = [];
      } else {
        const p = findInterface(d, m[2]);
        if (!p) throw new Error('Invalid interface ' + m[2]);
        // After "passive-interface default" the list holds the exceptions.
        const listed = config.passiveDefault ? !!m[1] : !m[1];
        config.passive = config.passive.filter((id) => id !== p.id);
        if (listed) config.passive.push(p.id);
      }
      save(e, d, config);
      return '';
    },
  });
  r.register({
    pattern: /^(no )?eigrp router-id(?: ([\d.]+))?$/i,
    syntax: ['eigrp router-id <address>', 'no eigrp router-id'],
    modes: ['router'],
    available: inEigrp,
    run: (m, e, d) => {
      const config = current(d);
      if (m[1]) delete config.routerId;
      else if (!m[2]) throw new Error('Incomplete command.');
      else {
        ipNumber(m[2]);
        if (m[2] === '0.0.0.0' || m[2] === '255.255.255.255') throw new Error('Invalid router ID ' + m[2]);
        config.routerId = m[2];
      }
      save(e, d, config);
      return '';
    },
  });
  r.register({
    pattern: /^(no )?eigrp stub((?: (?:receive-only|connected|summary|static|redistributed))*)$/i,
    syntax: ['eigrp stub', 'eigrp stub connected summary', 'eigrp stub receive-only', 'no eigrp stub'],
    modes: ['router'],
    available: inEigrp,
    run: (m, e, d) => {
      const config = current(d);
      if (m[1]) delete config.stub;
      else config.stub = stubOf(m[2]);
      save(e, d, config);
      return '';
    },
  });
  r.register({
    pattern: /^(no )?eigrp log-neighbor-changes$/i,
    modes: ['router'],
    available: inEigrp,
    run: () => '',
  });
  r.register({
    pattern: /^(no )?auto-summary$/i,
    syntax: ['no auto-summary'],
    modes: ['router'],
    available: inEigrp,
    run: (m) => {
      if (!m[1])
        throw new Error(
          'Automatic summarization is not supported; use "ip summary-address eigrp" on the interface.'
        );
      return '';
    },
  });
  r.register({
    pattern: /^(no )?variance(?: (\d+))?$/i,
    syntax: ['variance <multiplier>', 'no variance'],
    modes: ['router'],
    available: inEigrp,
    run: (m, e, d) => {
      const config = current(d);
      config.variance = m[1] ? 1 : Number(m[2] ?? NaN);
      if (!(config.variance >= 1 && config.variance <= 128)) throw new Error('Variance is 1-128.');
      save(e, d, config);
      return '';
    },
  });
  r.register({
    pattern: /^(no )?maximum-paths(?: (\d+))?$/i,
    syntax: ['maximum-paths <1-32>', 'no maximum-paths'],
    modes: ['router'],
    available: inEigrp,
    run: (m, e, d) => {
      const config = current(d);
      config.maximumPaths = m[1] ? 4 : Number(m[2] ?? NaN);
      if (!(config.maximumPaths >= 1 && config.maximumPaths <= 32)) throw new Error('maximum-paths is 1-32.');
      save(e, d, config);
      return '';
    },
  });
  r.register({
    pattern: /^(no )?metric weights(?: 0 (\d+) (\d+) (\d+) (\d+) (\d+))?$/i,
    syntax: ['metric weights 0 <k1> <k2> <k3> <k4> <k5>', 'no metric weights'],
    modes: ['router'],
    available: inEigrp,
    run: (m, e, d) => {
      const config = current(d);
      if (m[1]) config.k = [1, 0, 1, 0, 0];
      else if (!m[2]) throw new Error('Incomplete command.');
      else config.k = m.slice(2, 7).map(Number);
      if (config.k.some((k) => k > 255)) throw new Error('K values are 0-255.');
      save(e, d, config);
      return '';
    },
  });
  r.register({
    pattern: /^(no )?distance eigrp(?: (\d+) (\d+))?$/i,
    syntax: ['distance eigrp <internal> <external>', 'no distance eigrp'],
    modes: ['router'],
    available: inEigrp,
    run: (m, e, d) => {
      const config = current(d);
      if (m[1]) delete config.distance;
      else if (!m[2]) throw new Error('Incomplete command.');
      else config.distance = { internal: Number(m[2]), external: Number(m[3]) };
      if (
        config.distance &&
        [config.distance.internal, config.distance.external].some((x) => x < 1 || x > 255)
      )
        throw new Error('Distance is 1-255.');
      save(e, d, config);
      return '';
    },
  });
  r.register({
    pattern: /^(no )?default-metric(?: (\d+) (\d+) (\d+) (\d+) (\d+))?$/i,
    syntax: ['default-metric <bandwidth> <delay> <reliability> <load> <mtu>', 'no default-metric'],
    modes: ['router'],
    available: inEigrp,
    run: (m, e, d) => {
      const config = current(d);
      if (m[1]) delete config.defaultMetric;
      else if (!m[2]) throw new Error('Incomplete command.');
      else config.defaultMetric = metricOf(m.slice(2, 7));
      save(e, d, config);
      return '';
    },
  });
  r.register({
    pattern:
      /^(no )?redistribute (static|connected|rip|ospf|bgp)(?: (\d+))?(?: metric (\d+) (\d+) (\d+) (\d+) (\d+))?(?: route-map ([\w-]{1,64}))?$/i,
    syntax: [
      'redistribute static',
      'redistribute connected',
      'redistribute ospf <process> metric <bandwidth> <delay> <reliability> <load> <mtu>',
      'redistribute bgp <as> metric <bandwidth> <delay> <reliability> <load> <mtu>',
      'no redistribute <source>',
    ],
    modes: ['router'],
    available: inEigrp,
    run: (m, e, d) => {
      const config = current(d);
      const source = m[2].toLowerCase() as Config['redistribute'][number]['source'];
      if ((source === 'ospf' || source === 'bgp') && !m[3]) throw new Error('Incomplete command.');
      const process = m[3] ? Number(m[3]) : undefined;
      config.redistribute = config.redistribute.filter(
        (x) => !(x.source === source && x.process === process)
      );
      if (!m[1])
        config.redistribute.push({
          source,
          ...(process !== undefined ? { process } : {}),
          ...(m[4] ? { metric: metricOf(m.slice(4, 9)) } : {}),
          ...(m[9] ? { routeMap: m[9] } : {}),
        });
      save(e, d, config);
      return '';
    },
  });
  // Interface commands carry the AS number and may precede "router eigrp".
  const perInterface = (
    d: Device,
    c: Context,
    asnText: string,
    change: (entry: Config['interfaces'][number], config: Config) => void
  ) => {
    const asn = asnFor(d, asnText),
      config = current(d, asn);
    // Settings typed before "router eigrp" belong to the AS they name.
    if (!config.enabled) config.asn = asn;
    change(interfaceConfig(config, currentPort(d, c).id), config);
    prune(config);
    return config;
  };
  r.register({
    pattern: /^(no )?ip (hello-interval|hold-time) eigrp (\d+)(?: (\d+))?$/i,
    syntax: [
      'ip hello-interval eigrp <as> <seconds>',
      'ip hold-time eigrp <as> <seconds>',
      'no ip hello-interval eigrp <as>',
      'no ip hold-time eigrp <as>',
    ],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const seconds = Number(m[4]);
      if (!m[1] && !(seconds >= 1 && seconds <= 65535)) throw new Error('Interval is 1-65535 seconds.');
      const field = m[2].toLowerCase() === 'hello-interval' ? 'helloMs' : 'holdMs';
      save(
        e,
        d,
        perInterface(d, c, m[3], (entry) => {
          if (m[1]) delete entry[field];
          else entry[field] = seconds * 1000;
        })
      );
      return '';
    },
  });
  r.register({
    pattern: /^(no )?ip split-horizon eigrp (\d+)$/i,
    syntax: ['ip split-horizon eigrp <as>', 'no ip split-horizon eigrp <as>'],
    modes: ['interface'],
    run: (m, e, d, c) => {
      save(
        e,
        d,
        perInterface(d, c, m[2], (entry) => (entry.splitHorizon = !m[1]))
      );
      return '';
    },
  });
  r.register({
    pattern: /^(no )?ip summary-address eigrp (\d+) ([\d.]+) ([\d.]+)(?: \d+)?$/i,
    syntax: [
      'ip summary-address eigrp <as> <address> <mask>',
      'no ip summary-address eigrp <as> <address> <mask>',
    ],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const prefix = parsePrefix(m[4]);
      if (subnet(m[3], prefix).network !== m[3])
        throw new Error('Invalid summary address ' + m[3] + ' ' + m[4]);
      save(
        e,
        d,
        perInterface(d, c, m[2], (entry) => {
          entry.summaries = entry.summaries.filter((s) => !(s.network === m[3] && s.prefix === prefix));
          if (!m[1]) entry.summaries.push({ network: m[3], prefix });
        })
      );
      return '';
    },
  });
  r.register({
    pattern: /^(no )?ip authentication (mode|key-chain) eigrp (\d+)(?: (\S+))?$/i,
    syntax: [
      'ip authentication mode eigrp <as> md5',
      'ip authentication key-chain eigrp <as> <key-chain>',
      'no ip authentication mode eigrp <as>',
      'no ip authentication key-chain eigrp <as>',
    ],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const mode = m[2].toLowerCase() === 'mode';
      if (!m[1] && !m[4]) throw new Error('Incomplete command.');
      if (mode && !m[1] && m[4].toLowerCase() !== 'md5')
        throw new Error('Only md5 authentication is supported.');
      save(
        e,
        d,
        perInterface(d, c, m[3], (entry) => {
          if (mode) {
            if (m[1]) delete entry.authenticationMode;
            else entry.authenticationMode = 'md5';
          } else if (m[1]) delete entry.keyChain;
          else entry.keyChain = m[4];
        })
      );
      return '';
    },
  });
  r.register({
    pattern: /^(no )?delay(?: (\d+))?$/i,
    syntax: ['delay <tens-of-microseconds>', 'no delay'],
    modes: ['interface'],
    run: (m, _e, d, c) => {
      const p = currentPort(d, c);
      if (m[1]) delete p.delayTens;
      else {
        const value = Number(m[2]);
        if (!(value >= 1 && value <= 16777215)) throw new Error('Delay is 1-16777215 tens of microseconds.');
        p.delayTens = value;
      }
      return '';
    },
  });
  r.register({
    pattern: /^show ip eigrp neighbors?(?: (detail))?$/i,
    syntax: ['show ip eigrp neighbors', 'show ip eigrp neighbors detail'],
    modes: ALL_MODES,
    run: (m, e, d) => showNeighbors(e, d, !!m[1]),
  });
  r.register({
    pattern: /^show ip eigrp topology(?: (all-links))?$/i,
    syntax: ['show ip eigrp topology', 'show ip eigrp topology all-links'],
    modes: ALL_MODES,
    run: (m, e, d) => showTopology(e, d, !!m[1]),
  });
  r.register({
    pattern: /^show ip eigrp interfaces(?: (detail))?$/i,
    syntax: ['show ip eigrp interfaces', 'show ip eigrp interfaces detail'],
    modes: ALL_MODES,
    run: (m, e, d) => showInterfaces(e, d, !!m[1]),
  });
  r.register({
    pattern: /^show ip eigrp traffic$/i,
    syntax: 'show ip eigrp traffic',
    modes: ALL_MODES,
    run: (_m, _e, d) => showTraffic(d),
  });
  r.register({
    pattern: /^clear ip eigrp(?: \d+)? neighbors(?: (.+))?$/i,
    syntax: ['clear ip eigrp neighbors', 'clear ip eigrp neighbors <address|interface>'],
    modes: ['privileged'],
    run: (m, e, d) => {
      const target = m[1]?.trim();
      const port = target && !/^[\d.]+$/.test(target) ? findInterface(d, target) : undefined;
      if (target && !/^[\d.]+$/.test(target) && !port) throw new Error('Invalid interface ' + target);
      clearEigrpNeighbors(e, d, (n) => !target || (port ? n.port === port.id : n.address === target));
      return '';
    },
  });
}
