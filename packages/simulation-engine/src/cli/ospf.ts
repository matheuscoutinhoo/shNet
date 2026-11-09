import { ipv4Schema, type Device, type NetworkInterface, type OspfConfig } from '../model';
import type { SimulationEngine } from '../core/engine';
import { ALL_MODES, CONFIG_MODES, currentPort, type CommandRegistry } from './registry';
import { readSecret } from './secrets';
import { showOspfNeighbors } from './ios-show';
import {
  defaultOspfNetworkType,
  newOspfInterfaceSettings,
  ospfConfigOf,
  selectOspfRouterId,
} from '../protocols/ospf';
import { OSPF } from '../protocols/ospf-model';
import { ipNumber } from '../protocols/ipv4';
import { interfaceName } from './operational';
import { parsePrefix, subnet, ipString, mask } from '../protocols/ipv4';
import { registerBfdCommands } from './bfd';

export function ospfConfiguration(device: Device): OspfConfig {
  return configuration(device);
}
function configuration(device: Device): OspfConfig {
  if (!device.ospf) throw new Error('Configure first: router ospf <process-id>');
  return ospfConfigOf(device.ospf);
}
type OspfSettings = NonNullable<NetworkInterface['ospfSettings']>;
/** Record an interface OSPF command (IOS interface config) and apply it to a running OSPF interface. */
function setOspfInterface<K extends keyof OspfSettings>(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  key: K,
  value: OspfSettings[K] | undefined
) {
  const settings: OspfSettings = { ...port.ospfSettings };
  if (value === undefined) delete settings[key];
  else settings[key] = value;
  const hello = settings.helloMs ?? OSPF.helloMs,
    dead = settings.deadMs ?? hello * 4;
  if (dead < hello * 2) throw new Error('% OSPF dead interval must be at least twice the hello interval.');
  if (Object.keys(settings).length) port.ospfSettings = settings;
  else delete port.ospfSettings;
  const config = device.ospf ? configuration(device) : undefined,
    entry = config?.interfaces.find((item) => item.port === port.id);
  if (!config || !entry) return;
  if (key === 'cost') {
    entry.autoCost = value === undefined;
    if (value !== undefined) entry.cost = value as number;
  } else if (key === 'priority') entry.priority = (value as number | undefined) ?? 1;
  else if (key === 'networkType')
    entry.networkType = (value as OspfSettings['networkType']) ?? defaultOspfNetworkType(port);
  else {
    entry.helloMs = hello;
    entry.deadMs = dead;
  }
  engine.configureOspf(device.id, config);
}
export function registerOspfCommands(registry: CommandRegistry) {
  registerBfdCommands(registry);
  registry.register({
    pattern: /^(no )?ip ospf authentication(?: (message-digest|null))?$/i,
    syntax: [
      'ip ospf authentication message-digest',
      'ip ospf authentication null',
      'no ip ospf authentication',
    ],
    modes: ['interface'],
    run: (m, e, d, c) => {
      if (!m[1] && !m[2])
        throw new Error('Simple password authentication is not supported; use message-digest.');
      const p = currentPort(d, c);
      const keys = { ...p.ospfAuthentication };
      delete keys.enabled;
      // "no ip ospf authentication" returns to the area setting; "null" disables it here.
      const enabled = m[1] ? undefined : m[2].toLowerCase() === 'message-digest';
      const next = { ...keys, ...(enabled !== undefined ? { enabled } : {}) };
      if (Object.keys(next).length) p.ospfAuthentication = next;
      else delete p.ospfAuthentication;
      if (d.ospf) e.configureOspf(d.id, configuration(d));
    },
  });
  registry.register({
    pattern: /^(no )?ip ospf message-digest-key (\d+)(?: md5(?: ([07]))? (\S+))?$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c),
        keyId = Number(m[2]);
      if (keyId < 1 || keyId > 255) throw new Error('Key ID must be 1..255.');
      const enabled = p.ospfAuthentication?.enabled,
        mode = enabled !== undefined ? { enabled } : {};
      if (m[1]) {
        if (p.ospfAuthentication?.keyId === keyId)
          if (enabled !== undefined) p.ospfAuthentication = mode;
          else delete p.ospfAuthentication;
      } else {
        const key = m[4] ? readSecret(m[3], m[4]) : undefined;
        if (!key || new TextEncoder().encode(key).length > 16)
          throw new Error('MD5 key must contain 1..16 bytes.');
        p.ospfAuthentication = { ...mode, keyId, key };
      }
      if (d.ospf) e.configureOspf(d.id, configuration(d));
    },
  });
  registry.register({
    pattern: /^(no )?passive-interface (default|\S+)$/i,
    modes: ['router'],
    run: (m, e, d, c) => {
      if (c.router !== 'ospf') throw new Error('Requires OSPF router mode.');
      const value = configuration(d);
      if (m[2].toLowerCase() === 'default') value.passiveDefault = !m[1];
      else {
        const p = d.interfaces.find((p) => p.name.toLowerCase() === interfaceName(m[2]).toLowerCase());
        if (!p) throw new Error('Invalid interface.');
        value.passiveOverrides = [
          ...(value.passiveOverrides ?? []).filter((o) => o.port !== p.id),
          { port: p.id, passive: !m[1] },
        ];
      }
      value.interfaces = value.interfaces.map((p) => ({
        ...p,
        passive:
          value.passiveOverrides?.find((o) => o.port === p.port)?.passive ?? value.passiveDefault ?? false,
      }));
      e.configureOspf(d.id, value);
    },
  });
  registry.register({
    pattern: /^auto-cost reference-bandwidth (\d+)$/i,
    modes: ['router'],
    run: (m, e, d, c) => {
      if (c.router !== 'ospf') throw new Error('Requires OSPF router mode.');
      e.configureOspf(d.id, { ...configuration(d), referenceBandwidth: Number(m[1]) });
    },
  });
  const areaId = (text: string) => (text.includes('.') ? ipNumber(text) : Number(text));
  const ospfRouter = (c: { router?: string }) => {
    if (c.router !== 'ospf') throw new Error('Requires OSPF router mode.');
  };
  registry.register({
    pattern: /^(no )?area ([\d.]+) (stub|nssa)(?: (no-summary))?$/i,
    syntax: ['area <id> stub [no-summary]', 'area <id> nssa [no-summary]', 'no area <id> stub'],
    modes: ['router'],
    run: (m, e, d, c) => {
      ospfRouter(c);
      const value = configuration(d),
        id = areaId(m[2]),
        old = value.areas.find((a) => a.id === id);
      if (id === 0) throw new Error('OSPF: Backbone can not be configured as stub or NSSA area');
      const type = m[1] && !m[4] ? 'normal' : (m[3].toLowerCase() as 'stub' | 'nssa');
      // "no area N stub no-summary" keeps the stub area and only removes no-summary.
      const noSummary = m[4] ? !m[1] : undefined;
      value.areas = [
        ...value.areas.filter((a) => a.id !== id),
        {
          id,
          type,
          defaultCost: old?.defaultCost ?? 1,
          ...(noSummary && type !== 'normal' ? { noSummary: true } : {}),
          ...(old?.authentication ? { authentication: old.authentication } : {}),
        },
      ];
      e.configureOspf(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?area ([\d.]+) authentication(?: (message-digest))?$/i,
    syntax: ['area <id> authentication message-digest', 'no area <id> authentication'],
    modes: ['router'],
    run: (m, e, d, c) => {
      ospfRouter(c);
      if (!m[1] && !m[3])
        throw new Error('Simple password authentication is not supported; use message-digest.');
      const value = configuration(d),
        id = areaId(m[2]),
        old = value.areas.find((a) => a.id === id) ?? { id, type: 'normal' as const, defaultCost: 1 };
      const next = { ...old };
      if (m[1]) delete next.authentication;
      else next.authentication = 'message-digest';
      value.areas = [...value.areas.filter((a) => a.id !== id), next];
      e.configureOspf(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?log-adjacency-changes(?: (detail))?$/i,
    syntax: ['log-adjacency-changes [detail]', 'no log-adjacency-changes'],
    modes: ['router'],
    run: (m, e, d, c) => {
      ospfRouter(c);
      const value = configuration(d);
      // "no log-adjacency-changes detail" returns to the default (FULL/DOWN only).
      if (m[1]) value.logAdjacencyChanges = m[2] ? undefined : false;
      else value.logAdjacencyChanges = m[2] ? 'detail' : undefined;
      if (value.logAdjacencyChanges === undefined) delete value.logAdjacencyChanges;
      e.configureOspf(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?timers throttle spf(?: (\d+) (\d+) (\d+))?$/i,
    syntax: ['timers throttle spf <start-ms> <hold-ms> <max-ms>', 'no timers throttle spf'],
    modes: ['router'],
    run: (m, e, d, c) => {
      ospfRouter(c);
      if (!m[1] && !m[2]) throw new Error('Incomplete command.');
      const [startMs, holdMs, maxMs] = [m[2], m[3], m[4]].map(Number);
      if (!m[1] && (holdMs < startMs || maxMs < holdMs || startMs < 1 || maxMs > 600000))
        throw new Error('Invalid SPF throttle: start <= hold <= max <= 600000 ms.');
      const value = configuration(d);
      if (m[1]) delete value.spfThrottle;
      else value.spfThrottle = { startMs, holdMs, maxMs };
      e.configureOspf(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?bfd all-interfaces$/i,
    syntax: 'bfd all-interfaces',
    modes: ['router'],
    available: (_d, c) => c.router === 'ospf',
    run: (m, e, d, c) => {
      ospfRouter(c);
      const value = configuration(d);
      if (m[1]) delete value.bfdAllInterfaces;
      else value.bfdAllInterfaces = true;
      e.configureOspf(d.id, value);
    },
  });
  registry.register({
    pattern:
      /^(no )?redistribute (connected|static|rip|bgp)(?: (\d+))?((?: (?:subnets|metric \d+|metric-type [12]|tag \d+|route-map [\w-]{1,32}))*)$/i,
    syntax: [
      'redistribute connected [metric N] [metric-type 1|2] [route-map NAME] [subnets] [tag N]',
      'redistribute static [metric N] [metric-type 1|2] [route-map NAME] [subnets] [tag N]',
      'redistribute bgp <asn> [metric N] [metric-type 1|2] [route-map NAME] [subnets] [tag N]',
    ],
    modes: ['router'],
    available: (_d, c) => c.router === 'ospf',
    run: (m, e, d, c) => {
      ospfRouter(c);
      const source = m[2].toLowerCase() as 'connected' | 'static' | 'rip' | 'bgp';
      if (source === 'bgp' && !m[3]) throw new Error('Incomplete command.');
      if (source !== 'bgp' && m[3]) throw new Error('Invalid input detected at: ' + m[3]);
      const options = m[4] ?? '';
      const option = (name: string) => new RegExp(`(?:^| )${name} (\\S+)`, 'i').exec(options)?.[1];
      if (m[1] && /(?:^| )subnets(?: |$)/i.test(options) && !option('metric') && !option('route-map'))
        throw new Error(
          "OSPF supports only classless redistribution, keyword 'subnets' can only be disabled together with redistribution"
        );
      const value = configuration(d);
      const process = m[3] ? Number(m[3]) : undefined;
      const others = (value.redistribute ?? []).filter(
        (entry) => entry.source !== source || entry.process !== process
      );
      const metric = option('metric');
      if (metric !== undefined && (Number(metric) < 1 || Number(metric) > 16777214))
        throw new Error('Invalid input detected at: ' + metric);
      const entry = {
        source,
        ...(process !== undefined ? { process } : {}),
        ...(metric !== undefined ? { metric: Number(metric) } : {}),
        ...(option('metric-type') === '1' ? { metricType: 'E1' as const } : {}),
        ...(option('tag') !== undefined ? { tag: Number(option('tag')) } : {}),
        ...(option('route-map') ? { routeMap: option('route-map') } : {}),
      };
      value.redistribute = m[1] ? others : [...others, entry];
      if (!value.redistribute.length) delete value.redistribute;
      e.configureOspf(d.id, value);
    },
  });
  registry.register({
    pattern: /^area ([\d.]+) range ([\d.]+) ([\d.]+)(?: cost (\d+))?$/i,
    modes: ['router'],
    run: (m, e, d, c) => {
      if (c.router !== 'ospf') throw new Error('Requires OSPF router mode.');
      const value = configuration(d),
        area = m[1].includes('.') ? ipNumber(m[1]) : Number(m[1]),
        prefix = parsePrefix(m[3]);
      if (subnet(m[2], prefix).network !== m[2]) throw new Error('Unaligned area range.');
      value.summaryRanges = [
        ...(value.summaryRanges ?? []).filter(
          (r) => r.area !== area || r.network !== m[2] || r.prefix !== prefix
        ),
        { area, network: m[2], prefix, ...(m[4] ? { cost: Number(m[4]) } : {}) },
      ];
      e.configureOspf(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?default-information originate(?: (always))?(?: metric (\d+))?(?: metric-type ([12]))?$/i,
    modes: ['router'],
    run: (m, e, d, c) => {
      if (c.router !== 'ospf') throw new Error('Requires OSPF router mode.');
      e.configureOspf(d.id, {
        ...configuration(d),
        defaultOriginate: m[1]
          ? undefined
          : { always: !!m[2], cost: Number(m[3] ?? 1), metricType: m[4] === '1' ? 'E1' : 'E2' },
      });
    },
  });
  registry.register({
    pattern: /^maximum-paths (\d+)$/i,
    modes: ['router'],
    run: (m, e, d, c) => {
      if (c.router !== 'ospf') throw new Error('maximum-paths requires OSPF router mode.');
      e.configureOspf(d.id, { ...configuration(d), maximumPaths: Number(m[1]) });
    },
  });
  registry.register({
    pattern: /^ospf configure (.+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureOspf(d.id, JSON.parse(m[1])),
  });
  registry.register({
    pattern: /^router ospf ([\d.]+)$/i,
    syntax: 'router ospf <process-id>',
    modes: CONFIG_MODES,
    run: (match, engine, device, context) => {
      const legacy = match[1].includes('.'),
        processId = legacy ? (device.ospf?.processId ?? 1) : Number(match[1]);
      if (processId < 1 || processId > 65535) throw new Error('OSPF process ID must be between 1 and 65535.');
      if (device.ospf?.processId && device.ospf.processId !== processId)
        throw new Error('This device currently supports one OSPF process.');
      const routerId = legacy ? match[1] : (device.ospf?.routerId ?? selectOspfRouterId(device));
      if (device.ospf && !legacy) {
        // Entering the mode of a running process changes nothing.
        context.mode = 'router';
        context.router = 'ospf';
        context.process = processId;
        return;
      }
      engine.configureOspf(device.id, {
        ...(device.ospf ? ospfConfigOf(device.ospf) : {}),
        enabled: routerId !== '0.0.0.0',
        routerId,
        processId,
        autoRouterId: legacy ? false : (device.ospf?.autoRouterId ?? true),
        areas: device.ospf?.areas ?? [],
        externalRoutes: device.ospf?.externalRoutes ?? [],
        interfaces: device.ospf?.interfaces ?? [],
      });
      context.mode = 'router';
      context.router = 'ospf';
      context.process = processId;
    },
  });
  registry.register({
    pattern: /^(no )?router-id(?: ([\d.]+))?$/i,
    syntax: ['router-id <address>', 'no router-id'],
    modes: ['router'],
    run: (m, e, d, c) => {
      if (c.router !== 'ospf') throw new Error('router-id requires router ospf mode.');
      if (!m[1] && !m[2]) throw new Error('Incomplete command.');
      const value = configuration(d),
        state = d.ospf!;
      const wanted = m[1] ? selectOspfRouterId(d) : ipv4Schema.parse(m[2]);
      if (!m[1] && (ipNumber(wanted) === 0 || ipNumber(wanted) >= 0xe0000000))
        throw new Error('Invalid input detected at: ' + m[2]);
      // A running process keeps its router ID until "clear ip ospf process" or a reload.
      if (state.enabled && state.routerId !== '0.0.0.0' && state.routerId !== wanted) {
        e.configureOspf(d.id, { ...value, autoRouterId: !!m[1], pendingRouterId: wanted });
        return '% OSPF: Reload or use "clear ip ospf process" command, for this to take effect';
      }
      delete value.pendingRouterId;
      e.configureOspf(d.id, {
        ...value,
        routerId: wanted,
        autoRouterId: !!m[1],
        enabled: wanted !== '0.0.0.0',
      });
    },
  });
  registry.register({
    pattern: /^(no )?network ([\d.]+) ([\d.]+) area ([\d.]+)$/i,
    syntax: ['network <address> <wildcard> area <area>', 'no network <address> <wildcard> area <area>'],
    modes: ['router'],
    run: (m, e, d, c) => {
      if (c.router !== 'ospf') throw new Error('network area requires router ospf mode.');
      const value = configuration(d),
        area = m[4].includes('.') ? ipNumber(m[4]) : Number(m[4]);
      ipNumber(m[2]);
      ipNumber(m[3]);
      const networks = (value.networks ?? []).filter(
        (n) => n.address !== m[2] || n.wildcard !== m[3] || n.area !== area
      );
      if (!m[1]) networks.push({ address: m[2], wildcard: m[3], area });
      e.configureOspf(d.id, { ...value, networks });
    },
  });
  registry.register({
    pattern: /^(no )?service ospf$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      engine.configureOspf(device.id, { ...configuration(device), enabled: !match[1] });
    },
  });
  registry.register({
    pattern: /^ip ospf (?:(\d+) )?area ([\d.]+)$/i,
    syntax: ['ip ospf <process-id> area <area>', 'ip ospf area <area>'],
    modes: ['interface'],
    run: (match, engine, device, context) => {
      if (!device.ospf && match[1]) {
        const routerId = selectOspfRouterId(device);
        engine.configureOspf(device.id, {
          enabled: routerId !== '0.0.0.0',
          routerId,
          autoRouterId: true,
          processId: Number(match[1]),
          interfaces: [],
        });
      }
      const config = configuration(device),
        port = currentPort(device, context);
      if (match[1] && Number(match[1]) !== (config.processId ?? 1))
        throw new Error('OSPF process does not match this device.');
      const previous = config.interfaces.find((entry) => entry.port === port.id);
      engine.configureOspf(device.id, {
        ...config,
        interfaces: [
          ...config.interfaces.filter((entry) => entry.port !== port.id),
          {
            // Interface commands entered before OSPF ran on this interface are applied now.
            ...(previous ?? { autoCost: true, ...newOspfInterfaceSettings(port) }),
            networkManaged: undefined,
            port: port.id,
            autoCost: previous?.autoCost ?? port.ospfSettings?.cost === undefined,
            area: match[2].includes('.') ? ipNumber(match[2]) : Number(match[2]),
          },
        ],
      });
    },
  });
  registry.register({
    pattern: /^no ip ospf$/i,
    modes: ['interface'],
    run: (_match, engine, device, context) => {
      const config = configuration(device);
      engine.configureOspf(device.id, {
        ...config,
        interfaces: config.interfaces.filter((entry) => entry.port !== currentPort(device, context).id),
      });
    },
  });
  registry.register({
    pattern: /^(no )?ip ospf (cost|priority|hello-interval|dead-interval)(?: (\d+))?$/i,
    modes: ['interface'],
    run: (match, engine, device, context) => {
      if (!match[1] && match[3] === undefined) throw new Error('% Incomplete command.');
      const key = (
        {
          cost: 'cost',
          priority: 'priority',
          'hello-interval': 'helloMs',
          'dead-interval': 'deadMs',
        } as const
      )[match[2].toLowerCase() as 'cost' | 'priority' | 'hello-interval' | 'dead-interval'];
      const value = match[1]
        ? undefined
        : Number(match[3]) * (key === 'helloMs' || key === 'deadMs' ? 1000 : 1);
      setOspfInterface(engine, device, currentPort(device, context), key, value);
    },
  });
  registry.register({
    pattern: /^(no )?ip ospf network(?: (point-to-point|broadcast))?$/i,
    modes: ['interface'],
    run: (match, engine, device, context) => {
      if (!match[1] && !match[2]) throw new Error('% Incomplete command.');
      setOspfInterface(
        engine,
        device,
        currentPort(device, context),
        'networkType',
        match[1] ? undefined : (match[2].toLowerCase() as 'point-to-point' | 'broadcast')
      );
    },
  });
  registry.register({
    pattern: /^(no )?ip ospf passive$/i,
    modes: ['interface'],
    run: (match, engine, device, context) => {
      const config = configuration(device),
        entry = config.interfaces.find((item) => item.port === currentPort(device, context).id);
      if (!entry) throw new Error('Configure ip ospf area nesta interface.');
      entry.passive = !match[1];
      engine.configureOspf(device.id, config);
    },
  });
  registry.register({
    pattern: /^show ip ospf neighbor$/i,
    syntax: 'show ip ospf neighbor',
    modes: ALL_MODES,
    run: (_match, engine, device) => (device.ospf ? showOspfNeighbors(engine, device) : ''),
  });
}
function ospfInterfaceRunning(device: Device): string[] {
  const state = device.ospf;
  return device.interfaces.flatMap((port) => {
    const entry = state?.interfaces.find((config) => config.port === port.id),
      settings = port.ospfSettings ?? {};
    const networkType = entry?.networkType ?? settings.networkType,
      priority = entry?.priority ?? settings.priority,
      hello = entry?.helloMs ?? settings.helloMs ?? OSPF.helloMs,
      dead = entry?.deadMs ?? settings.deadMs ?? hello * 4,
      cost = entry ? (entry.autoCost ? undefined : entry.cost) : settings.cost;
    const lines = [
      ...(networkType && networkType !== defaultOspfNetworkType(port)
        ? [' ip ospf network ' + networkType]
        : []),
      ...(priority !== undefined && priority !== 1 ? [' ip ospf priority ' + priority] : []),
      ...(hello !== OSPF.helloMs ? [' ip ospf hello-interval ' + hello / 1000] : []),
      ...(dead !== hello * 4 ? [' ip ospf dead-interval ' + dead / 1000] : []),
      ...(entry && !entry.networkManaged
        ? [' ip ospf ' + (state!.processId ?? 1) + ' area ' + entry.area]
        : []),
      ...(cost !== undefined ? [' ip ospf cost ' + cost] : []),
    ];
    return lines.length ? ['interface ' + port.name, ...lines, 'exit'] : [];
  });
}
export function ospfRunningConfig(device: Device): string[] {
  const state = device.ospf;
  if (!state) return ospfInterfaceRunning(device);
  const areaText = (id: number) => String(id);
  return [
    'router ospf ' + (state.processId ?? 1),
    ...(!state.autoRouterId ? [' router-id ' + (state.pendingRouterId ?? state.routerId)] : []),
    ...(state.logAdjacencyChanges === false
      ? [' no log-adjacency-changes']
      : state.logAdjacencyChanges === 'detail'
        ? [' log-adjacency-changes detail']
        : []),
    ...(state.maximumPaths !== 4 ? [' maximum-paths ' + state.maximumPaths] : []),
    ...(state.referenceBandwidth !== 100
      ? [' auto-cost reference-bandwidth ' + state.referenceBandwidth]
      : []),
    ...state.areas
      .filter((a) => a.authentication)
      .map((a) => ` area ${areaText(a.id)} authentication message-digest`),
    ...state.areas
      .filter((a) => a.type !== 'normal')
      .map((a) => ` area ${areaText(a.id)} ${a.type}${a.noSummary ? ' no-summary' : ''}`),
    ...state.summaryRanges.map(
      (r) =>
        ` area ${r.area} range ${r.network} ${ipString(mask(r.prefix))}${r.cost ? ' cost ' + r.cost : ''}`
    ),
    ...(state.spfThrottle
      ? [
          ` timers throttle spf ${state.spfThrottle.startMs} ${state.spfThrottle.holdMs} ${state.spfThrottle.maxMs}`,
        ]
      : []),
    // IOS XE no longer prints "subnets": OSPF redistribution is always classless.
    ...(state.redistribute ?? []).map(
      (r) =>
        ` redistribute ${r.source}` +
        (r.process !== undefined ? ' ' + r.process : '') +
        (r.metric !== undefined ? ' metric ' + r.metric : '') +
        (r.metricType === 'E1' ? ' metric-type 1' : '') +
        (r.tag ? ' tag ' + r.tag : '') +
        (r.routeMap ? ' route-map ' + r.routeMap : '')
    ),
    ...(state.passiveDefault ? [' passive-interface default'] : []),
    ...state.passiveOverrides.map(
      (o) =>
        ` ${o.passive ? '' : 'no '}passive-interface ${device.interfaces.find((p) => p.id === o.port)!.name}`
    ),
    ...state.interfaces
      .filter(
        (p) => p.passive && !state.passiveDefault && !state.passiveOverrides.some((o) => o.port === p.port)
      )
      .map((p) => ' passive-interface ' + device.interfaces.find((i) => i.id === p.port)!.name),
    ...(state.networks ?? []).map((n) => ` network ${n.address} ${n.wildcard} area ${n.area}`),
    ...(state.bfdAllInterfaces ? [' bfd all-interfaces'] : []),
    ...(state.defaultOriginate
      ? [
          ' default-information originate' +
            (state.defaultOriginate.always ? ' always' : '') +
            (state.defaultOriginate.cost !== 1 ? ' metric ' + state.defaultOriginate.cost : '') +
            (state.defaultOriginate.metricType === 'E1' ? ' metric-type 1' : ''),
        ]
      : []),
    // OSPF stopped from the simulator panel (IOS has no global equivalent).
    ...(!state.enabled && state.routerId !== '0.0.0.0' ? [' no service ospf'] : []),
    'exit',
    ...ospfInterfaceRunning(device),
  ];
}
