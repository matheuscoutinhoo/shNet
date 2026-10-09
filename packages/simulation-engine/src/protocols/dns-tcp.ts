import type { SimulationEngine } from '../core/engine';
import type { Device, DnsMessage, TcpConnection } from '../model';
import { decodeDnsTcp, encodeDnsTcp } from './dns-tcp-codec';
import { queueTcpText } from './tcp-services';
import { buildDnsResponse } from './dnssec';
import { receiveDnsAnswer } from './dns-client';

export function receiveDnsTcpApplication(
  engine: SimulationEngine,
  device: Device,
  connection: TcpConnection
) {
  if (connection.dnsHandled) return;
  let message: DnsMessage | undefined;
  try {
    message = decodeDnsTcp(connection.received);
  } catch {
    engine.drop(device, 'DNS/TCP: framing ou mensagem inválida.');
    connection.closeRequested = true;
    return;
  }
  if (!message) return;
  connection.dnsHandled = true;
  if (connection.role === 'client' && message.type === 'response') {
    receiveDnsAnswer(engine, device, message, {
      src: connection.remoteIp,
      dst: connection.localIp,
      destinationPort: connection.localPort,
      transport: 'tcp',
      connection: connection.id,
    });
  } else if (connection.role === 'server' && message.type === 'query') {
    const response = buildDnsResponse(device, message, engine.state.clock);
    let encoded: string;
    try {
      encoded = encodeDnsTcp(response);
    } catch {
      response.code = 'SERVFAIL';
      response.answers = [];
      delete response.dnssec;
      encoded = encodeDnsTcp(response);
    }
    queueTcpText(connection, encoded);
    engine.emit(
      'DNS_RESPONSE',
      device.id,
      `${message.question.name}: ${response.code}, ${response.answers.length} registros por TCP/53.`
    );
  } else engine.drop(device, 'DNS/TCP: tipo de mensagem incompatível com o papel da conexão.');
  connection.closeRequested = true;
}
