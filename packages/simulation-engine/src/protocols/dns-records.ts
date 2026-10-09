import { z } from 'zod';
import { dnsCacheExpiry, verifyDnsResponse } from './dnssec';
import { DNS, dnsRecordSchema, ipv4Schema, type Device, type DnsQuestion, type DnsRecord } from '../model';
import { unicast6, linkLocal6 } from './ipv6-address';
const dnsUnicast = (s: string) => (s.includes(':') ? unicast6(s) && !linkLocal6(s) : isUnicast(s));
import { isUnicast } from './dhcp-config';

export function validateDnsRecords(device: Device) {
  if (!device.dnsServer) return;
  if (device.type !== 'server' && device.type !== 'router')
    throw new Error('Serviço DNS requer servidor ou roteador.');
  if (
    device.dnsServer.enabled &&
    device.tcpServices?.some((service) => service.enabled && service.port === 53)
  )
    throw new Error('TCP/53 já está ocupado por outro serviço.');
  const keys = new Set<string>();
  for (const record of device.dnsServer.records) {
    const key = JSON.stringify([record.name, record.type, record.value]);
    if (keys.has(key)) throw new Error('Registro DNS duplicado.');
    keys.add(key);
    const siblings = device.dnsServer.records.filter((entry) => entry.name === record.name);
    if (siblings.length > 1 && siblings.some((entry) => entry.type === 'CNAME'))
      throw new Error('CNAME não pode coexistir com outros registros do mesmo nome.');
  }
}

export function configureDnsRecord(device: Device, input: unknown, previous?: DnsRecord) {
  const record = dnsRecordSchema.parse(input);
  const records =
    device.dnsServer?.records.filter(
      (entry) =>
        !previous ||
        entry.name !== previous.name ||
        entry.type !== previous.type ||
        entry.value !== previous.value
    ) ?? [];
  if (records.length >= 256) throw new Error('Limite de 256 registros DNS.');
  const candidate = {
    ...device.dnsServer,
    enabled: device.dnsServer?.enabled ?? true,
    records: [...records, record],
  };
  validateDnsRecords({ ...device, dnsServer: candidate });
  device.dnsServer = candidate;
  return record;
}

export function resolveDnsRecords(
  records: DnsRecord[],
  question: DnsQuestion
): {
  code: 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL';
  answers: DnsRecord[];
} {
  let name = question.name;
  const visited = new Set<string>();
  const answers: DnsRecord[] = [];
  for (let depth = 0; depth <= DNS.maxAliases; depth++) {
    if (visited.has(name)) return { code: 'SERVFAIL', answers: [] };
    visited.add(name);
    const matching = records.filter((record) => record.name === name);
    if (!matching.length) return { code: 'NXDOMAIN', answers };
    const values = matching.filter((record) => record.type === question.type);
    if (values.length) return { code: 'NOERROR', answers: [...answers, ...structuredClone(values)] };
    const alias = matching.find((record) => record.type === 'CNAME');
    if (!alias || question.type === 'CNAME') return { code: 'NOERROR', answers };
    answers.push(structuredClone(alias));
    name = alias.value;
  }
  return { code: 'SERVFAIL', answers: [] };
}

export function validDnsAnswers(question: DnsQuestion, answers: DnsRecord[]) {
  const result = resolveDnsRecords(answers, question);
  return (
    result.code === 'NOERROR' &&
    result.answers.some((record) => record.type === question.type) &&
    JSON.stringify(result.answers) === JSON.stringify(answers)
  );
}

export function configureDnsServers(device: Device, portId: string, input: unknown) {
  const port = device.interfaces.find((entry) => entry.id === portId);
  if (!port || port.mode !== 'routed' || device.type === 'switch')
    throw new Error('Resolvedor DNS requer uma interface routed.');
  if (port.ipv4Mode === 'dhcp')
    throw new Error('DNS desta interface é gerenciado pelo DHCP; altere as opções do pool.');
  const servers = z.array(ipv4Schema).max(8).parse(input);
  if (!servers.every(isUnicast)) throw new Error('Servidores DNS devem usar IPv4 unicast.');
  port.dns = [...new Set(servers)];
  device.dnsCache = [];
}

export function validateDnsState(
  device: Device,
  clock: number,
  timers: Map<string, { at: number; attempt: number }>
) {
  validateDnsRecords(device);
  const ids = new Set<string>();
  const pendingPorts = new Set<number>();
  for (const port of device.interfaces) {
    if (port.dns && !port.dns.every(isUnicast)) throw new Error('Servidor DNS inválido na interface.');
  }
  for (const query of device.dnsQueries ?? []) {
    if (ids.has(query.id)) throw new Error('Consulta DNS duplicada.');
    ids.add(query.id);
    if (
      !device.interfaces.some((port) => port.id === query.port) ||
      !query.servers.includes(query.server) ||
      !query.servers.every(dnsUnicast) ||
      query.startedAt > clock
    )
      throw new Error('Referência ou relógio DNS inválido.');
    if (query.status === 'pending') {
      if (query.transport === 'tcp') {
        const connection = device.tcpConnections?.find((entry) => entry.id === query.tcpConnection);
        if (
          !connection ||
          connection.service !== 'dns' ||
          connection.role !== 'client' ||
          connection.remoteIp !== query.server ||
          connection.remotePort !== DNS.port ||
          connection.localIp !== query.sourceIp ||
          connection.localPort !== query.sourcePort
        )
          throw new Error('Consulta DNS/TCP sem conexão correspondente.');
      } else if (query.tcpConnection) throw new Error('Consulta UDP com conexão TCP.');
      const timer = timers.get(JSON.stringify([device.id, query.id]));
      if (
        query.attempts < 1 ||
        query.attempts > query.servers.length * DNS.attemptsPerServer ||
        timer?.at !== query.deadline ||
        timer.at < clock ||
        timer.attempt !== query.attempts
      )
        throw new Error('Consulta DNS sem timer correspondente.');
      if (pendingPorts.has(query.sourcePort)) throw new Error('Porta DNS de consulta duplicada.');
      pendingPorts.add(query.sourcePort);
      if (query.answers.length || query.fromCache || query.elapsed !== undefined)
        throw new Error('Consulta DNS pendente com resultado.');
    } else if (query.elapsed === undefined || query.elapsed > clock - query.startedAt)
      throw new Error('Duração DNS inválida.');
    if (
      query.status === 'success' &&
      (query.code !== 'NOERROR' || !validDnsAnswers(query.question, query.answers))
    )
      throw new Error('Resposta DNS não corresponde à pergunta.');
  }
  const cacheKeys = new Set<string>();
  for (const entry of device.dnsCache ?? []) {
    const key = JSON.stringify([entry.server, entry.question]);
    if (
      cacheKeys.has(key) ||
      !dnsUnicast(entry.server) ||
      entry.storedAt > clock ||
      entry.expiresAt <= clock ||
      entry.expiresAt !== dnsCacheExpiry(entry.storedAt, entry.answers, entry.proof) ||
      !validDnsAnswers(entry.question, entry.answers)
    )
      throw new Error('Cache DNS inválido ou expirado.');
    if (
      entry.security === 'secure' &&
      (!entry.proof ||
        verifyDnsResponse(
          device,
          {
            type: 'response',
            transactionId: 0,
            question: entry.question,
            recursionDesired: true,
            recursionAvailable: false,
            authoritative: true,
            truncated: false,
            code: 'NOERROR',
            answers: entry.answers,
            dnssec: entry.proof,
          },
          clock
        ) !== 'secure')
    )
      throw new Error('Cache DNSSEC sem prova válida.');
    cacheKeys.add(key);
  }
}
