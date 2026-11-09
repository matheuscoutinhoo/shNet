import type { Device, FirewallSession, ZbfConfig } from '../model';
import { firewallZone, sessionPacket, zoneRule } from '../protocols/firewall-policy';
import { longInterfaceName } from '../protocols/interface-name';
import { applyZbf, ZBF_PROTOCOLS, zbfApplication, zbfClasses } from '../protocols/zbf';
import { ALL_MODES, currentPort, type CommandRegistry } from './registry';

/**
 * Native IOS zone-based policy firewall: security zones, inspect class-maps and policy-maps,
 * zone-pairs and "zone-member security". The configuration is compiled into the firewall zone
 * policy that the forwarding plane enforces (protocols/zbf.ts).
 */
const NAME = /^[a-zA-Z0-9][\w-]{0,31}$/;
const ZONE = /^[a-zA-Z][\w-]{0,31}$/;
const INVALID = "% Invalid input detected at '^' marker.";
function zbfOf(d: Device): ZbfConfig {
  if (!d.zbf && d.firewall?.zonePolicy)
    throw new Error(
      '% The simulator zone firewall (firewall mode zones) is configured; use "firewall mode trusted" before configuring IOS security zones.'
    );
  return (d.zbf ??= { zones: [], classMaps: [], policyMaps: [], zonePairs: [] });
}
function named<T extends { name: string }>(list: T[] | undefined, name: string | undefined, kind: string) {
  const found = list?.find((entry) => entry.name === name);
  if (!found) throw new Error(`% ${kind} ${name ?? ''} does not exist.`);
  return found;
}
function checkName(name: string, pattern = NAME) {
  if (!pattern.test(name) || name.toLowerCase() === 'class-default') throw new Error(INVALID);
}
// Whether matching class-map "inner" inside "outer" would make "outer" match itself.
function nests(z: ZbfConfig, outer: string, inner: string, depth = 0): boolean {
  if (outer === inner || depth > 8) return true;
  return !!z.classMaps
    .find((map) => map.name === inner)
    ?.matches.some((m) => 'classMap' in m && nests(z, outer, m.classMap, depth + 1));
}
const matchText = (m: ZbfConfig['classMaps'][number]['matches'][number]) =>
  'protocol' in m
    ? 'protocol ' + m.protocol
    : 'acl' in m
      ? (/^\d+$/.test(m.acl) ? 'access-group ' : 'access-group name ') + m.acl
      : 'class-map ' + m.classMap;
const actionText = (entry: { action?: string; log?: boolean }) => {
  const action = entry.action ?? 'drop';
  return action[0].toUpperCase() + action.slice(1) + (entry.log ? ' log' : '');
};
const SIS_STATE: Record<string, string> = {
  'SYN-SENT': 'SIS_OPENING',
  'SYN-RECEIVED': 'SIS_OPENING',
  CLOSING: 'SIS_CLOSING',
};
const sisState = (s: FirewallSession) =>
  s.protocol === 'TCP' ? (SIS_STATE[s.state] ?? 'SIS_OPEN') : 'SIS_OPEN';

