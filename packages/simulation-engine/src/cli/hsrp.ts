import { EXEC_MODES, CommandRegistry, currentPort } from './registry';
import { configureHsrp, hsrpConfig } from '../protocols/hsrp';
import { hsrpGroupConfigSchema, hsrpMac, type HsrpConfig, type HsrpGroup } from '../protocols/hsrp-model';
import { interfaceName } from './operational';
import { dottedMac, longInterfaceName, shortInterfaceName } from '../protocols/interface-name';
import { printSecret, readSecret } from './secrets';
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
    pattern:
      /^(no )?standby (\d+) preempt(?: (delay)(?: minimum (\d+))?(?: reload (\d+))?(?: sync (\d+))?)?$/i,
    syntax: [
      'standby <group> preempt',
      'standby <group> preempt delay minimum <seconds>',
      'standby <group> preempt delay minimum <seconds> reload <seconds>',
      'no standby <group> preempt',
    ],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const delays = [m[4], m[5], m[6]].map((s) => (s === undefined ? undefined : Number(s) * 1000));
      if (delays.some((ms) => ms !== undefined && ms > 3600000))
        throw new Error('% Delay is 0-3600 seconds.');
      if (m[3] && !m[1] && delays.every((ms) => ms === undefined)) throw new Error('% Incomplete command.');
      // "no standby N preempt delay" keeps preemption; re-entering "preempt" replaces its delays.
      configureHsrp(
        e,
        d,
        update(d, currentPort(d, c).id, Number(m[2]), {
          preempt: !m[1] || !!m[3],
          preemptDelayMs: m[1] ? undefined : delays[0],
          preemptReloadMs: m[1] ? undefined : delays[1],
          preemptSyncMs: m[1] ? undefined : delays[2],
        })
      );
    },
  });
  r.register({
    pattern: /^standby (\d+) authentication md5 key-string(?: ([07]))? (\S+)(?: timeout \d+)?$/i,
    syntax: 'standby <group> authentication md5 key-string <key>',
    modes: ['interface'],
    run: (m, e, d, c) => {
      const key = readSecret(m[2], m[3]);
      if (key.length > 64) throw new Error('% The key-string is 1-64 characters.');
      configureHsrp(
        e,
        d,
        update(d, currentPort(d, c).id, Number(m[1]), { authentication: { mode: 'md5', key } })
      );
    },
  });
  r.register({
    pattern: /^standby (\d+) authentication(?: text)? (?!md5(?:\s|$))(\S+)$/i,
    syntax: ['standby <group> authentication text <string>', 'standby <group> authentication <string>'],
    modes: ['interface'],
    run: (m, e, d, c) => {
      if (!/^[\x21-\x7e]{1,8}$/.test(m[2])) throw new Error('% The authentication string is 1-8 characters.');
      configureHsrp(
        e,
        d,
        update(d, currentPort(d, c).id, Number(m[1]), { authentication: { mode: 'text', key: m[2] } })
      );
    },
  });
  r.register({
    pattern: /^no standby (\d+) authentication(?: .*)?$/i,
    syntax: 'no standby <group> authentication',
    modes: ['interface'],
    run: (m, e, d, c) =>
      configureHsrp(e, d, update(d, currentPort(d, c).id, Number(m[1]), { authentication: undefined })),
  });
  r.register({
    pattern: /^(no )?standby (\d+) name(?: (\S+))?$/i,
    syntax: ['standby <group> name <name>', 'no standby <group> name'],
    modes: ['interface'],
    run: (m, e, d, c) => {
      if (!m[1] && !m[3]) throw new Error('% Incomplete command.');
      if (m[3] && !/^[\w.-]{1,25}$/.test(m[3])) throw new Error('% The group name is 1-25 characters.');
      configureHsrp(e, d, update(d, currentPort(d, c).id, Number(m[2]), { name: m[1] ? undefined : m[3] }));
    },
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
      if (!groups.length) return '';
      return m[1] ? showStandbyBrief(e.state.clock, d, groups) : showStandby(e.state.clock, d, groups);
    },
  });
}
const stateName = (state: string) => state[0] + state.slice(1).toLowerCase();
const seconds = (ms: number) => String(ms % 1000 ? (ms / 1000).toFixed(3) : ms / 1000);
function showStandbyBrief(now: number, d: Device, groups: HsrpGroup[]) {
  return [
    '                     P indicates configured to preempt.',
    '                     |',
    'Interface   Grp  Pri P State   Active          Standby         Virtual IP',
    ...groups.map((g) => {
      const p = d.interfaces.find((p) => p.id === g.port)!,
        peers = g.peers.filter((peer) => peer.expiresAt > now);
      const who = (state: 'ACTIVE' | 'STANDBY') =>
        g.state === state ? 'local' : (peers.find((peer) => peer.state === state)?.ip ?? 'unknown');
      return (
        shortInterfaceName(p.name).padEnd(12) +
        String(g.group).padEnd(5) +
        String(g.effectivePriority).padEnd(4) +
        (g.preempt ? 'P ' : '  ') +
        stateName(g.state).padEnd(8) +
        who('ACTIVE').padEnd(16) +
        who('STANDBY').padEnd(16) +
        (g.vip ?? 'unknown')
      );
    }),
  ].join('\n');
}
function showStandby(now: number, d: Device, groups: HsrpGroup[]) {
  return groups
    .map((g) => {
      const p = d.interfaces.find((p) => p.id === g.port)!,
        peers = g.peers.filter((peer) => peer.expiresAt > now);
      const router = (state: 'ACTIVE' | 'STANDBY') => {
        if (g.state === state) return 'local';
        const peer = peers.find((x) => x.state === state);
        return peer
          ? `${peer.ip}, priority ${peer.priority} (expires in ${((peer.expiresAt - now) / 1000).toFixed(3)} sec)`
          : 'unknown';
      };
      const auth = g.authentication;
      return [
        `${longInterfaceName(p.name)} - Group ${g.group}${g.version === 2 ? ' (version 2)' : ''}`,
        '  State is ' + stateName(g.state),
        `    last state change ${clockText(now - g.changedAt)}`,
        '  Virtual IP address is ' + (g.vip ?? 'unknown'),
        `  Active virtual MAC address is ${dottedMac(hsrpMac(g))} (MAC ${g.state === 'ACTIVE' ? 'In Use' : 'Not In Use'})`,
        `    Local virtual MAC address is ${dottedMac(hsrpMac(g))} (v${g.version} default)`,
        `  Hello time ${seconds(g.helloMs)} sec, hold time ${seconds(g.holdMs)} sec`,
        ...(g.state !== 'INIT' && g.state !== 'LISTEN'
          ? [`    Next hello sent in ${(Math.max(0, g.nextHello - now) / 1000).toFixed(3)} secs`]
          : []),
        auth?.mode === 'md5'
          ? '  Authentication MD5, key-string'
          : `  Authentication text, string "${auth?.key ?? 'cisco'}"`,
        '  Preemption ' +
          (g.preempt
            ? 'enabled' +
              (g.preemptDelayMs ? `, delay min ${g.preemptDelayMs / 1000} secs` : '') +
              (g.preemptReloadMs ? `, reload ${g.preemptReloadMs / 1000} secs` : '') +
              (g.preemptSyncMs ? `, sync ${g.preemptSyncMs / 1000} secs` : '')
            : 'disabled'),
        '  Active router is ' + router('ACTIVE'),
        '  Standby router is ' + router('STANDBY'),
        `  Priority ${g.effectivePriority} (configured ${g.priority})`,
        ...g.objectTrack.map(
          (t) =>
            `    Track object ${t.object} state ${d.monitoring?.tracks.find((o) => o.id === t.object)?.state ? 'Up' : 'Down'} decrement ${t.decrement}`
        ),
        ...g.track.map(
          (t) =>
            `    Track interface ${longInterfaceName(d.interfaces.find((x) => x.id === t.port)!.name)} decrement ${t.decrement}`
        ),
        g.name
          ? `  Group name is "${g.name}" (cfgd)`
          : `  Group name is "hsrp-${shortInterfaceName(p.name)}-${g.group}" (default)`,
      ].join('\n');
    })
    .join('\n');
}
const clockText = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
};
/** IOS defaults (version 1, priority 100, no preemption, 3/10 s timers, text "cisco") are not shown. */
export function hsrpRunningConfig(d: Device) {
  return d.interfaces.flatMap((p) => {
    const groups = hsrpConfig(d).filter((g) => g.port === p.id);
    if (!groups.length && p.hsrpVersion === undefined) return [];
    const version = p.hsrpVersion ?? groups[0]?.version ?? 1;
    return [
      'interface ' + p.name,
      ...(version === 2 ? [' standby version 2'] : []),
      ...groups.flatMap((g) => [
        ...(g.vip ? [' standby ' + g.group + ' ip ' + g.vip] : []),
        ...(g.helloMs !== 3000 || g.holdMs !== 10000
          ? [
              g.helloMs % 1000 || g.holdMs % 1000
                ? ` standby ${g.group} timers msec ${g.helloMs} msec ${g.holdMs}`
                : ` standby ${g.group} timers ${g.helloMs / 1000} ${g.holdMs / 1000}`,
            ]
          : []),
        ...(g.priority !== 100 ? [' standby ' + g.group + ' priority ' + g.priority] : []),
        ...(g.preempt
          ? [
              ' standby ' +
                g.group +
                ' preempt' +
                (g.preemptDelayMs !== undefined ||
                g.preemptReloadMs !== undefined ||
                g.preemptSyncMs !== undefined
                  ? ' delay' +
                    (g.preemptDelayMs !== undefined ? ' minimum ' + g.preemptDelayMs / 1000 : '') +
                    (g.preemptReloadMs !== undefined ? ' reload ' + g.preemptReloadMs / 1000 : '') +
                    (g.preemptSyncMs !== undefined ? ' sync ' + g.preemptSyncMs / 1000 : '')
                  : ''),
            ]
          : []),
        ...(g.authentication?.mode === 'md5'
          ? [` standby ${g.group} authentication md5 key-string ${printSecret(d, g.authentication.key)}`]
          : g.authentication && g.authentication.key !== 'cisco'
            ? [` standby ${g.group} authentication ${g.authentication.key}`]
            : []),
        ...(g.name ? [` standby ${g.group} name ${g.name}`] : []),
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
