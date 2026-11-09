import type { SimulationEngine } from '../core/engine';
import type { Device } from '../model';
import { ALL_MODES, CONFIG_MODES, currentPort, type CommandRegistry, type Context } from './registry';
import {
  clearOspf3Process,
  configureOspf3,
  ospf3Abr,
  ospf3Config,
  ospf3Cost,
  ospf3RouterId,
  removeOspf3,
} from '../protocols/ospf3';
import type { Ospf3Config, Ospf3Neighbor } from '../protocols/ospf3-model';
import { findInterface, longInterfaceName, shortInterfaceName } from '../protocols/interface-name';
import { ipNumber } from '../protocols/ipv4';

type Config = Ospf3Config;
const inOspf3 = (_d: Device, c: Context) => c.mode === 'router' && c.router === 'ospfv3';
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
};
function current(d: Device, processId?: number): Config {
  return (
    ospf3Config(d) ?? {
      enabled: false,
      processId: processId ?? 1,
      passiveDefault: false,
      passive: [],
      maximumPaths: 4,
      referenceBandwidth: 100,
      interfaces: [],
    }
  );
}
const save = (e: SimulationEngine, d: Device, config: Config) => configureOspf3(e, d, config);
function processFor(d: Device, value: string) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1 || id > 65535) throw new Error('% OSPFv3 process ID must be 1-65535');
  if (d.ospf3 && d.ospf3.processId !== id && (d.ospf3.enabled || d.ospf3.interfaces.length))
    throw new Error(`% OSPFv3 process ${d.ospf3.processId} is already running on this router`);
  return id;
}
function requireRouting(d: Device) {
  if (d.type === 'switch' && !d.ipRouting) throw new Error('% IPv6 routing not enabled');
  if (!d.ipv6Routing) throw new Error('% IPv6 routing not enabled');
}
const areaOf = (text: string) => {
  const area = text.includes('.') ? ipNumber(text) : Number(text);
  if (!Number.isInteger(area) || area < 0 || area > 4294967295) throw new Error('% Invalid area ID ' + text);
  return area;
};
const areaText = (area: number) => String(area);
const header = (d: Device) =>
  `          OSPFv3 ${d.ospf3!.processId} address-family ipv6 (router-id ${ospf3RouterId(d) ?? '0.0.0.0'})`;

