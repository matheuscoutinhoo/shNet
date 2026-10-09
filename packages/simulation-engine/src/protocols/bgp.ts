import { advertiseEvpn, evpnEnabled, receiveEvpn, withdrawEvpnPeer } from './evpn';
import { interfaceOperational } from './layer3';
import type { SimulationEngine } from '../core/engine';
import type { Device } from '../model';
import { tcpBytes, tcpFinished, type TcpConnection, TCP } from './tcp-model';
import { openTcp, closeTcp, writeTcp } from './tcp';
import { isUnicast } from './dhcp-config';
import { ipNumber } from './ipv4';
import {
  BGP,
  bgpConfigSchema,
  bgpMessageSchema,
  bgpPrefixKey,
  type BgpMessage,
  type BgpPeer,
  type BgpTimer,
} from './bgp-model';
import { bgpNextHop, bgpPermits, exportedBgpPaths, installedBgpRoutes, validBgpPrefix } from './bgp-routing';
import { validateBgpConfig } from './bgp-validation';

export function bgpConfig(device: Device) {
  const state = device.bgp;
  return state
    ? {
        enabled: state.enabled,
        asn: state.asn,
        routerId: state.routerId,
        holdMs: state.holdMs,
        networks: structuredClone(state.networks),
        neighbors: structuredClone(state.neighbors),
      }
    : undefined;
}
function peerState(engine: SimulationEngine, device: Device, peer: BgpPeer, state: BgpPeer['state']) {
  if (peer.state === state) return;
  const before = peer.state;
  peer.state = state;
  peer.changedAt = engine.state.clock;
  engine.emit('BGP_STATE_CHANGED', device.id, `${peer.ip}: ${before} → ${state}.`);
}
function connectionOpen(connection: TcpConnection) {
  return (
    !tcpFinished(connection) &&
    !connection.closeRequested &&
    ['ESTABLISHED', 'SYN-SENT', 'SYN-RECEIVED'].includes(connection.state)
  );
}
function connections(device: Device, ip: string) {
  return (
    device.tcpConnections?.filter(
      (connection) => connection.service === 'bgp' && connection.remoteIp === ip && connectionOpen(connection)
    ) ?? []
  );
}
function setup(connection: TcpConnection) {
  connection.service = 'bgp';
  connection.stream ??= { readBytes: 0, writtenBytes: 0 };
  connection.bgpOpen ??= { sent: false, received: false };
}
function send(engine: SimulationEngine, device: Device, connection: TcpConnection, message: BgpMessage) {
  const text = JSON.stringify(message) + '\n';
  if (
    tcpBytes(text) > BGP.maxMessage ||
    !connectionOpen(connection) ||
    connection.state !== 'ESTABLISHED' ||
    connection.bytesSent + tcpBytes(connection.sendBuffer) + tcpBytes(text) > TCP.buffer
  )
    return false;
  writeTcp(engine, device, connection.id, text);
  const peer = device.bgp?.peers.find((peer) => peer.ip === connection.remoteIp);
  if (peer) peer.sent++;
  engine.emit(
    'BGP_SENT',
    device.id,
    `${connection.remoteIp}: ${message.type}${message.type === 'UPDATE' ? `, ${message.announcements.length} anúncios, ${message.withdrawn.length} retiradas` : ''}.`
  );
  return true;
}
function sendOpen(engine: SimulationEngine, device: Device, connection: TcpConnection) {
  setup(connection);
  if (connection.bgpOpen!.sent) return;
  const state = device.bgp!;
  if (
    send(engine, device, connection, {
      type: 'OPEN',
      ...(evpnEnabled(device) ? { evpn: true } : {}),
      version: 4,
      asn: state.asn,
      routerId: state.routerId,
      holdMs: state.holdMs,
    })
  )
    connection.bgpOpen!.sent = true;
}
// Derived FIB only changes when routing inputs change. Counters, TCP ACKs and
// keepalives do not require a new best-path calculation. Cache is disposable:
// snapshot restore always recalculates from the serialized protocol state.
const fibInputs = new WeakMap<Device, { signature: string; routes: NonNullable<Device['bgp']>['routes'] }>();
function synchronize(engine: SimulationEngine, device: Device) {
  const state = device.bgp;
  if (!state) return;
  const signature = JSON.stringify({
    power: device.power,
    ipRouting: device.ipRouting,
    interfaces: device.interfaces.map((p) => ({
      id: p.id,
      ip: p.ip,
      prefix: p.prefix,
      adminUp: p.adminUp,
      vrf: p.vrf,
      mode: p.mode,
      channel: p.channel,
      logical: p.logical,
      gateway: p.gateway,
      tunnel: p.tunnel
        ? {
            enabled: p.tunnel.enabled,
            status: p.tunnel.status,
            peerIp: p.tunnel.peerIp,
            remotePrefixes: p.tunnel.remotePrefixes,
          }
        : undefined,
    })),
    routes: device.routes,
    ospf: device.ospf?.enabled ? device.ospf.routes : undefined,
    rip: device.rip?.enabled ? device.rip.table : undefined,
    enabled: state.enabled,
    asn: state.asn,
    routerId: state.routerId,
    networks: state.networks,
    neighbors: state.neighbors,
    rib: state.rib,
    peers: state.peers.map((p) => ({ ip: p.ip, state: p.state, remoteId: p.remoteId })),
  });
  const cache = fibInputs.get(device);
  if (cache?.signature === signature && cache.routes === state.routes) return;
  const before = state.routes;
  state.routes = installedBgpRoutes(device);
  fibInputs.set(device, { signature, routes: state.routes });
  for (const route of before)
    if (!state.routes.some((entry) => JSON.stringify(entry) === JSON.stringify(route)))
      engine.emit('ROUTE_REMOVED', device.id, `BGP retirou ${bgpPrefixKey(route)} via ${route.nextHop}.`, {
        port: route.port,
      });
  for (const route of state.routes)
    if (!before.some((entry) => JSON.stringify(entry) === JSON.stringify(route)))
      engine.emit(
        'ROUTE_ADDED',
        device.id,
        `BGP instalou ${bgpPrefixKey(route)} via ${route.nextHop}, distância ${route.distance}.`,
        { port: route.port }
      );
}
function resetPeer(engine: SimulationEngine, device: Device, peer: BgpPeer, reason: string, notify?: number) {
  for (const connection of connections(device, peer.ip)) {
    const delivered =
      notify !== undefined &&
      send(engine, device, connection, { type: 'NOTIFICATION', code: notify, reason: reason.slice(0, 120) });
    closeTcp(engine, device, connection.id, !delivered);
  }
  device.bgp!.rib = device.bgp!.rib.filter((route) => route.peer !== peer.ip);
  peer.advertised = [];
  delete peer.evpnAdvertised;
  withdrawEvpnPeer(engine, device, peer.ip);
  delete peer.connection;
  delete peer.remoteId;
  delete peer.holdMs;
  delete peer.receivedAt;
  delete peer.holdAt;
  delete peer.keepaliveAt;
  delete peer.establishedAt;
  peer.retryAt = engine.state.clock + BGP.retryMs;
  peerState(engine, device, peer, 'Idle');
  engine.emit('BGP_SESSION_CLOSED', device.id, `${peer.ip}: ${reason}.`);
  synchronize(engine, device);
}
export function configureBgp(engine: SimulationEngine, device: Device, input: unknown) {
  const config = bgpConfigSchema.parse(input);
  validateBgpConfig(device, config);
  if (device.bgp)
    for (const peer of device.bgp.peers) resetPeer(engine, device, peer, 'Configuração alterada', 6);
  engine.state.queue = engine.state.queue.filter(
    ({ action }) => action.kind !== 'bgp-tick' || action.device !== device.id
  );
  const token = engine.id('bgp'),
    tickAt = engine.state.clock + 0.001;
  device.bgp = {
    ...config,
    token,
    tickAt,
    rib: [],
    routes: [],
    peers: config.neighbors.map((neighbor) => ({
      ip: neighbor.ip,
      state: 'Idle',
      changedAt: engine.state.clock,
      retryAt: engine.state.clock,
      sent: 0,
      received: 0,
      advertised: [],
    })),
  };
  if (config.enabled) engine.schedule(0.001, { kind: 'bgp-tick', device: device.id, token });
  engine.emit(
    'CONFIG_CHANGED',
    device.id,
    `BGP AS ${config.asn} ${config.enabled ? 'ativado' : 'desativado'}.`
  );
}
export function canListenBgp(device: Device, ip: string) {
  return device.bgp?.enabled && device.bgp.neighbors.some((neighbor) => neighbor.ip === ip);
}
function advertisements(engine: SimulationEngine, device: Device, peer: BgpPeer, connection: TcpConnection) {
  const desired = exportedBgpPaths(
    device,
    device.bgp!.neighbors.find((neighbor) => neighbor.ip === peer.ip)!
  );
  const withdrawn = peer.advertised
    .filter((route) => !desired.some((entry) => bgpPrefixKey(entry) === bgpPrefixKey(route)))
    .slice(0, 32);
  if (
    withdrawn.length &&
    send(engine, device, connection, {
      type: 'UPDATE',
      announcements: [],
      withdrawn: withdrawn.map(({ network, prefix }) => ({ network, prefix })),
    })
  )
    peer.advertised = peer.advertised.filter((route) => !withdrawn.includes(route));
  const announcements = desired
    .filter((route) => !peer.advertised.some((entry) => JSON.stringify(entry) === JSON.stringify(route)))
    .slice(0, 16);
  for (const path of announcements) {
    if (!send(engine, device, connection, { type: 'UPDATE', announcements: [path], withdrawn: [] })) break;
    peer.advertised = [
      ...peer.advertised.filter((route) => bgpPrefixKey(route) !== bgpPrefixKey(path)),
      path,
    ].sort((a, b) => bgpPrefixKey(a).localeCompare(bgpPrefixKey(b)));
  }
}
export function refreshBgp(engine: SimulationEngine) {
  for (const device of engine.state.devices) {
    if (!device.bgp?.enabled) continue;
    for (const peer of device.bgp.peers) {
      const connection = device.tcpConnections?.find((entry) => entry.id === peer.connection);
      const route = bgpNextHop(device, peer.ip);
      const usable = route && interfaceOperational(engine.state, device, route.port);
      if (
        (!device.power || (connection && !connectionOpen(connection)) || (connection && !usable)) &&
        (peer.state !== 'Idle' || connections(device, peer.ip).length)
      )
        resetPeer(engine, device, peer, 'Energia, interface ou TCP indisponível');
    }
    synchronize(engine, device);
  }
}
export function handleBgpTick(engine: SimulationEngine, action: BgpTimer) {
  const device = engine.device(action.device),
    state = device.bgp;
  if (!state?.enabled || state.token !== action.token) return;
  for (const peer of state.peers) {
    const config = state.neighbors.find((neighbor) => neighbor.ip === peer.ip)!;
    if (!device.power) {
      if (peer.state !== 'Idle' || connections(device, peer.ip).length)
        resetPeer(engine, device, peer, 'Equipamento desligado');
      continue;
    }
    const primary = device.tcpConnections?.find((connection) => connection.id === peer.connection);
    if (peer.connection && (!primary || !connectionOpen(primary))) {
      resetPeer(engine, device, peer, 'Transporte TCP encerrado');
      continue;
    }
    if (peer.holdAt !== undefined && peer.holdAt <= engine.state.clock) {
      resetPeer(engine, device, peer, 'Hold timer expirado', 4);
      continue;
    }
    const active = connections(device, peer.ip);
    for (const connection of active) {
      setup(connection);
      if (connection.state === 'ESTABLISHED' && !connection.bgpOpen!.sent) {
        sendOpen(engine, device, connection);
        if (!peer.connection) peer.connection = connection.id;
        if (!['OpenConfirm', 'Established'].includes(peer.state)) peerState(engine, device, peer, 'OpenSent');
      }
    }
    if (peer.state === 'Established' && primary) {
      if (peer.keepaliveAt! <= engine.state.clock && send(engine, device, primary, { type: 'KEEPALIVE' }))
        peer.keepaliveAt = engine.state.clock + peer.holdMs! / 3;
      advertisements(engine, device, peer, primary);
      if (primary.bgpOpen?.evpn && evpnEnabled(device))
        advertiseEvpn(engine, device, peer, (m) => send(engine, device, primary, m));
    } else if (peer.state === 'OpenConfirm' && primary && peer.keepaliveAt! <= engine.state.clock) {
      if (send(engine, device, primary, { type: 'KEEPALIVE' }))
        peer.keepaliveAt = engine.state.clock + peer.holdMs! / 3;
    } else if (!active.length && !config.passive && peer.retryAt <= engine.state.clock) {
      peer.retryAt = engine.state.clock + BGP.retryMs;
      try {
        const id = openTcp(engine, device, peer.ip, BGP.port, '', false, setup);
        peer.connection = id;
        peerState(engine, device, peer, 'Connect');
      } catch {
        peerState(engine, device, peer, 'Active');
      }
    }
  }
  synchronize(engine, device);
  state.tickAt = engine.state.clock + BGP.tickMs;
  engine.schedule(BGP.tickMs, { kind: 'bgp-tick', device: device.id, token: state.token });
}
function receiveMessage(
  engine: SimulationEngine,
  device: Device,
  connection: TcpConnection,
  message: BgpMessage
) {
  const state = device.bgp!,
    peer = state.peers.find((peer) => peer.ip === connection.remoteIp);
  if (!peer) {
    closeTcp(engine, device, connection.id, true);
    return;
  }
  const config = state.neighbors.find((neighbor) => neighbor.ip === peer.ip)!;
  const fail = (reason: string, code: number) => resetPeer(engine, device, peer, reason, code);
  peer.received++;
  engine.emit('BGP_RECEIVED', device.id, `${peer.ip}: ${message.type}.`);
  if (message.type === 'NOTIFICATION') {
    fail(`NOTIFICATION ${message.code}: ${message.reason}`, 6);
    return;
  }
  if (message.type === 'OPEN') {
    if (
      connection.bgpOpen!.received ||
      message.asn !== config.remoteAs ||
      !isUnicast(message.routerId) ||
      message.routerId === state.routerId
    ) {
      fail('OPEN inválido: ASN, Router ID ou repetição', 2);
      return;
    }
    connection.bgpOpen!.received = true;
    connection.bgpOpen!.evpn = message.evpn === true;
    connection.bgpOpen!.routerId = message.routerId;
    sendOpen(engine, device, connection);
    const previous = device.tcpConnections?.find((entry) => entry.id === peer.connection);
    if (previous && previous.id !== connection.id && peer.state === 'Established') {
      closeTcp(engine, device, connection.id, true);
      return;
    }
    const candidates = connections(device, peer.ip).filter((entry) => entry.bgpOpen?.received);
    const role = ipNumber(state.routerId) > ipNumber(message.routerId) ? 'client' : 'server';
    const selected = candidates.find((entry) => entry.role === role) ?? connection;
    peer.connection = selected.id;
    for (const entry of candidates) if (entry.id !== selected.id) closeTcp(engine, device, entry.id, true);
    if (selected !== connection) return;
    peer.remoteId = message.routerId;
    peer.holdMs = Math.min(state.holdMs, message.holdMs);
    peer.receivedAt = engine.state.clock;
    peer.holdAt = engine.state.clock + peer.holdMs;
    peer.keepaliveAt = engine.state.clock + peer.holdMs / 3;
    peerState(engine, device, peer, 'OpenConfirm');
    send(engine, device, connection, { type: 'KEEPALIVE' });
    return;
  }
  if (peer.connection !== connection.id || !connection.bgpOpen!.received) {
    fail('Mensagem antes de OPEN válido', 5);
    return;
  }
  if (message.type === 'KEEPALIVE') {
    if (!['OpenConfirm', 'Established'].includes(peer.state)) {
      fail('KEEPALIVE fora de estado', 5);
      return;
    }
    peer.receivedAt = engine.state.clock;
    peer.holdAt = engine.state.clock + peer.holdMs!;
    if (peer.state !== 'Established') {
      peer.establishedAt = engine.state.clock;
      peerState(engine, device, peer, 'Established');
    }
    return;
  }
  if (peer.state !== 'Established') {
    fail('UPDATE antes de Established', 5);
    return;
  }
  if (
    message.withdrawn.some((prefix) => !validBgpPrefix(prefix)) ||
    message.announcements.some(
      (path) =>
        !validBgpPrefix(path) ||
        !isUnicast(path.nextHop) ||
        (config.remoteAs !== state.asn && path.asPath[0] !== config.remoteAs)
    )
  ) {
    fail('UPDATE com prefixo, NEXT_HOP ou AS_PATH inválido', 3);
    return;
  }
  if (
    (message.evpnAnnouncements?.length || message.evpnWithdrawn?.length) &&
    (!connection.bgpOpen?.evpn || !evpnEnabled(device))
  ) {
    fail('EVPN não negociado no OPEN', 3);
    return;
  }
  receiveEvpn(engine, device, peer, message);
  for (const prefix of [...message.withdrawn, ...message.announcements])
    state.rib = state.rib.filter(
      (path) => path.peer !== peer.ip || bgpPrefixKey(path) !== bgpPrefixKey(prefix)
    );
  for (const path of message.announcements) {
    if (
      path.asPath.includes(state.asn) ||
      path.originatorId === state.routerId ||
      path.clusterList?.includes(state.routerId) ||
      !bgpPermits(config.importFilter, path)
    ) {
      engine.emit(
        'BGP_ROUTE_REJECTED',
        device.id,
        `${bgpPrefixKey(path)} de ${peer.ip}: loop de AS/reflexão ou filtro de entrada.`
      );
      continue;
    }
    if (state.rib.length >= BGP.maxRoutes) {
      fail('Limite de prefixos BGP excedido', 6);
      return;
    }
    state.rib.push({
      ...path,
      localPref: config.remoteAs === state.asn ? path.localPref : config.localPref,
      peer: peer.ip,
      learnedAt: engine.state.clock,
    });
  }
  state.rib.sort(
    (a, b) => bgpPrefixKey(a).localeCompare(bgpPrefixKey(b)) || ipNumber(a.peer) - ipNumber(b.peer)
  );
  peer.receivedAt = engine.state.clock;
  peer.holdAt = engine.state.clock + peer.holdMs!;
  synchronize(engine, device);
}
export function receiveBgpApplication(engine: SimulationEngine, device: Device, connection: TcpConnection) {
  setup(connection);
  if (!connectionOpen(connection)) {
    connection.stream!.readBytes += connection.bytesReceived;
    connection.received = '';
    connection.bytesReceived = 0;
    return;
  }
  if (!device.bgp?.enabled) {
    closeTcp(engine, device, connection.id, true);
    return;
  }
  while (connection.received.includes('\n')) {
    const end = connection.received.indexOf('\n') + 1,
      text = connection.received.slice(0, end);
    connection.received = connection.received.slice(end);
    connection.bytesReceived -= tcpBytes(text);
    connection.stream!.readBytes += tcpBytes(text);
    try {
      if (tcpBytes(text) > BGP.maxMessage) throw new Error('Mensagem longa');
      const message = bgpMessageSchema.parse(JSON.parse(text));
      receiveMessage(engine, device, connection, message);
    } catch {
      const peer = device.bgp.peers.find((peer) => peer.ip === connection.remoteIp);
      if (peer) resetPeer(engine, device, peer, 'Framing ou mensagem BGP inválida', 1);
      else closeTcp(engine, device, connection.id, true);
    }
    if (!connectionOpen(connection)) break;
  }
  if (tcpBytes(connection.received) > BGP.maxMessage) {
    const peer = device.bgp.peers.find((peer) => peer.ip === connection.remoteIp);
    if (peer) resetPeer(engine, device, peer, 'Framing BGP excedido', 1);
  }
}
