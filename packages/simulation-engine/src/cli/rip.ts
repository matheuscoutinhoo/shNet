import type { Device, RipConfig } from '../model';
import { ALL_MODES, CONFIG_MODES, currentPort, type CommandRegistry } from './registry';
const config = (device: Device): RipConfig => ({
  holdDownMs: device.rip?.holdDownMs ?? 0,
  redistributeStatic: device.rip?.redistributeStatic ?? false,
  staticMetric: device.rip?.staticMetric ?? 1,
  staticTag: device.rip?.staticTag ?? 0,
  enabled: device.rip?.enabled ?? false,
  interfaces: structuredClone(device.rip?.interfaces ?? []),
});
export function registerRipCommands(registry: CommandRegistry) {
  registry.register({
    pattern: /^rip configure (.+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureRip(d.id, JSON.parse(m[1])),
  });
  registry.register({
    pattern: /^(router rip|service rip|no service rip)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      engine.configureRip(device.id, {
        ...config(device),
        enabled: !match[1].toLowerCase().startsWith('no '),
      });
    },
  });
  registry.register({
    pattern: /^(ip rip enable|no ip rip)$/i,
    modes: ['interface'],
    run: (match, engine, device, context) => {
      const value = config(device),
        port = currentPort(device, context),
        existing = value.interfaces.find((entry) => entry.port === port.id);
      engine.configureRip(device.id, {
        ...value,
        interfaces: [
          ...value.interfaces.filter((entry) => entry.port !== port.id),
          ...(match[1].toLowerCase().startsWith('no ') ? [] : [existing ?? { port: port.id }]),
        ],
      });
    },
  });
  registry.register({
    pattern: /^(no )?ip rip (passive|poison-reverse)$/i,
    modes: ['interface'],
    run: (match, engine, device, context) => {
      const value = config(device),
        entry = value.interfaces.find((item) => item.port === currentPort(device, context).id);
      if (!entry) throw new Error('Configure ip rip enable nesta interface.');
      if (match[2].toLowerCase() === 'passive') entry.passive = !match[1];
      else entry.poisonReverse = !match[1];
      engine.configureRip(device.id, value);
    },
  });
  registry.register({
    pattern: /^show ip rip(?: (database|interface))?$/i,
    modes: ALL_MODES,
    run: (match, engine, device) => {
      const state = device.rip;
      if (!state) return 'RIP não configurado.';
      if (match[1]?.toLowerCase() === 'interface')
        return state.interfaces
          .map(
            (entry) =>
              `${device.interfaces.find((port) => port.id === entry.port)?.name}: ${entry.passive ? 'passiva' : 'ativa'}, ${entry.poisonReverse ? 'poison reverse' : 'split horizon'}`
          )
          .join('\n');
      return (
        `RIPv2 ${state.enabled ? 'ativo' : 'inativo'} · update 30s ±5s · timeout 180s · garbage 120s\nREDE                 VIA             METRICA  EXPIRA(s)\n` +
        state.table
          .map(
            (route) =>
              `${(route.network + '/' + route.prefix).padEnd(21)}${(route.learnedFrom ?? 'connected').padEnd(16)}${route.metric} ${route.garbageAt !== undefined ? 'garbage ' + Math.max(0, (route.garbageAt - engine.state.clock) / 1000).toFixed(1) : route.expiresAt !== undefined ? Math.max(0, (route.expiresAt - engine.state.clock) / 1000).toFixed(1) : '-'}`
          )
          .join('\n')
      );
    },
  });
}
export function ripRunningConfig(device: Device) {
  const state = device.rip;
  return state
    ? [
        'router rip',
        ...state.interfaces.flatMap((entry) => [
          'interface ' + device.interfaces.find((port) => port.id === entry.port)!.name,
          ' ip rip enable',
          ...(entry.passive ? [' ip rip passive'] : []),
          ...(entry.poisonReverse ? [] : [' no ip rip poison-reverse']),
          'exit',
        ]),
        (state.enabled ? '' : 'no ') + 'service rip',
      ]
    : [];
}
