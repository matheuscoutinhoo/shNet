import type { SimulationEngine } from '../core/engine';
import type { Device, UdpPacket, Action } from '../model';
import {
  aaaServerConfigSchema,
  aaaClientSchema,
  aaaQuerySchema,
  supplicantConfigSchema,
  radiusRequestSchema,
  radiusResponseSchema,
  type AaaQuery,
  type RadiusRequest,
  type RadiusResponse,
} from './aaa-model';
import { chapProof, encodeAaaRadius, verifyAaaRadius } from './aaa-codec';
import { hashHex } from './security-crypto';
import { resolveRoute } from './ipv4';
import { resolveUnderlay } from './underlay';
import { sendWithArp } from './arp';
import { isUnicast } from './dhcp-config';
import { completeDot1x } from './dot1x';
import { openTacacs } from './tacacs';
export const eapProof = (_username: string, password: string, challenge: string) =>
  chapProof(password, challenge);
export function aaaServerConfig(d: Device) {
  if (!d.aaaServer) throw new Error('Servidor AAA ausente.');
  const { enabled, radius, tacacs, key, clients, users } = d.aaaServer;
  return { enabled, radius, tacacs, key, clients, users };
}
export function configureAaaServer(e: SimulationEngine, d: Device, input: unknown) {
  const c = aaaServerConfigSchema.parse(input);
  if (
    c.users.some(
      (u) =>
        new Set(u.commands).size !== u.commands.length ||
        u.commands.some((v) => v !== '*' && !/^[a-zA-Z0-9_. /-]+$/.test(v))
    )
  )
    throw new Error('Política de comandos AAA inválida.');
  if (
    d.type === 'pc' ||
    new Set(c.users.map((u) => u.username)).size !== c.users.length ||
    new Set(c.clients).size !== c.clients.length ||
    c.clients.some((ip) => !isUnicast(ip)) ||
    (c.tacacs && d.tcpServices?.some((s) => s.enabled && s.port === 49))
  )
    throw new Error('AAA exige servidor/roteador/switch, usuários únicos e TCP/49 disponível.');
  d.aaaServer = { ...c, accepted: 0, rejected: 0, requests: [], accounting: [] };
  e.emit('CONFIG_CHANGED', d.id, 'Servidor AAA de rede configurado (RADIUS/1812 e TACACS+/49).');
}
export function configureAaaClient(e: SimulationEngine, d: Device, input: unknown) {
  const c = aaaClientSchema.parse(input);
  if (!isUnicast(c.server)) throw new Error('Servidor AAA deve ser unicast.');
  d.aaaClient = c;
  for (const q of d.aaaQueries ?? []) if (!q.port && q.status === 'pending') completeAaa(e, d, q);
  delete d.networkAuth;
  e.emit('CONFIG_CHANGED', d.id, 'Cliente AAA de rede configurado.');
}
export function verifyRadius(m: RadiusRequest | RadiusResponse, key: string) {
  return verifyAaaRadius(m, key);
}
export function radiusRequest(q: AaaQuery): RadiusRequest {
  const body = {
    type: 'Access-Request' as const,
    id: q.id,
    username: q.username,
    challenge: q.challenge,
    proof: q.proof,
    authenticator: hashHex(q.id + '|' + q.key + '|' + q.challenge).slice(0, 32),
  };
  return { ...body, wire: encodeAaaRadius(body, q.key) };
}
export function authorizeAaa(
  e: SimulationEngine,
  d: Device,
  source: string,
  method: 'radius' | 'tacacs',
  m: RadiusRequest
): RadiusResponse {
  const s = d.aaaServer!,
    user = s.users.find((u) => u.enabled && u.username === m.username),
    accepted =
      !!user && user.password !== '' && eapProof(user.username, user.password, m.challenge) === m.proof;
  if (accepted) s.accepted++;
  else s.rejected++;
  const body = {
    type: accepted ? ('Access-Accept' as const) : ('Access-Reject' as const),
    id: m.id,
    requestAuthenticator: m.authenticator,
    privilege: accepted ? user!.privilege : 0,
    ...(accepted && user!.vlan ? { vlan: user!.vlan } : {}),
    sessionMs: accepted ? Math.ceil(user!.sessionMs / 1000) * 1000 : 5000,
    commands: accepted ? user!.commands : [],
  };
  s.accounting.push({
    at: e.state.clock,
    username: m.username,
    method,
    source,
    accepted,
    privilege: body.privilege,
    stage: 'authentication',
  });
  s.accounting = s.accounting.slice(-128);
  e.emit(
    'AAA_RESULT',
    d.id,
    method.toUpperCase() + ': ' + m.username + ' ' + (accepted ? 'autorizado' : 'rejeitado') + '.'
  );
  const wire = encodeAaaRadius({ ...body, authenticator: '0'.repeat(32) }, s.key);
  return { ...body, wire, authenticator: wire.slice(8, 40) };
}
function sendRadius(e: SimulationEngine, d: Device, q: AaaQuery) {
  const m = radiusRequest(q);
  const packet: UdpPacket = {
    protocol: 'UDP',
    src: q.sourceIp,
    dst: q.server,
    ttl: 64,
    sourcePort: q.sourcePort!,
    destinationPort: 1812,
    bytes: 28 + m.wire.length / 2,
    payload: { protocol: 'RADIUS', message: m },
  };
  if (q.port) {
    const auth = d.interfaces.find((p) => p.id === q.port)?.dot1x,
      wan = d.interfaces.find((p) => p.id === auth?.underlay),
      route = wan && resolveUnderlay(d, wan, q.server);
    if (wan && route) sendWithArp(e, d, wan, route.nextHop, packet);
    else e.drop(d, 'RADIUS: underlay sem rota.');
  } else e.sendIp(d.id, packet);
  e.emit(
    'AAA_SENT',
    d.id,
    'Access-Request ' + q.id + ' para ' + q.server + '; tentativa ' + q.attempts + '.'
  );
}
export function startRadius(
  e: SimulationEngine,
  d: Device,
  input: Pick<AaaQuery, 'username' | 'key' | 'server' | 'challenge' | 'proof' | 'sourceIp'> &
    Partial<Pick<AaaQuery, 'port' | 'mac' | 'session'>>
) {
  d.aaaQueries ??= [];
  if (d.aaaQueries.length >= 128) {
    const i = d.aaaQueries.findIndex(
      (q) =>
        q.status !== 'pending' &&
        d.networkAuth?.query !== q.id &&
        !d.interfaces.some((p) => p.dot1x?.query === q.id)
    );
    if (i < 0) throw new Error('Limite de consultas AAA.');
    d.aaaQueries.splice(i, 1);
  }
  let sourcePort = 51000;
  while (
    d.aaaQueries.some((q) => q.status === 'pending' && q.sourcePort === sourcePort) ||
    d.dnsQueries?.some((q) => q.status === 'pending' && q.sourcePort === sourcePort) ||
    d.snmpQueries?.some((q) => q.status === 'pending' && q.sourcePort === sourcePort)
  )
    sourcePort++;
  const q = aaaQuerySchema.parse({
    ...input,
    id: e.id('radius'),
    method: 'radius',
    sourcePort,
    status: 'pending',
    startedAt: e.state.clock,
    deadline: e.state.clock + 3000,
    attempts: 1,
    requestAuthenticator: '0'.repeat(32),
  });
  q.requestAuthenticator = radiusRequest(q).authenticator;
  d.aaaQueries.push(q);
  sendRadius(e, d, q);
  e.schedule(3000, { kind: 'aaa-timeout', device: d.id, query: q.id, at: q.deadline });
  return q;
}
export function completeAaa(e: SimulationEngine, d: Device, q: AaaQuery, m?: RadiusResponse) {
  if (q.status !== 'pending') return;
  q.status = m ? (m.type === 'Access-Accept' ? 'accepted' : 'rejected') : 'timeout';
  q.privilege = m?.privilege;
  q.vlan = m?.vlan;
  q.commands = m?.commands;
  q.expiresAt = m && m.type === 'Access-Accept' ? e.state.clock + m.sessionMs : undefined;
  e.state.queue = e.state.queue.filter(
    (x) => x.action.kind !== 'aaa-timeout' || x.action.device !== d.id || x.action.query !== q.id
  );
  if (q.port) completeDot1x(e, d, q);
  else if (q.status === 'accepted')
    d.networkAuth = {
      query: q.id,
      commands: q.commands ?? ['*'],
      username: q.username,
      privilege: q.privilege!,
      expiresAt: q.expiresAt!,
    };
  else delete d.networkAuth;
  e.emit('AAA_RESULT', d.id, q.method.toUpperCase() + ': ' + q.username + ' ' + q.status + '.');
}
export function receiveRadius(e: SimulationEngine, d: Device, packet: UdpPacket) {
  if (packet.payload.protocol !== 'RADIUS' || !isUnicast(packet.src) || !isUnicast(packet.dst) || !packet.ttl)
    return;
  const m = packet.payload.message;
  if (m.type === 'Access-Request') {
    const s = d.aaaServer;
    if (
      packet.destinationPort !== 1812 ||
      !s?.enabled ||
      !s.radius ||
      (s.clients.length && !s.clients.includes(packet.src)) ||
      !verifyRadius(m, s.key)
    ) {
      e.drop(d, 'RADIUS: serviço, NAS ou autenticador inválido.');
      return;
    }
    s.requests = s.requests.filter((r) => r.expiresAt > e.state.clock);
    const duplicate = s.requests.find((r) => r.id === m.id && r.source === packet.src);
    if (duplicate && duplicate.wire !== m.wire) {
      e.drop(d, 'RADIUS: identificador reutilizado com outro request.');
      return;
    }
    const response = duplicate
      ? radiusResponseSchema.parse(JSON.parse(duplicate.response))
      : authorizeAaa(e, d, packet.src, 'radius', radiusRequestSchema.parse(m));
    if (!duplicate) {
      s.requests.push({
        id: m.id,
        source: packet.src,
        wire: m.wire,
        response: JSON.stringify(response),
        expiresAt: e.state.clock + 15000,
      });
      s.requests = s.requests.slice(-128);
    }
    e.sendIp(d.id, {
      protocol: 'UDP',
      src: packet.dst,
      dst: packet.src,
      ttl: 64,
      sourcePort: 1812,
      destinationPort: packet.sourcePort,
      bytes: 28 + response.wire.length / 2,
      payload: { protocol: 'RADIUS', message: response },
    });
  } else {
    const q = d.aaaQueries?.find(
      (q) =>
        q.method === 'radius' &&
        q.status === 'pending' &&
        q.id === m.id &&
        q.server === packet.src &&
        q.sourceIp === packet.dst &&
        q.sourcePort === packet.destinationPort &&
        packet.sourcePort === 1812
    );
    if (!q || m.requestAuthenticator !== q.requestAuthenticator || !verifyRadius(m, q.key)) {
      e.drop(d, 'RADIUS: resposta sem consulta/autenticador correspondente.');
      return;
    }
    completeAaa(e, d, q, radiusResponseSchema.parse(m));
  }
}
export function handleAaaTimeout(e: SimulationEngine, a: Extract<Action, { kind: 'aaa-timeout' }>) {
  const d = e.device(a.device),
    q = d.aaaQueries?.find((q) => q.id === a.query && q.status === 'pending' && q.deadline === a.at);
  if (!q) return;
  if (q.method === 'tacacs' || q.attempts >= 3) {
    completeAaa(e, d, q);
    return;
  }
  q.attempts++;
  q.deadline = e.state.clock + 3000;
  sendRadius(e, d, q);
  e.schedule(3000, { kind: 'aaa-timeout', device: d.id, query: q.id, at: q.deadline });
}
export function loginNetwork(e: SimulationEngine, d: Device, username: string, password: string) {
  supplicantConfigSchema.parse({ enabled: true, username, password });
  const c = d.aaaClient;
  if (!c) throw new Error('Configure um cliente AAA de rede.');
  if (d.aaaQueries?.some((q) => !q.port && q.status === 'pending'))
    throw new Error('Login de rede já pendente.');
  const sourceIp = resolveRoute(d, c.server)?.port.ip;
  if (!sourceIp || !d.power) throw new Error('Login exige IPv4/rota e equipamento ligado.');
  delete d.networkAuth;
  const challenge = e.id('aaa-challenge'),
    proof = eapProof(username, password, challenge);
  if (c.method === 'radius')
    return startRadius(e, d, { server: c.server, key: c.key, username, challenge, proof, sourceIp }).id;
  return openTacacs(e, d, { username, key: c.key, server: c.server, sourceIp, challenge, proof });
}