// --- show views -----------------------------------------------------------------------------------
function role(d: Device, n: Ospf3Neighbor) {
  const runtime = d.ospf3!.ports.find((r) => r.port === n.port);
  const c = d.ospf3!.interfaces.find((i) => i.port === n.port);
  if (c?.networkType === 'point-to-point') return '-';
  return n.routerId === runtime?.dr ? 'DR' : n.routerId === runtime?.bdr ? 'BDR' : 'DROTHER';
}
function showNeighbors(e: SimulationEngine, d: Device) {
  const s = d.ospf3;
  if (!s?.enabled) return '';
  return [
    '',
    header(d),
    '',
    'Neighbor ID     Pri   State           Dead Time   Interface ID    Interface',
    ...s.neighbors.map(
      (n) =>
        n.routerId.padEnd(16) +
        String(n.priority).padStart(3) +
        '   ' +
        (n.state + '/' + role(d, n)).padEnd(16) +
        clock(n.deadAt - e.state.clock).padEnd(12) +
        String(n.interfaceId).padEnd(16) +
        longInterfaceName(d.interfaces.find((p) => p.id === n.port)?.name ?? n.port)
    ),
  ].join('\n');
}
function showInterfaceBrief(d: Device) {
  const s = d.ospf3;
  if (!s?.enabled) return '';
  const rid = ospf3RouterId(d);
  return [
    'Interface    PID   Area            Intf ID    Cost  State Nbrs F/C',
    ...s.interfaces.flatMap((c) => {
      const p = d.interfaces.find((x) => x.id === c.port);
      if (!p) return [];
      const runtime = s.ports.find((r) => r.port === p.id);
      const state = !runtime?.operational
        ? 'DOWN'
        : p.loopback
          ? 'LOOP'
          : c.networkType === 'point-to-point'
            ? 'P2P'
            : runtime.dr === '0.0.0.0'
              ? 'WAIT'
              : runtime.dr === rid
                ? 'DR'
                : runtime.bdr === rid
                  ? 'BDR'
                  : 'DROTH';
      const neighbors = s.neighbors.filter((n) => n.port === p.id);
      return [
        shortInterfaceName(p.name).padEnd(13) +
          String(s.processId).padEnd(6) +
          areaText(c.area).padEnd(16) +
          String(d.interfaces.indexOf(p) + 1).padEnd(11) +
          String(ospf3Cost(s, p)).padEnd(6) +
          state.padEnd(6) +
          `${neighbors.filter((n) => n.state === 'FULL').length}/${neighbors.length}`,
      ];
    }),
  ].join('\n');
}
function showProcess(d: Device) {
  const s = d.ospf3;
  if (!s?.enabled) return '';
  const areas = [...new Set(s.interfaces.map((i) => i.area))].sort((a, b) => a - b);
  return [
    ` OSPFv3 ${s.processId} address-family ipv6`,
    ` Router ID ${ospf3RouterId(d) ?? '0.0.0.0'}`,
    ...(ospf3Abr(s) ? [' It is an area border router'] : []),
    ` Number of areas in this router is ${areas.length}. ${areas.length} normal 0 stub 0 nssa`,
    ` Reference bandwidth unit is ${s.referenceBandwidth} mbps`,
    ...(s.maximumPaths !== 4 ? [` Maximum number of paths ${s.maximumPaths}`] : []),
    ...areas.flatMap((a) => [
      `    Area ${a === 0 ? 'BACKBONE(0)' : a}`,
      `        Number of interfaces in this area is ${s.interfaces.filter((i) => i.area === a).length}`,
    ]),
  ].join('\n');
}
function showDatabase(e: SimulationEngine, d: Device) {
  const s = d.ospf3;
  if (!s?.enabled) return '';
  const lines = ['', header(d)];
  const titles = {
    router: 'Router Link States',
    prefix: 'Intra Area Prefix Link States',
    'inter-prefix': 'Inter Area Prefix Link States',
  } as const;
  for (const area of [...new Set(s.lsdb.map((l) => l.area))].sort((a, b) => a - b))
    for (const type of ['router', 'inter-prefix', 'prefix'] as const) {
      const list = s.lsdb
        .filter((l) => l.area === area && l.type === type && !l.flushed)
        .sort((a, b) => ipNumber(a.advertisingRouter) - ipNumber(b.advertisingRouter) || a.id - b.id);
      if (!list.length) continue;
      lines.push(
        '',
        `                ${titles[type]} (Area ${area})`,
        '',
        type === 'router'
          ? 'ADV Router       Age         Seq#        Fragment ID  Link count  Bits'
          : type === 'prefix'
            ? 'ADV Router       Age         Seq#        Link ID    Ref-lstype  Ref-LSID'
            : 'ADV Router       Age         Seq#        Prefix',
        ...list.flatMap((l) => {
          const age = String(Math.min(3600, Math.floor((e.state.clock - l.originatedAt) / 1000)));
          const seq = '0x' + ((0x80000000 + l.sequence) >>> 0).toString(16).toUpperCase();
          const row = l.advertisingRouter.padEnd(17) + age.padEnd(12) + seq.padEnd(12);
          if (type === 'router')
            return [
              row +
                String(l.id).padEnd(13) +
                String(l.links.length).padEnd(12) +
                (s.lsdb.some(
                  (x) =>
                    x.type === 'inter-prefix' && x.advertisingRouter === l.advertisingRouter && !x.flushed
                )
                  ? 'B'
                  : 'None'),
            ];
          if (type === 'prefix') return [row + String(l.id).padEnd(11) + '0x2001'.padEnd(12) + '0'];
          return l.prefixes.map((x) => row + `${x.network.toUpperCase()}/${x.prefix}`);
        })
      );
    }
  return lines.join('\n');
}

