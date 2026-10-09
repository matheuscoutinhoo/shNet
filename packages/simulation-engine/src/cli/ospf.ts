import type { Device, OspfConfig } from '../model';
import { ALL_MODES, CONFIG_MODES, currentPort, type CommandRegistry } from './registry';

function configuration(device: Device): OspfConfig {
  if (!device.ospf) throw new Error('Configure primeiro: router ospf ROUTER_ID');
  return {
    areas: structuredClone(device.ospf.areas),
    externalRoutes: structuredClone(device.ospf.externalRoutes),
    enabled: device.ospf.enabled,
    routerId: device.ospf.routerId,
    interfaces: structuredClone(device.ospf.interfaces),
  };
}
export function registerOspfCommands(registry: CommandRegistry) {
  registry.register({
    pattern: /^ospf configure (.+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureOspf(d.id, JSON.parse(m[1])),
  });
  registry.register({
    pattern: /^router ospf ([\d.]+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      engine.configureOspf(device.id, {
        enabled: true,
        routerId: match[1],
        areas: device.ospf?.areas ?? [],
        externalRoutes: device.ospf?.externalRoutes ?? [],
        interfaces: device.ospf?.interfaces ?? [],
      });
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
    pattern: /^ip ospf area (\d+)$/i,
    modes: ['interface'],
    run: (match, engine, device, context) => {
      const config = configuration(device),
        port = currentPort(device, context);
      const previous = config.interfaces.find((entry) => entry.port === port.id);
      engine.configureOspf(device.id, {
        ...config,
        interfaces: [
          ...config.interfaces.filter((entry) => entry.port !== port.id),
          { ...previous, port: port.id, area: Number(match[1]) },
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
    pattern: /^ip ospf (cost|priority|hello-interval|dead-interval) (\d+)$/i,
    modes: ['interface'],
    run: (match, engine, device, context) => {
      const config = configuration(device),
        entry = config.interfaces.find((item) => item.port === currentPort(device, context).id);
      if (!entry) throw new Error('Configure ip ospf area nesta interface.');
      const key = match[1].toLowerCase();
      if (key === 'cost') entry.cost = Number(match[2]);
      else if (key === 'priority') entry.priority = Number(match[2]);
      else if (key === 'hello-interval') entry.helloMs = Number(match[2]) * 1000;
      else entry.deadMs = Number(match[2]) * 1000;
      engine.configureOspf(device.id, config);
    },
  });
  registry.register({
    pattern: /^ip ospf network (point-to-point|broadcast)$/i,
    modes: ['interface'],
    run: (match, engine, device, context) => {
      const config = configuration(device),
        entry = config.interfaces.find((item) => item.port === currentPort(device, context).id);
      if (!entry) throw new Error('Configure ip ospf area nesta interface.');
      entry.networkType = match[1].toLowerCase() as typeof entry.networkType;
      engine.configureOspf(device.id, config);
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
export function ospfRunningConfig(device: Device): string[] {
  const state = device.ospf;
  if (!state) return [];
  return [
    'router ospf ' + state.routerId,
    ...state.interfaces.flatMap((config) => [
      'interface ' + device.interfaces.find((port) => port.id === config.port)!.name,
      ' ip ospf area ' + config.area,
      ' ip ospf cost ' + config.cost,
      ' ip ospf network ' + config.networkType,
      ' ip ospf priority ' + config.priority,
      ...(config.helloMs < 10000
        ? [
            ' ip ospf hello-interval ' + config.helloMs / 1000,
            ' ip ospf dead-interval ' + config.deadMs / 1000,
          ]
        : [
            ' ip ospf dead-interval ' + config.deadMs / 1000,
            ' ip ospf hello-interval ' + config.helloMs / 1000,
          ]),
      ...(config.passive ? [' ip ospf passive'] : []),
      'exit',
    ]),
    (state.enabled ? '' : 'no ') + 'service ospf',
  ];
}
