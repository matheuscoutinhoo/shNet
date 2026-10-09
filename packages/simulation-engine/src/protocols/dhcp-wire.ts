import {
  BROADCAST,
  DHCP,
  LIMITS,
  type Device,
  type DhcpMessage,
  type Frame,
  type NetworkEvent,
  type NetworkInterface,
  type UdpPacket,
} from '../model';
import type { SimulationEngine } from '../core/engine';

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
    bytes: 328 + ('dns' in message ? message.dns.length * 4 : 0),
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
