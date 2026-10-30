import { CONFIG_MODES, EXEC_MODES, CommandRegistry, currentPort } from './registry';
import { discoveryConfigSchema } from '../protocols/discovery-model';
import { configureDiscovery, refreshDiscovery } from '../protocols/discovery';
import type { Device } from '../model';

export function registerDiscoveryCommands(r: CommandRegistry) {
  r.register({
    pattern: /^(no )?(cdp|lldp) run$/i,
    syntax: ['cdp run', 'no cdp run', 'lldp run', 'no lldp run'],
    modes: CONFIG_MODES,
    run: (m, e, d) =>
      configureDiscovery(e, d, {
        ...discoveryConfigSchema.parse(
          d.discovery
            ? {
                cdp: d.discovery.cdp,
                lldp: d.discovery.lldp,
                cdpTimer: d.discovery.cdpTimer,
                cdpHoldtime: d.discovery.cdpHoldtime,
                lldpTimer: d.discovery.lldpTimer,
                lldpHoldtime: d.discovery.lldpHoldtime,
              }
            : {}
        ),
        [m[2].toLowerCase()]: !m[1],
      }),
  });
  r.register({
    pattern: /^(cdp|lldp) (timer|holdtime) (\d+)$/i,
    syntax: [
      'cdp timer <seconds>',
      'cdp holdtime <seconds>',
      'lldp timer <seconds>',
      'lldp holdtime <seconds>',
    ],
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const s = d.discovery,
        c = discoveryConfigSchema.parse(
          s
            ? {
                cdp: s.cdp,
                lldp: s.lldp,
                cdpTimer: s.cdpTimer,
                cdpHoldtime: s.cdpHoldtime,
                lldpTimer: s.lldpTimer,
                lldpHoldtime: s.lldpHoldtime,
              }
            : {}
        );
      configureDiscovery(e, d, {
        ...c,
        [m[1].toLowerCase() + (m[2].toLowerCase() === 'timer' ? 'Timer' : 'Holdtime')]: Number(m[3]),
      });
    },
  });
  r.register({
    pattern: /^(no )?(cdp enable|lldp transmit|lldp receive)$/i,
    syntax: [
      'cdp enable',
      'no cdp enable',
      'lldp transmit',
      'no lldp transmit',
      'lldp receive',
      'no lldp receive',
    ],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c);
      if (!['rj45', 'sfp', 'qsfp'].includes(p.media) || p.logical || p.loopback || p.aggregate)
        throw new Error('Discovery requires a physical Ethernet interface.');
      const command = m[2].toLowerCase();
      p[
        command === 'cdp enable' ? 'cdpEnabled' : command === 'lldp transmit' ? 'lldpTransmit' : 'lldpReceive'
      ] = !m[1];
      if (!d.discovery) configureDiscovery(e, d, {});
      refreshDiscovery(e);
    },
  });
  r.register({
    pattern: /^show (cdp|lldp) neighbors(?: (detail))?$/i,
    syntax: [
      'show cdp neighbors',
      'show cdp neighbors detail',
      'show lldp neighbors',
      'show lldp neighbors detail',
    ],
    modes: EXEC_MODES,
    run: (m, e, d) => {
      const protocol = m[1].toUpperCase(),
        neighbors = (d.discovery?.neighbors ?? []).filter(
          (n) => n.protocol === protocol && n.expiresAt > e.state.clock
        );
      if (!neighbors.length) return 'No ' + protocol + ' neighbors found.';
      return m[2]
        ? neighbors
            .map((n) =>
              [
                'Device ID: ' + n.deviceId,
                'Local Interface: ' + d.interfaces.find((p) => p.id === n.port)!.name,
                'Port ID: ' + n.portId,
                'Chassis ID: ' + n.chassisId,
                'Platform: ' + n.platform,
                'Capabilities: ' + n.capabilities.join(' '),
                'Management Addresses: ' + n.addresses.join(', '),
                'Holdtime: ' + Math.ceil((n.expiresAt - e.state.clock) / 1000) + ' sec',
              ].join('\n')
            )
            .join('\n\n')
        : [
            'Device ID           Local Intrfce       Holdtme  Capability  Platform             Port ID',
            ...neighbors.map(
              (n) =>
                n.deviceId.padEnd(20) +
                d.interfaces.find((p) => p.id === n.port)!.name.padEnd(20) +
                String(Math.ceil((n.expiresAt - e.state.clock) / 1000)).padEnd(9) +
                n.capabilities
                  .map((c) => c[0])
                  .join(' ')
                  .padEnd(12) +
                n.platform.padEnd(21) +
                n.portId
            ),
          ].join('\n');
    },
  });
}
export function discoveryRunningConfig(d: Device): string[] {
  const s = d.discovery;
  if (!s) return [];
  return [
    s.cdp ? 'cdp run' : 'no cdp run',
    s.lldp ? 'lldp run' : 'no lldp run',
    `cdp timer ${s.cdpTimer}`,
    `cdp holdtime ${s.cdpHoldtime}`,
    `lldp timer ${s.lldpTimer}`,
    `lldp holdtime ${s.lldpHoldtime}`,
    ...d.interfaces.flatMap((p) =>
      p.cdpEnabled === undefined && p.lldpTransmit === undefined && p.lldpReceive === undefined
        ? []
        : [
            'interface ' + p.name,
            ...(p.cdpEnabled === undefined ? [] : [p.cdpEnabled ? 'cdp enable' : 'no cdp enable']),
            ...(p.lldpTransmit === undefined ? [] : [p.lldpTransmit ? 'lldp transmit' : 'no lldp transmit']),
            ...(p.lldpReceive === undefined ? [] : [p.lldpReceive ? 'lldp receive' : 'no lldp receive']),
            'exit',
          ]
    ),
  ];
}
