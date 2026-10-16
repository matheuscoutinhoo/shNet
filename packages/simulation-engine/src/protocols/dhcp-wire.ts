import {
  BROADCAST,
  DHCP,
  LIMITS,
  type Device,
  type DhcpMessage,
  type DhcpPool,
  type Frame,
  type NetworkEvent,
  type NetworkInterface,
  type UdpPacket,
} from '../model';
import type { SimulationEngine } from '../core/engine';
import { dhcp4MessageSize } from '../wire/dhcp4-codec';

const eventTypes: Record<DhcpMessage['type'], NetworkEvent['type']> = {
  discover: 'DHCP_DISCOVER',
  offer: 'DHCP_OFFER',
  request: 'DHCP_REQUEST',
  ack: 'DHCP_ACK',
  nak: 'DHCP_NAK',
  release: 'DHCP_RELEASE',
  decline: 'DHCP_DECLINE',
};

export function sendDhcp(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  message: DhcpMessage,
  destination: string,
  reason: string,
  destinationMac?: string,
  toRelay = false
) {
  const response = message.type === 'offer' || message.type === 'ack' || message.type === 'nak';
  const packet: UdpPacket = {
    src: response ? message.server : message.clientIp,
    dst: destination,
    ttl: 64,
    protocol: 'UDP',
    sourcePort: response ? DHCP.serverPort : DHCP.clientPort,
    destinationPort: response && !toRelay ? DHCP.clientPort : DHCP.serverPort,
    payload: { protocol: 'DHCP', message },
    bytes: 28 + dhcp4MessageSize(message),
  };
  const target = destination === DHCP.broadcastIp ? BROADCAST : destinationMac;
  const frame: Frame | undefined = target
    ? {
        src: port.mac,
        dst: target,
        etherType: 'IPv4',
        packet,
        hops: LIMITS.l2Hops,
      }
    : undefined;
  engine.emit(eventTypes[message.type], device.id, reason, { port: port.id, ...(frame ? { frame } : {}) });
  if (frame) engine.sendFrame(device.id, port.id, frame);
  else engine.sendIp(device.id, packet);
}

export function sendDhcpServerResponse(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  request: DhcpMessage,
  type: 'offer' | 'ack',
  pool: DhcpPool,
  address: string
) {
  const message: DhcpMessage = {
    type,
    transactionId: request.transactionId,
    clientMac: request.clientMac,
    clientIp: request.clientIp,
    giaddr: request.giaddr,
    hops: request.hops,
    address,
    prefix: pool.prefix,
    server: port.ip!,
    gateway: pool.gateway,
    dns: [...pool.dns],
    leaseMs: pool.leaseMs,
  };
  const relayed = !!request.giaddr && request.giaddr !== DHCP.unspecifiedIp;
  const destination = relayed
    ? request.giaddr!
    : request.clientIp === DHCP.unspecifiedIp
      ? DHCP.broadcastIp
      : request.clientIp;
  sendDhcp(
    engine,
    device,
    port,
    message,
    destination,
    'DHCP ' +
      type.toUpperCase() +
      ': ' +
      address +
      '/' +
      pool.prefix +
      ' do pool ' +
      pool.name +
      '; lease de ' +
      pool.leaseMs / 1000 +
      ' s.',
    undefined,
    relayed
  );
}
