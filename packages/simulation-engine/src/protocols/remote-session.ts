import type { SimulationEngine } from '../core/engine';
import type { Device } from '../model';
import type { TcpConnection } from './tcp-model';
import { tcpBytes, tcpFinished } from './tcp-model';
import { openTcp, closeTcp } from './tcp';
import { queueTcpText } from './tcp-services';
import { remoteDefaultTrust, runRemoteRpc } from './remote';
import {
  tlsClientHello,
  tlsServerHello,
  tlsClientFinish,
  tlsServerFinish,
  tlsClientResult,
  tlsServerAcknowledgment,
} from './tls-session';
import { tlsMessageSchema, tlsClientConfigSchema } from './tls-model';
import { hashHex, sealRecord, openRecord } from './security-crypto';
import {
  netconfHello,
  decodeHello,
  encodeRpc,
  decodeRpc,
  encodeReply,
  decodeReply,
  frameNetconf,
  readNetconf,
  httpRequest,
  httpRpc,
  httpResponse,
  decodeHttpResponse,
  readHttp,
} from './remote-codec';
import type { RemoteQuery, RemoteTransport, RemoteResponse } from './remote-model';
type Input = {
  target: string;
  protocol: 'netconf' | 'restconf';
  username: string;
  password: string;
  key: string;
  tls?: unknown;
};
const bind = (c: TcpConnection) =>
  'remote|' + c.service + '|' + (c.role === 'client' ? c.remoteIp : c.localIp);
