import { ospfAuthenticator, ospfAreaType } from './ospf-security';
import type { SimulationEngine } from '../core/engine';
import { LIMITS, type Device, type NetworkInterface } from '../model';
import { OSPF, lsaKey, type OspfLsa, type OspfMessage, type OspfNeighbor } from './ospf-model';

export function ospfBytes(message: OspfMessage) {
  if (message.type === 'hello') return 64 + message.neighbors.length * 4;
  if (message.type === 'database') return 52 + message.headers.length * 20;
  if (message.type === 'request') return 44 + message.headers.length * 12;
  if (message.type === 'ack') return 64;
  const lsa = message.lsa;
  return (
    68 +
    (lsa.type === 'router'
      ? 4 + 12 * (lsa.links.length + lsa.prefixes.length)
      : lsa.type === 'network'
        ? 4 + lsa.routers.length * 4
        : 8)
  );
}
export function sendOspf(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  message: OspfMessage,
  neighbor?: OspfNeighbor
) {
  const config = device.ospf?.interfaces.find((entry) => entry.port === port.id);
  if (!device.ospf?.enabled || !device.power || !config || config.passive || !port.adminUp || !port.ip)
    return;
  const packet: import('./ospf-model').OspfPacket = {
    protocol: 'OSPF' as const,
    src: port.ip,
    dst: neighbor?.ip ?? OSPF.destination,
    routerId: device.ospf.routerId,
    area: config.area,
    ttl: 1 as const,
    message,
    bytes: ospfBytes(message) + (config.authenticationKey ? 40 : 0),
  };
  if (config.authenticationKey) {
    packet.authentication = { sequence: ++engine.state.sequence, digest: '00'.repeat(32) };
    packet.authentication.digest = ospfAuthenticator(packet, config.authenticationKey);
  }
  const frame = {
    src: port.mac,
    dst: neighbor?.mac ?? OSPF.mac,
    etherType: 'IPv4' as const,
    packet,
    hops: LIMITS.l2Hops,
  };
  engine.emit(
    message.type === 'hello' ? 'OSPF_HELLO' : 'OSPF_SENT',
    device.id,
    `OSPF ${message.type}, área ${config.area}, ${port.name}${neighbor ? ' → ' + neighbor.routerId : ' → AllSPFRouters'}.`,
    { port: port.id, frame }
  );
  engine.sendFrame(device.id, port.id, frame);
}
export function sendOspfHello(engine: SimulationEngine, device: Device, port: NetworkInterface) {
  const state = device.ospf!,
    config = state.interfaces.find((entry) => entry.port === port.id)!;
  const runtime = state.ports.find((entry) => entry.port === port.id)!;
  sendOspf(engine, device, port, {
    type: 'hello',
    areaType: ospfAreaType(device, config.area),
    prefix: port.prefix!,
    helloMs: config.helloMs,
    deadMs: config.deadMs,
    networkType: config.networkType,
    priority: config.priority,
    dr: runtime.dr,
    bdr: runtime.bdr,
    neighbors: state.neighbors
      .filter((entry) => entry.port === port.id && entry.deadAt > engine.state.clock)
      .map((entry) => entry.routerId),
  });
  runtime.helloAt = engine.state.clock + config.helloMs;
}
export function sendOspfDatabase(
  engine: SimulationEngine,
  device: Device,
  neighbor: OspfNeighbor,
  reply = false
) {
  const port = device.interfaces.find((entry) => entry.id === neighbor.port)!;
  neighbor.description ??= device
    .ospf!.lsdb.filter((lsa) => lsa.area === neighbor.area)
    .map((lsa) => ({ key: lsaKey(lsa), sequence: lsa.sequence }));
  const headers = neighbor.description;
  const pages = Math.max(1, Math.ceil(headers.length / 16));
  for (let page = 0; page < pages; page++)
    sendOspf(
      engine,
      device,
      port,
      {
        type: 'database',
        exchange: neighbor.exchange,
        page,
        pages,
        reply,
        mtu: port.mtu,
        headers: headers.slice(page * 16, page * 16 + 16),
      },
      neighbor
    );
}
export function sendOspfRequests(engine: SimulationEngine, device: Device, neighbor: OspfNeighbor) {
  const port = device.interfaces.find((entry) => entry.id === neighbor.port)!;
  for (let i = 0; i < neighbor.requests.length; i += 16)
    sendOspf(
      engine,
      device,
      port,
      { type: 'request', headers: neighbor.requests.slice(i, i + 16) },
      neighbor
    );
}
export function sendOspfUpdate(
  engine: SimulationEngine,
  device: Device,
  neighbor: OspfNeighbor,
  lsa: OspfLsa
) {
  const key = lsaKey(lsa);
  neighbor.pending = neighbor.pending.filter((entry) => entry.key !== key);
  neighbor.pending.push({ key, sequence: lsa.sequence });
  sendOspf(
    engine,
    device,
    device.interfaces.find((entry) => entry.id === neighbor.port)!,
    { type: 'update', lsa, flush: lsa.withdrawn },
    neighbor
  );
}
export function floodOspf(engine: SimulationEngine, device: Device, lsa: OspfLsa, except?: OspfNeighbor) {
  for (const neighbor of device.ospf!.neighbors)
    if (
      neighbor !== except &&
      neighbor.area === lsa.area &&
      ['Exchange', 'Loading', 'Full'].includes(neighbor.state)
    )
      sendOspfUpdate(engine, device, neighbor, lsa);
}
