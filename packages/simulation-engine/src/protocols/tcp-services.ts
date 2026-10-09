import { receiveDatabase } from './database';
import { receiveSpecialApplication } from './applications';
import { receiveRemote } from './remote-wire';
import { receiveTacacs } from './tacacs';
import { receiveBgpApplication } from './bgp';
import type { SimulationEngine } from '../core/engine';
import type { Device } from '../model';
import { TCP, tcpBytes, tcpServiceSchema, tcpTextSchema, type TcpConnection } from './tcp-model';
import { receiveDnsTcpApplication } from './dns-tcp';

export function configureTcpService(engine: SimulationEngine, device: Device, input: unknown) {
  const service = tcpServiceSchema.parse(input);
  if (device.type === 'pc' && service.kind !== 'echo')
    throw new Error('Serviço TCP exige servidor, switch com SVI ou roteador.');
  if (
    service.enabled &&
    device.remoteManagement?.enabled &&
    ((service.port === 830 && device.remoteManagement.netconf) ||
      (service.port === 443 && device.remoteManagement.restconf))
  )
    throw new Error('Porta reservada para NETCONF/RESTCONF.');
  if (service.enabled && service.port === 49 && device.aaaServer?.enabled && device.aaaServer.tacacs)
    throw new Error('TCP/49 reservado pelo TACACS+.');
  if (service.enabled && service.port === 179 && device.bgp?.enabled)
    throw new Error('TCP/179 está reservado pelo BGP.');
  if (service.enabled && service.port === 53 && device.dnsServer?.enabled)
    throw new Error('TCP/53 está reservado pelo serviço DNS.');
  const others = device.tcpServices?.filter((entry) => entry.port !== service.port) ?? [];
  if (others.length >= 32) throw new Error('Limite de 32 serviços TCP.');
  device.tcpServices = [...others, service].sort((a, b) => a.port - b.port);
  engine.emit(
    'CONFIG_CHANGED',
    device.id,
    `Serviço ${service.kind} TCP/${service.port} ${service.enabled ? 'ativado' : 'desativado'}.`
  );
  return service;
}
export function queueTcpText(connection: TcpConnection, input: string) {
  const data = tcpTextSchema.parse(input);
  if (connection.bytesSent + tcpBytes(connection.sendBuffer) + tcpBytes(data) > TCP.buffer)
    throw new Error('Limite de 16384 bytes enviados por conexão TCP.');
  connection.sendBuffer += data;
}
export function receiveTcpApplication(
  engine: SimulationEngine,
  device: Device,
  connection: TcpConnection,
  data: string
) {
  engine.emit(
    'APPLICATION_DATA',
    device.id,
    `${connection.id}: ${tcpBytes(data)} bytes recebidos por ${connection.service}.`
  );
  if (connection.service === 'database') {
    receiveDatabase(engine, device, connection);
    return;
  }
  if (receiveSpecialApplication(engine, device, connection)) return;
  if (connection.service === 'netconf' || connection.service === 'restconf') {
    receiveRemote(engine, device, connection);
    return;
  }
  if (connection.service === 'aaa') {
    receiveTacacs(engine, device, connection);
    return;
  }
  if (connection.service === 'bgp') {
    receiveBgpApplication(engine, device, connection);
    return;
  }
  if (connection.service === 'dns') {
    receiveDnsTcpApplication(engine, device, connection);
    return;
  }
  if (connection.role !== 'server') return;
  if (connection.service === 'echo') queueTcpText(connection, data);
  if (connection.service !== 'http' || connection.httpHandled || !connection.received.includes('\r\n\r\n'))
    return;
  connection.httpHandled = true;
  const line = connection.received.split('\r\n')[0];
  const request = /^(\S+) (\/\S*) HTTP\/1\.[01]$/.exec(line);
  const status = !request
    ? '400 Bad Request'
    : request[1] !== 'GET'
      ? '405 Method Not Allowed'
      : request[2] !== '/'
        ? '404 Not Found'
        : '200 OK';
  const body = status === '200 OK' ? (connection.responseBody ?? '') : status + '\n';
  queueTcpText(
    connection,
    `HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${tcpBytes(body)}\r\nConnection: close\r\n\r\n${body}`
  );
  connection.closeRequested = true;
}
