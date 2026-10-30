import type { Device, NetworkInterface, OspfConfig } from '../model';
import type { SimulationEngine } from '../core/engine';
import { ALL_MODES, CONFIG_MODES, currentPort, type CommandRegistry } from './registry';
import { defaultOspfNetworkType, newOspfInterfaceSettings, selectOspfRouterId } from '../protocols/ospf';
import { OSPF } from '../protocols/ospf-model';
import { ipNumber } from '../protocols/ipv4';
import { interfaceName } from './operational';
import { parsePrefix, subnet, ipString, mask } from '../protocols/ipv4';
import { registerBfdCommands } from './bfd';

function configuration(device: Device): OspfConfig {
  if (!device.ospf) throw new Error('Configure first: router ospf <process-id>');
  return {
    areas: structuredClone(device.ospf.areas),
    externalRoutes: structuredClone(device.ospf.externalRoutes),
    enabled: device.ospf.enabled,
    routerId: device.ospf.routerId,
    processId: device.ospf.processId,
    autoRouterId: device.ospf.autoRouterId,
    maximumPaths: device.ospf.maximumPaths,
    referenceBandwidth: device.ospf.referenceBandwidth,
    passiveDefault: device.ospf.passiveDefault,
    passiveOverrides: structuredClone(device.ospf.passiveOverrides),
    summaryRanges: structuredClone(device.ospf.summaryRanges),
    defaultOriginate: structuredClone(device.ospf.defaultOriginate),
    networks: structuredClone(device.ospf.networks),
    interfaces: structuredClone(device.ospf.interfaces),
  };
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
    pattern: /^(no )?ip ospf authentication(?: (message-digest))?$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      if (!m[1] && !m[2]) throw new Error('Use ip ospf authentication message-digest.');
      const p = currentPort(d, c);
      p.ospfAuthentication = { ...p.ospfAuthentication, enabled: !m[1] };
      if (d.ospf) e.configureOspf(d.id, configuration(d));
    },
  });
  registry.register({
    pattern: /^(no )?ip ospf message-digest-key (\d+)(?: md5(?: 0)? (\S+))?$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c),
        keyId = Number(m[2]);
      if (keyId < 1 || keyId > 255) throw new Error('Key ID must be 1..255.');
      if (m[1]) {
        if (p.ospfAuthentication?.keyId === keyId)
          p.ospfAuthentication = { enabled: p.ospfAuthentication.enabled };
      } else {
        if (!m[3] || new TextEncoder().encode(m[3]).length > 16)
          throw new Error('MD5 key must contain 1..16 bytes.');
        p.ospfAuthentication = { enabled: p.ospfAuthentication?.enabled ?? false, keyId, key: m[3] };
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
  registry.register({
    pattern: /^area ([\d.]+) (stub|nssa)$/i,
    modes: ['router'],
    run: (m, e, d, c) => {
      if (c.router !== 'ospf') throw new Error('Requires OSPF router mode.');
      const value = configuration(d),
        id = m[1].includes('.') ? ipNumber(m[1]) : Number(m[1]);
      value.areas = [
        ...value.areas.filter((a) => a.id !== id),
        { id, type: m[2].toLowerCase() as 'stub' | 'nssa', defaultCost: 1 },
      ];
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
      engine.configureOspf(device.id, {
        enabled: routerId !== '0.0.0.0',
        routerId,
        processId,
        autoRouterId: legacy ? false : (device.ospf?.autoRouterId ?? true),
        maximumPaths: device.ospf?.maximumPaths,
        referenceBandwidth: device.ospf?.referenceBandwidth,
        passiveDefault: device.ospf?.passiveDefault,
        passiveOverrides: device.ospf?.passiveOverrides,
        summaryRanges: device.ospf?.summaryRanges,
        defaultOriginate: device.ospf?.defaultOriginate,
        networks: device.ospf?.networks,
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
    pattern: /^router-id ([\d.]+)$/i,
    syntax: 'router-id <address>',
    modes: ['router'],
    run: (m, e, d, c) => {
      if (c.router !== 'ospf') throw new Error('router-id requires router ospf mode.');
      e.configureOspf(d.id, { ...configuration(d), routerId: m[1], autoRouterId: false, enabled: true });
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
      const key = ({ cost: 'cost', priority: 'priority', 'hello-interval': 'helloMs', 'dead-interval': 'deadMs' } as const)[
        match[2].toLowerCase() as 'cost' | 'priority' | 'hello-interval' | 'dead-interval'
      ];
      const value = match[1] ? undefined : Number(match[3]) * (key === 'helloMs' || key === 'deadMs' ? 1000 : 1);
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
    pattern: /^show ip ospf(?: (neighbor|database|interface))?$/i,
    modes: ALL_MODES,
    run: (match, engine, device) => {
      const state = device.ospf;
      if (!state) return 'OSPF não configurado.';
      if (match[1]?.toLowerCase() === 'neighbor')
        return (
          'ROUTER ID       STATE      ADDRESS         PORT  DEAD(s)\n' +
          state.neighbors
            .map(
              (n) =>
                `${n.routerId.padEnd(16)}${n.state.padEnd(11)}${n.ip.padEnd(16)}${device.interfaces.find((p) => p.id === n.port)?.name}  ${Math.max(0, (n.deadAt - engine.state.clock) / 1000).toFixed(1)}`
            )
            .join('\n')
        );
      if (match[1]?.toLowerCase() === 'database')
        return (
          'AREA TYPE     LINK STATE ID       ADVERTISING ROUTER  SEQUENCE AGE(s)\n' +
          state.lsdb
            .map(
              (lsa) =>
                `${lsa.area} ${lsa.type.padEnd(9)}${lsa.id.padEnd(20)}${lsa.advertisingRouter.padEnd(20)}${lsa.sequence} ${((engine.state.clock - lsa.originatedAt) / 1000).toFixed(1)}${lsa.withdrawn ? ' WITHDRAWN' : ''}`
            )
            .join('\n')
        );
      if (match[1]?.toLowerCase() === 'interface')
        return state.interfaces
          .map((config) => {
            const runtime = state.ports.find((entry) => entry.port === config.port)!;
            return `${device.interfaces.find((p) => p.id === config.port)?.name}: area ${config.area}, cost ${config.cost}, ${config.networkType}${config.passive ? ', passive' : ''}, ${runtime.operational ? 'up' : 'down'}\n  Hello ${config.helloMs / 1000}s Dead ${config.deadMs / 1000}s DR ${runtime.dr} BDR ${runtime.bdr}`;
          })
          .join('\n');
      return `OSPF ${state.enabled ? 'ativo' : 'inativo'}, router ID ${state.routerId}\n${state.neighbors.filter((n) => n.state === 'Full').length} adjacências Full, ${state.lsdb.length} LSAs, ${state.routes.length} rotas, ${state.spfRuns} alterações SPF.`;
    },
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
      ...(networkType && networkType !== defaultOspfNetworkType(port) ? [' ip ospf network ' + networkType] : []),
      ...(priority !== undefined && priority !== 1 ? [' ip ospf priority ' + priority] : []),
      ...(hello !== OSPF.helloMs ? [' ip ospf hello-interval ' + hello / 1000] : []),
      ...(dead !== hello * 4 ? [' ip ospf dead-interval ' + dead / 1000] : []),
      ...(entry && !entry.networkManaged ? [' ip ospf ' + (state!.processId ?? 1) + ' area ' + entry.area] : []),
      ...(cost !== undefined ? [' ip ospf cost ' + cost] : []),
    ];
    return lines.length ? ['interface ' + port.name, ...lines, 'exit'] : [];
  });
}
export function ospfRunningConfig(device: Device): string[] {
  const state = device.ospf;
  if (!state) return ospfInterfaceRunning(device);
  return [
    'router ospf ' + (state.processId ?? 1),
    ...(!state.autoRouterId ? [' router-id ' + state.routerId] : []),
    ...(state.maximumPaths !== 4 ? [' maximum-paths ' + state.maximumPaths] : []),
    ...(state.referenceBandwidth !== 100
      ? [' auto-cost reference-bandwidth ' + state.referenceBandwidth]
      : []),
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
    ...state.areas.filter((a) => a.type !== 'normal').map((a) => ` area ${a.id} ${a.type}`),
    ...state.summaryRanges.map(
      (r) =>
        ` area ${r.area} range ${r.network} ${ipString(mask(r.prefix))}${r.cost ? ' cost ' + r.cost : ''}`
    ),
    ...(state.defaultOriginate
      ? [
          ` default-information originate${state.defaultOriginate.always ? ' always' : ''} metric ${state.defaultOriginate.cost} metric-type ${state.defaultOriginate.metricType === 'E1' ? 1 : 2}`,
        ]
      : []),
    ...(state.networks ?? []).map((n) => ` network ${n.address} ${n.wildcard} area ${n.area}`),
    'exit',
    ...ospfInterfaceRunning(device),
    (state.enabled ? '' : 'no ') + 'service ospf',
  ];
}
