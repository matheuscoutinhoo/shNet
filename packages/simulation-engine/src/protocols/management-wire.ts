import type { UdpPacket } from '../model';
import { snmpMessageSchema } from './snmp-model';
import { syslogMessageSchema } from './syslog-model';
type Payload = Extract<UdpPacket['payload'], { protocol: 'SNMP' | 'SYSLOG' }>;
export function managementBytes(payload: Payload) {
  const message =
    payload.protocol === 'SNMP'
      ? snmpMessageSchema.parse(payload.message)
      : syslogMessageSchema.parse(payload.message);
  return 28 + new TextEncoder().encode(JSON.stringify(message)).length;
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
