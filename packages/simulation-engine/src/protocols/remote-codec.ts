import { tcpBytes } from './tcp-model';
import { remoteRpcSchema, remoteResponseSchema, type RemoteRpc, type RemoteResponse } from './remote-model';

export const NETCONF_NS = 'urn:ietf:params:xml:ns:netconf:base:1.0';
export const NETWORK_NS = 'urn:shlab:yang:network';
export const NETCONF_CAPABILITIES = [
  'urn:ietf:params:netconf:base:1.0',
  'urn:ietf:params:netconf:base:1.1',
  'urn:ietf:params:netconf:capability:candidate:1.0',
  'urn:ietf:params:netconf:capability:validate:1.1',
  'urn:ietf:params:netconf:capability:startup:1.0',
  'urn:ietf:params:netconf:capability:rollback-on-error:1.0',
  NETWORK_NS + '?module=shlab-network&revision=2026-10-08',
];
type Node = { name: string; attributes: Record<string, string>; children: Node[]; value: string };
export const xmlEscape = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
function unescape(value: string) {
  if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(value)) throw new Error('Entidade XML não suportada.');
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}
export function parseXml(xml: string): Node {
  if (
    tcpBytes(xml) > 12000 ||
    /<!|<\?/.test(xml) ||
    [...xml].some(
      (character) => character.charCodeAt(0) < 32 && ![9, 10, 13].includes(character.charCodeAt(0))
    )
  )
    throw new Error('XML excedido, declaração/DTD ou caractere proibido.');
  const tokens = xml.match(/<[^>]*>|[^<]+/g) ?? [];
  let index = 0,
    nodes = 0;
  function parse(depth: number): Node {
    if (depth > 24 || ++nodes > 2048) throw new Error('XML excede profundidade/elementos permitidos.');
    const tag = tokens[index++],
      m = /^<([a-zA-Z_][\w:.-]*)([^<>]*?)(\/?)>$/.exec(tag ?? '');
    if (!m) throw new Error('Elemento XML inválido.');
    const attributes: Record<string, string> = {};
    let rest = m[2];
    while (rest.trim()) {
      const a = /^\s+([a-zA-Z_][\w:.-]*)="([^"<>]*)"/.exec(rest);
      if (!a || a[1] in attributes) throw new Error('Atributo XML inválido/duplicado.');
      attributes[a[1]] = unescape(a[2]);
      rest = rest.slice(a[0].length);
    }
    const node: Node = { name: m[1], attributes, children: [], value: '' };
    if (m[3]) return node;
    while (index < tokens.length) {
      const token = tokens[index];
      if (token.startsWith('</')) {
        index++;
        if (token !== `</${m[1]}>`) throw new Error('Fechamento XML divergente.');
        return node;
      }
      if (token.startsWith('<')) node.children.push(parse(depth + 1));
      else {
        index++;
        node.value += unescape(token);
      }
    }
    throw new Error('XML incompleto.');
  }
  while (tokens[index]?.trim() === '') index++;
  const root = parse(0);
  while (tokens[index]?.trim() === '') index++;
  if (index !== tokens.length) throw new Error('XML possui raízes múltiplas.');
  return root;
}
const child = (node: Node, name: string) => node.children.find((n) => n.name === name);
const one = (node: Node, name: string) => {
  const found = node.children.filter((n) => n.name === name);
  if (found.length !== 1) throw new Error('Elemento XML obrigatório/duplicado: ' + name);
  return found[0];
};
const names: Record<string, string> = {
  adminUp: 'admin-up',
  accessVlan: 'access-vlan',
  nextHop: 'next-hop',
  clearIp: 'clear-ip',
  routesAdd: 'routes-add',
  routesRemove: 'routes-remove',
  nextInterface: 'next-interface',
  nextRoute: 'next-route',
  leaseMs: 'lease-ms',
  base11: 'base-1-1',
};
const sourceName = (name: string) => Object.entries(names).find(([, v]) => v === name)?.[0] ?? name;
const arrays: Record<string, string> = {
  interfaces: 'interface',
  routes: 'route',
  routesAdd: 'route',
  routesRemove: 'route',
  capabilities: 'capability',
};
const numbers = new Set([
  'prefix',
  'metric',
  'speed',
  'mtu',
  'accessVlan',
  'offset',
  'revision',
  'rx',
  'tx',
  'nextInterface',
  'nextRoute',
  'leaseMs',
  'sessionId',
]);
const booleans = new Set([
  'adminUp',
  'clearIp',
  'locked',
  'discarded',
  'candidate',
  'valid',
  'committed',
  'patched',
  'copied',
  'deleted',
  'created',
  'replaced',
]);
function encodeValue(name: string, value: unknown): string {
  const tag = names[name] ?? name;
  if (value === null) return `<${tag} nil="true"/>`;
  if (Array.isArray(value))
    return `<${tag}>` + value.map((v) => encodeValue(arrays[name] ?? 'item', v)).join('') + `</${tag}>`;
  if (typeof value === 'object' && value !== null)
    return (
      `<${tag}>` +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => encodeValue(k, v))
        .join('') +
      `</${tag}>`
    );
  return `<${tag}>${xmlEscape(String(value))}</${tag}>`;
}
function decodeValue(node: Node): unknown {
  const name = sourceName(node.name);
  if (node.attributes.nil === 'true') return null;
  if (name in arrays) return node.children.map(decodeValue);
  if (node.children.length) {
    if (node.value.trim()) throw new Error('XML misto inválido.');
    const value: Record<string, unknown> = {};
    for (const n of node.children) {
      const key = sourceName(n.name);
      if (key in value) throw new Error('Campo XML duplicado: ' + key);
      value[key] = decodeValue(n);
    }
    return value;
  }
  if (numbers.has(name)) {
    const n = Number(node.value);
    if (!Number.isSafeInteger(n)) throw new Error('Número XML inválido.');
    return n;
  }
  if (booleans.has(name)) {
    if (!['true', 'false'].includes(node.value)) throw new Error('Booleano XML inválido.');
    return node.value === 'true';
  }
  return node.value;
}
export function netconfHello(sessionId?: number, base11 = true) {
  return (
    `<hello xmlns="${NETCONF_NS}"><capabilities>` +
    NETCONF_CAPABILITIES.filter((c) => base11 || !c.endsWith('base:1.1'))
      .map((c) => `<capability>${xmlEscape(c)}</capability>`)
      .join('') +
    `</capabilities>${sessionId ? `<session-id>${sessionId}</session-id>` : ''}</hello>`
  );
}
export function decodeHello(xml: string, server: boolean) {
  const n = parseXml(xml);
  if (n.name !== 'hello' || n.attributes.xmlns !== NETCONF_NS)
    throw new Error('NETCONF hello/namespace inválido.');
  const capabilities = one(n, 'capabilities').children.map((n) => {
    if (n.name !== 'capability' || !n.value || n.children.length) throw new Error('Capability inválida.');
    return n.value;
  });
  if (capabilities.length > 32 || !capabilities.some((c) => /^urn:ietf:params:netconf:base:1\.[01]$/.test(c)))
    throw new Error('Base NETCONF incompatível.');
  const id = child(n, 'session-id');
  if (server !== !!id || (id && (!/^[1-9]\d*$/.test(id.value) || Number(id.value) > Number.MAX_SAFE_INTEGER)))
    throw new Error('NETCONF session-id inválido.');
  return { capabilities, sessionId: id ? Number(id.value) : undefined };
}
export function encodeRpc(id: string, rpc: RemoteRpc) {
  const datastore = `<${rpc.datastore}/>`;
  let body = '';
  if (['get-config', 'copy-config', 'validate'].includes(rpc.operation))
    body += `<source><${rpc.source ?? rpc.datastore}/></source>`;
  if (['edit-config', 'lock', 'unlock', 'copy-config', 'delete-config'].includes(rpc.operation))
    body += `<target>${datastore}</target>`;
  if (rpc.patch)
    body +=
      '<config>' +
      encodeValue('network', rpc.patch).replace(
        '<network>',
        `<network xmlns="${NETWORK_NS}" operation="merge">`
      ) +
      '</config>';
  if (rpc.config)
    body +=
      '<config>' +
      encodeValue('network', rpc.config).replace(
        '<network>',
        `<network xmlns="${NETWORK_NS}" operation="replace">`
      ) +
      '</config>';
  if (rpc.offset)
    body += `<filter type="subtree"><network xmlns="${NETWORK_NS}"><offset>${rpc.offset}</offset></network></filter>`;
  if (rpc.ifMatch !== undefined) body += `<if-match xmlns="${NETWORK_NS}">${rpc.ifMatch}</if-match>`;
  if (rpc.operation === 'edit-config')
    body +=
      '<default-operation>merge</default-operation><test-option>test-then-set</test-option><error-option>rollback-on-error</error-option>';
  return `<rpc xmlns="${NETCONF_NS}" message-id="${xmlEscape(id)}"><${rpc.operation}>${body}</${rpc.operation}></rpc>`;
}
export function decodeRpc(xml: string) {
  const n = parseXml(xml);
  if (
    n.name !== 'rpc' ||
    n.attributes.xmlns !== NETCONF_NS ||
    !n.attributes['message-id'] ||
    n.children.length !== 1
  )
    throw new Error('NETCONF RPC/namespace/message-id inválido.');
  const operation = n.children[0],
    target = child(operation, 'target')?.children[0]?.name,
    source = child(operation, 'source')?.children[0]?.name;
  const config = child(operation, 'config'),
    network = config && one(config, 'network'),
    filter = child(operation, 'filter');
  if (network && ![NETWORK_NS, 'urn:netlab:yang:network'].includes(network.attributes.xmlns))
    throw new Error('Namespace de configuração YANG inválido.');
  if (filter && filter.attributes.type !== 'subtree') throw new Error('Somente filtro subtree é anunciado.');
  const patch = network && network.attributes.operation !== 'replace' ? decodeValue(network) : undefined,
    full = network?.attributes.operation === 'replace' ? decodeValue(network) : undefined;
  const offset = filter ? Number(one(one(filter, 'network'), 'offset').value) : 0;
  for (const option of ['default-operation', 'test-option', 'error-option']) {
    const node = child(operation, option);
    if (
      node &&
      node.value !==
        (
          {
            'default-operation': 'merge',
            'test-option': 'test-then-set',
            'error-option': 'rollback-on-error',
          } as Record<string, string>
        )[option]
    )
      throw new Error('Opção NETCONF não suportada: ' + option);
  }
  const rpc = remoteRpcSchema.parse({
    operation: operation.name,
    datastore: target ?? (operation.name === 'get-config' ? source : undefined),
    source: operation.name === 'copy-config' ? source : undefined,
    patch,
    config: full,
    offset,
    ...(child(operation, 'if-match') ? { ifMatch: Number(child(operation, 'if-match')!.value) } : {}),
  });
  return { id: n.attributes['message-id'], rpc };
}
const errorTag = (code: number) =>
  code === 403
    ? 'access-denied'
    : code === 404
      ? 'data-missing'
      : code === 409
        ? 'in-use'
        : code === 412
          ? 'operation-failed'
          : code === 413
            ? 'too-big'
            : 'invalid-value';
