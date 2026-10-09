import {
  DNS,
  dnsQuestionSchema,
  type Action,
  type Device,
  type DnsQuery,
  type DnsQuestion,
  type UdpPacket,
  type DnsMessage,
} from '../model';
import type { SimulationEngine } from '../core/engine';
import { random } from '../core/queue';
import { verifyDnsResponse, dnsCacheExpiry } from './dnssec';
import { transportAddressSchema } from './tcp-model';
import { sendDatagram6 } from './udp6';
import { resolveRoute6, source6, usable6 } from './ipv6-routing';
import { unicast6, linkLocal6 } from './ipv6-address';
import { isUnicast } from './dhcp-config';
import { resolveRoute } from './ipv4';
import { validDnsAnswers } from './dns-records';
import { dnsPacket } from './dns-wire';
import { openTcp, closeTcp } from './tcp';
import { encodeDnsTcp } from './dns-tcp-codec';

function cancelTimeout(engine: SimulationEngine, device: Device, query: DnsQuery) {
  engine.state.queue = engine.state.queue.filter(
    ({ action }) =>
      action.kind !== 'dns-timeout' || action.device !== device.id || action.queryId !== query.id
  );
}

function complete(engine: SimulationEngine, device: Device, query: DnsQuery) {
  cancelTimeout(engine, device, query);
  query.elapsed = engine.state.clock - query.startedAt;
  engine.emit(
    query.status === 'success' ? 'DNS_ANSWER' : 'DNS_FAILED',
    device.id,
    query.question.name +
      ' ' +
      query.question.type +
      ': ' +
      query.status +
      (query.status === 'success'
        ? '; ' + query.answers.length + ' registro(s) recebido(s).'
        : '; servidor ' + query.server + '.')
  );
  if (query.status === 'success' && query.pingTtl !== undefined) {
    const address = query.answers.find((record) => record.type === 'A')?.value;
    if (address) query.probeId = engine.ping(device.id, address, query.pingTtl);
  }
}

function dnsSource(engine: SimulationEngine, device: Device, server: string) {
  const p = server.includes(':')
    ? resolveRoute6(device, server, engine.state.clock)?.port
    : resolveRoute(device, server)?.port;
  return p?.adminUp ? { port: p, ip: server.includes(':') ? source6(p, server) : p.ip } : undefined;
}
function sendQuery(engine: SimulationEngine, device: Device, query: DnsQuery) {
  if (query.tcpConnection) {
    closeTcp(engine, device, query.tcpConnection, true);
    delete query.tcpConnection;
  }
  query.transport = query.mode === 'tcp' ? 'tcp' : 'udp';
  delete query.tcpFallback;
  query.server = query.servers[Math.floor(query.attempts / DNS.attemptsPerServer)];
  const origin = dnsSource(engine, device, query.server);
  if (!device.power || !origin?.ip) {
    query.status = 'cancelled';
    complete(engine, device, query);
    return;
  }
  query.port = origin.port.id;
  query.sourceIp = origin.ip;
  query.transactionId = Math.floor(random(engine.state) * 65536);
  query.attempts++;
  query.deadline = engine.state.clock + DNS.timeout;
  const packet = dnsPacket(query.sourceIp, query.server, query.sourcePort, {
    type: 'query',
    transactionId: query.transactionId,
    question: query.question,
    recursionDesired: true,
    ...(device.dnsResolver?.edns ? { edns: device.dnsResolver.edns } : {}),
  });
  engine.emit(
    'DNS_QUERY',
    device.id,
    'Consulta ' +
      query.question.type +
      ' ' +
      query.question.name +
      ' para ' +
      query.server +
      ':53; tentativa ' +
      query.attempts +
      '.',
    { port: query.port }
  );
  engine.schedule(DNS.timeout, {
    kind: 'dns-timeout',
    device: device.id,
    queryId: query.id,
    attempt: query.attempts,
  });
  if (query.transport === 'tcp') sendTcpQuery(engine, device, query);
  else if (query.server.includes(':'))
    sendDatagram6(engine, device, origin.port, query.sourceIp, query.server, {
      sourcePort: packet.sourcePort,
      destinationPort: 53,
      payload: packet.payload,
    });
  else engine.sendIp(device.id, packet);
}

