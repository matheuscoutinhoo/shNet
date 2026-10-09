import type { Device, Snapshot } from '../model';
import { isUnicast } from './dhcp-config';
import { bgpPrefixKey, type BgpConfig } from './bgp-model';
import { installedBgpRoutes, validBgpPrefix } from './bgp-routing';

export function validateBgpConfig(device: Device, config: BgpConfig) {
  if (
    (device.type !== 'router' && !(device.type === 'switch' && device.ipRouting)) ||
    !isUnicast(config.routerId)
  )
    throw new Error('BGP exige roteador e Router ID unicast.');
  if (device.tcpServices?.some((service) => service.port === 179 && service.enabled))
    throw new Error('TCP/179 está ocupado por outro serviço.');
  if (
    new Set(config.neighbors.map((peer) => peer.ip)).size !== config.neighbors.length ||
    new Set(config.networks.map(bgpPrefixKey)).size !== config.networks.length ||
    config.networks.some((prefix) => !validBgpPrefix(prefix))
  )
    throw new Error('Rede BGP desalinhada ou configuração duplicada.');
  for (const peer of config.neighbors) {
    if (
      !isUnicast(peer.ip) ||
      device.interfaces.some((port) => port.ip === peer.ip) ||
      (peer.reflectorClient && peer.remoteAs !== config.asn)
    )
      throw new Error('Vizinho BGP inválido; cliente de reflexão exige iBGP.');
    for (const list of [peer.importFilter, peer.exportFilter])
      if (new Set(list.map((rule) => rule.sequence)).size !== list.length)
        throw new Error('Sequência de filtro BGP duplicada.');
    for (const filter of [...peer.importFilter, ...peer.exportFilter])
      if (
        !validBgpPrefix(filter) ||
        (filter.minPrefix ?? filter.prefix) < filter.prefix ||
        (filter.maxPrefix ?? filter.minPrefix ?? filter.prefix) < (filter.minPrefix ?? filter.prefix)
      )
        throw new Error('Filtro BGP possui prefixo ou intervalo inválido.');
  }
}
export function validateBgp(snapshot: Snapshot) {
  const usedTimers = new Set<object>();
  for (const device of snapshot.devices) {
    const state = device.bgp;
    if (!state) continue;
    validateBgpConfig(device, state);
    if (
      state.peers.length !== state.neighbors.length ||
      new Set(state.peers.map((peer) => peer.ip)).size !== state.peers.length ||
      state.peers.some((peer) => !state.neighbors.some((config) => config.ip === peer.ip))
    )
      throw new Error('Referências de peers BGP inválidas.');
    const timers = snapshot.queue.filter(
      ({ action }) => action.kind === 'bgp-tick' && action.device === device.id
    );
    if (
      timers.length !== Number(state.enabled) ||
      (state.enabled &&
        (timers[0].at !== state.tickAt ||
          state.tickAt < snapshot.clock ||
          timers[0].action.kind !== 'bgp-tick' ||
          timers[0].action.token !== state.token))
    )
      throw new Error('Timer BGP inconsistente.');
    for (const timer of timers) usedTimers.add(timer.action);
    if (
      !state.enabled &&
      (state.rib.length || state.routes.length || state.peers.some((peer) => peer.state !== 'Idle'))
    )
      throw new Error('BGP desativado com sessão/rotas.');
    for (const peer of state.peers) {
      if (
        peer.changedAt > snapshot.clock ||
        (peer.establishedAt !== undefined && peer.establishedAt > snapshot.clock) ||
        (peer.receivedAt !== undefined && peer.receivedAt > snapshot.clock)
      )
        throw new Error('Relógio BGP inválido.');
      const open = ['OpenConfirm', 'Established'].includes(peer.state);
      const connection = device.tcpConnections?.find((connection) => connection.id === peer.connection);
      if (
        (peer.connection !== undefined &&
          (!connection || connection.service !== 'bgp' || connection.remoteIp !== peer.ip)) ||
        (open &&
          (!peer.connection ||
            !peer.remoteId ||
            !isUnicast(peer.remoteId) ||
            peer.holdMs === undefined ||
            peer.receivedAt === undefined ||
            peer.holdAt !== peer.receivedAt + peer.holdMs ||
            peer.keepaliveAt === undefined)) ||
        (peer.state === 'Established' && peer.establishedAt === undefined) ||
        (!open && (peer.holdAt !== undefined || peer.remoteId !== undefined || peer.advertised.length)) ||
        new Set(peer.advertised.map(bgpPrefixKey)).size !== peer.advertised.length ||
        peer.advertised.some((path) => !validBgpPrefix(path) || !isUnicast(path.nextHop))
      )
        throw new Error('Sessão BGP inconsistente.');
    }
    if (
      new Set(state.rib.map((path) => path.peer + ':' + bgpPrefixKey(path))).size !== state.rib.length ||
      state.rib.some(
        (path) =>
          !validBgpPrefix(path) ||
          !isUnicast(path.nextHop) ||
          path.asPath.includes(state.asn) ||
          path.learnedAt > snapshot.clock ||
          !state.peers.some((peer) => peer.ip === path.peer && peer.state === 'Established')
      )
    )
      throw new Error('Adj-RIB-In BGP inválida.');
    if (JSON.stringify(state.routes) !== JSON.stringify(installedBgpRoutes(device)))
      throw new Error('Rotas BGP não correspondem à seleção local.');
  }
  for (const { action } of snapshot.queue)
    if (action.kind === 'bgp-tick' && !usedTimers.has(action)) throw new Error('Timer BGP órfão.');
}
