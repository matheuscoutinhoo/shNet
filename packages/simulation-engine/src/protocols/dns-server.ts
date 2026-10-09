import { DNS, type Device, type DnsMessage, type UdpPacket } from '../model';
import type { SimulationEngine } from '../core/engine';
import { buildDnsResponse } from './dnssec';
import { dnsMessageLength, dnsPacket } from './dns-wire';

export function receiveDnsQuery(engine: SimulationEngine, device: Device, packet: UdpPacket) {
  if (packet.payload.protocol !== 'DNS' || packet.payload.message.type !== 'query') return;
  if (!device.dnsServer?.enabled) return;
  const query = packet.payload.message;
  const message: Extract<DnsMessage, { type: 'response' }> = buildDnsResponse(
    device,
    query,
    engine.state.clock
  );
  if (dnsMessageLength(message) > (query.edns?.udpSize ?? DNS.maxUdpBytes) || message.answers.length > 64) {
    message.truncated = true;
    message.answers = [];
    delete message.dnssec;
  }
  engine.emit(
    'DNS_RESPONSE',
    device.id,
    query.question.name +
      ' ' +
      query.question.type +
      ': ' +
      (message.truncated
        ? 'resposta excede limite UDP; TC=1, cliente pode repetir por TCP.'
        : message.code + ', ' + message.answers.length + ' registro(s).')
  );
  engine.sendIp(device.id, dnsPacket(packet.dst, packet.src, packet.sourcePort, message));
}
