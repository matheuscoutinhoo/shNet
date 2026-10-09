import { ALL_MODES, CONFIG_MODES, CommandRegistry, currentPort } from './registry';
import { bridgeId, bridgeLabel, portCost } from '../protocols/stp-election';
import type { Device } from '../model';
import { multiStpConfig } from '../protocols/stp';

export function registerStpCommands(registry: CommandRegistry) {
  registry.register({
    pattern: /^spanning-tree configure (.+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => engine.configureMultiSpanningTree(device.id, JSON.parse(match[1])),
  });
  registry.register({
    pattern: /^spanning-tree mode (stp|rstp)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) =>
      engine.configureSpanningTree(device.id, match[1].toLowerCase() as 'stp' | 'rstp'),
  });
  registry.register({
    pattern: /^no spanning-tree$/i,
    modes: CONFIG_MODES,
    run: (_match, engine, device) => engine.configureSpanningTree(device.id, 'off'),
  });
  registry.register({
    pattern: /^spanning-tree priority (\d+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const config = multiStpConfig(device);
      if (config)
        engine.configureMultiSpanningTree(device.id, {
          ...config,
          priorities: [
            ...config.priorities.filter((p) => p.instance !== 0),
            { instance: 0, priority: Number(match[1]) },
          ],
        });
      else engine.configureSpanningTree(device.id, device.spanningTree?.mode ?? 'rstp', Number(match[1]));
    },
  });
  registry.register({
    pattern: /^(no )?spanning-tree portfast$/i,
    modes: ['interface'],
    run: (match, engine, device, context) =>
      engine.setSpanningTreePort(device.id, currentPort(device, context).id, { edge: !match[1] }),
  });
  registry.register({
    pattern: /^spanning-tree cost (\d+)$/i,
    modes: ['interface'],
    run: (match, engine, device, context) =>
      engine.setSpanningTreePort(device.id, currentPort(device, context).id, { cost: Number(match[1]) }),
  });
  registry.register({
    pattern: /^no spanning-tree cost$/i,
    modes: ['interface'],
    run: (_match, engine, device, context) =>
      engine.setSpanningTreePort(device.id, currentPort(device, context).id, { cost: undefined }),
  });
  registry.register({
    pattern: /^show spanning-tree(?: instance (\d+))?$/i,
    modes: ALL_MODES,
    run: (match, _engine, device) => {
      const instance = Number(match[1] ?? 0);
      const tree = instance
        ? device.multiSpanningTree?.instances.find((i) => i.id === instance)?.tree
        : device.spanningTree;
      if (!tree?.enabled) return 'Spanning tree desabilitado';
      return [
        (device.multiSpanningTree?.mode.toUpperCase() ?? 'Common Spanning Tree') +
          ' / ' +
          tree.mode.toUpperCase() +
          ' / instância ' +
          instance,
        ...(device.multiSpanningTree
          ? ['Instâncias: ' + device.multiSpanningTree.instances.map((i) => i.id).join(', ')]
          : []),
        'Bridge ID: ' + bridgeLabel(bridgeId(device)),
        'Root ID: ' + bridgeLabel(tree.root) + ' | cost ' + tree.cost,
        'Root port: ' + (device.interfaces.find((port) => port.id === tree.rootPort)?.name ?? 'local'),
        'PORT          ROLE         STATE        COST  EDGE',
        ...device.interfaces
          .filter((port) =>
            instance ? port.spanningInstances?.some((i) => i.id === instance) : port.spanningTree
          )
          .map((port) => {
            const state = instance
              ? port.spanningInstances!.find((i) => i.id === instance)!.state
              : port.spanningTree!;
            return (
              port.name.padEnd(14) +
              state.role.padEnd(13) +
              state.state.padEnd(13) +
              String(portCost(port)).padEnd(6) +
              (port.stpEdge ? 'yes' : 'no') +
              (port.mstBoundary ? ' boundary' : '')
            );
          }),
      ].join('\n');
    },
  });
}
export function stpRunningConfig(device: Device) {
  if (device.multiSpanningTree) return ['spanning-tree configure ' + JSON.stringify(multiStpConfig(device))];
  return device.spanningTree?.enabled
    ? [
        'spanning-tree mode ' + device.spanningTree.mode,
        'spanning-tree priority ' + device.spanningTree.priority,
      ]
    : [];
}
