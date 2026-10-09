import type { Device } from '../model';
import { qosConfig } from '../protocols/qos';
import { ALL_MODES, CONFIG_MODES, currentPort, type CommandRegistry } from './registry';
export function registerForwardingCommands(r: CommandRegistry) {
  r.register({
    pattern: /^qos configure (\{.+\})$/i,
    modes: ['interface'],
    run: (m, e, d, c) => e.configureQos(d.id, currentPort(d, c).id, JSON.parse(m[1])),
  });
  r.register({
    pattern: /^no service qos$/i,
    modes: ['interface'],
    run: (_m, e, d, c) => {
      const p = currentPort(d, c);
      e.configureQos(d.id, p.id, { ...qosConfig(p), enabled: false });
    },
  });
  r.register({
    pattern: /^show qos$/i,
    modes: ALL_MODES,
    run: (_m, _e, d) =>
      d.interfaces
        .filter((p) => p.qos)
        .map(
          (p) =>
            p.name +
            ' ' +
            p.qos!.rateMbps +
            ' Mbps ' +
            p.qos!.scheduler +
            ' depth=' +
            p.qos!.queues.length +
            '\n' +
            p
              .qos!.stats.map(
                (s) => s.name + ' enqueued=' + s.enqueued + ' sent=' + s.dequeued + ' drops=' + s.dropped
              )
              .join('\n')
        )
        .join('\n') || 'QoS não configurada.',
  });
  r.register({
    pattern: /^mpls configure (\{.+\})$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureMpls(d.id, JSON.parse(m[1])),
  });
  r.register({
    pattern: /^mpls (ingress|lfib) (\{.+\})$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const config = structuredClone(d.mpls ?? { enabled: true, ingress: [], lfib: [] }),
        rule = JSON.parse(m[2]);
      if (m[1].toLowerCase() === 'ingress')
        config.ingress = [
          ...config.ingress.filter((r) => r.network !== rule.network || r.prefix !== rule.prefix),
          rule,
        ];
      else config.lfib = [...config.lfib.filter((r) => r.incoming !== rule.incoming), rule];
      e.configureMpls(d.id, config);
    },
  });
  r.register({
    pattern: /^(no )?service mpls$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureMpls(d.id, { ...(d.mpls ?? { ingress: [], lfib: [] }), enabled: !m[1] }),
  });
  r.register({
    pattern: /^show mpls(?: forwarding-table)?$/i,
    modes: ALL_MODES,
    run: (_m, _e, d) => JSON.stringify(d.mpls ?? {}, null, 2),
  });
}
export function forwardingRunningConfig(d: Device) {
  return [
    ...d.interfaces
      .filter((p) => p.qos)
      .flatMap((p) => ['interface ' + p.name, ' qos configure ' + JSON.stringify(qosConfig(p)), 'exit']),
    ...(d.mpls ? ['mpls configure ' + JSON.stringify(d.mpls)] : []),
  ];
}
