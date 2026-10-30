import type { Device } from '../model';
import { bgpConfig, clearBgpPeers } from '../protocols/bgp';
import { bgpNeighborSchema, type BgpConfig } from '../protocols/bgp-model';
import { ALL_MODES, CONFIG_MODES, type CommandRegistry } from './registry';
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
    pattern: /^(no )?neighbor ([\w.-]+) password(?: 0)?(?: (\S+))?$/i,
    modes: ['router'],
    run: (m, e, d) => {
      const value = config(d);
      if (!m[1] && !m[3]) throw new Error('Password is required.');
      patchNeighbor(value, m[2], { password: m[1] ? undefined : m[3] });
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
    pattern: /^neighbor ([\w.-]+) maximum-prefix (\d+)$/i,
    modes: ['router', 'address-family'],
    run: (m, e, d) => {
      const value = config(d);
      patchNeighbor(value, m[1], { maximumPrefix: Number(m[2]) });
      e.configureBgp(d.id, value);
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
      const routerId = old?.routerId ?? selectOspfRouterId(device);
      engine.configureBgp(device.id, {
        enabled: routerId !== '0.0.0.0',
        asn: Number(match[1]),
        routerId,
        autoRouterId: old?.autoRouterId ?? true,
        holdMs: old?.holdMs ?? 90000,
        networks: old?.networks ?? [],
        neighbors: old?.neighbors ?? [],
        peerGroups: old?.peerGroups,
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
    run: (_m, _e, _d, c) => {
      if (c.router !== 'bgp') throw new Error('IPv4 address family requires BGP router mode.');
      c.mode = 'address-family';
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
    pattern: /^show ip bgp(?: (summary|neighbors))?$/i,
    modes: ALL_MODES,
    run: (match, _engine, device) => {
      const state = device.bgp;
      if (!state) return 'BGP não configurado.';
      if (match[1])
        return (
          `BGP AS ${state.asn}, Router ID ${state.routerId}\n` +
          state.peers
            .map(
              (peer) =>
                `${peer.ip} AS ${state.neighbors.find((config) => config.ip === peer.ip)!.remoteAs} ${peer.state} · ${peer.connection ?? 'sem TCP'} · TX/RX ${peer.sent}/${peer.received} · prefixos ${state.rib.filter((path) => path.peer === peer.ip).length}`
            )
            .join('\n')
        );
      return (
        'PREFIXO             NEXT_HOP         LOCAL_PREF MED AS_PATH\n' +
        state.rib
          .map(
            (path) =>
              `${device.bgp!.routes.some((route) => route.peer === path.peer && route.network === path.network && route.prefix === path.prefix) ? '>' : ' '}${(path.network + '/' + path.prefix).padEnd(20)}${path.nextHop.padEnd(17)}${path.localPref} ${path.med} ${path.asPath.join(' ')} ${path.origin}`
          )
          .join('\n')
      );
    },
  });
}
export function bgpRunningConfig(device: Device) {
  const state = device.bgp;
  const options = (name: string, p: Partial<Neighbor>) => [
    ...(p.bfd
      ? [`neighbor ${name} fall-over bfd single-hop${p.bfdStrict ? ' strict-mode' : ''}`]
      : p.bfd === false
        ? [`no neighbor ${name} fall-over bfd`]
        : []),
    ...(p.remoteAs ? [`neighbor ${name} remote-as ${p.remoteAs}`] : []),
    ...(p.updateSource
      ? [`neighbor ${name} update-source ${device.interfaces.find((i) => i.id === p.updateSource)!.name}`]
      : []),
    ...(p.maximumPrefix ? [`neighbor ${name} maximum-prefix ${p.maximumPrefix}`] : []),
    ...(p.password ? [`neighbor ${name} password 0 ${p.password}`] : []),
    ...(['import', 'export'] as const).flatMap((direction) => {
      const prefix = p[`${direction}PrefixList`],
        map = p[`${direction}RouteMap`],
        dir = direction === 'import' ? 'in' : 'out';
      return [
        ...(prefix ? [`neighbor ${name} prefix-list ${prefix} ${dir}`] : []),
        ...(map ? [`neighbor ${name} route-map ${map} ${dir}`] : []),
      ];
    }),
    ...(['passive', 'nextHopSelf', 'reflectorClient'] as const).flatMap((field) =>
      p[field] !== undefined
        ? [
            `${p[field] ? '' : 'no '}neighbor ${name} ${{ passive: 'passive', nextHopSelf: 'next-hop-self', reflectorClient: 'route-reflector-client' }[field]}`,
          ]
        : []
    ),
    ...(['localPref', 'med', 'prepend'] as const).flatMap((field) =>
      p[field] !== undefined
        ? [
            `neighbor ${name} ${{ localPref: 'local-preference', med: 'metric', prepend: 'as-path-prepend' }[field]} ${p[field]}`,
          ]
        : []
    ),
    ...(['importFilter', 'exportFilter'] as const).flatMap((direction) =>
      (p[direction] ?? []).map(
        (rule) =>
          `neighbor ${name} prefix-filter ${direction === 'importFilter' ? 'in' : 'out'} ${rule.sequence} ${rule.action} ${rule.network}/${rule.prefix}${rule.minPrefix !== undefined ? ' ge ' + rule.minPrefix : ''}${rule.maxPrefix !== undefined ? ' le ' + rule.maxPrefix : ''}`
      )
    ),
  ];
  return state
    ? [
        `router bgp ${state.asn}`,
        `bgp router-id ${state.routerId}`,
        `bgp hold-time ${state.holdMs / 1000}`,
        ...(state.peerGroups ?? []).flatMap((g) => [
          `neighbor ${g.name} peer-group`,
          ...options(g.name, g.settings),
        ]),
        ...state.networks.map((route) => `network ${route.network} mask ${ipString(mask(route.prefix))}`),
        ...state.neighbors.flatMap((peer) =>
          peer.peerGroup
            ? [
                `neighbor ${peer.ip} peer-group ${peer.peerGroup}`,
                ...options(
                  peer.ip,
                  Object.fromEntries(
                    Object.entries(peer).filter(([key]) => peer.peerGroupOverrides?.includes(key))
                  )
                ),
              ]
            : options(peer.ip, peer)
        ),
        `${state.enabled ? '' : 'no '}service bgp`,
      ]
    : [];
}