// --- running-config -------------------------------------------------------------------------------
export function ospf3RunningConfig(d: Device) {
  const s = d.ospf3;
  if (!s) return [];
  const name = (id: string) => d.interfaces.find((p) => p.id === id)?.name ?? id;
  return [
    ...s.interfaces.flatMap((i) => [
      'interface ' + name(i.port),
      ` ipv6 ospf ${s.processId} area ${areaText(i.area)}`,
      ...(i.cost !== undefined ? [' ipv6 ospf cost ' + i.cost] : []),
      ...(i.priority !== 1 ? [' ipv6 ospf priority ' + i.priority] : []),
      ...(i.networkType === 'point-to-point' ? [' ipv6 ospf network point-to-point'] : []),
      ...(i.helloMs !== 10000 ? [' ipv6 ospf hello-interval ' + i.helloMs / 1000] : []),
      ...(i.deadMs !== i.helloMs * 4 ? [' ipv6 ospf dead-interval ' + i.deadMs / 1000] : []),
      'exit',
    ]),
    ...(s.enabled
      ? [
          'ipv6 router ospf ' + s.processId,
          ...(s.routerId ? [' router-id ' + s.routerId] : []),
          ...(s.referenceBandwidth !== 100 ? [' auto-cost reference-bandwidth ' + s.referenceBandwidth] : []),
          ...(s.passiveDefault ? [' passive-interface default'] : []),
          ...s.passive.map((p) => (s.passiveDefault ? ' no' : '') + ' passive-interface ' + name(p)),
          ...(s.maximumPaths !== 4 ? [' maximum-paths ' + s.maximumPaths] : []),
          'exit',
        ]
      : []),
  ];
}

