import type { Device } from '../model';
import { bgpConfig, clearBgpPeers } from '../protocols/bgp';
import { bgpNeighborActive, bgpNeighborSchema, type BgpConfig } from '../protocols/bgp-model';
import { ALL_MODES, CONFIG_MODES, type CommandRegistry, type Context } from './registry';
import { printSecret, readSecret } from './secrets';
import { showBgpNeighborRoutes, showBgpNeighbors, showBgpSummary, showBgpTable } from './ios-show';
import { parsePrefix, subnet, ipString, mask } from '../protocols/ipv4';
import { selectOspfRouterId } from '../protocols/ospf';
import { interfaceName } from './operational';

function config(device: Device): BgpConfig {
  const value = bgpConfig(device);
  if (!value) throw new Error('Configure router bgp ASN.');
  return value;
}
function prefix(value: string) {
  const match = /^([\d.]+)\/(\d+)$/.exec(value);
  if (!match) throw new Error('Informe NETWORK/PREFIX.');
  return { network: match[1], prefix: Number(match[2]) };
}
type Neighbor = BgpConfig['neighbors'][number];
function patchNeighbor(value: BgpConfig, name: string, patch: Partial<Neighbor>) {
  const group = value.peerGroups?.find((g) => g.name === name);
  if (group) {
    Object.assign(group.settings, patch);
    for (const peer of value.neighbors.filter((p) => p.peerGroup === name))
      for (const [key, entry] of Object.entries(patch))
        if (!peer.peerGroupOverrides?.includes(key)) Object.assign(peer, { [key]: entry });
    return;
  }
  const peer = value.neighbors.find((p) => p.ip === name);
  if (!peer) throw new Error('Configure neighbor remote-as or peer-group first.');
  Object.assign(peer, patch);
  if (peer.peerGroup)
    peer.peerGroupOverrides = [...new Set([...(peer.peerGroupOverrides ?? []), ...Object.keys(patch)])];
}
export function registerBgpCommands(registry: CommandRegistry) {
  registry.register({
    pattern: /^(no )?neighbor ([\w.-]+) fall-over bfd(?: (single-hop))?(?: (strict-mode))?$/i,
    modes: ['router'],
    run: (m, e, d, c) => {
      if (c.router !== 'bgp') throw new Error('Requires BGP router mode.');
      const value = config(d);
      patchNeighbor(value, m[2], { bfd: !m[1], bfdStrict: !m[1] && !!m[4] });
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^neighbor ([\w.-]+) update-source (\S+)$/i,
    modes: ['router'],
    run: (m, e, d) => {
      const p = d.interfaces.find((p) => p.name.toLowerCase() === interfaceName(m[2]).toLowerCase());
      if (!p) throw new Error('Invalid update-source interface.');
      const value = config(d);
      patchNeighbor(value, m[1], { updateSource: p.id });
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?neighbor ([\w.-]+) ebgp-multihop(?: (\d+))?$/i,
    syntax: ['neighbor <ip|peer-group> ebgp-multihop [ttl]', 'no neighbor <ip|peer-group> ebgp-multihop'],
    modes: ['router'],
    run: (m, e, d, c) => {
      if (c.router !== 'bgp') throw new Error('Requires BGP router mode.');
      const ttl = Number(m[3] ?? 255);
      if (!m[1] && (ttl < 1 || ttl > 255)) throw new Error('Invalid TTL: use 1-255.');
      const value = config(d);
      patchNeighbor(value, m[2], { ebgpMultihop: m[1] ? undefined : ttl });
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?neighbor ([\w.-]+) disable-connected-check$/i,
    modes: ['router'],
    run: (m, e, d, c) => {
      if (c.router !== 'bgp') throw new Error('Requires BGP router mode.');
      const value = config(d);
      patchNeighbor(value, m[2], { disableConnectedCheck: m[1] ? undefined : true });
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?bgp fast-external-fallover$/i,
    syntax: ['bgp fast-external-fallover', 'no bgp fast-external-fallover'],
    modes: ['router'],
    run: (m, e, d, c) => {
      if (c.router !== 'bgp') throw new Error('Requires BGP router mode.');
      const value = config(d);
      if (m[1]) value.fastExternalFallover = false;
      else delete value.fastExternalFallover;
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?neighbor ([\w.-]+) password(?: ([07]))?(?: (\S+))?$/i,
    modes: ['router'],
    run: (m, e, d) => {
      const value = config(d);
      if (!m[1] && !m[4]) throw new Error('Password is required.');
      patchNeighbor(value, m[2], { password: m[1] ? undefined : readSecret(m[3], m[4]) });
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^neighbor ([\w-]{1,32}) peer-group$/i,
    modes: ['router'],
    run: (m, e, d, c) => {
      if (c.router !== 'bgp') throw new Error('Requires BGP router mode.');
      const value = config(d);
      if (!value.peerGroups?.some((g) => g.name === m[1]))
        value.peerGroups = [...(value.peerGroups ?? []), { name: m[1], settings: {} }];
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^neighbor ([\w-]{1,32}) remote-as (\d+)$/i,
    modes: ['router'],
    run: (m, e, d, c) => {
      if (c.router !== 'bgp') throw new Error('Requires BGP router mode.');
      const value = config(d),
        group = value.peerGroups?.find((g) => g.name === m[1]);
      if (!group) throw new Error('Configure the peer-group first.');
      group.settings.remoteAs = Number(m[2]);
      for (const peer of value.neighbors.filter(
        (p) => p.peerGroup === group.name && !p.peerGroupOverrides?.includes('remoteAs')
      ))
        peer.remoteAs = Number(m[2]);
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^neighbor ([\d.]+) peer-group ([\w-]{1,32})$/i,
    modes: ['router'],
    run: (m, e, d, c) => {
      if (c.router !== 'bgp') throw new Error('Requires BGP router mode.');
      const value = config(d),
        group = value.peerGroups?.find((g) => g.name === m[2]);
      if (!group?.settings.remoteAs) throw new Error('Configure peer-group remote-as first.');
      const old = value.neighbors.find((p) => p.ip === m[1]);
      value.neighbors = [
        ...value.neighbors.filter((p) => p.ip !== m[1]),
        bgpNeighborSchema.parse({
          ...old,
          ...group.settings,
          ip: m[1],
          peerGroup: group.name,
          peerGroupOverrides: [],
        }),
      ];
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?neighbor ([\w.-]+) (prefix-list|route-map) ([\w-]{1,32}) (in|out)$/i,
    modes: ['router', 'address-family'],
    run: (m, e, d, c) => {
      if (c.router !== 'bgp') throw new Error('Requires BGP router mode.');
      const value = config(d);
      const field = ((m[5].toLowerCase() === 'in' ? 'import' : 'export') +
        (m[3].toLowerCase() === 'prefix-list' ? 'PrefixList' : 'RouteMap')) as
        'importPrefixList' | 'exportPrefixList' | 'importRouteMap' | 'exportRouteMap';
      patchNeighbor(value, m[2], { [field]: m[1] ? undefined : m[4] });
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern:
      /^(no )?neighbor ([\w.-]+) maximum-prefix(?: (\d+)(?: (\d+))?(?: (warning-only|restart \d+))?)?$/i,
    syntax: [
      'neighbor <ip> maximum-prefix <max> [threshold] [warning-only]',
      'no neighbor <ip> maximum-prefix',
    ],
    modes: ['router', 'address-family'],
    run: (m, e, d) => {
      const value = config(d);
      if (!m[1] && !m[3]) throw new Error('Incomplete command.');
      const maximum = m[3] ? Number(m[3]) : undefined,
        threshold = m[4] ? Number(m[4]) : undefined;
      if (maximum !== undefined && (maximum < 1 || maximum > 2147483647))
        throw new Error('Invalid input detected at: ' + m[3]);
      if (threshold !== undefined && (threshold < 1 || threshold > 100))
        throw new Error('Invalid input detected at: ' + m[4]);
      patchNeighbor(value, m[2], {
        maximumPrefix: m[1] ? undefined : maximum,
        maximumPrefixThreshold: m[1] ? undefined : threshold,
        maximumPrefixWarningOnly: m[1] || !/^warning-only$/i.test(m[5] ?? '') ? undefined : true,
      });
      e.configureBgp(d.id, value);
    },
  });
  const bgpRouter = (c: Context) => {
    if (c.router !== 'bgp') throw new Error('Requires BGP router mode.');
  };
  registry.register({
    pattern: /^(no )?neighbor ([\w.-]+) description(?: (.+))?$/i,
    syntax: ['neighbor <ip> description <text>', 'no neighbor <ip> description'],
    modes: ['router', 'address-family'],
    run: (m, e, d, c) => {
      bgpRouter(c);
      const text = m[3]?.trim();
      if (!m[1] && !text) throw new Error('Incomplete command.');
      if (text && text.length > 80) throw new Error('Description exceeds 80 characters.');
      const value = config(d);
      patchNeighbor(value, m[2], { description: m[1] ? undefined : text });
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?neighbor ([\w.-]+) activate$/i,
    syntax: ['neighbor <ip> activate', 'no neighbor <ip> activate'],
    modes: ['router', 'address-family'],
    run: (m, e, d, c) => {
      bgpRouter(c);
      const value = config(d);
      // With "bgp default ipv4-unicast" (default) activation is implicit: store only the exception.
      const activate = !m[1];
      patchNeighbor(value, m[2], {
        activate: activate === (value.defaultIpv4Unicast !== false) ? undefined : activate,
      });
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?neighbor ([\w.-]+) send-community(?: (both|standard|extended))?$/i,
    syntax: ['neighbor <ip> send-community [both|standard|extended]', 'no neighbor <ip> send-community'],
    modes: ['router', 'address-family'],
    run: (m, e, d, c) => {
      bgpRouter(c);
      const value = config(d);
      const kind = (m[3]?.toLowerCase() ?? 'standard') as 'standard' | 'extended' | 'both';
      patchNeighbor(value, m[2], { sendCommunity: m[1] ? undefined : kind });
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?neighbor ([\w.-]+) soft-reconfiguration inbound$/i,
    syntax: 'neighbor <ip> soft-reconfiguration inbound',
    modes: ['router', 'address-family'],
    run: (m, e, d, c) => {
      bgpRouter(c);
      const value = config(d);
      patchNeighbor(value, m[2], { softReconfigurationInbound: m[1] ? undefined : true });
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?neighbor ([\w.-]+) default-originate(?: route-map ([\w-]{1,32}))?$/i,
    syntax: ['neighbor <ip> default-originate', 'neighbor <ip> default-originate route-map <name>'],
    modes: ['router', 'address-family'],
    run: (m, e, d, c) => {
      bgpRouter(c);
      const value = config(d);
      patchNeighbor(value, m[2], {
        defaultOriginate: m[1] ? undefined : m[3] ? { routeMap: m[3] } : true,
      });
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?neighbor ([\w.-]+) allowas-in(?: (\d+))?$/i,
    syntax: ['neighbor <ip> allowas-in [count]', 'no neighbor <ip> allowas-in'],
    modes: ['router', 'address-family'],
    run: (m, e, d, c) => {
      bgpRouter(c);
      const count = m[3] ? Number(m[3]) : 3;
      if (count < 1 || count > 10) throw new Error('Invalid input detected at: ' + m[3]);
      const value = config(d);
      patchNeighbor(value, m[2], { allowasIn: m[1] ? undefined : count });
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?neighbor ([\w.-]+) transport connection-mode passive$/i,
    syntax: 'neighbor <ip> transport connection-mode passive',
    modes: ['router', 'address-family'],
    run: (m, e, d, c) => {
      bgpRouter(c);
      const value = config(d);
      patchNeighbor(value, m[2], { passive: !m[1] });
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?bgp (log-neighbor-changes|default ipv4-unicast)$/i,
    syntax: ['bgp log-neighbor-changes', 'no bgp default ipv4-unicast'],
    modes: ['router'],
    run: (m, e, d, c) => {
      bgpRouter(c);
      const value = config(d);
      const field = /^log/i.test(m[2]) ? 'logNeighborChanges' : 'defaultIpv4Unicast';
      if (m[1]) value[field] = false;
      else delete value[field];
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?(synchronization|auto-summary)$/i,
    syntax: ['no synchronization', 'no auto-summary'],
    modes: ['router', 'address-family'],
    // IOS 15 and later default to "no synchronization" and "no auto-summary" for BGP.
    run: (m, _e, _d, c) => {
      if (c.router !== 'bgp') throw new Error('Invalid input detected at: ' + m[2]);
      if (!m[1]) throw new Error(m[2] + ' is not supported; IOS default is no ' + m[2] + '.');
    },
  });
  registry.register({
    pattern:
      /^(no )?redistribute (connected|static|rip|ospf|eigrp)(?: (\d+))?(?: metric (\d+))?(?: route-map ([\w-]{1,32}))?$/i,
    syntax: [
      'redistribute connected [metric N] [route-map NAME]',
      'redistribute static [metric N] [route-map NAME]',
      'redistribute ospf <process> [metric N] [route-map NAME]',
      'redistribute eigrp <asn> [metric N] [route-map NAME]',
    ],
    modes: ['router', 'address-family'],
    available: (_d, c) => c.router === 'bgp',
    run: (m, e, d, c) => {
      bgpRouter(c);
      const source = m[2].toLowerCase() as 'connected' | 'static' | 'rip' | 'ospf' | 'eigrp';
      const numbered = source === 'ospf' || source === 'eigrp';
      if (numbered && !m[3]) throw new Error('Incomplete command.');
      if (!numbered && m[3]) throw new Error('Invalid input detected at: ' + m[3]);
      const value = config(d);
      const process = m[3] ? Number(m[3]) : undefined;
      const others = (value.redistribute ?? []).filter(
        (entry) => entry.source !== source || entry.process !== process
      );
      const entry = {
        source,
        ...(process !== undefined ? { process } : {}),
        ...(m[4] ? { metric: Number(m[4]) } : {}),
        ...(m[5] ? { routeMap: m[5] } : {}),
      };
      value.redistribute = m[1] ? others : [...others, entry];
      if (!value.redistribute.length) delete value.redistribute;
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?aggregate-address ([\d.]+) ([\d.]+)((?: (?:as-set|summary-only))*)$/i,
    syntax: ['aggregate-address <network> <mask> [as-set] [summary-only]'],
    modes: ['router', 'address-family'],
    run: (m, e, d, c) => {
      bgpRouter(c);
      const length = parsePrefix(m[3]);
      if (subnet(m[2], length).network !== m[2]) throw new Error('Inconsistent address and mask');
      const options = m[4].toLowerCase();
      const value = config(d);
      const others = (value.aggregates ?? []).filter(
        (entry) => entry.network !== m[2] || entry.prefix !== length
      );
      value.aggregates = m[1]
        ? others
        : [
            ...others,
            {
              network: m[2],
              prefix: length,
              ...(options.includes('summary-only') ? { summaryOnly: true } : {}),
              ...(options.includes('as-set') ? { asSet: true } : {}),
            },
          ];
      if (!value.aggregates.length) delete value.aggregates;
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?timers bgp(?: (\d+) (\d+))?$/i,
    syntax: ['timers bgp <keepalive> <holdtime>', 'no timers bgp'],
    modes: ['router'],
    run: (m, e, d, c) => {
      bgpRouter(c);
      if (!m[1] && !m[2]) throw new Error('Incomplete command.');
      const hold = m[1] ? 180 : Number(m[3]);
      if (!m[1] && (hold < 3 || hold > 180 || Number(m[2]) >= hold))
        throw new Error('Invalid timers: holdtime 3-180 s and greater than keepalive.');
      const value = config(d);
      value.holdMs = (m[1] ? 180 : hold) * 1000;
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^clear ip bgp (\*|[\d.]+)(?: (soft)(?: (in|out))?| (in|out))$/i,
    syntax: ['clear ip bgp * soft', 'clear ip bgp <ip> soft in', 'clear ip bgp <ip> soft out'],
    modes: ['privileged'],
    // Policy is applied continuously, so a soft clear never needs to reset the session.
    run: (m, _e, d) => {
      if (!d.bgp) throw new Error('BGP is not running.');
      if (m[1] !== '*' && !d.bgp.peers.some((peer) => peer.ip === m[1]))
        throw new Error('No such neighbor ' + m[1]);
    },
  });
  registry.register({
    pattern: /^clear ip bgp (\*|[\d.]+)$/i,
    modes: ['privileged'],
    run: (m, e, d) => clearBgpPeers(e, d, m[1] === '*' ? undefined : m[1]),
  });
  registry.register({
    pattern: /^router bgp (\d+)$/i,
    syntax: 'router bgp <asn>',
    modes: CONFIG_MODES,
    run: (match, engine, device, context) => {
      const old = bgpConfig(device);
      if (old && old.asn !== Number(match[1])) throw new Error('BGP is already running; AS is ' + old.asn);
      const routerId = old?.routerId ?? selectOspfRouterId(device);
      if (!old)
        engine.configureBgp(device.id, {
          enabled: routerId !== '0.0.0.0',
          asn: Number(match[1]),
          routerId,
          autoRouterId: true,
          holdMs: 180000,
          networks: [],
          neighbors: [],
        });
      context.mode = 'router';
      context.router = 'bgp';
      delete context.vrf;
    },
  });
  registry.register({
    pattern: /^address-family ipv4(?: unicast)?$/i,
    syntax: ['address-family ipv4', 'address-family ipv4 unicast'],
    modes: ['router'],
    run: (_m, e, d, c) => {
      if (c.router !== 'bgp') throw new Error('IPv4 address family requires BGP router mode.');
      c.mode = 'address-family';
      // Like IOS, once the address family is used the running-config shows its block.
      const value = config(d);
      if (!value.addressFamily) e.configureBgp(d.id, { ...value, addressFamily: true });
    },
  });
  registry.register({
    pattern: /^exit-address-family$/i,
    modes: ['address-family'],
    run: (_m, _e, _d, c) => {
      c.mode = c.vrf ? 'vrf' : 'router';
    },
  });
  registry.register({
    pattern: /^(no )?network ([\d.]+) mask ([\d.]+)$/i,
    syntax: ['network <network> mask <mask>', 'no network <network> mask <mask>'],
    modes: ['router', 'address-family'],
    run: (m, e, d, c) => {
      if (c.router !== 'bgp') throw new Error('network mask requires BGP router mode.');
      const value = config(d),
        length = parsePrefix(m[3]);
      if (subnet(m[2], length).network !== m[2]) throw new Error('Prefixo BGP desalinhado.');
      value.networks = value.networks.filter((n) => n.network !== m[2] || n.prefix !== length);
      if (!m[1]) value.networks.push({ network: m[2], prefix: length });
      e.configureBgp(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?service bgp$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => engine.configureBgp(device.id, { ...config(device), enabled: !match[1] }),
  });
  registry.register({
    pattern: /^bgp (router-id|hold-time) ([\d.]+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const value = config(device);
      if (match[1].toLowerCase() === 'router-id') {
        value.routerId = match[2];
        value.autoRouterId = false;
        value.enabled = true;
      } else value.holdMs = Number(match[2]) * 1000;
      engine.configureBgp(device.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?bgp network ([\d./]+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const value = config(device),
        route = prefix(match[2]);
      value.networks = value.networks.filter(
        (entry) => entry.network !== route.network || entry.prefix !== route.prefix
      );
      if (!match[1]) value.networks.push(route);
      engine.configureBgp(device.id, value);
    },
  });
  registry.register({
    pattern: /^neighbor ([\d.]+) remote-as (\d+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const value = config(device),
        old = value.neighbors.find((peer) => peer.ip === match[1]);
      value.neighbors = value.neighbors.filter((peer) => peer.ip !== match[1]);
      value.neighbors.push(
        bgpNeighborSchema.parse({
          ...old,
          ip: match[1],
          remoteAs: Number(match[2]),
          ...(old?.peerGroup
            ? { peerGroupOverrides: [...new Set([...(old.peerGroupOverrides ?? []), 'remoteAs'])] }
            : {}),
        })
      );
      engine.configureBgp(device.id, value);
    },
  });
  registry.register({
    pattern: /^no neighbor ([\d.]+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const value = config(device);
      value.neighbors = value.neighbors.filter((peer) => peer.ip !== match[1]);
      engine.configureBgp(device.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?neighbor ([\w.-]+) (passive|next-hop-self|route-reflector-client)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const value = config(device);
      const field = {
        passive: 'passive',
        'next-hop-self': 'nextHopSelf',
        'route-reflector-client': 'reflectorClient',
      } as const;
      patchNeighbor(value, match[2], { [field[match[3].toLowerCase() as keyof typeof field]]: !match[1] });
      engine.configureBgp(device.id, value);
    },
  });
  registry.register({
    pattern: /^neighbor ([\w.-]+) (local-preference|metric|as-path-prepend) (\d+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const value = config(device);
      const field = { 'local-preference': 'localPref', metric: 'med', 'as-path-prepend': 'prepend' } as const;
      patchNeighbor(value, match[1], {
        [field[match[2].toLowerCase() as keyof typeof field]]: Number(match[3]),
      });
      engine.configureBgp(device.id, value);
    },
  });
  registry.register({
    pattern:
      /^(no )?neighbor ([\w.-]+) prefix-filter (in|out) (\d+)(?: (permit|deny) ([\d./]+)(?: ge (\d+))?(?: le (\d+))?)?$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const value = config(device),
        peer =
          value.neighbors.find((peer) => peer.ip === match[2]) ??
          value.peerGroups?.find((g) => g.name === match[2])?.settings;
      if (!peer) throw new Error('Configure neighbor IP remote-as ASN.');
      const direction = match[3].toLowerCase() === 'in' ? 'importFilter' : 'exportFilter',
        sequence = Number(match[4]);
      peer[direction] = (peer[direction] ?? []).filter((rule) => rule.sequence !== sequence);
      if (!match[1]) {
        if (!match[5] || !match[6]) throw new Error('Informe permit|deny NETWORK/PREFIX.');
        peer[direction].push({
          ...prefix(match[6]),
          sequence,
          action: match[5].toLowerCase() as 'permit' | 'deny',
          ...(match[7] ? { minPrefix: Number(match[7]) } : {}),
          ...(match[8] ? { maxPrefix: Number(match[8]) } : {}),
        });
      }
      peer[direction].sort((a, b) => a.sequence - b.sequence);
      patchNeighbor(value, match[2], { [direction]: peer[direction] });
      engine.configureBgp(device.id, value);
    },
  });
  registry.register({
    pattern:
      /^show ip bgp(?: (summary|neighbors)(?: ([\d.]+)(?: (advertised-routes|received-routes|routes))?)?)?$/i,
    syntax: [
      'show ip bgp',
      'show ip bgp summary',
      'show ip bgp neighbors',
      'show ip bgp neighbors <ip>',
      'show ip bgp neighbors <ip> advertised-routes',
      'show ip bgp neighbors <ip> received-routes',
      'show ip bgp neighbors <ip> routes',
    ],
    modes: ALL_MODES,
    run: (match, engine, device) => {
      if (!device.bgp) return '% BGP not active';
      const view = match[1]?.toLowerCase();
      if (view === 'summary') {
        if (match[2]) throw new Error('Invalid input detected at: ' + match[2]);
        return showBgpSummary(engine, device);
      }
      if (view !== 'neighbors') return showBgpTable(device);
      if (match[3]) return showBgpNeighborRoutes(device, match[2], match[3].toLowerCase());
      const all = showBgpNeighbors(engine, device);
      if (!match[2]) return all;
      const block = all.split('\n\n').find((entry) => entry.startsWith(`BGP neighbor is ${match[2]},`));
      return block ?? '% No such neighbor or address family';
    },
  });
}
export function bgpRunningConfig(device: Device) {
  const state = device.bgp;
  if (!state) return [];
  const blockStyle = !!state.addressFamily,
    indent = blockStyle ? '  ' : ' ';
  // Session settings stay under "router bgp" in both IOS layouts.
  const session = (name: string, p: Partial<Neighbor>) => [
    ...(p.remoteAs ? [` neighbor ${name} remote-as ${p.remoteAs}`] : []),
    ...(p.description ? [` neighbor ${name} description ${p.description}`] : []),
    ...(p.passive ? [` neighbor ${name} transport connection-mode passive`] : []),
    ...(p.password ? [` neighbor ${name} password ${printSecret(device, p.password)}`] : []),
    ...(p.ebgpMultihop ? [` neighbor ${name} ebgp-multihop ${p.ebgpMultihop}`] : []),
    ...(p.disableConnectedCheck ? [` neighbor ${name} disable-connected-check`] : []),
    ...(p.updateSource
      ? [` neighbor ${name} update-source ${device.interfaces.find((i) => i.id === p.updateSource)!.name}`]
      : []),
    ...(p.bfd
      ? [` neighbor ${name} fall-over bfd single-hop${p.bfdStrict ? ' strict-mode' : ''}`]
      : p.bfd === false
        ? [` no neighbor ${name} fall-over bfd`]
        : []),
  ];
  // Address-family settings: inside "address-family ipv4" once that mode was used.
  const policy = (name: string, p: Partial<Neighbor>, activated?: boolean) => [
    ...(activated === true ? [`neighbor ${name} activate`] : []),
    ...(activated === false ? [`no neighbor ${name} activate`] : []),
    ...(p.sendCommunity
      ? [`neighbor ${name} send-community${p.sendCommunity === 'standard' ? '' : ' ' + p.sendCommunity}`]
      : []),
    ...(p.reflectorClient ? [`neighbor ${name} route-reflector-client`] : []),
    ...(p.nextHopSelf ? [`neighbor ${name} next-hop-self`] : []),
    ...(p.defaultOriginate
      ? [
          `neighbor ${name} default-originate` +
            (p.defaultOriginate === true ? '' : ' route-map ' + p.defaultOriginate.routeMap),
        ]
      : []),
    ...(p.softReconfigurationInbound ? [`neighbor ${name} soft-reconfiguration inbound`] : []),
    ...(p.allowasIn ? [`neighbor ${name} allowas-in` + (p.allowasIn === 3 ? '' : ' ' + p.allowasIn)] : []),
    ...(['import', 'export'] as const).flatMap((direction) => {
      const prefix = p[`${direction}PrefixList`],
        map = p[`${direction}RouteMap`],
        dir = direction === 'import' ? 'in' : 'out';
      return [
        ...(prefix ? [`neighbor ${name} prefix-list ${prefix} ${dir}`] : []),
        ...(map ? [`neighbor ${name} route-map ${map} ${dir}`] : []),
      ];
    }),
    ...(p.maximumPrefix
      ? [
          `neighbor ${name} maximum-prefix ${p.maximumPrefix}` +
            (p.maximumPrefixThreshold ? ' ' + p.maximumPrefixThreshold : '') +
            (p.maximumPrefixWarningOnly ? ' warning-only' : ''),
        ]
      : []),
    // Simulator attributes without an IOS neighbor command (set from the BGP panel).
    ...(p.localPref !== undefined && p.localPref !== 100
      ? [`neighbor ${name} local-preference ${p.localPref}`]
      : []),
    ...(p.med ? [`neighbor ${name} metric ${p.med}`] : []),
    ...(p.prepend ? [`neighbor ${name} as-path-prepend ${p.prepend}`] : []),
    ...(['importFilter', 'exportFilter'] as const).flatMap((direction) =>
      (p[direction] ?? []).map(
        (rule) =>
          `neighbor ${name} prefix-filter ${direction === 'importFilter' ? 'in' : 'out'} ${rule.sequence} ${rule.action} ${rule.network}/${rule.prefix}${rule.minPrefix !== undefined ? ' ge ' + rule.minPrefix : ''}${rule.maxPrefix !== undefined ? ' le ' + rule.maxPrefix : ''}`
      )
    ),
  ];
  const overrides = (peer: Neighbor): Partial<Neighbor> =>
    peer.peerGroup
      ? Object.fromEntries(Object.entries(peer).filter(([key]) => peer.peerGroupOverrides?.includes(key)))
      : peer;
  // IOS prints "neighbor X activate" in the address-family block (or when activation is not implicit)
  // and "no neighbor X activate" only where "bgp default ipv4-unicast" would activate it.
  const activation = (peer: Neighbor) => {
    const active = bgpNeighborActive(state, peer),
      implicit = state.defaultIpv4Unicast !== false;
    if (active) return blockStyle || !implicit ? true : undefined;
    return implicit ? false : undefined;
  };
  const families = [
    ...state.networks.map((route) => `network ${route.network} mask ${ipString(mask(route.prefix))}`),
    ...(state.aggregates ?? []).map(
      (entry) =>
        `aggregate-address ${entry.network} ${ipString(mask(entry.prefix))}` +
        (entry.asSet ? ' as-set' : '') +
        (entry.summaryOnly ? ' summary-only' : '')
    ),
    ...(state.redistribute ?? []).map(
      (entry) =>
        `redistribute ${entry.source}` +
        (entry.process !== undefined ? ' ' + entry.process : '') +
        (entry.metric !== undefined ? ' metric ' + entry.metric : '') +
        (entry.routeMap ? ' route-map ' + entry.routeMap : '')
    ),
    ...(state.peerGroups ?? []).flatMap((group) => policy(group.name, group.settings)),
    ...state.neighbors.flatMap((peer) => policy(peer.ip, overrides(peer), activation(peer))),
  ].map((line) => indent + line);
  return [
    `router bgp ${state.asn}`,
    ...(state.autoRouterId ? [] : [` bgp router-id ${state.routerId}`]),
    ...(state.logNeighborChanges === false ? [] : [' bgp log-neighbor-changes']),
    ...(state.defaultIpv4Unicast === false ? [' no bgp default ipv4-unicast'] : []),
    ...(state.holdMs !== 180000 ? [` timers bgp ${state.holdMs / 3000} ${state.holdMs / 1000}`] : []),
    ...(state.fastExternalFallover === false ? [' no bgp fast-external-fallover'] : []),
    ...(state.peerGroups ?? []).flatMap((group) => [
      ` neighbor ${group.name} peer-group`,
      ...session(group.name, group.settings),
    ]),
    ...state.neighbors.flatMap((peer) => [
      ...(peer.peerGroup ? [` neighbor ${peer.ip} peer-group ${peer.peerGroup}`] : []),
      ...session(peer.ip, overrides(peer)),
    ]),
    ...(blockStyle ? [' !', ' address-family ipv4', ...families, ' exit-address-family'] : families),
    // BGP stopped from the simulator panel (IOS has no global equivalent).
    ...(!state.enabled && state.routerId !== '0.0.0.0' ? ['no service bgp'] : []),
    'exit',
  ];
}