export function encodeReply(response: RemoteResponse) {
  const body = response.ok
    ? response.data
      ? '<data>' +
        encodeValue('network', JSON.parse(response.data)).replace(
          '<network>',
          `<network xmlns="${NETWORK_NS}">`
        ) +
        '</data>'
      : '<ok/>'
    : `<rpc-error><error-type>application</error-type><error-tag>${errorTag(response.code)}</error-tag><error-severity>error</error-severity><error-message>${xmlEscape(response.error ?? 'Erro RPC')}</error-message></rpc-error>`;
  return `<rpc-reply xmlns="${NETCONF_NS}" message-id="${xmlEscape(response.id)}" revision="${response.revision}" status="${response.code}">${body}</rpc-reply>`;
}
export function decodeReply(xml: string) {
  const n = parseXml(xml);
  if (n.name !== 'rpc-reply' || n.attributes.xmlns !== NETCONF_NS)
    throw new Error('NETCONF rpc-reply inválido.');
  const err = child(n, 'rpc-error'),
    data = child(n, 'data');
  if (n.children.length !== 1 || (!err && !data && !child(n, 'ok')))
    throw new Error('Conteúdo rpc-reply inválido.');
  return remoteResponseSchema.parse({
    id: n.attributes['message-id'],
    ok: !err,
    revision: Number(n.attributes.revision),
    code: Number(n.attributes.status),
    ...(err ? { error: one(err, 'error-message').value } : {}),
    ...(data ? { data: JSON.stringify(decodeValue(one(data, 'network'))) } : {}),
  });
}
export function frameNetconf(xml: string, version: '1.0' | '1.1') {
  return version === '1.0' ? xml + ']]>]]>' : '\n#' + tcpBytes(xml) + '\n' + xml + '\n##\n';
}
// The octet count is evaluated after UTF-8 encoding, including split multi-byte strings.
export function readNetconf(
  buffer: string,
  version: '1.0' | '1.1'
): { message: string; consumed: number } | undefined {
  if (version === '1.0') {
    const end = buffer.indexOf(']]>]]>');
    return end < 0 ? undefined : { message: buffer.slice(0, end), consumed: end + 6 };
  }
  let cursor = 0,
    result = '';
  while (true) {
    if (buffer.slice(cursor, cursor + 4) === '\n##\n') {
      if (!result) throw new Error('NETCONF mensagem vazia.');
      return { message: result, consumed: cursor + 4 };
    }
    const tail = buffer.slice(cursor),
      match = /^\n#([1-9]\d{0,7})\n/.exec(tail);
    if (!match) {
      if (tail.length < 14 && !tail.includes('\n', 2)) return;
      throw new Error('Framing NETCONF 1.1 inválido.');
    }
    const size = Number(match[1]);
    if (size > 12000 || tcpBytes(result) + size > 12000) throw new Error('Chunk NETCONF excede limite.');
    const data = tail.slice(match[0].length);
    if (tcpBytes(data) < size) return;
    let length = 0,
      bytes = 0;
    for (const character of data) {
      if (bytes >= size) break;
      bytes += tcpBytes(character);
      length += character.length;
    }
    if (bytes !== size) throw new Error('Chunk NETCONF divide caractere UTF-8.');
    result += data.slice(0, length);
    cursor += match[0].length + length;
  }
}