// --- commands -------------------------------------------------------------------------------------
export function registerOspf3Commands(r: CommandRegistry) {
  r.register({
    pattern: /^(no )?ipv6 router ospf (\d+)$/i,
    syntax: ['ipv6 router ospf <process-id>', 'no ipv6 router ospf <process-id>'],
    modes: CONFIG_MODES,
    run: (m, e, d, c) => {
      const id = Number(m[2]);
      if (m[1]) {
        if (d.ospf3?.processId === id) removeOspf3(e, d);
        return '';
      }
      requireRouting(d);
      processFor(d, m[2]);
      if (!d.ospf3?.enabled) save(e, d, { ...current(d, id), processId: id, enabled: true });
      c.mode = 'router';
      c.router = 'ospfv3';
      c.process = id;
      return '';
    },
  });
  r.register({
    pattern: /^(no )?router-id(?: ([\d.]+))?$/i,
    syntax: ['router-id <address>', 'no router-id'],
    modes: ['router'],
    available: inOspf3,
    run: (m, e, d) => {
      const config = current(d);
      if (m[1]) delete config.routerId;
      else if (!m[2]) throw new Error('% Incomplete command.');
      else {
        ipNumber(m[2]);
        config.routerId = m[2];
      }
      save(e, d, config);
      return '';
    },
  });
  r.register({
    pattern: /^(no )?passive-interface (default|.+)$/i,
    syntax: ['passive-interface default', 'passive-interface <interface>'],
    modes: ['router'],
    available: inOspf3,
    run: (m, e, d) => {
      const config = current(d);
      if (m[2].toLowerCase() === 'default') {
        config.passiveDefault = !m[1];
        config.passive = [];
      } else {
        const p = findInterface(d, m[2]);
        if (!p) throw new Error('% Invalid input detected at interface ' + m[2]);
        const listed = config.passiveDefault ? !!m[1] : !m[1];
        config.passive = config.passive.filter((id) => id !== p.id);
        if (listed) config.passive.push(p.id);
      }
      save(e, d, config);
      return '';
    },
  });
  r.register({
    pattern: /^(no )?(maximum-paths|auto-cost reference-bandwidth)(?: (\d+))?$/i,
    syntax: ['maximum-paths <1-32>', 'auto-cost reference-bandwidth <1-4294967>'],
    modes: ['router'],
    available: inOspf3,
    run: (m, e, d) => {
      const config = current(d),
        paths = m[2].toLowerCase() === 'maximum-paths';
      const value = m[1] ? (paths ? 4 : 100) : Number(m[3] ?? NaN);
      if (paths ? !(value >= 1 && value <= 32) : !(value >= 1 && value <= 4294967))
        throw new Error('% Invalid input detected: ' + (m[3] ?? ''));
      if (paths) config.maximumPaths = value;
      else config.referenceBandwidth = value;
      save(e, d, config);
      return '';
    },
  });
  r.register({
    pattern: /^(no )?log-adjacency-changes(?: detail)?$/i,
    syntax: 'log-adjacency-changes [detail]',
    modes: ['router'],
    available: inOspf3,
    run: () => '',
  });
  r.register({
    pattern: /^(no )?ipv6 ospf (\d+) area ([\d.]+)$/i,
    syntax: ['ipv6 ospf <process-id> area <area-id>', 'no ipv6 ospf <process-id> area <area-id>'],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c),
        config = current(d, Number(m[2])),
        old = config.interfaces.find((i) => i.port === p.id);
      if (m[1]) {
        if (!old || config.processId !== Number(m[2])) return '';
        config.interfaces = config.interfaces.filter((i) => i !== old);
        save(e, d, config);
        return '';
      }
      requireRouting(d);
      const id = processFor(d, m[2]);
      // Accepted before IPv6 is enabled (pasted configurations come in any order); the interface
      // joins OSPFv3 once it has a link-local address.
      // Like IOS, the interface command starts the process when it does not exist yet.
      config.enabled = true;
      config.processId = id;
      config.interfaces = [
        ...config.interfaces.filter((i) => i !== old),
        {
          port: p.id,
          area: areaOf(m[3]),
          ...(old?.cost !== undefined ? { cost: old.cost } : {}),
          priority: old?.priority ?? 1,
          networkType: old?.networkType ?? 'broadcast',
          helloMs: old?.helloMs ?? 10000,
          deadMs: old?.deadMs ?? 40000,
        },
      ];
      save(e, d, config);
      return '';
    },
  });
  r.register({
    pattern: /^(no )?ipv6 ospf (cost|priority|hello-interval|dead-interval)(?: (\d+))?$/i,
    syntax: [
      'ipv6 ospf cost <1-65535>',
      'ipv6 ospf priority <0-255>',
      'ipv6 ospf hello-interval <1-65535>',
      'ipv6 ospf dead-interval <1-65535>',
    ],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c),
        config = current(d),
        entry = config.interfaces.find((i) => i.port === p.id);
      if (!entry)
        throw new Error('% OSPFv3: enable "ipv6 ospf <process> area <area>" on the interface first');
      const field = m[2].toLowerCase(),
        value = Number(m[3] ?? NaN);
      if (!m[1] && !Number.isInteger(value)) throw new Error('% Incomplete command.');
      const range = {
        cost: [1, 65535],
        priority: [0, 255],
        'hello-interval': [1, 65535],
        'dead-interval': [1, 65535],
      }[field]!;
      if (!m[1] && (value < range[0] || value > range[1]))
        throw new Error('% Invalid input detected: ' + m[3]);
      if (field === 'cost') {
        if (m[1]) delete entry.cost;
        else entry.cost = value;
      } else if (field === 'priority') entry.priority = m[1] ? 1 : value;
      else if (field === 'hello-interval') {
        const fourHellos = entry.deadMs === entry.helloMs * 4;
        entry.helloMs = m[1] ? 10000 : value * 1000;
        // IOS keeps the dead interval at four hellos unless it was set.
        if (fourHellos) entry.deadMs = entry.helloMs * 4;
      } else entry.deadMs = m[1] ? entry.helloMs * 4 : value * 1000;
      save(e, d, config);
      return '';
    },
  });
  r.register({
    pattern: /^(no )?ipv6 ospf network (point-to-point|broadcast)$/i,
    syntax: ['ipv6 ospf network point-to-point', 'ipv6 ospf network broadcast'],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c),
        config = current(d),
        entry = config.interfaces.find((i) => i.port === p.id);
      if (!entry)
        throw new Error('% OSPFv3: enable "ipv6 ospf <process> area <area>" on the interface first');
      entry.networkType = m[1] ? 'broadcast' : (m[2].toLowerCase() as 'broadcast' | 'point-to-point');
      save(e, d, config);
      return '';
    },
  });
  r.register({
    pattern: /^clear ipv6 ospf(?: \d+)? process$/i,
    syntax: 'clear ipv6 ospf [process-id] process',
    modes: ['privileged'],
    run: (_m, e, d) => {
      clearOspf3Process(e, d);
      return '';
    },
  });
  r.register({
    pattern: /^show ipv6 ospf neighbors?$/i,
    syntax: 'show ipv6 ospf neighbor',
    modes: ALL_MODES,
    run: (_m, e, d) => showNeighbors(e, d),
  });
  r.register({
    pattern: /^show ipv6 ospf interface brief$/i,
    syntax: 'show ipv6 ospf interface brief',
    modes: ALL_MODES,
    run: (_m, _e, d) => showInterfaceBrief(d),
  });
  r.register({
    pattern: /^show ipv6 ospf$/i,
    syntax: 'show ipv6 ospf',
    modes: ALL_MODES,
    run: (_m, _e, d) => showProcess(d),
  });
  r.register({
    pattern: /^show ipv6 ospf database$/i,
    syntax: 'show ipv6 ospf database',
    modes: ALL_MODES,
    run: (_m, e, d) => showDatabase(e, d),
  });
}
