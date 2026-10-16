import type { UdpPacket } from '../model';
import { snmpMessageSchema } from './snmp-model';
import { syslogMessageSchema } from './syslog-model';
import { syslogMessageSize } from '../wire/syslog-codec';
type Payload = Extract<UdpPacket['payload'], { protocol: 'SNMP' | 'SYSLOG' }>;
export function managementBytes(payload: Payload) {
  if (payload.protocol === 'SYSLOG') return 28 + syslogMessageSize(payload.message);
  return legacyManagementBytes(payload);
}
export function legacyManagementBytes(payload: Payload) {
  const message =
    payload.protocol === 'SNMP'
      ? snmpMessageSchema.parse(payload.message)
      : syslogMessageSchema.parse(payload.message);
  return 28 + new TextEncoder().encode(JSON.stringify(message)).length;
}
export function validManagementLength(packet: UdpPacket) {
  const p = packet.payload;
  return (
    (p.protocol === 'SNMP' || p.protocol === 'SYSLOG') &&
    (packet.bytes === managementBytes(p) || packet.bytes === legacyManagementBytes(p))
  );
}
export function managementPacket(
  src: string,
  dst: string,
  sourcePort: number,
  destinationPort: number,
  payload: Payload
): UdpPacket {
  return {
    protocol: 'UDP',
    src,
    dst,
    ttl: 64,
    sourcePort,
    destinationPort,
    payload,
    bytes: managementBytes(payload),
  };
}
