import type { Device } from '../model';
import { bgpConfig } from '../protocols/bgp';
import { bgpNeighborSchema, type BgpConfig } from '../protocols/bgp-model';
import { ALL_MODES, CONFIG_MODES, type CommandRegistry } from './registry';

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
export function registerBgpCommands(registry: CommandRegistry) {
  registry.register({
    pattern: /^router bgp (\d+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const old = bgpConfig(device);
      engine.configureBgp(device.id, {
        enabled: true,
        asn: Number(match[1]),
        routerId: old?.routerId ?? device.interfaces.find((port) => port.ip)?.ip ?? '0.0.0.0',
        holdMs: old?.holdMs ?? 90000,
        networks: old?.networks ?? [],
        neighbors: old?.neighbors ?? [],
      });
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
      if (match[1].toLowerCase() === 'router-id') value.routerId = match[2];
      else value.holdMs = Number(match[2]) * 1000;
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
      value.neighbors.push(bgpNeighborSchema.parse({ ...old, ip: match[1], remoteAs: Number(match[2]) }));
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
    pattern: /^(no )?neighbor ([\d.]+) (passive|next-hop-self|route-reflector-client)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const value = config(device),
        peer = value.neighbors.find((peer) => peer.ip === match[2]);
      if (!peer) throw new Error('Configure neighbor IP remote-as ASN.');
      const field = {
        passive: 'passive',
        'next-hop-self': 'nextHopSelf',
        'route-reflector-client': 'reflectorClient',
      } as const;
      peer[field[match[3].toLowerCase() as keyof typeof field]] = !match[1];
      engine.configureBgp(device.id, value);
    },
  });
  registry.register({
    pattern: /^neighbor ([\d.]+) (local-preference|metric|as-path-prepend) (\d+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const value = config(device),
        peer = value.neighbors.find((peer) => peer.ip === match[1]);
      if (!peer) throw new Error('Configure neighbor IP remote-as ASN.');
      const field = { 'local-preference': 'localPref', metric: 'med', 'as-path-prepend': 'prepend' } as const;
      peer[field[match[2].toLowerCase() as keyof typeof field]] = Number(match[3]);
      engine.configureBgp(device.id, value);
    },
  });
  registry.register({
    pattern:
      /^(no )?neighbor ([\d.]+) prefix-filter (in|out) (\d+)(?: (permit|deny) ([\d./]+)(?: ge (\d+))?(?: le (\d+))?)?$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const value = config(device),
        peer = value.neighbors.find((peer) => peer.ip === match[2]);
      if (!peer) throw new Error('Configure neighbor IP remote-as ASN.');
      const direction = match[3].toLowerCase() === 'in' ? 'importFilter' : 'exportFilter',
        sequence = Number(match[4]);
      peer[direction] = peer[direction].filter((rule) => rule.sequence !== sequence);
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
  return state
    ? [
        `router bgp ${state.asn}`,
        `bgp router-id ${state.routerId}`,
        `bgp hold-time ${state.holdMs / 1000}`,
        ...state.networks.map((route) => `bgp network ${route.network}/${route.prefix}`),
        ...state.neighbors.flatMap((peer) => [
          `neighbor ${peer.ip} remote-as ${peer.remoteAs}`,
          ...(peer.passive ? [`neighbor ${peer.ip} passive`] : []),
          ...(peer.nextHopSelf ? [`neighbor ${peer.ip} next-hop-self`] : []),
          ...(peer.reflectorClient ? [`neighbor ${peer.ip} route-reflector-client`] : []),
          `neighbor ${peer.ip} local-preference ${peer.localPref}`,
          `neighbor ${peer.ip} metric ${peer.med}`,
          `neighbor ${peer.ip} as-path-prepend ${peer.prepend}`,
          ...(['importFilter', 'exportFilter'] as const).flatMap((direction) =>
            peer[direction].map(
              (rule) =>
                `neighbor ${peer.ip} prefix-filter ${direction === 'importFilter' ? 'in' : 'out'} ${rule.sequence} ${rule.action} ${rule.network}/${rule.prefix}${rule.minPrefix !== undefined ? ' ge ' + rule.minPrefix : ''}${rule.maxPrefix !== undefined ? ' le ' + rule.maxPrefix : ''}`
            )
          ),
        ]),
        `${state.enabled ? '' : 'no '}service bgp`,
      ]
    : [];
}
