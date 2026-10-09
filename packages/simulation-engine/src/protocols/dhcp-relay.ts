import {
  BROADCAST,
  DHCP,
  LIMITS,
  type Device,
  type DhcpMessage,
  type Frame,
  type NetworkInterface,
  type UdpPacket,
} from '../model';
import type { SimulationEngine } from '../core/engine';
import { sameSubnet } from './ipv4';

export function relayDhcpRequest(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  packet: UdpPacket
) {
  if (packet.payload.protocol !== 'DHCP' || device.type !== 'router' || !port.ip || !port.dhcpRelay?.length)
    return;
  const message = packet.payload.message;
  if (!['discover', 'request', 'decline'].includes(message.type) || packet.dst !== DHCP.broadcastIp) return;
  // One relay hop: routed unicast renewals and replies never enter this branch.
  if ((message.giaddr && message.giaddr !== DHCP.unspecifiedIp) || (message.hops ?? 0) !== 0) {
    engine.drop(
      device,
      'DHCP relay: requisição já contém giaddr ou hops; encadeamento não suportado.',
      port.id
    );
    return;
  }
  if (message.clientIp !== DHCP.unspecifiedIp && !sameSubnet(message.clientIp, port.ip, port.prefix!)) {
    engine.drop(device, 'DHCP relay: ciaddr não pertence à rede de entrada.', port.id);
    return;
  }
  for (const server of port.dhcpRelay) {
    const forwarded: UdpPacket = {
      ...packet,
      src: port.ip,
      dst: server,
      ttl: 64,
      sourcePort: DHCP.serverPort,
      destinationPort: DHCP.serverPort,
      payload: { protocol: 'DHCP', message: { ...message, giaddr: port.ip, hops: 1 } },
    };
    engine.emit(
      'DHCP_RELAY_REQUEST',
      device.id,
      'Relay preserva cliente e transação; giaddr=' + port.ip + ', hops=1; UDP 67 → 67 para ' + server + '.',
      { port: port.id }
    );
    engine.sendIp(device.id, forwarded);
  }
}

export function relayDhcpReply(engine: SimulationEngine, device: Device, packet: UdpPacket) {
  if (packet.payload.protocol !== 'DHCP') return;
  const message: DhcpMessage = packet.payload.message;
  const port = device.interfaces.find(
    (entry) => entry.adminUp && entry.ip === message.giaddr && entry.dhcpRelay?.includes(packet.src)
  );
  if (
    device.type !== 'router' ||
    !port?.ip ||
    packet.dst !== port.ip ||
    packet.destinationPort !== DHCP.serverPort ||
    !['offer', 'ack', 'nak'].includes(message.type) ||
    (message.hops ?? 0) !== 1 ||
    (message.clientIp !== DHCP.unspecifiedIp && !sameSubnet(message.clientIp, port.ip, port.prefix!)) ||
    ('address' in message && !sameSubnet(message.address, port.ip, port.prefix!))
  ) {
    engine.drop(
      device,
      'DHCP relay: resposta de servidor não configurado, giaddr, hops ou subnet incompatível.'
    );
    return;
  }
  const broadcast = message.type === 'nak' || message.clientIp === DHCP.unspecifiedIp;
  const frame: Frame = {
    src: port.mac,
    dst: broadcast ? BROADCAST : message.clientMac,
    etherType: 'IPv4',
    hops: LIMITS.l2Hops,
    packet: {
      ...packet,
      dst: broadcast ? DHCP.broadcastIp : message.clientIp,
      ttl: 64,
      destinationPort: DHCP.clientPort,
    },
  };
  engine.emit(
    'DHCP_RELAY_REPLY',
    device.id,
    'Resposta do servidor ' + packet.src + ' entregue na rede de giaddr=' + port.ip + '; UDP 67 → 68.',
    { port: port.id, frame }
  );
  engine.sendFrame(device.id, port.id, frame);
}
