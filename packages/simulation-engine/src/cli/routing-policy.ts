import type { Device } from '../model';
import { bgpConfig } from '../protocols/bgp';
import { subnet } from '../protocols/ipv4';
import { ALL_MODES, type CommandRegistry } from './registry';
const policy = (d: Device) => (d.routingPolicy ??= { prefixLists: [], routeMaps: [] });
export function registerRoutingPolicy(r: CommandRegistry) {
  r.register({
    pattern:
      /^(no )?ip prefix-list ([\w-]{1,32})(?: seq (\d+))?(?: (permit|deny) ([\d.]+)\/(\d+)(?: ge (\d+))?(?: le (\d+))?)?$/i,
    modes: ['config'],
    run: (m, e, d) => {
      const p = policy(d),
        old = p.prefixLists.find((p) => p.name === m[2]);
      if (m[1] && !m[3]) {
        p.prefixLists = p.prefixLists.filter((p) => p.name !== m[2]);
        if (d.bgp) e.configureBgp(d.id, bgpConfig(d));
        return;
      }
      const list = old ?? { name: m[2], entries: [] };
      if (!old) p.prefixLists.push(list);
      const sequence = Number(m[3] ?? Math.max(0, ...list.entries.map((r) => r.sequence)) + 5);
      list.entries = list.entries.filter((r) => r.sequence !== sequence);
      if (!m[1]) {
        if (!m[4] || !m[5]) throw new Error('A prefix-list entry requires permit/deny and prefix.');
        const prefix = Number(m[6]);
        if (subnet(m[5], prefix).network !== m[5]) throw new Error('Unaligned prefix.');
        const minPrefix = m[7] ? Number(m[7]) : undefined,
          maxPrefix = m[8] ? Number(m[8]) : undefined;
        if ((minPrefix ?? prefix) < prefix || (maxPrefix ?? minPrefix ?? prefix) < (minPrefix ?? prefix))
          throw new Error('Invalid prefix length range.');
        list.entries.push({
          sequence,
          action: m[4].toLowerCase() as 'permit' | 'deny',
          network: m[5],
          prefix,
          ...(minPrefix !== undefined ? { minPrefix } : {}),
          ...(maxPrefix !== undefined ? { maxPrefix } : {}),
        });
      }
      if (d.bgp) e.configureBgp(d.id, bgpConfig(d));
    },
  });
  r.register({
    pattern: /^route-map ([\w-]{1,32}) (permit|deny)(?: (\d+))?$/i,
    modes: ['config'],
    run: (m, e, d, c) => {
      const p = policy(d),
        sequence = Number(m[3] ?? 10),
        old = p.routeMaps.find((r) => r.name === m[1] && r.sequence === sequence);
      if (old) old.action = m[2].toLowerCase() as 'permit' | 'deny';
      else
        p.routeMaps.push({
          name: m[1],
          sequence,
          action: m[2].toLowerCase() as 'permit' | 'deny',
          prefixLists: [],
          prepend: [],
        });
      c.mode = 'route-map';
      c.name = m[1];
      c.sequence = sequence;
      if (d.bgp) e.configureBgp(d.id, bgpConfig(d));
    },
  });
  r.register({
    pattern: /^match ip address prefix-list ([\w -]+)$/i,
    modes: ['route-map'],
    run: (m, e, d, c) => {
      const entry = policy(d).routeMaps.find((r) => r.name === c.name && r.sequence === c.sequence)!;
      entry.prefixLists = m[1].split(/\s+/);
      if (d.bgp) e.configureBgp(d.id, bgpConfig(d));
    },
  });
  r.register({
    pattern: /^set (local-preference|metric|as-path prepend) ([\d ]+)$/i,
    modes: ['route-map'],
    run: (m, e, d, c) => {
      const entry = policy(d).routeMaps.find((r) => r.name === c.name && r.sequence === c.sequence)!;
      if (m[1].toLowerCase() === 'metric') entry.metric = Number(m[2]);
      else if (m[1].toLowerCase() === 'local-preference') entry.localPref = Number(m[2]);
      else entry.prepend = m[2].trim().split(/\s+/).map(Number);
      if (d.bgp) e.configureBgp(d.id, bgpConfig(d));
    },
  });
  r.register({
    pattern: /^show (ip prefix-list|route-map)(?: ([\w-]+))?$/i,
    modes: ALL_MODES,
    run: (m, _e, d) =>
      JSON.stringify(
        m[1].toLowerCase() === 'route-map'
          ? d.routingPolicy?.routeMaps.filter((r) => !m[2] || r.name === m[2])
          : d.routingPolicy?.prefixLists.filter((p) => !m[2] || p.name === m[2]),
        null,
        2
      ),
  });
}
export function routingPolicyRunning(d: Device) {
  return [
    ...(d.routingPolicy?.prefixLists ?? []).flatMap((p) =>
      p.entries.map(
        (e) =>
          `ip prefix-list ${p.name} seq ${e.sequence} ${e.action} ${e.network}/${e.prefix}${e.minPrefix !== undefined ? ' ge ' + e.minPrefix : ''}${e.maxPrefix !== undefined ? ' le ' + e.maxPrefix : ''}`
      )
    ),
    ...(d.routingPolicy?.routeMaps ?? []).flatMap((r) => [
      `route-map ${r.name} ${r.action} ${r.sequence}`,
      ...(r.prefixLists.length ? [' match ip address prefix-list ' + r.prefixLists.join(' ')] : []),
      ...(r.localPref !== undefined ? [' set local-preference ' + r.localPref] : []),
      ...(r.metric !== undefined ? [' set metric ' + r.metric] : []),
      ...(r.prepend.length ? [' set as-path prepend ' + r.prepend.join(' ')] : []),
      'exit',
    ]),
  ];
}
