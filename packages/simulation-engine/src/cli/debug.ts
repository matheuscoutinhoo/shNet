import { DEBUG_KINDS, type DebugKind } from '../protocols/debug-model';
import type { Device } from '../model';
import { CONFIG_MODES, type CommandRegistry } from './registry';

const KINDS = Object.keys(DEBUG_KINDS) as DebugKind[];
// IOS subcommands that the simulator reports through the same output as their parent category.
const ALIASES: Record<string, DebugKind> = {
  'ip ospf adjacency': 'ip ospf adj',
  'ip ospf events': 'ip ospf adj',
  'ip bgp updates': 'ip bgp',
  'ip bgp events': 'ip bgp',
  'ip packet detail': 'ip packet',
  'ip nat detailed': 'ip nat',
  'standby events': 'standby',
  'standby packets': 'standby',
  'standby errors': 'standby',
  'vrrp all': 'vrrp',
  'vrrp state': 'vrrp',
  'vrrp events': 'vrrp',
};
/** The category typed, with IOS abbreviations of each keyword ("deb ip os adj"). */
function category(text: string): DebugKind {
  const words = text.trim().toLowerCase().split(/\s+/);
  const phrases: [string, DebugKind][] = [
    ...KINDS.map((k): [string, DebugKind] => [k, k]),
    ...Object.entries(ALIASES),
  ];
  const exact = phrases.find(([phrase]) => phrase === words.join(' '));
  if (exact) return exact[1];
  const matches = phrases.filter(([phrase]) => {
    const parts = phrase.split(' ');
    return parts.length === words.length && parts.every((part, i) => part.startsWith(words[i]));
  });
  if (!matches.length || new Set(matches.map(([, kind]) => kind)).size > 1)
    throw new Error("Invalid input detected at '^' marker.");
  return matches[0][1];
}
const ios = (d: Device) => {
  if (d.type !== 'router' && d.type !== 'switch') throw new Error("Invalid input detected at '^' marker.");
};
export function registerDebugCommands(r: CommandRegistry) {
  const off = (d: Device) => {
    delete d.debug;
    return 'All possible debugging has been turned off';
  };
  r.register({
    pattern: /^(no )?debug (.+)$/i,
    syntax: [...KINDS.map((k) => 'debug ' + k), 'no debug all'],
    modes: ['privileged', ...CONFIG_MODES],
    run: (m, _e, d) => {
      ios(d);
      if (/^all$/i.test(m[2].trim())) {
        if (m[1]) return off(d);
        throw new Error('"debug all" would overwhelm the console; enable specific debugging instead.');
      }
      const kind = category(m[2]),
        [, text] = DEBUG_KINDS[kind];
      d.debug = [...(d.debug ?? []).filter((k) => k !== kind), ...(m[1] ? [] : [kind])];
      if (!d.debug.length) delete d.debug;
      return m[1] ? text.replace(/ is on(\.?)$/, ' is off$1') : text;
    },
  });
  r.register({
    pattern: /^(?:undebug|undebu|undeb|unde|und|un|u) (.+)$/i,
    syntax: ['undebug all', ...KINDS.map((k) => 'undebug ' + k)],
    modes: ['privileged'],
    run: (m, _e, d) => {
      ios(d);
      if (/^all$/i.test(m[1].trim())) return off(d);
      const kind = category(m[1]);
      d.debug = (d.debug ?? []).filter((k) => k !== kind);
      if (!d.debug.length) delete d.debug;
      return DEBUG_KINDS[kind][1].replace(/ is on(\.?)$/, ' is off$1');
    },
  });
  r.register({
    pattern: /^show debug(?:ging)?$/i,
    syntax: 'show debugging',
    modes: ['privileged', ...CONFIG_MODES],
    run: (_m, _e, d) => {
      const groups = new Map<string, string[]>();
      for (const kind of d.debug ?? []) {
        const [group, text] = DEBUG_KINDS[kind];
        groups.set(group, [...(groups.get(group) ?? []), '  ' + text]);
      }
      return [...groups].flatMap(([group, lines]) => [group + ':', ...lines]).join('\n');
    },
  });
}
