import { receiveEnterpriseRadius } from './enterprise';
import { receiveCapwap } from './capwap';
import { receiveVoice } from './voice';
import { receiveTelemetry } from './telemetry';
import { receiveNtp } from './ntp';
import { receiveRadius } from './aaa';
import { receiveVxlan } from './vxlan';
import { receiveSdwan } from './sdwan';
import { receiveTunnel } from './tunnel';
import { DHCP, type Device, type NetworkInterface, type UdpPacket } from '../model';
import type { SimulationEngine } from '../core/engine';
import { receiveDhcpClient } from './dhcp-client';
import { receiveDhcpServer } from './dhcp-server';
import { receiveDnsQuery } from './dns-server';
import { receiveDnsResponse } from './dns-client';
import { isUnicast } from './dhcp-config';
import { DNS } from '../model';
import { receiveRip } from './rip';
import { receiveSnmp } from './snmp';
import { receiveSyslog } from './syslog';
import { relayDhcpReply, relayDhcpRequest } from './dhcp-relay';
import { sendIcmpError } from './icmp';

export function receiveUdp(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  packet: UdpPacket,
  sourceMac: string
) {
  if (packet.payload.protocol === 'EAP-RADIUS') {
    receiveEnterpriseRadius(engine, device, packet);
    return;
  }
  if (packet.payload.protocol === 'CAPWAP') {
    receiveCapwap(engine, device, packet);
    return;
  }
  if (packet.payload.protocol === 'SIP' || packet.payload.protocol === 'RTP') {
    receiveVoice(engine, device, packet);
    return;
  }
  if (packet.payload.protocol === 'TELEMETRY') {
    receiveTelemetry(engine, device, packet);
    return;
  }
  if (packet.payload.protocol === 'NTP') {
    receiveNtp(engine, device, packet);
    return;
  }
  if (packet.payload.protocol === 'RADIUS') {
    receiveRadius(engine, device, packet);
    return;
  }
  if (packet.payload.protocol === 'VXLAN') {
    receiveVxlan(engine, device, port, packet);
    return;
  }
  if (packet.payload.protocol === 'TUNNEL') {
    receiveTunnel(engine, device, port, packet);
    return;
  }
  if (packet.payload.protocol === 'SDWAN') {
    receiveSdwan(engine, device, packet);
    return;
  }
  const closed =
    (packet.payload.protocol === 'DNS' &&
      packet.payload.message.type === 'query' &&
      (packet.destinationPort !== DNS.port || !device.dnsServer?.enabled)) ||
    (packet.payload.protocol === 'SNMP' &&
      packet.payload.message.type !== 'response' &&
      (packet.destinationPort !== 161 || !device.snmpAgent?.enabled)) ||
    (packet.payload.protocol === 'SYSLOG' &&
      (packet.destinationPort !== 514 || !device.syslogServer?.enabled));
  if (closed) {
    engine.drop(device, 'Porta UDP ' + packet.destinationPort + ' sem serviço ativo.', port.id);
    sendIcmpError(engine, device, port, packet, 'unreachable', 3);
    return;
  }
  if (packet.payload.protocol === 'SNMP') {
    receiveSnmp(engine, device, packet);
    return;
  }
  if (packet.payload.protocol === 'SYSLOG') {
    receiveSyslog(engine, device, packet);
    return;
  }
  if (packet.payload.protocol === 'RIP') {
    receiveRip(engine, device, port, packet, sourceMac);
    return;
  }
  if (packet.payload.protocol === 'DNS') {
    const query = packet.payload.message.type === 'query';
    if (
      packet.ttl === 0 ||
      !isUnicast(packet.src) ||
      !isUnicast(packet.dst) ||
      (query
        ? packet.destinationPort !== DNS.port || packet.sourcePort < 49152
        : packet.sourcePort !== DNS.port || packet.destinationPort < 49152)
    ) {
      engine.drop(device, 'Datagrama DNS recusado: origem, destino, portas UDP ou TTL inválidos.', port.id);
      return;
    }
    if (query) receiveDnsQuery(engine, device, packet);
    else receiveDnsResponse(engine, device, packet);
    return;
  }
  const message = packet.payload.message;
  const response = message.type === 'offer' || message.type === 'ack' || message.type === 'nak';
  const relayed = !!message.giaddr && message.giaddr !== DHCP.unspecifiedIp;
  const validPorts = response
    ? packet.sourcePort === DHCP.serverPort &&
      (packet.destinationPort === DHCP.clientPort || (relayed && packet.destinationPort === DHCP.serverPort))
    : packet.sourcePort === (relayed ? DHCP.serverPort : DHCP.clientPort) &&
      packet.destinationPort === DHCP.serverPort;
  const validSource = response
    ? packet.src === message.server
    : relayed
      ? isUnicast(message.giaddr!) &&
        packet.src === message.giaddr &&
        (message.hops ?? 0) === 1 &&
        isUnicast(packet.dst)
      : packet.src === message.clientIp &&
        (message.hops ?? 0) === 0 &&
        ((packet.dst !== DHCP.broadcastIp && isUnicast(message.clientIp)) || sourceMac === message.clientMac);
  if (!validPorts || !validSource || packet.ttl === 0) {
    engine.drop(device, 'Datagrama DHCP recusado: portas UDP, origem ou TTL incompatíveis.', port.id);
    return;
  }
  if (response) {
    if (packet.destinationPort === DHCP.serverPort) relayDhcpReply(engine, device, packet);
    else receiveDhcpClient(engine, device, port, packet, sourceMac);
  } else {
    relayDhcpRequest(engine, device, port, packet);
    receiveDhcpServer(engine, device, port, packet);
  }
}
