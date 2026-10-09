import { z } from 'zod';
import type { SimulationEngine } from '../core/engine';
import type { Device, UdpPacket } from '../model';
import { ipv4Schema } from '../schemas';
import { random } from '../core/queue';
import { isUnicast } from './dhcp-config';
import { resolveRoute } from './ipv4';
import {
  SNMP,
  snmpAgentSchema,
  snmpMessageSchema,
  oidSchema,
  type SnmpMessage,
  type SnmpQuery,
} from './snmp-model';
import { compareOids, snmpMib } from './snmp-mib';
import { managementPacket } from './management-wire';

export function configureSnmpAgent(engine: SimulationEngine, device: Device, input: unknown) {
  if (device.type === 'switch' && !device.ipRouting)
    throw new Error('Switch L2 não possui stack IPv4 de gerenciamento.');
  const fields = snmpAgentSchema.omit({ startedAt: true }).parse(input);
  device.snmpAgent = {
    ...fields,
    startedAt: device.snmpAgent?.enabled ? device.snmpAgent.startedAt : engine.state.clock,
  };
  engine.emit(
    'CONFIG_CHANGED',
    device.id,
    'Agente SNMP/161 ' + (fields.enabled ? 'ativado' : 'desativado') + '.'
  );
}
function finish(engine: SimulationEngine, device: Device, query: SnmpQuery) {
  engine.state.queue = engine.state.queue.filter(
    ({ action }) =>
      action.kind !== 'snmp-timeout' || action.device !== device.id || action.queryId !== query.id
  );
  query.elapsed = engine.state.clock - query.startedAt;
  engine.emit(
    query.status === 'success' ? 'SNMP_ANSWER' : 'SNMP_FAILED',
    device.id,
    'SNMP ' + query.id + ' ' + query.status + '; agente ' + query.server + '.'
  );
}
function send(engine: SimulationEngine, device: Device, query: SnmpQuery) {
  const port = device.interfaces.find((entry) => entry.id === query.port);
  if (!device.power || !port?.adminUp || port.ip !== query.sourceIp) {
    query.status = 'cancelled';
    finish(engine, device, query);
    return;
  }
  query.deadline = engine.state.clock + SNMP.timeout;
  query.requestId = Math.floor(random(engine.state) * 2147483648);
  engine.schedule(SNMP.timeout, {
    kind: 'snmp-timeout',
    device: device.id,
    queryId: query.id,
    attempt: query.attempts,
  });
  engine.emit(
    'SNMP_QUERY',
    device.id,
    query.operation + ' para ' + query.server + ':161; tentativa ' + query.attempts + '.',
    { port: query.port }
  );
  engine.sendIp(
    device.id,
    managementPacket(query.sourceIp, query.server, query.sourcePort, SNMP.port, {
      protocol: 'SNMP',
      message: {
        type: query.operation,
        requestId: query.requestId,
        community: query.community,
        oids: query.oids,
      },
    })
  );
}
export function querySnmp(
  engine: SimulationEngine,
  device: Device,
  server: string,
  community: string,
  oids: string[],
  operation: 'get' | 'get-next' = 'get'
) {
  if ((device.type === 'switch' && !device.ipRouting) || !device.power)
    throw new Error('SNMP exige equipamento ligado com stack IPv4.');
  const target = ipv4Schema.parse(server);
  if (!isUnicast(target)) throw new Error('Agente SNMP deve ser unicast.');
  const request = snmpMessageSchema.parse({
    type: operation,
    requestId: 0,
    community,
    oids: z.array(oidSchema).min(1).max(16).parse(oids),
  });
  if (request.type === 'response') throw new Error('Operação SNMP inválida.');
  const route = resolveRoute(device, target),
    port = route?.port ?? device.interfaces.find((entry) => entry.adminUp && entry.ip);
  if (!port?.ip) throw new Error('Configure um endereço IPv4 na origem SNMP.');
  device.snmpQueries ??= [];
  if (device.snmpQueries.length >= 128) {
    const index = device.snmpQueries.findIndex((query) => query.status !== 'pending');
    if (index < 0) throw new Error('Limite de consultas SNMP pendentes atingido.');
    device.snmpQueries.splice(index, 1);
  }
  let sourcePort = 49152 + Math.floor(random(engine.state) * 16384);
  const used = new Set([
    ...device.snmpQueries.filter((query) => query.status === 'pending').map((query) => query.sourcePort),
    ...(device.dnsQueries?.filter((query) => query.status === 'pending').map((query) => query.sourcePort) ??
      []),
    ...(device.tcpConnections?.map((connection) => connection.localPort) ?? []),
  ]);
  while (used.has(sourcePort)) sourcePort = sourcePort === 65535 ? 49152 : sourcePort + 1;
  const query: SnmpQuery = {
    id: engine.id('snmp'),
    requestId: 0,
    community: request.community,
    oids: request.oids,
    operation,
    server: target,
    port: port.id,
    sourceIp: port.ip,
    sourcePort,
    startedAt: engine.state.clock,
    deadline: engine.state.clock + SNMP.timeout,
    attempts: 1,
    status: 'pending',
    varbinds: [],
  };
  device.snmpQueries.push(query);
  send(engine, device, query);
  return query.id;
}
export function handleSnmpTimeout(engine: SimulationEngine, device: Device, id: string, attempt: number) {
  const query = device.snmpQueries?.find(
    (entry) => entry.id === id && entry.status === 'pending' && entry.attempts === attempt
  );
  if (!query) return;
  if (query.attempts < SNMP.attempts) {
    query.attempts++;
    send(engine, device, query);
  } else {
    query.status = 'timeout';
    finish(engine, device, query);
  }
}
export function receiveSnmp(engine: SimulationEngine, device: Device, incoming: UdpPacket) {
  if (incoming.payload.protocol !== 'SNMP') return;
  const message = incoming.payload.message;
  if (
    !incoming.ttl ||
    !isUnicast(incoming.src) ||
    !isUnicast(incoming.dst) ||
    (message.type === 'response'
      ? incoming.sourcePort !== SNMP.port || incoming.destinationPort < 49152
      : incoming.destinationPort !== SNMP.port || incoming.sourcePort < 49152)
  ) {
    engine.drop(device, 'SNMP: origem, destino, portas UDP ou TTL inválidos.');
    return;
  }
  if (message.type === 'response') {
    const query = device.snmpQueries?.find(
      (entry) =>
        entry.status === 'pending' &&
        entry.server === incoming.src &&
        entry.sourceIp === incoming.dst &&
        entry.sourcePort === incoming.destinationPort &&
        entry.requestId === message.requestId &&
        entry.community === message.community
    );
    if (
      !query ||
      (message.errorStatus === 'tooBig'
        ? message.varbinds.length !== 0
        : message.varbinds.length !== query.oids.length ||
          message.varbinds.some((entry, index) =>
            query.operation === 'get'
              ? entry.oid !== query.oids[index] || entry.type === 'endOfMibView'
              : entry.type === 'endOfMibView'
                ? entry.oid !== query.oids[index]
                : entry.type === 'noSuchObject' || compareOids(entry.oid, query.oids[index]) <= 0
          ))
    ) {
      engine.drop(device, 'SNMP: resposta não corresponde à consulta pendente.');
      return;
    }
    query.varbinds = structuredClone(message.varbinds);
    query.status = message.errorStatus === 'noError' ? 'success' : 'tooBig';
    finish(engine, device, query);
    return;
  }
  if (!device.snmpAgent?.enabled || message.community !== device.snmpAgent.community) {
    engine.emit('SNMP_REJECTED', device.id, 'Agente desativado ou community sem acesso.');
    return;
  }
  const mib = snmpMib(engine, device);
  const varbinds = message.oids.map(
    (oid) =>
      (message.type === 'get'
        ? mib.find((entry) => entry.oid === oid)
        : mib.find((entry) => compareOids(entry.oid, oid) > 0)) ??
      (message.type === 'get'
        ? { oid, type: 'noSuchObject' as const }
        : { oid, type: 'endOfMibView' as const })
  );
  let response: Extract<SnmpMessage, { type: 'response' }> = {
    type: 'response',
    requestId: message.requestId,
    community: message.community,
    errorStatus: 'noError',
    varbinds,
  };
  let reply = managementPacket(incoming.dst, incoming.src, SNMP.port, incoming.sourcePort, {
    protocol: 'SNMP',
    message: response,
  });
  const mtu =
    resolveRoute(device, incoming.src)?.port.mtu ??
    device.interfaces.find((entry) => entry.ip === incoming.dst)?.mtu ??
    1500;
  if (reply.bytes > mtu) {
    response = { ...response, errorStatus: 'tooBig', varbinds: [] };
    reply = managementPacket(incoming.dst, incoming.src, SNMP.port, incoming.sourcePort, {
      protocol: 'SNMP',
      message: response,
    });
  }
  engine.emit(
    'SNMP_RESPONSE',
    device.id,
    'Resposta ' +
      message.requestId +
      ': ' +
      response.errorStatus +
      '; ' +
      response.varbinds.length +
      ' objeto(s).'
  );
  engine.sendIp(device.id, reply);
}