function sendTcpQuery(engine: SimulationEngine, device: Device, query: DnsQuery) {
  try {
    openTcp(
      engine,
      device,
      query.server,
      DNS.port,
      encodeDnsTcp({
        type: 'query',
        transactionId: query.transactionId,
        question: query.question,
        recursionDesired: true,
        ...(device.dnsResolver?.edns ? { edns: device.dnsResolver.edns } : {}),
      }),
      true,
      (connection) => {
        connection.service = 'dns';
        query.tcpConnection = connection.id;
        query.sourcePort = connection.localPort;
        query.sourceIp = connection.localIp;
        query.port = device.interfaces.find(
          (port) => port.ip === connection.localIp || usable6(port).some((a) => a.ip === connection.localIp)
        )!.id;
      }
    );
  } catch {
    query.status = 'servfail';
    query.code = 'SERVFAIL';
    complete(engine, device, query);
  }
}

export function lookupDns(
  engine: SimulationEngine,
  device: Device,
  name: string,
  type: DnsQuestion['type'] = 'A',
  server?: string,
  pingTtl?: number,
  mode: 'auto' | 'udp' | 'tcp' = 'auto'
) {
  if (device.type === 'switch') throw new Error('Switch L2 não possui resolvedor DNS.');
  if (!device.power) throw new Error('Equipamento desligado.');
  const question = dnsQuestionSchema.parse({ name, type });
  if (!['auto', 'udp', 'tcp'].includes(mode)) throw new Error('Transporte DNS inválido.');
  const servers = server
    ? [transportAddressSchema.parse(server)]
    : [
        ...new Set(
          device.interfaces
            .filter((port) => port.adminUp)
            .flatMap((port) => [...(port.dns ?? []), ...(port.dhcp6?.dns ?? [])])
        ),
      ].slice(0, 8);
  if (
    !servers.length ||
    !servers.every((s) => (s.includes(':') ? unicast6(s) && !linkLocal6(s) : isUnicast(s)))
  )
    throw new Error('Configure servidores DNS na interface ou obtenha-os por DHCP.');
  const origin = dnsSource(engine, device, servers[0]);
  if (!origin?.ip) throw new Error('Configure endereço e rota para o servidor DNS e aguarde DAD.');
  const port = origin.port;
  if (pingTtl !== undefined && (!Number.isInteger(pingTtl) || pingTtl < 1 || pingTtl > 255))
    throw new Error('TTL inválido.');
  const queries = (device.dnsQueries ??= []);
  if (queries.length >= DNS.maxQueries) {
    const oldest = queries.findIndex((query) => query.status !== 'pending');
    if (oldest < 0) throw new Error('Limite de consultas DNS pendentes.');
    queries.splice(oldest, 1);
  }
  const queryId = engine.id('dns-query');
  let sourcePort = 49152 + (engine.state.sequence % 16384);
  while (queries.some((query) => query.status === 'pending' && query.sourcePort === sourcePort))
    sourcePort = sourcePort === 65535 ? 49152 : sourcePort + 1;
  const query: DnsQuery = {
    id: queryId,
    question,
    servers,
    server: servers[0],
    port: port.id,
    sourceIp: origin.ip,
    sourcePort,
    transactionId: 0,
    attempts: 0,
    mode,
    transport: mode === 'tcp' ? 'tcp' : 'udp',
    startedAt: engine.state.clock,
    deadline: engine.state.clock,
    status: 'pending',
    answers: [],
    fromCache: false,
    ...(pingTtl !== undefined ? { pingTtl } : {}),
  };
  queries.push(query);
  device.dnsCache = device.dnsCache?.filter((entry) => entry.expiresAt > engine.state.clock);
  const cached = device.dnsCache?.find(
    (entry) =>
      servers.includes(entry.server) &&
      entry.question.name === question.name &&
      entry.question.type === question.type
  );
  if (cached) {
    query.answers = cached.answers.map((record) => ({
      ...record,
      ttl: Math.max(0, record.ttl - Math.floor((engine.state.clock - cached.storedAt) / 1000)),
    }));
    query.server = cached.server;
    query.status = 'success';
    query.code = 'NOERROR';
    query.fromCache = true;
    query.security = cached.security ?? 'insecure';
    engine.emit(
      'DNS_CACHE_HIT',
      device.id,
      question.name +
        ' atendido pelo cache; TTL restante ' +
        Math.ceil((cached.expiresAt - engine.state.clock) / 1000) +
        ' s.'
    );
    complete(engine, device, query);
  } else sendQuery(engine, device, query);
  return query.id;
}

