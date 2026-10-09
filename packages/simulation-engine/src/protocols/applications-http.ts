import type { SimulationEngine } from '../core/engine';
import type { Device, TcpConnection } from '../model';
import { tcpBytes, tcpFinished } from './tcp-model';
import { queueTcpText } from './tcp-services';
import { openTcp, flushTcp } from './tcp';
import { decodeIpp, encodeIpp } from './ipp-codec';
export function httpMessage(text: string) {
  const at = text.indexOf('\r\n\r\n');
  if (at < 0) return;
  const header = text.slice(0, at),
    lengths = [...header.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)];
  if (lengths.length > 1 || /^Transfer-Encoding:/im.test(header)) throw new Error('HTTP framing ambíguo.');
  const length = lengths.length ? Number(lengths[0][1]) : 0,
    body = text.slice(at + 4);
  if (length > 12000) throw new Error('HTTP corpo excede limite.');
  if (tcpBytes(body) < length) return;
  if (tcpBytes(body) !== length) throw new Error('HTTP dados após mensagem.');
  return { line: header.split('\r\n')[0], header, body };
}
export function respondHttp(
  e: SimulationEngine,
  d: Device,
  c: TcpConnection,
  status: string,
  body: string,
  type = 'text/plain; charset=utf-8'
) {
  queueTcpText(
    c,
    `HTTP/1.1 ${status}\r\nContent-Type: ${type}\r\nContent-Length: ${tcpBytes(body)}\r\nConnection: close\r\n\r\n${body}`
  );
  c.closeRequested = true;
  flushTcp(e, d, c);
}
export function proxyRequest(e: SimulationEngine, d: Device, c: TcpConnection) {
  const config = d.proxy;
  if (!config?.enabled || c.httpHandled) return;
  const request = httpMessage(c.received);
  if (!request) return;
  c.httpHandled = true;
  const match = /^GET (\S+) HTTP\/1\.[01]$/.exec(request.line);
  if (!match) {
    respondHttp(e, d, c, '405 Method Not Allowed', 'Somente GET.');
    return;
  }
  let target: string, port: number, path: string;
  if (config.kind === 'proxy') {
    const url = /^http:\/\/([a-f0-9.]+|\[[a-f0-9:]+\])(?::(\d+))?(\/[^\s]*)?$/i.exec(match[1]);
    if (!url) {
      respondHttp(e, d, c, '400 Bad Request', 'Use URL http://IPv4/ ou http://[IPv6]/.');
      return;
    }
    target = url[1].replace(/[[\]]/g, '');
    port = Number(url[2] ?? 80);
    path = url[3] ?? '/';
    if (!config.allowedNetworks.includes(target)) {
      respondHttp(e, d, c, '403 Forbidden', 'Destino fora da lista permitida do proxy.');
      return;
    }
  } else {
    path = match[1];
    if (!path.startsWith('/')) {
      respondHttp(e, d, c, '400 Bad Request', 'Caminho HTTP inválido.');
      return;
    }
    const available = config.health.filter((h) => h.state !== 'down');
    if (!available.length) {
      respondHttp(e, d, c, '503 Service Unavailable', 'Nenhum backend saudável.');
      return;
    }
    if (config.algorithm === 'least-connections')
      available.sort(
        (a, b) =>
          config.requests.filter(
            (r) => r.state === 'pending' && !r.health && r.backend === a.address && r.port === a.port
          ).length -
          config.requests.filter(
            (r) => r.state === 'pending' && !r.health && r.backend === b.address && r.port === b.port
          ).length
      );
    const selected = available[config.algorithm === 'round-robin' ? config.cursor++ % available.length : 0];
    target = selected.address;
    port = selected.port;
  }
  if (target === c.localIp && port === c.localPort) {
    respondHttp(e, d, c, '508 Loop Detected', 'Proxy aponta para o próprio listener.');
    return;
  }
  startProxyUpstream(e, d, target, port, path, c.id);
}
export function startProxyUpstream(
  e: SimulationEngine,
  d: Device,
  target: string,
  port: number,
  path = '/',
  front?: string
) {
  const config = d.proxy!;
  if (config.requests.length >= 128) {
    const old = config.requests.findIndex((r) => r.state !== 'pending');
    if (old < 0) {
      if (front) {
        const c = d.tcpConnections?.find((c) => c.id === front);
        if (c) respondHttp(e, d, c, '503 Service Unavailable', 'Limite de requisições.');
      }
      return;
    }
    config.requests.splice(old, 1);
  }
  try {
    openTcp(
      e,
      d,
      target,
      port,
      `GET ${path} HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`,
      true,
      (c) => {
        c.service = 'proxy-upstream';
        config.requests.push({
          id: e.id('proxy-request'),
          ...(front ? { front } : {}),
          upstream: c.id,
          backend: target,
          port,
          deadline: e.state.clock + 3000,
          state: 'pending',
          health: !front,
        });
        const health = config.health.find((h) => h.address === target && h.port === port);
        if (!front && health) health.connection = c.id;
      }
    );
  } catch {
    const health = config.health.find((h) => h.address === target && h.port === port);
    if (health) {
      health.state = 'down';
      health.checkedAt = e.state.clock;
    }
    if (front) {
      const c = d.tcpConnections?.find((c) => c.id === front);
      if (c) respondHttp(e, d, c, '502 Bad Gateway', 'Backend sem rota ou conexão.');
    }
  }
}
export function proxyResponse(e: SimulationEngine, d: Device, c: TcpConnection) {
  const r = d.proxy?.requests.find((r) => r.upstream === c.id && r.state === 'pending');
  if (!r) return;
  const response = httpMessage(c.received);
  if (!response) return;
  if (!/^HTTP\/1\.[01] \d{3} /.test(response.line)) throw new Error('Resposta HTTP inválida do backend.');
  r.state = 'complete';
  const h = d.proxy!.health.find((h) => h.address === r.backend && h.port === r.port);
  if (h) {
    h.state = /^HTTP\/1\.[01] [23]/.test(response.line) ? 'up' : 'down';
    h.checkedAt = e.state.clock;
    delete h.connection;
  }
  if (r.front) {
    const front = d.tcpConnections?.find((c) => c.id === r.front);
    if (front && !tcpFinished(front)) {
      queueTcpText(front, c.received);
      front.closeRequested = true;
      flushTcp(e, d, front);
    }
  }
  e.emit(
    'APPLICATION_DATA',
    d.id,
    `HTTP ${r.health ? 'health check' : r.id} recebido de ${r.backend}:${r.port}.`
  );
}
export function printerRequest(e: SimulationEngine, d: Device, c: TcpConnection) {
  const config = d.printer;
  if (!config?.enabled || c.httpHandled) return;
  const request = httpMessage(c.received);
  if (!request) return;
  c.httpHandled = true;
  if (
    request.line !== 'POST /ipp/print HTTP/1.1' ||
    !/^Content-Type: application\/ipp\s*$/im.test(request.header)
  ) {
    respondHttp(e, d, c, '400 Bad Request', 'IPP requer POST /ipp/print.');
    return;
  }
  const m = decodeIpp(request.body);
  let code = 0,
    attributes: Record<string, string | number> = {
      'attributes-charset': 'utf-8',
      'attributes-natural-language': 'pt-br',
    };
  if (m.attributes['attributes-charset'] !== 'utf-8') code = 0x040b;
  else if (m.code === 2) {
    const pages = Number(m.attributes['job-impressions'] ?? 1),
      name = String(m.attributes['job-name'] ?? 'Documento');
    if (!Number.isInteger(pages) || pages < 1 || pages > 50 || name.length > 100 || !m.document)
      code = 0x040b;
    else if (config.jobs.length >= 128) code = 0x0507;
    else {
      const id = ++config.sequence;
      config.jobs.push({
        id,
        name,
        owner: c.remoteIp,
        pages,
        printed: 0,
        state: 'pending',
        nextPage: e.state.clock,
      });
      attributes['job-id'] = id;
      attributes['job-state'] = 3;
      e.emit('APPLICATION_DATA', d.id, `IPP Print-Job ${id}: ${pages} página(s).`);
    }
  } else if (m.code === 8 || m.code === 9) {
    const job = config.jobs.find((j) => j.id === m.attributes['job-id']);
    if (!job) code = 0x0406;
    else if (m.code === 8 && job.owner !== c.remoteIp) code = 0x0403;
    else {
      if (m.code === 8 && !['completed', 'cancelled'].includes(job.state)) job.state = 'cancelled';
      attributes = {
        ...attributes,
        'job-id': job.id,
        'job-state': { pending: 3, processing: 5, stopped: 6, cancelled: 7, completed: 9 }[job.state],
        'job-impressions-completed': job.printed,
      };
    }
  } else if (m.code === 11)
    attributes = {
      ...attributes,
      'printer-state': config.jobs.some((j) => j.state === 'processing') ? 4 : 3,
      'queued-job-count': config.jobs.filter((j) => ['pending', 'processing', 'stopped'].includes(j.state))
        .length,
      'media-count': config.paper,
    };
  else code = 0x0501;
  respondHttp(
    e,
    d,
    c,
    '200 OK',
    encodeIpp({ code, requestId: m.requestId, attributes, document: '' }),
    'application/ipp'
  );
}
export function submitPrint(
  e: SimulationEngine,
  d: Device,
  target: string,
  name: string,
  pages: number,
  document = 'Documento shLab',
  operation = 2,
  jobId?: number
) {
  if (name.length > 100 || !Number.isInteger(pages) || pages < 1 || pages > 50 || tcpBytes(document) > 4096)
    throw new Error('Trabalho de impressão inválido.');
  const body = encodeIpp({
    code: operation,
    requestId: 1 + (e.state.sequence % 2147483647),
    attributes: {
      'attributes-charset': 'utf-8',
      'attributes-natural-language': 'pt-br',
      'printer-uri': `ipp://${target}/ipp/print`,
      'job-name': name,
      'job-impressions': pages,
      ...(jobId ? { 'job-id': jobId } : {}),
    },
    document: operation === 2 ? document : '',
  });
  return openTcp(
    e,
    d,
    target,
    631,
    `POST /ipp/print HTTP/1.1\r\nHost: ${target}\r\nContent-Type: application/ipp\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
    true
  );
}