const key = (t: RemoteTransport) => hashHex(t.tls.master + '|management application|' + t.tls.session);
function line(c: TcpConnection, value: unknown) {
  queueTcpText(c, JSON.stringify(value) + '\n');
}
function write(c: TcpConnection, t: RemoteTransport, text: string) {
  if (t.tls.phase !== 'ESTABLISHED' || !t.tls.accepted) throw new Error('TLS sem autorização.');
  const sequence = t.transmit++;
  line(c, {
    type: 'ApplicationData',
    session: t.tls.session,
    sequence,
    ciphertext: sealRecord(key(t), c.role === 'client' ? 0 : 1, sequence, text, bind(c)),
  });
}
function clientRpc(c: TcpConnection, q: RemoteQuery) {
  const t = q.transport!;
  write(
    c,
    t,
    q.protocol === 'netconf'
      ? frameNetconf(encodeRpc(q.id, q.rpc), t.negotiated!)
      : httpRequest(q.target, q.id, q.rpc)
  );
  t.stage = 'rpc';
}
export function openRemoteSession(e: SimulationEngine, d: Device, input: Input, q: RemoteQuery) {
  const config = tlsClientConfigSchema.parse(
    input.tls ?? { trust: remoteDefaultTrust(input.key), serverName: input.target }
  );
  const hello = tlsClientHello(
    q.id,
    hashHex(e.id('remote-dh')),
    e.id('remote-nonce'),
    'remote|' + q.protocol + '|' + q.target
  );
  q.transport = {
    tls: hello.state,
    stage: 'handshake',
    transmit: 2,
    receive: 2,
    plain: '',
    credential: input.password,
    clientConfig: config,
    username: q.username,
    id: q.id,
  };
  openTcp(
    e,
    d,
    q.target,
    q.protocol === 'netconf' ? 830 : 443,
    JSON.stringify(hello.message) + '\n',
    false,
    (c) => {
      c.service = q.protocol;
      c.stream = { readBytes: 0, writtenBytes: 0 };
      q.connection = c.id;
      q.transport!.connection = c.id;
    }
  );
}
export function receiveRemoteSession(
  e: SimulationEngine,
  d: Device,
  c: TcpConnection,
  complete: (e: SimulationEngine, d: Device, q: RemoteQuery, response?: RemoteResponse) => void
) {
  if (c.managementHandled) return;
  try {
    while (c.received.includes('\n')) {
      const at = c.received.indexOf('\n'),
        raw = c.received.slice(0, at),
        bytes = tcpBytes(c.received.slice(0, at + 1));
      c.received = c.received.slice(at + 1);
      c.bytesReceived -= bytes;
      c.stream!.readBytes += bytes;
      if (raw.length > 14000) throw new Error('Registro TLS de gerenciamento excede limite.');
      const message = JSON.parse(raw) as Record<string, unknown>;
      const q =
        c.role === 'client'
          ? d.remoteQueries?.find((q) => q.connection === c.id && q.status === 'pending')
          : undefined;
      const s = d.remoteManagement;
      if (
        c.role === 'server' &&
        (!s?.enabled ||
          (c.service === 'netconf' ? !s.netconf : !s.restconf) ||
          (s.clients.length && !s.clients.includes(c.remoteIp)))
      )
        throw new Error('Cliente/serviço remoto não autorizado.');
      let t = c.role === 'client' ? q?.transport : s?.sessions.find((t) => t.connection === c.id);
      if (message.type === 'ClientHello') {
        if (c.role !== 'server' || t || !s?.identity) throw new Error('TLS ClientHello inesperado.');
        s.sessions = s.sessions.filter(
          (t) => !t.connection || !d.tcpConnections?.some((n) => n.id === t.connection && tcpFinished(n))
        );
        if (s.sessions.length >= 128) throw new Error('Limite de sessões de gerenciamento.');
        const hello = tlsServerHello(
          tlsMessageSchema.parse(message),
          hashHex(e.id('remote-dh')),
          e.id('remote-nonce'),
          s.identity,
          bind(c)
        );
        t = { tls: hello.state, stage: 'handshake', transmit: 2, receive: 2, plain: '', connection: c.id };
        s.sessions.push(t);
        line(c, hello.message);
        continue;
      }
      if (!t) throw new Error('Registro remoto sem sessão TLS.');
      if (message.type === 'ServerHello') {
        if (!q || !t.clientConfig || !t.credential) throw new Error('TLS ServerHello inesperado.');
        line(
          c,
          tlsClientFinish(
            t.tls,
            tlsMessageSchema.parse(message),
            t.clientConfig,
            e.state.clock,
            { username: q.username, password: t.credential },
            false
          )
        );
        delete t.credential;
        continue;
      }
      if (message.type === 'ClientFinished') {
        if (c.role !== 'server' || !s) throw new Error('TLS ClientFinished inesperado.');
        const result = tlsServerFinish(
          t.tls,
          tlsMessageSchema.parse(message),
          s.trust ?? [],
          e.state.clock,
          false,
          (username, password) => s.users.some((u) => u.username === username && u.password === password)
        );
        t.username = t.tls.username;
        t.privilege = s.users.find((u) => u.username === t.username)?.privilege ?? 0;
        line(c, result);
        continue;
      }
      if (message.type === 'ProtectedResult') {
        if (!q) throw new Error('TLS resultado inesperado.');
        line(c, tlsClientResult(t.tls, tlsMessageSchema.parse(message)));
        if (!t.tls.accepted) {
          closeTcp(e, d, c.id, true);
          return;
        }
        t.stage = c.service === 'netconf' ? 'hello' : 'rpc';
        if (c.service === 'netconf') write(c, t, frameNetconf(netconfHello(), '1.0'));
        else clientRpc(c, q);
        continue;
      }
      if (message.type === 'ResultAcknowledgment') {
        if (c.role !== 'server' || !s) throw new Error('TLS confirmação inesperada.');
        if (!tlsServerAcknowledgment(t.tls, tlsMessageSchema.parse(message))) {
          closeTcp(e, d, c.id, true);
          return;
        }
        t.stage = c.service === 'netconf' ? 'hello' : 'rpc';
        if (c.service === 'netconf') {
          t.sessionId = ++e.state.sequence;
          write(c, t, frameNetconf(netconfHello(t.sessionId, s.base11), '1.0'));
        }
        continue;
      }
      if (
        message.type !== 'ApplicationData' ||
        message.session !== t.tls.session ||
        message.sequence !== t.receive ||
        typeof message.ciphertext !== 'string' ||
        t.tls.phase !== 'ESTABLISHED' ||
        !t.tls.accepted
      )
        throw new Error('TLS registro, sequência ou sessão inválidos.');
      t.plain += openRecord(key(t), c.role === 'client' ? 1 : 0, t.receive++, message.ciphertext, bind(c));
      if (tcpBytes(t.plain) > 12000) throw new Error('Mensagem NETCONF/RESTCONF excede limite.');
      if (c.service === 'netconf' && t.stage === 'hello') {
        const hello = readNetconf(t.plain, '1.0');
        if (!hello) continue;
        const parsed = decodeHello(hello.message, c.role === 'client');
        t.plain = t.plain.slice(hello.consumed);
        t.capabilities = parsed.capabilities;
        t.sessionId = parsed.sessionId ?? t.sessionId;
        t.negotiated =
          parsed.capabilities.includes('urn:ietf:params:netconf:base:1.1') &&
          (c.role === 'client' || s?.base11)
            ? '1.1'
            : '1.0';
        t.stage = 'rpc';
        if (q) {
          if (q.rpc.operation === 'hello') {
            complete(e, d, q, {
              id: q.id,
              ok: true,
              code: 200,
              revision: 0,
              data: JSON.stringify({
                capabilities: parsed.capabilities,
                sessionId: t.sessionId,
                base: t.negotiated,
              }),
            });
            c.closeRequested = true;
            t.stage = 'closed';
            c.managementHandled = true;
            return;
          }
          clientRpc(c, q);
        }
      }
      if (t.stage !== 'rpc') continue;
      const parsed = c.service === 'netconf' ? readNetconf(t.plain, t.negotiated!) : readHttp(t.plain);
      if (!parsed) continue;
      if (q) {
        const response =
          c.service === 'netconf'
            ? decodeReply((parsed as ReturnType<typeof readNetconf>)!.message)
            : decodeHttpResponse(parsed as NonNullable<ReturnType<typeof readHttp>>);
        if (response.id !== q.id) throw new Error('Resposta remota sem message-id correlacionado.');
        complete(e, d, q, response);
      } else {
        if (!s || !t.username) throw new Error('Sessão remota sem usuário autorizado.');
        const request =
          c.service === 'netconf'
            ? decodeRpc((parsed as ReturnType<typeof readNetconf>)!.message)
            : httpRpc(parsed as NonNullable<ReturnType<typeof readHttp>>);
        const hash = hashHex(JSON.stringify(request.rpc)),
          old = s.seen.find(
            (n) => n.id === request.id && n.source === c.remoteIp && n.username === t.username
          );
        if (old && old.hash !== hash) throw new Error('Reuso de message-id com RPC divergente.');
        let response =
          old?.response ??
          runRemoteRpc(e, d, request.rpc, c.remoteIp + '|' + t.username, t.privilege ?? 0, request.id);
        if (tcpBytes(JSON.stringify(response)) > 6500)
          response = {
            id: request.id,
            ok: false,
            code: 413,
            revision: s.revision,
            error: 'Resposta grande; consulte uma página menor.',
          };
        if (!old) {
          s.seen.push({
            id: request.id,
            source: c.remoteIp,
            username: t.username,
            hash,
            at: e.state.clock,
            response,
          });
          s.seen = s.seen.slice(-64);
        }
        write(
          c,
          t,
          c.service === 'netconf'
            ? frameNetconf(encodeReply(response), t.negotiated!)
            : httpResponse(response)
        );
        e.emit(
          'REMOTE_RESPONSE',
          d.id,
          c.service.toUpperCase() + ' ' + request.rpc.operation + ': ' + response.code + '.'
        );
      }
      t.plain = t.plain.slice(parsed.consumed);
      t.stage = 'closed';
      c.managementHandled = true;
      c.closeRequested = true;
      return;
    }
  } catch (error) {
    e.drop(d, 'Gerenciamento remoto: ' + (error as Error).message);
    closeTcp(e, d, c.id, true);
  }
}