export function handleDnsTimeout(engine: SimulationEngine, action: Extract<Action, { kind: 'dns-timeout' }>) {
  const device = engine.device(action.device);
  const query = device.dnsQueries?.find((entry) => entry.id === action.queryId);
  if (!query || query.status !== 'pending' || query.attempts !== action.attempt) return;
  engine.emit('DNS_TIMEOUT', device.id, 'Sem resposta DNS de ' + query.server + ' após 5 s virtuais.', {
    port: query.port,
  });
  if (query.attempts < query.servers.length * DNS.attemptsPerServer) sendQuery(engine, device, query);
  else {
    query.status = 'timeout';
    if (query.tcpConnection) closeTcp(engine, device, query.tcpConnection, true);
    complete(engine, device, query);
  }
}

export function receiveDnsResponse(engine: SimulationEngine, device: Device, packet: UdpPacket) {
  if (packet.payload.protocol !== 'DNS' || packet.payload.message.type !== 'response') return;
  receiveDnsAnswer(engine, device, packet.payload.message, {
    src: packet.src,
    dst: packet.dst,
    destinationPort: packet.destinationPort,
    transport: 'udp',
  });
}
export function receiveDnsAnswer(
  engine: SimulationEngine,
  device: Device,
  message: Extract<DnsMessage, { type: 'response' }>,
  packet: {
    src: string;
    dst: string;
    destinationPort: number;
    transport: 'udp' | 'tcp';
    connection?: string;
  }
) {
  const query = device.dnsQueries?.find(
    (entry) =>
      entry.status === 'pending' &&
      (entry.transport ?? 'udp') === packet.transport &&
      (packet.transport !== 'tcp' || entry.tcpConnection === packet.connection) &&
      entry.transactionId === message.transactionId &&
      entry.sourcePort === packet.destinationPort &&
      entry.sourceIp === packet.dst &&
      entry.server === packet.src &&
      entry.question.name === message.question.name &&
      entry.question.type === message.question.type
  );
  if (!query) {
    engine.drop(
      device,
      'Resposta DNS sem consulta correspondente: origem, ID, porta ou pergunta divergente.'
    );
    return;
  }
  if (message.truncated && packet.transport === 'udp' && (query.mode ?? 'auto') === 'auto') {
    query.transport = 'tcp';
    query.tcpFallback = true;
    cancelTimeout(engine, device, query);
    query.deadline = engine.state.clock + DNS.timeout;
    engine.schedule(DNS.timeout, {
      kind: 'dns-timeout',
      device: device.id,
      queryId: query.id,
      attempt: query.attempts,
    });
    engine.emit(
      'DNS_TCP_FALLBACK',
      device.id,
      `${query.question.name}: resposta UDP truncada; nova consulta por TCP/53.`
    );
    sendTcpQuery(engine, device, query);
    return;
  }
  if (
    message.code === 'NOERROR' &&
    !message.truncated &&
    message.answers.some((record) => record.type === query.question.type) &&
    !validDnsAnswers(query.question, message.answers)
  ) {
    engine.drop(device, 'Resposta DNS contém registros fora da cadeia consultada.');
    return;
  }
  query.security = message.truncated ? 'insecure' : verifyDnsResponse(device, message, engine.state.clock);
  if (query.security === 'bogus') {
    query.code = 'SERVFAIL';
    query.answers = [];
    query.status = 'servfail';
    engine.drop(device, 'DNSSEC: assinatura, âncora, validade ou prova de negação inválida.');
    complete(engine, device, query);
    return;
  }
  query.code = message.code;
  query.answers = structuredClone(message.answers);
  query.status = message.truncated
    ? 'truncated'
    : message.code === 'NXDOMAIN'
      ? 'nxdomain'
      : message.code === 'SERVFAIL' || message.code === 'BADVERS'
        ? 'servfail'
        : message.code === 'REFUSED'
          ? 'refused'
          : message.answers.some((record) => record.type === query.question.type)
            ? 'success'
            : 'nodata';
  if (query.status === 'success') {
    const ttl = Math.min(...message.answers.map((record) => record.ttl));
    if (ttl > 0) {
      const cache = (device.dnsCache ??= []);
      device.dnsCache = cache.filter(
        (entry) =>
          !(
            entry.server === query.server &&
            entry.question.name === query.question.name &&
            entry.question.type === query.question.type
          )
      );
      device.dnsCache.push({
        question: query.question,
        server: query.server,
        answers: structuredClone(message.answers),
        storedAt: engine.state.clock,
        expiresAt: dnsCacheExpiry(
          engine.state.clock,
          message.answers,
          query.security === 'secure' ? message.dnssec : undefined
        ),
        security: query.security,
        ...(query.security === 'secure' ? { proof: message.dnssec } : {}),
      });
      if (device.dnsCache.length > DNS.maxCache) device.dnsCache.shift();
    }
  }
  complete(engine, device, query);
}