export function registerZbfCommands(r: CommandRegistry) {
  r.register({
    pattern: /^(no )?zone security (\S+)$/i,
    syntax: 'zone security <name>',
    modes: ['config'],
    run: (m, e, d, c) => {
      const name = m[2];
      if (name === 'self') throw new Error('% The self zone is system defined.');
      checkName(name, ZONE);
      const z = zbfOf(d),
        exists = z.zones.some((zone) => zone.name === name);
      if (m[1]) {
        if (!exists) throw new Error(`% Zone ${name} does not exist.`);
        if (d.interfaces.some((port) => port.zoneMember === name))
          throw new Error(
            `% Zone ${name} has member interfaces; remove "zone-member security" from them first.`
          );
        const pair = z.zonePairs.find((p) => p.source === name || p.destination === name);
        if (pair) throw new Error(`% Zone ${name} is used by zone-pair ${pair.name}.`);
        z.zones = z.zones.filter((zone) => zone.name !== name);
        applyZbf(e, d);
        return;
      }
      if (!exists) {
        if (z.zones.length >= 16) throw new Error('% At most 16 security zones.');
        z.zones.push({ name });
      }
      applyZbf(e, d);
      c.mode = 'zbf-zone';
      c.name = name;
    },
  });
  r.register({
    pattern: /^(no )?description(?: (.{1,200}))?$/i,
    syntax: 'description <text...>',
    modes: ['zbf-zone'],
    run: (m, _e, d, c) => {
      const zone = named(d.zbf?.zones, c.name, 'Zone');
      if (m[1]) delete zone.description;
      else if (!m[2]) throw new Error('% Incomplete command.');
      else zone.description = m[2];
    },
  });
  r.register({
    pattern: /^(no )?class-map type inspect(?: (match-any|match-all))? (\S+)$/i,
    syntax: [
      'class-map type inspect match-any <name>',
      'class-map type inspect match-all <name>',
      'class-map type inspect <name>',
    ],
    modes: ['config'],
    run: (m, e, d, c) => {
      const name = m[3];
      checkName(name);
      const z = zbfOf(d),
        existing = z.classMaps.find((map) => map.name === name);
      if (m[1]) {
        if (!existing) throw new Error(`% Class-map ${name} does not exist.`);
        const user =
          z.policyMaps.find((p) => p.classes.some((entry) => entry.className === name)) ??
          z.classMaps.find((map) => map.matches.some((x) => 'classMap' in x && x.classMap === name));
        if (user) throw new Error(`% Class-map ${name} is being used by ${user.name}.`);
        z.classMaps = z.classMaps.filter((map) => map.name !== name);
        applyZbf(e, d);
        return;
      }
      if (!existing) {
        if (z.classMaps.length >= 64) throw new Error('% At most 64 inspect class-maps.');
        z.classMaps.push({ name, matchAll: m[2]?.toLowerCase() !== 'match-any', matches: [] });
      } else if (m[2]) existing.matchAll = m[2].toLowerCase() === 'match-all';
      applyZbf(e, d);
      c.mode = 'zbf-class-map';
      c.name = name;
    },
  });
  r.register({
    pattern: /^(no )?match (protocol|access-group name|access-group|class-map) (\S+)$/i,
    syntax: [
      'match protocol <name>',
      'match access-group name <acl>',
      'match access-group <number>',
      'match class-map <name>',
    ],
    modes: ['zbf-class-map'],
    run: (m, e, d, c) => {
      const z = zbfOf(d),
        map = named(z.classMaps, c.name, 'Class-map'),
        kind = m[2].toLowerCase(),
        value = m[3];
      let entry: ZbfConfig['classMaps'][number]['matches'][number];
      if (kind === 'protocol') {
        if (!ZBF_PROTOCOLS[value.toLowerCase()]) throw new Error(INVALID);
        entry = { protocol: value.toLowerCase() };
      } else if (kind.startsWith('access-group')) {
        if (!/^[\w-]{1,32}$/.test(value) || (kind === 'access-group' && !/^\d+$/.test(value)))
          throw new Error(INVALID);
        entry = { acl: value };
      } else {
        if (!m[1]) {
          named(z.classMaps, value, 'Class-map');
          if (nests(z, map.name, value)) throw new Error('% A class-map cannot match itself.');
        }
        entry = { classMap: value };
      }
      const key = JSON.stringify(entry);
      map.matches = map.matches.filter((x) => JSON.stringify(x) !== key);
      if (!m[1]) {
        if (map.matches.length >= 32) throw new Error('% At most 32 match statements per class-map.');
        map.matches.push(entry);
      }
      applyZbf(e, d);
    },
  });
  r.register({
    pattern: /^(no )?policy-map type inspect (\S+)$/i,
    syntax: 'policy-map type inspect <name>',
    modes: ['config'],
    run: (m, e, d, c) => {
      const name = m[2];
      checkName(name);
      const z = zbfOf(d),
        exists = z.policyMaps.some((p) => p.name === name);
      if (m[1]) {
        if (!exists) throw new Error(`% Policy-map ${name} does not exist.`);
        const pair = z.zonePairs.find((p) => p.policy === name);
        if (pair) throw new Error(`% Policy-map ${name} is attached to zone-pair ${pair.name}.`);
        z.policyMaps = z.policyMaps.filter((p) => p.name !== name);
        applyZbf(e, d);
        return;
      }
      if (!exists) {
        if (z.policyMaps.length >= 32) throw new Error('% At most 32 inspect policy-maps.');
        z.policyMaps.push({ name, classes: [] });
      }
      applyZbf(e, d);
      c.mode = 'zbf-policy-map';
      c.name = name;
    },
  });
  r.register({
    pattern: /^(no )?class (?:type inspect (\S+)|class-default)$/i,
    syntax: ['class type inspect <class-map>', 'class class-default'],
    modes: ['zbf-policy-map'],
    run: (m, e, d, c) => {
      const z = zbfOf(d),
        policy = named(z.policyMaps, c.name, 'Policy-map'),
        className = m[2] ?? 'class-default';
      if (m[1]) {
        policy.classes = policy.classes.filter((entry) => entry.className !== className);
        applyZbf(e, d);
        return;
      }
      if (className !== 'class-default') named(z.classMaps, className, 'Class-map');
      if (!policy.classes.some((entry) => entry.className === className)) {
        if (policy.classes.length >= 32) throw new Error('% At most 32 classes per policy-map.');
        policy.classes.push({ className });
      }
      applyZbf(e, d);
      c.mode = 'zbf-policy-class';
      c.className = className;
    },
  });
  r.register({
    pattern: /^(no )?(inspect|pass|drop)(?: (log))?$/i,
    syntax: ['inspect', 'pass', 'pass log', 'drop', 'drop log'],
    modes: ['zbf-policy-class'],
    run: (m, e, d, c) => {
      const entry = named(d.zbf?.policyMaps, c.name, 'Policy-map').classes.find(
        (x) => x.className === c.className
      );
      if (!entry) throw new Error(`% Class ${c.className ?? ''} does not exist.`);
      const action = m[2].toLowerCase() as 'inspect' | 'pass' | 'drop';
      if (action === 'inspect' && m[3]) throw new Error(INVALID);
      if (m[1]) {
        if ((entry.action ?? 'drop') === action) {
          delete entry.action;
          delete entry.log;
        }
      } else {
        entry.action = action;
        if (m[3]) entry.log = true;
        else delete entry.log;
      }
      applyZbf(e, d);
    },
  });
  r.register({
    pattern: /^(no )?zone-pair security (\S+)(?: source (\S+) destination (\S+))?$/i,
    syntax: 'zone-pair security <name> source <zone> destination <zone>',
    modes: ['config'],
    run: (m, e, d, c) => {
      const name = m[2];
      checkName(name);
      const z = zbfOf(d),
        existing = z.zonePairs.find((p) => p.name === name);
      if (m[1]) {
        if (!existing) throw new Error(`% Zone-pair ${name} does not exist.`);
        z.zonePairs = z.zonePairs.filter((p) => p.name !== name);
        applyZbf(e, d);
        return;
      }
      if (!m[3]) {
        if (!existing) throw new Error('% Incomplete command.');
      } else {
        const [source, destination] = [m[3], m[4]];
        for (const zone of [source, destination])
          if (zone !== 'self' && !z.zones.some((entry) => entry.name === zone))
            throw new Error(`% Zone ${zone} does not exist.`);
        if (source === 'self' && destination === 'self')
          throw new Error('% Source and destination cannot both be the self zone.');
        if (existing && (existing.source !== source || existing.destination !== destination))
          throw new Error(`% Zone-pair ${name} already exists with different zones.`);
        const twin = z.zonePairs.find(
          (p) => p.name !== name && p.source === source && p.destination === destination
        );
        if (twin)
          throw new Error(
            `% Zone-pair ${twin.name} already has source ${source} and destination ${destination}.`
          );
        if (!existing) {
          if (z.zonePairs.length >= 32) throw new Error('% At most 32 zone-pairs.');
          z.zonePairs.push({ name, source, destination });
        }
      }
      applyZbf(e, d);
      c.mode = 'zbf-zone-pair';
      c.name = name;
    },
  });
  r.register({
    pattern: /^(no )?service-policy type inspect (\S+)$/i,
    syntax: 'service-policy type inspect <policy-map>',
    modes: ['zbf-zone-pair'],
    run: (m, e, d, c) => {
      const pair = named(d.zbf?.zonePairs, c.name, 'Zone-pair');
      if (m[1]) {
        if (pair.policy === m[2]) delete pair.policy;
      } else {
        named(d.zbf?.policyMaps, m[2], 'Policy-map');
        pair.policy = m[2];
      }
      applyZbf(e, d);
    },
  });
  r.register({
    pattern: /^(no )?zone-member security(?: (\S+))?$/i,
    syntax: 'zone-member security <zone>',
    modes: ['interface'],
    run: (m, e, d, c) => {
      const port = currentPort(d, c);
      if (m[1]) {
        delete port.zoneMember;
        if (d.zbf) applyZbf(e, d);
        return;
      }
      if (!m[2]) throw new Error('% Incomplete command.');
      if (!d.zbf?.zones.some((zone) => zone.name === m[2])) throw new Error(`% Zone ${m[2]} does not exist.`);
      port.zoneMember = m[2];
      applyZbf(e, d);
    },
  });
  r.register({
    pattern: /^show zone security(?: (\S+))?$/i,
    syntax: ['show zone security', 'show zone security <zone>'],
    modes: ALL_MODES,
    run: (m, _e, d) => {
      const zones = [{ name: 'self', description: 'System defined zone' }, ...(d.zbf?.zones ?? [])].filter(
        (zone) => !m[1] || zone.name === m[1]
      );
      if (!zones.length) throw new Error(`% Zone ${m[1]} does not exist.`);
      return zones
        .map((zone) => {
          const members = d.interfaces.filter((port) => port.zoneMember === zone.name);
          return [
            'zone ' + zone.name,
            ...(zone.description ? ['  Description: ' + zone.description] : []),
            ...(members.length
              ? ['  Member Interfaces:', ...members.map((port) => '    ' + longInterfaceName(port.name))]
              : []),
          ].join('\n');
        })
        .join('\n\n');
    },
  });
  r.register({
    pattern: /^show zone-pair security$/i,
    syntax: 'show zone-pair security',
    modes: ALL_MODES,
    run: (_m, _e, d) =>
      (d.zbf?.zonePairs ?? [])
        .map((pair) =>
          [
            'Zone-pair name ' + pair.name,
            `    Source-Zone ${pair.source}  Destination-Zone ${pair.destination}`,
            '    service-policy ' + (pair.policy ?? 'not configured'),
          ].join('\n')
        )
        .join('\n'),
  });
  r.register({
    pattern: /^show class-map type inspect(?: (\S+))?$/i,
    syntax: ['show class-map type inspect', 'show class-map type inspect <name>'],
    modes: ALL_MODES,
    run: (m, _e, d) => {
      const maps = (d.zbf?.classMaps ?? []).filter((map) => !m[1] || map.name === m[1]);
      if (m[1] && !maps.length) throw new Error(`% Class-map ${m[1]} does not exist.`);
      return maps
        .map((map, index) =>
          [
            ` Class Map type inspect ${map.matchAll ? 'match-all' : 'match-any'} ${map.name} (id ${index + 1})`,
            ...map.matches.map((x) => '   Match ' + matchText(x)),
          ].join('\n')
        )
        .join('\n\n');
    },
  });
  r.register({
    pattern: /^show policy-map type inspect(?: (?!zone-pair(?:\s|$))(\S+))?$/i,
    syntax: ['show policy-map type inspect', 'show policy-map type inspect <name>'],
    modes: ALL_MODES,
    run: (m, _e, d) => {
      const policies = (d.zbf?.policyMaps ?? []).filter((p) => !m[1] || p.name === m[1]);
      if (m[1] && !policies.length) throw new Error(`% Policy-map ${m[1]} does not exist.`);
      return policies
        .map((policy) =>
          [
            '  Policy Map type inspect ' + policy.name,
            ...zbfClasses(policy).flatMap((entry) => [
              '    Class ' + entry.className,
              '      ' + actionText(entry),
            ]),
          ].join('\n')
        )
        .join('\n\n');
    },
  });
  r.register({
    pattern: /^show policy-map type inspect zone-pair(?: (?!sessions$)(\S+))?(?: (sessions))?$/i,
    syntax: [
      'show policy-map type inspect zone-pair',
      'show policy-map type inspect zone-pair sessions',
      'show policy-map type inspect zone-pair <name>',
      'show policy-map type inspect zone-pair <name> sessions',
    ],
    modes: ALL_MODES,
    run: (m, e, d) => showZonePairPolicies(d, e.state.clock, m[1], !!m[2]),
  });
}
function showZonePairPolicies(d: Device, now: number, name: string | undefined, detail: boolean) {
  const z = d.zbf;
  const pairs = (z?.zonePairs ?? []).filter((pair) => !name || pair.name === name);
  if (name && !pairs.length) throw new Error(`% Zone-pair ${name} does not exist.`);
  const sessions = (d.firewall?.sessions ?? []).filter((s) => s.expiresAt > now);
  return pairs
    .filter((pair) => pair.policy)
    .map((pair) => {
      const policy = z!.policyMaps.find((p) => p.name === pair.policy)!;
      // Sessions belong to the class whose rule admitted their first packet.
      const owned = sessions.filter(
        (s) => firewallZone(d, s.inside) === pair.source && firewallZone(d, s.outside) === pair.destination
      );
      const classOf = (s: FirewallSession) =>
        zoneRule(
          d,
          pair.source,
          pair.destination,
          s.protocol,
          s.protocol === 'ICMP' ? undefined : s.serverPort,
          sessionPacket(s)
        )?.className;
      const lines = [
        '',
        'policy exists on zp ' + pair.name,
        '  Zone-pair: ' + pair.name,
        '',
        '  Service-policy inspect : ' + policy.name,
      ];
      for (const entry of zbfClasses(policy)) {
        const map = z!.classMaps.find((x) => x.name === entry.className);
        lines.push(
          '',
          `    Class-map: ${entry.className} (${map && map.matchAll ? 'match-all' : 'match-any'})`,
          ...(map ? map.matches.map((x) => '      Match: ' + matchText(x)) : ['      Match: any']),
          '      ' + actionText(entry)
        );
        if (entry.action !== 'inspect') continue;
        const mine = owned.filter((s) => classOf(s) === entry.className);
        const half = mine.filter((s) => sisState(s) === 'SIS_OPENING').length,
          closing = mine.filter((s) => sisState(s) === 'SIS_CLOSING').length;
        lines.push(
          `        Current session counts (estab/half-open/terminating) [${mine.length - half - closing}:${half}:${closing}]`
        );
        if (!detail || !mine.length) continue;
        lines.push('        Established Sessions');
        for (const s of mine) {
          const id = Number(/\d+$/.exec(s.id)?.[0] ?? 0)
            .toString(16)
            .toUpperCase()
            .padStart(8, '0');
          const [client, server] = s.protocol === 'ICMP' ? [0, 0] : [s.clientPort, s.serverPort];
          lines.push(
            `         Session ${id} (${s.clientIp}:${client})=>(${s.serverIp}:${server}) ${zbfApplication(s.protocol, s.protocol === 'ICMP' ? undefined : s.serverPort)}:${s.protocol.toLowerCase()} ${sisState(s)}`
          );
        }
      }
      return lines.join('\n');
    })
    .join('\n');
}
/** Class-maps (nested ones first), policy-maps, zones and zone-pairs, before the interfaces. */
export function zbfRunningConfig(d: Device) {
  const z = d.zbf;
  if (!z) return [];
  const ordered: ZbfConfig['classMaps'] = [];
  const visit = (map: ZbfConfig['classMaps'][number], depth: number) => {
    if (ordered.includes(map) || depth > 8) return;
    for (const x of map.matches)
      if ('classMap' in x) {
        const inner = z.classMaps.find((entry) => entry.name === x.classMap);
        if (inner) visit(inner, depth + 1);
      }
    ordered.push(map);
  };
  for (const map of z.classMaps) visit(map, 0);
  return [
    ...ordered.flatMap((map) => [
      `class-map type inspect ${map.matchAll ? 'match-all' : 'match-any'} ${map.name}`,
      ...map.matches.map((x) => ' match ' + matchText(x)),
      'exit',
    ]),
    ...z.policyMaps.flatMap((policy) => [
      'policy-map type inspect ' + policy.name,
      ...zbfClasses(policy).flatMap((entry) => [
        entry.className === 'class-default'
          ? ' class class-default'
          : ' class type inspect ' + entry.className,
        ...(entry.action || entry.className === 'class-default'
          ? ['  ' + (entry.action ?? 'drop') + (entry.log ? ' log' : '')]
          : []),
      ]),
      'exit',
    ]),
    ...z.zones.flatMap((zone) => [
      'zone security ' + zone.name,
      ...(zone.description ? [' description ' + zone.description] : []),
      'exit',
    ]),
    ...z.zonePairs.flatMap((pair) => [
      `zone-pair security ${pair.name} source ${pair.source} destination ${pair.destination}`,
      ...(pair.policy ? [' service-policy type inspect ' + pair.policy] : []),
      'exit',
    ]),
  ];
}