export type HttpMessage = {
  method?: string;
  path?: string;
  code?: number;
  headers: Record<string, string>;
  body: string;
  consumed: number;
};
export function readHttp(buffer: string): HttpMessage | undefined {
  const split = buffer.indexOf('\r\n\r\n');
  if (split < 0) return;
  if (split > 4000) throw new Error('Cabeçalho RESTCONF excede limite.');
  const [line, ...lines] = buffer.slice(0, split).split('\r\n'),
    headers: Record<string, string> = {};
  for (const line of lines) {
    const m = /^([A-Za-z-]+):\s*([^\r\n]*)$/.exec(line);
    if (!m || m[1].toLowerCase() in headers) throw new Error('Cabeçalho HTTP inválido/duplicado.');
    headers[m[1].toLowerCase()] = m[2];
  }
  if (headers['transfer-encoding']) throw new Error('RESTCONF Transfer-Encoding não suportado.');
  const size = Number(headers['content-length'] ?? '0');
  if (!Number.isSafeInteger(size) || size < 0 || size > 10000) throw new Error('Content-Length inválido.');
  const tail = buffer.slice(split + 4);
  if (tcpBytes(tail) < size) return;
  let length = 0,
    bytes = 0;
  for (const char of tail) {
    if (bytes >= size) break;
    bytes += tcpBytes(char);
    length += char.length;
  }
  if (bytes !== size) throw new Error('Content-Length divide UTF-8.');
  const request = /^(GET|PATCH|PUT|POST|DELETE) (\/\S*) HTTP\/1\.1$/.exec(line),
    response = /^HTTP\/1\.1 (\d{3}) [^\r\n]+$/.exec(line);
  if (!request && !response) throw new Error('Linha HTTP RESTCONF inválida.');
  return {
    method: request?.[1],
    path: request?.[2],
    code: response ? Number(response[1]) : undefined,
    headers,
    body: tail.slice(0, length),
    consumed: split + 4 + length,
  };
}
export function httpRequest(target: string, id: string, rpc: RemoteRpc) {
  const method =
    rpc.operation === 'patch'
      ? 'PATCH'
      : rpc.operation === 'replace'
        ? 'PUT'
        : rpc.operation === 'create'
          ? 'POST'
          : rpc.operation === 'delete'
            ? 'DELETE'
            : 'GET';
  const path =
    rpc.resource?.replace('/restconf/data/netlab:', '/restconf/data/shlab:') ??
    (rpc.operation === 'hello'
      ? '/restconf'
      : rpc.operation === 'get-config'
        ? '/restconf/data/shlab:network?content=config'
        : '/restconf/data/shlab:network');
  const body =
    rpc.operation === 'patch'
      ? JSON.stringify({ 'shlab:network': rpc.patch })
      : ['replace', 'create'].includes(rpc.operation)
        ? JSON.stringify({ 'shlab:network': rpc.config ?? rpc.patch })
        : '';
  return `${method} ${path}${rpc.offset ? (path.includes('?') ? '&' : '?') + 'offset=' + rpc.offset : ''} HTTP/1.1\r\nHost: ${target}\r\nAccept: application/yang-data+json\r\n${body ? 'Content-Type: application/yang-data+json\r\n' : ''}X-Request-ID: ${id}\r\n${rpc.ifMatch !== undefined ? 'If-Match: "' + rpc.ifMatch + '"\r\n' : ''}Content-Length: ${tcpBytes(body)}\r\nConnection: close\r\n\r\n${body}`;
}
export function httpRpc(message: HttpMessage): { id: string; rpc: RemoteRpc } {
  if (!message.method || !message.path || !message.headers['x-request-id'])
    throw new Error('RESTCONF requisição inválida.');
  const [resource, query] = message.path
      .replace('/restconf/data/netlab:', '/restconf/data/shlab:')
      .split('?'),
    params = new URLSearchParams(query ?? '');
  if (
    !/^\/restconf(?:\/data\/shlab:network(?:\/(?:hostname|interfaces(?:\/interface=[a-zA-Z0-9_-]+)?|routes))?|\/yang-library-version)?$/.test(
      resource
    )
  )
    throw new Error('Recurso RESTCONF inexistente.');
  if (
    message.headers.accept &&
    !message.headers.accept.includes('application/yang-data+json') &&
    message.headers.accept !== '*/*'
  )
    throw new Error('RESTCONF Accept incompatível.');
  if (message.body && message.headers['content-type'] !== 'application/yang-data+json')
    throw new Error('RESTCONF exige application/yang-data+json.');
  const body = message.body ? JSON.parse(message.body) : undefined,
    operation =
      message.method === 'GET'
        ? resource === '/restconf' || resource === '/restconf/yang-library-version'
          ? 'hello'
          : params.get('content') === 'config'
            ? 'get-config'
            : 'get'
        : ({ PATCH: 'patch', PUT: 'replace', POST: 'create', DELETE: 'delete' } as Record<string, string>)[
            message.method
          ];
  if (body && (Object.keys(body).length !== 1 || !('shlab:network' in body || 'netlab:network' in body)))
    throw new Error('Raiz YANG JSON inválida.');
  const ifMatch = message.headers['if-match'];
  if (ifMatch && !/^"\d+"$/.test(ifMatch)) throw new Error('ETag If-Match inválido.');
  return {
    id: message.headers['x-request-id'],
    rpc: remoteRpcSchema.parse({
      operation,
      resource,
      datastore: 'running',
      offset: Number(params.get('offset') ?? 0),
      ...(ifMatch ? { ifMatch: Number(ifMatch.slice(1, -1)) } : {}),
      ...(operation === 'patch' || operation === 'create'
        ? { patch: body?.['shlab:network'] ?? body?.['netlab:network'] }
        : {}),
      ...(operation === 'replace' ? { config: body?.['shlab:network'] ?? body?.['netlab:network'] } : {}),
    }),
  };
}
export function httpResponse(response: RemoteResponse) {
  const error = response.ok
    ? undefined
    : {
        'ietf-restconf:errors': {
          error: [
            {
              'error-type': 'application',
              'error-tag': errorTag(response.code),
              'error-message': response.error ?? 'Erro RESTCONF',
            },
          ],
        },
      };
  const body = JSON.stringify(error ?? { 'shlab:network': response.data ? JSON.parse(response.data) : {} });
  return `HTTP/1.1 ${response.code} ${response.ok ? 'OK' : 'Error'}\r\nContent-Type: application/yang-data+json\r\nETag: "${response.revision}"\r\nX-Request-ID: ${response.id}\r\nContent-Length: ${tcpBytes(body)}\r\nConnection: close\r\n\r\n${body}`;
}
export function decodeHttpResponse(message: HttpMessage) {
  if (
    !message.code ||
    message.headers['content-type'] !== 'application/yang-data+json' ||
    !/^"\d+"$/.test(message.headers.etag ?? '')
  )
    throw new Error('Resposta RESTCONF/ETag inválida.');
  const body = JSON.parse(message.body),
    ok = message.code < 400;
  return remoteResponseSchema.parse({
    id: message.headers['x-request-id'],
    ok,
    code: message.code,
    revision: Number(message.headers.etag.slice(1, -1)),
    ...(ok
      ? { data: JSON.stringify(body['shlab:network'] ?? body['netlab:network']) }
      : { error: body['ietf-restconf:errors']?.error?.[0]?.['error-message'] }),
  });
}
