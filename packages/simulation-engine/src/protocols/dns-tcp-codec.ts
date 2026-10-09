import { dnsMessageSchema, type DnsMessage } from '../model';
import { TCP, tcpBytes } from './tcp-model';

// The simulator's TCP stream carries UTF-8 text. A four-character hexadecimal
// length represents the DNS 16-bit length field; the message body is typed JSON.
// This is a model encoding, not the binary DNS wire format.
export function encodeDnsTcp(message: DnsMessage) {
  const body = JSON.stringify(dnsMessageSchema.parse(message));
  const length = tcpBytes(body);
  if (length > TCP.buffer - 4) throw new Error('Mensagem DNS excede o buffer TCP do modelo.');
  return length.toString(16).padStart(4, '0') + body;
}
export function decodeDnsTcp(stream: string): DnsMessage | undefined {
  if (stream.length < 4) return undefined;
  if (!/^[0-9a-f]{4}$/i.test(stream.slice(0, 4))) throw new Error('Comprimento DNS/TCP inválido.');
  const length = Number.parseInt(stream.slice(0, 4), 16);
  if (length < 2 || length > TCP.buffer - 4) throw new Error('Comprimento DNS/TCP fora do limite.');
  const body = stream.slice(4),
    received = tcpBytes(body);
  if (received < length) return undefined;
  if (received !== length) throw new Error('DNS/TCP aceita uma mensagem por conexão neste modelo.');
  return dnsMessageSchema.parse(JSON.parse(body));
}
