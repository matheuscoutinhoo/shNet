import { DNS, type DnsMessage, type UdpPacket } from '../model';

export function dnsMessageLength(message: DnsMessage) {
  return (
    12 +
    (message.edns ? 11 : 0) +
    (message.type === 'response' && message.dnssec
      ? message.dnssec.zone.length +
        48 +
        message.dnssec.signatures.reduce((n, s) => n + s.name.length + message.dnssec!.zone.length + 96, 0) +
        message.dnssec.denial.reduce((n, r) => n + r.name.length + r.next.length + 23, 0)
      : 0) +
    message.question.name.length +
    6 +
    (message.type === 'response'
      ? message.answers.reduce(
          (total, record) =>
            total +
            record.name.length +
            12 +
            (record.type === 'A' ? 4 : record.type === 'AAAA' ? 16 : record.value.length + 2),
          0
        )
      : 0)
  );
}

export function dnsPacket(src: string, dst: string, clientPort: number, message: DnsMessage): UdpPacket {
  return {
    src,
    dst,
    ttl: 64,
    protocol: 'UDP',
    sourcePort: message.type === 'query' ? clientPort : DNS.port,
    destinationPort: message.type === 'query' ? DNS.port : clientPort,
    payload: { protocol: 'DNS', message },
    bytes: 28 + dnsMessageLength(message),
  };
}
