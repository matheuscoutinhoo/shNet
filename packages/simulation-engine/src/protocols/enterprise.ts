import type { SimulationEngine } from '../core/engine';
import type { Device, Snapshot, UdpPacket } from '../model';
import {
  eapServerConfigSchema,
  eapAuthenticatorConfigSchema,
  eapSupplicantConfigSchema,
} from './enterprise-model';
import { decodeEap, encodeEap, decodeRadius, encodeRadius, type EapPacket } from './radius-codec';
import { emptyFragments, nextTls, queueTls, receiveTls } from './eap-fragments';
import {
  tlsClientHello,
  tlsServerHello,
  tlsClientFinish,
  tlsServerFinish,
  tlsClientResult,
  tlsServerAcknowledgment,
  tlsExport,
} from './tls-session';
import { hashHex, publicKey } from './security-crypto';
import { resolveUnderlay } from './underlay';
import { sendWithArp } from './arp';
import { isUnicast } from './dhcp-config';
import { sendWireless } from './wireless';
export function configureEapServer(e: SimulationEngine, d: Device, input: unknown) {
  const c = eapServerConfigSchema.parse(input);
  if (
    d.type === 'pc' ||
    publicKey(c.identity.seed) !== c.identity.certificate.publicKey ||
    c.identity.certificate.usage !== 'server' ||
    new Set(c.users.map((u) => u.username)).size !== c.users.length ||
    new Set(c.clients).size !== c.clients.length ||
    c.clients.some((ip) => !isUnicast(ip)) ||
    c.users.some((u) => (c.method === 'tls' ? !u.certificateSubject : !u.password))
  )
    throw new Error('EAP exige identidade de servidor, clientes unicast e usuários válidos para TLS/PEAP.');
  d.eapServer = { ...c, sessions: [], accepted: 0, rejected: 0 };
  e.emit('CONFIG_CHANGED', d.id, 'Servidor EAP ' + c.method.toUpperCase() + ' / RADIUS configurado.');
}
export function configureEapAuthenticator(e: SimulationEngine, d: Device, input: unknown) {
  const c = eapAuthenticatorConfigSchema.parse(input),
    port = d.interfaces.find((p) => p.id === c.underlay);
  if (
    d.wireless?.role !== 'ap' ||
    !port?.ip ||
    !['routed', 'svi'].includes(port.mode) ||
    !isUnicast(c.server)
  )
    throw new Error('EAP authenticator exige AP e underlay IPv4 routed/SVI.');
  d.eapAuthenticator = { ...c, queries: [] };
  d.wireless.peers = [];
  e.emit('CONFIG_CHANGED', d.id, 'AP autenticador EAP/RADIUS configurado.');
}
export function configureEapSupplicant(e: SimulationEngine, d: Device, input: unknown) {
  const c = eapSupplicantConfigSchema.parse(input);
  if (
    d.wireless?.role !== 'client' ||
    (c.method === 'tls' && !c.tls.identity) ||
    (c.method === 'peap' && !c.password)
  )
    throw new Error('Cliente EAP exige rádio, certificado TLS ou senha PEAP.');
  d.eapSupplicant = { ...c, fragments: emptyFragments(), phase: 'idle' };
  delete d.wireless.association;
  d.wireless.phase = 'scanning';
  e.emit('CONFIG_CHANGED', d.id, 'Supplicant EAP ' + c.method.toUpperCase() + ' configurado.');
}
function send(e: SimulationEngine, d: Device, mac: string, token: string, p: EapPacket) {
  sendWireless(e, d, mac, {
    kind: 'eap',
    ssid: d.wireless!.ssid,
    security: d.wireless!.security,
    token,
    eap: encodeEap(p),
  });
}
function reject(e: SimulationEngine, d: Device, mac: string, token: string, reason: string) {
  sendWireless(e, d, mac, { kind: 'reject', ssid: d.wireless!.ssid, security: d.wireless!.security, token });
  d.wireless!.peers = d.wireless!.peers.filter((p) => p.token !== token);
  if (d.eapAuthenticator)
    d.eapAuthenticator.queries = d.eapAuthenticator.queries.filter((q) => q.token !== token);
  e.emit('WIFI_AUTH_FAILED', d.id, reason);
}
export function startEnterprise(e: SimulationEngine, d: Device, mac: string, token: string) {
  if (!d.eapAuthenticator?.enabled) {
    reject(e, d, mac, token, 'SSID empresarial sem autenticador RADIUS.');
    return;
  }
  d.eapAuthenticator.queries = d.eapAuthenticator.queries.filter((q) => q.token !== token && q.mac !== mac);
  send(e, d, mac, token, { code: 1, identifier: 0, method: 1, data: '' });
}
function transmit(
  e: SimulationEngine,
  d: Device,
  q: NonNullable<Device['eapAuthenticator']>['queries'][number]
) {
  const c = d.eapAuthenticator!,
    port = d.interfaces.find((p) => p.id === c.underlay),
    route = port && resolveUnderlay(d, port, c.server);
  if (!port?.ip || !route) {
    e.drop(d, 'EAP-RADIUS sem rota underlay.');
    return;
  }
  sendWithArp(e, d, port, route.nextHop, {
    protocol: 'UDP',
    src: port.ip,
    dst: c.server,
    ttl: 64,
    sourcePort: q.sourcePort,
    destinationPort: 1812,
    bytes: 28 + q.wire.length / 2,
    payload: { protocol: 'EAP-RADIUS', wire: q.wire },
  });
}
export function receiveEnterpriseWifi(
  e: SimulationEngine,
  d: Device,
  mac: string,
  token: string,
  wire: string
) {
  try {
    const p = decodeEap(wire),
      w = d.wireless!;
    if (w.role === 'ap') {
      const c = d.eapAuthenticator,
        peer = w.peers.find((p) => p.mac === mac && p.token === token);
      if (!c?.enabled || !peer || p.code !== 2 || peer.phase !== 'challenged')
        throw new Error('EAP Response sem associação autenticando.');
      const old = c.queries.find((q) => q.token === token);
      if (old?.lastEap === wire) {
        transmit(e, d, old);
        return;
      }
      c.queries = c.queries.filter((q) => q.token !== token);
      const identifier = e.state.sequence % 256,
        authenticator = hashHex(e.id('radius-auth')).slice(0, 32),
        binding = w.ssid + '|' + d.interfaces.find((p) => p.id === w.port)!.mac + '|' + token;
      const request = encodeRadius(
        {
          code: 1,
          identifier,
          authenticator,
          eap: p,
          state: token,
          nas: binding,
          callingStation: mac,
          ...(p.method === 1 ? { username: p.data } : {}),
        },
        c.key
      );
      let sourcePort = 52000;
      while (c.queries.some((q) => q.sourcePort === sourcePort)) sourcePort++;
      const q = {
        token,
        mac,
        identifier,
        authenticator,
        sourcePort,
        wire: request,
        lastEap: wire,
        deadline: e.state.clock + 1000,
        attempts: 1,
      };
      c.queries.push(q);
      transmit(e, d, q);
      return;
    }
    const c = d.eapSupplicant,
      a = w.association;
    if (!c?.enabled || !a || a.bssid !== mac || a.token !== token)
      throw new Error('EAP Request sem supplicant/associação.');
    if (p.code === 3) {
      if (c.tlsState?.phase !== 'ESTABLISHED' || !a.pmk) throw new Error('EAP Success sem TLS/PMK.');
      c.phase = 'authorized';
      return;
    }
    if (p.code === 4) {
      c.phase = 'rejected';
      delete a.pmk;
      throw new Error('EAP Failure recebido.');
    }
    if (p.code !== 1) throw new Error('EAP Request esperado.');
    if (c.token === token && c.lastIdentifier === p.identifier && c.lastResponse) {
      send(e, d, mac, token, decodeEap(c.lastResponse));
      return;
    }
    let response: EapPacket;
    const method = c.method === 'tls' ? 13 : 25;
    if (p.method === 1) {
      c.token = token;
      c.phase = 'authenticating';
      c.fragments = emptyFragments();
      delete c.tlsState;
      delete a.pmk;
      response = {
        code: 2,
        identifier: p.identifier,
        method: 1,
        data: c.method === 'peap' ? c.outerIdentity : c.username,
      };
    } else {
      if (p.method !== method || c.token !== token) throw new Error('Método EAP incompatível.');
      if (p.flags === 32 && !p.data) {
        const hello = tlsClientHello(
          e.id('eap-tls'),
          hashHex(e.id('tls-client-key')),
          e.id('tls-nonce'),
          w.ssid + '|' + mac + '|' + token
        );
        c.tlsState = hello.state;
        queueTls(c.fragments, hello.message);
      } else if (!p.data) {
        if (!c.fragments.outgoing || p.flags) throw new Error('EAP ACK inesperado.');
      } else {
        const message = receiveTls(c.fragments, p);
        if (message) {
          if (!c.tlsState) throw new Error('TLS sem ClientHello.');
          const result =
            message.type === 'ServerHello'
              ? tlsClientFinish(
                  c.tlsState,
                  message,
                  c.tls,
                  e.state.clock,
                  { username: c.username, password: c.password },
                  c.method === 'tls'
                )
              : tlsClientResult(c.tlsState, message);
          queueTls(c.fragments, result);
          if (c.tlsState.phase === 'ESTABLISHED') a.pmk = tlsExport(c.tlsState).slice(0, 64);
        }
      }
      response = c.fragments.outgoing
        ? nextTls(c.fragments, 2, p.identifier, method)
        : { code: 2, identifier: p.identifier, method, data: '', flags: 0 };
    }
    c.lastIdentifier = p.identifier;
    c.lastResponse = encodeEap(response);
    send(e, d, mac, token, response);
  } catch (error) {
    e.drop(d, 'EAP: ' + (error as Error).message);
    if (d.wireless?.role === 'client') {
      if (d.eapSupplicant) d.eapSupplicant.phase = 'rejected';
      delete d.wireless.association?.pmk;
    }
  }
}
export function receiveEnterpriseRadius(e: SimulationEngine, d: Device, packet: UdpPacket) {
  if (packet.payload.protocol !== 'EAP-RADIUS') return;
  try {
    if (packet.destinationPort === 1812) {
      const c = d.eapServer;
      if (
        !c?.enabled ||
        (c.clients.length && !c.clients.includes(packet.src)) ||
        !isUnicast(packet.src) ||
        packet.sourcePort < 1024
      )
        throw new Error('NAS/serviço RADIUS inválido.');
      const m = decodeRadius(packet.payload.wire, c.key);
      if (m.code !== 1 || m.eap.code !== 2 || !m.state || !m.nas || !m.callingStation)
        throw new Error('Access-Request sem EAP/State/NAS.');
      c.sessions = c.sessions.filter((s) => e.state.clock - s.lastAt < 180000);
      let s = c.sessions.find(
        (s) =>
          s.id === m.state && s.source === packet.src && s.mac === m.callingStation && s.binding === m.nas
      );
      if (s?.lastRequest === packet.payload.wire) {
        e.sendIp(d.id, {
          ...packet,
          src: packet.dst,
          dst: packet.src,
          sourcePort: 1812,
          destinationPort: packet.sourcePort,
          payload: { protocol: 'EAP-RADIUS', wire: s.lastResponse },
          bytes: 28 + s.lastResponse.length / 2,
        });
        return;
      }
      let response: EapPacket,
        code: 2 | 3 | 11 = 11,
        msk: string | undefined;
      if (m.eap.method === 1) {
        if (c.sessions.length >= 128) throw new Error('Limite de sessões EAP.');
        if (s) throw new Error('Identidade EAP repetida com novo request.');
        s = {
          id: m.state,
          source: packet.src,
          mac: m.callingStation,
          binding: m.nas,
          method: c.method,
          identifier: 1,
          fragments: emptyFragments(),
          lastAt: e.state.clock,
          lastRequest: '',
          lastResponse: '',
        };
        c.sessions.push(s);
        response = {
          code: 1,
          identifier: s.identifier,
          method: s.method === 'tls' ? 13 : 25,
          data: '',
          flags: 32,
        };
      } else {
        if (!s || m.eap.identifier !== s.identifier || m.eap.method !== (s.method === 'tls' ? 13 : 25))
          throw new Error('EAP State/identificador/método inválido.');
        s.identifier = (s.identifier + 1) % 256;
        if (!m.eap.data) {
          if (!s.fragments.outgoing || m.eap.flags) throw new Error('EAP ACK inesperado.');
        } else {
          const message = receiveTls(s.fragments, m.eap);
          if (message) {
            if (message.type === 'ClientHello') {
              if (s.tls) throw new Error('ClientHello duplicado.');
              const hello = tlsServerHello(
                message,
                hashHex(e.id('tls-server-key')),
                e.id('tls-nonce'),
                c.identity,
                s.binding
              );
              s.tls = hello.state;
              queueTls(s.fragments, hello.message);
            } else if (message.type === 'ClientFinished' && s.tls)
              queueTls(
                s.fragments,
                tlsServerFinish(
                  s.tls,
                  message,
                  c.trust,
                  e.state.clock,
                  s.method === 'tls',
                  (username, password, subject) =>
                    c.users.some(
                      (u) =>
                        u.enabled &&
                        u.username === username &&
                        (s!.method === 'tls' ? u.certificateSubject === subject : u.password === password)
                    )
                )
              );
            else if (message.type === 'ResultAcknowledgment' && s.tls) {
              const accepted = tlsServerAcknowledgment(s.tls, message);
              code = accepted ? 2 : 3;
              if (accepted) {
                msk = tlsExport(s.tls);
                c.accepted++;
              } else c.rejected++;
              e.emit(
                'AAA_RESULT',
                d.id,
                'EAP ' + s.method.toUpperCase() + ': ' + (accepted ? 'autorizado' : 'rejeitado') + '.'
              );
            } else throw new Error('Flight TLS inesperado.');
          }
        }
        response =
          code === 11
            ? s.fragments.outgoing
              ? nextTls(s.fragments, 1, s.identifier, s.method === 'tls' ? 13 : 25)
              : {
                  code: 1,
                  identifier: s.identifier,
                  method: s.method === 'tls' ? 13 : 25,
                  data: '',
                  flags: 0,
                }
            : { code: code === 2 ? 3 : 4, identifier: m.eap.identifier, data: '' };
      }
      const wire = encodeRadius(
        {
          code,
          identifier: m.identifier,
          authenticator: m.authenticator,
          eap: response,
          state: s.id,
          ...(msk ? { recvKey: msk.slice(0, 64), sendKey: msk.slice(64) } : {}),
        },
        c.key,
        m.authenticator
      );
      s.lastAt = e.state.clock;
      s.lastRequest = packet.payload.wire;
      s.lastResponse = wire;
      e.sendIp(d.id, {
        protocol: 'UDP',
        src: packet.dst,
        dst: packet.src,
        ttl: 64,
        sourcePort: 1812,
        destinationPort: packet.sourcePort,
        bytes: 28 + wire.length / 2,
        payload: { protocol: 'EAP-RADIUS', wire },
      });
    } else {
      const c = d.eapAuthenticator,
        q = c?.queries.find((q) => q.sourcePort === packet.destinationPort),
        peer = d.wireless?.peers.find((p) => p.token === q?.token && p.mac === q?.mac);
      if (
        !c?.enabled ||
        !q ||
        !peer ||
        packet.src !== c.server ||
        packet.sourcePort !== 1812 ||
        packet.dst !== d.interfaces.find((p) => p.id === c.underlay)?.ip
      )
        throw new Error('RADIUS resposta sem NAS/request correlacionado.');
      const m = decodeRadius(packet.payload.wire, c.key, q.authenticator);
      if (m.identifier !== q.identifier || m.state !== q.token || m.code === 1)
        throw new Error('RADIUS identificador/State inválido.');
      if (m.code === 2) {
        if (m.eap.code !== 3 || m.recvKey?.length !== 64)
          throw new Error('Access-Accept sem EAP-Success/MPPE.');
        peer.pmk = m.recvKey;
        peer.eapExpires = e.state.clock + c.reauthMs;
        send(e, d, q.mac, q.token, m.eap);
        sendWireless(e, d, q.mac, {
          kind: 'key1',
          ssid: d.wireless!.ssid,
          security: d.wireless!.security,
          token: q.token,
          nonce: peer.nonce,
        });
      } else if (m.code === 3) {
        reject(e, d, q.mac, q.token, 'RADIUS Access-Reject.');
        return;
      } else {
        if (m.eap.code !== 1) throw new Error('Access-Challenge sem Request.');
        send(e, d, q.mac, q.token, m.eap);
      }
      c.queries = c.queries.filter((v) => v !== q);
    }
  } catch (error) {
    e.drop(d, 'EAP-RADIUS: ' + (error as Error).message);
  }
}
export function tickEnterprise(e: SimulationEngine, d: Device) {
  const c = d.eapAuthenticator;
  if (!c) return;
  c.queries = c.queries.filter((q) => d.wireless?.peers.some((p) => p.token === q.token));
  for (const q of [...c.queries])
    if (q.deadline <= e.state.clock) {
      if (q.attempts >= 3) reject(e, d, q.mac, q.token, 'EAP-RADIUS timeout.');
      else {
        q.attempts++;
        q.deadline = e.state.clock + 1000;
        transmit(e, d, q);
      }
    }
  for (const p of [...(d.wireless?.peers ?? [])])
    if (p.eapExpires !== undefined && p.eapExpires <= e.state.clock)
      reject(e, d, p.mac, p.token, 'Sessão EAP expirada; nova autenticação necessária.');
}
export function validateEnterprise(s: Snapshot) {
  for (const d of s.devices) {
    const c = d.eapAuthenticator;
    if (
      c &&
      (d.wireless?.role !== 'ap' ||
        !d.interfaces.some((p) => p.id === c.underlay && p.ip && ['routed', 'svi'].includes(p.mode)) ||
        new Set(c.queries.map((q) => q.sourcePort)).size !== c.queries.length ||
        c.queries.some((q) => !d.wireless?.peers.some((p) => p.mac === q.mac && p.token === q.token)))
    )
      throw new Error('EAP NAS/queries inconsistentes.');
    if (
      d.eapSupplicant &&
      (d.wireless?.role !== 'client' ||
        (d.eapSupplicant.token &&
          d.eapSupplicant.phase === 'authorized' &&
          d.eapSupplicant.token !== d.wireless.association?.token))
    )
      throw new Error('EAP supplicant/associação inconsistentes.');
    if (
      d.eapServer &&
      (new Set(d.eapServer.users.map((u) => u.username)).size !== d.eapServer.users.length ||
        publicKey(d.eapServer.identity.seed) !== d.eapServer.identity.certificate.publicKey)
    )
      throw new Error('EAP servidor/identidade inconsistentes.');
    for (const p of [
      ...(d.wireless?.peers ?? []),
      ...(d.wireless?.association ? [d.wireless.association] : []),
    ])
      if (
        d.wireless?.security === 'wpa2-enterprise' &&
        ('phase' in p ? p.phase === 'associated' : d.wireless.phase === 'associated') &&
        !p.pmk
      )
        throw new Error('Associação empresarial sem PMK.');
  }
}
