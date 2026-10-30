import { EXEC_MODES, CommandRegistry, currentPort } from './registry';
import { configureHsrp, hsrpConfig } from '../protocols/hsrp';
import { hsrpGroupConfigSchema, hsrpMac, type HsrpConfig } from '../protocols/hsrp-model';
import { interfaceName } from './operational';
import type { Device } from '../model';
function update(d: Device, port: string, group: number, patch: Partial<HsrpConfig>) {
  const groups = hsrpConfig(d),
    old = groups.find((g) => g.port === port && g.group === group);
  return {
    groups: [
      ...groups.filter((g) => g !== old),
      hsrpGroupConfigSchema.parse({
        ...old,
        port,
        group,
        version: d.interfaces.find((p) => p.id === port)!.hsrpVersion ?? 1,
        ...patch,
      }),
    ],
  };
}
export function registerHsrpCommands(r: CommandRegistry) {
  r.register({
    pattern: /^(no )?standby (\d+) track (\d+)(?: decrement (\d+))?$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c),
        old = hsrpConfig(d).find((g) => g.port === p.id && g.group === Number(m[2]));
      configureHsrp(
        e,
        d,
        update(d, p.id, Number(m[2]), {
          objectTrack: [
            ...(old?.objectTrack ?? []).filter((t) => t.object !== Number(m[3])),
            ...(m[1] ? [] : [{ object: Number(m[3]), decrement: Number(m[4] ?? 10) }]),
          ],
        })
      );
    },
  });
  r.register({
    pattern: /^standby version ([12])$/i,
    syntax: 'standby version <version>',
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c);
      p.hsrpVersion = Number(m[1]) as 1 | 2;
      configureHsrp(e, d, {
        groups: hsrpConfig(d).map((g) => (g.port === p.id ? { ...g, version: p.hsrpVersion } : g)),
      });
    },
  });
  r.register({
    pattern: /^(no )?standby (\d+) ip(?: ([\d.]+))?$/i,
    syntax: ['standby <group> ip <address>', 'no standby <group> ip'],
    modes: ['interface'],
    run: (m, e, d, c) => {
      if (!m[1] && !m[3]) throw new Error('A virtual IPv4 address is required.');
      const p = currentPort(d, c);
      configureHsrp(e, d, update(d, p.id, Number(m[2]), { vip: m[1] ? undefined : m[3] }));
    },
  });
  r.register({
    pattern: /^standby (\d+) priority (\d+)$/i,
    syntax: 'standby <group> priority <priority>',
    modes: ['interface'],
    run: (m, e, d, c) =>
      configureHsrp(e, d, update(d, currentPort(d, c).id, Number(m[1]), { priority: Number(m[2]) })),
  });
  r.register({
    pattern: /^(no )?standby (\d+) preempt$/i,
    syntax: ['standby <group> preempt', 'no standby <group> preempt'],
    modes: ['interface'],
    run: (m, e, d, c) =>
      configureHsrp(e, d, update(d, currentPort(d, c).id, Number(m[2]), { preempt: !m[1] })),
  });
  r.register({
    pattern: /^standby (\d+) timers (msec )?(\d+) (msec )?(\d+)$/i,
    syntax: [
      'standby <group> timers <hello> <hold>',
      'standby <group> timers msec <hello-ms> msec <hold-ms>',
    ],
    modes: ['interface'],
    run: (m, e, d, c) =>
      configureHsrp(
        e,
        d,
        update(d, currentPort(d, c).id, Number(m[1]), {
          helloMs: Number(m[3]) * (m[2] ? 1 : 1000),
          holdMs: Number(m[5]) * (m[4] ? 1 : 1000),
        })
      ),
  });
  r.register({
    pattern: /^(no )?standby (\d+) track (\S+)(?: (\d+))?$/i,
    syntax: [
      'standby <group> track <interface> <decrement>',
      'standby <group> track <interface>',
      'no standby <group> track <interface>',
    ],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c),
        tracked = d.interfaces.find((p) => p.name.toLowerCase() === interfaceName(m[3]).toLowerCase());
      if (!tracked) throw new Error('Tracked interface does not exist.');
      const old = hsrpConfig(d).find((g) => g.port === p.id && g.group === Number(m[2]));
      configureHsrp(
        e,
        d,
        update(d, p.id, Number(m[2]), {
          track: [
            ...(old?.track ?? []).filter((t) => t.port !== tracked.id),
            ...(m[1] ? [] : [{ port: tracked.id, decrement: Number(m[4] ?? 10) }]),
          ],
        })
      );
    },
  });
  r.register({
    pattern: /^no standby (\d+)$/i,
    syntax: 'no standby <group>',
    modes: ['interface'],
    run: (m, e, d, c) =>
      configureHsrp(e, d, {
        groups: hsrpConfig(d).filter((g) => g.port !== currentPort(d, c).id || g.group !== Number(m[1])),
      }),
  });
  r.register({
    pattern: /^show standby(?: (brief))?$/i,
    syntax: ['show standby', 'show standby brief'],
    modes: EXEC_MODES,
    run: (m, e, d) => {
      const groups = d.hsrp?.groups ?? [];
      if (!groups.length) return 'No HSRP groups configured.';
      return m[1]
        ? [
            'Interface               Grp Pri P State    Active          Standby         Virtual IP',
            ...groups.map((g) => {
              const p = d.interfaces.find((p) => p.id === g.port)!,
                peers = g.peers.filter((peer) => peer.expiresAt > e.state.clock);
              return (
                p.name.padEnd(24) +
                String(g.group).padEnd(4) +
                String(g.effectivePriority).padEnd(4) +
                (g.preempt ? 'P ' : '  ') +
                g.state.padEnd(9) +
                (g.state === 'ACTIVE'
                  ? 'local'
                  : (peers.find((peer) => peer.state === 'ACTIVE')?.ip ?? 'unknown')
                ).padEnd(16) +
                (g.state === 'STANDBY'
                  ? 'local'
                  : (peers.find((peer) => peer.state === 'STANDBY')?.ip ?? 'unknown')
                ).padEnd(16) +
                (g.vip ?? 'unassigned')
              );
            }),
          ].join('\n')
        : groups
            .map((g) =>
              [
                d.interfaces.find((p) => p.id === g.port)!.name +
                  ' - Group ' +
                  g.group +
                  ' (version ' +
                  g.version +
                  ')',
                '  State is ' + g.state,
                '  Virtual IP address is ' + (g.vip ?? 'unassigned'),
                '  Virtual MAC address is ' + hsrpMac(g),
                '  Hello time ' + g.helloMs / 1000 + ' sec, hold time ' + g.holdMs / 1000 + ' sec',
                '  Priority ' +
                  g.effectivePriority +
                  ' (configured ' +
                  g.priority +
                  '), preemption ' +
                  (g.preempt ? 'enabled' : 'disabled'),
                '  ' + g.sent + ' packets sent, ' + g.received + ' received',
              ].join('\n')
            )
            .join('\n\n');
    },
  });
}
export function hsrpRunningConfig(d: Device) {
  return d.interfaces.flatMap((p) => {
    const groups = hsrpConfig(d).filter((g) => g.port === p.id);
    if (!groups.length && p.hsrpVersion === undefined) return [];
    return [
      'interface ' + p.name,
      ' standby version ' + (p.hsrpVersion ?? groups[0]?.version ?? 1),
      ...groups.flatMap((g) => [
        ...(g.vip ? [' standby ' + g.group + ' ip ' + g.vip] : []),
        ' standby ' + g.group + ' priority ' + g.priority,
        ' ' + (g.preempt ? '' : 'no ') + 'standby ' + g.group + ' preempt',
        ` standby ${g.group} timers msec ${g.helloMs} msec ${g.holdMs}`,
        ...g.objectTrack.map((t) => ` standby ${g.group} track ${t.object} decrement ${t.decrement}`),
        ...g.track.map(
          (t) =>
            ' standby ' +
            g.group +
            ' track ' +
            d.interfaces.find((p) => p.id === t.port)!.name +
            ' ' +
            t.decrement
        ),
      ]),
      'exit',
    ];
  });
}
