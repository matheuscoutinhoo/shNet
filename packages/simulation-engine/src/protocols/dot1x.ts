import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkInterface, Frame, Action } from '../model';
import { dot1xConfigSchema, supplicantConfigSchema, type Eapol, type AaaQuery } from './aaa-model';
import { eapProof, startRadius } from './aaa';
import { interfaceOperational } from './layer3';
import { isUnicast } from './dhcp-config';
const destination = '01:80:c2:00:00:03';
function physical(p: NetworkInterface) {
  return p.media !== 'wifi' && !p.logical && !p.aggregate && !p.channel && !p.tunnel && !p.vxlan;
}
export function dot1xConfig(p: NetworkInterface) {
  const a = p.dot1x;
  if (!a) throw new Error('Porta sem 802.1X.');
  const { enabled, server, key, underlay, reauthMs } = a;
  return { enabled, server, key, underlay, reauthMs };
}
export function supplicantConfig(p: NetworkInterface) {
  const a = p.supplicant;
  if (!a) throw new Error('Supplicant ausente.');
  const { enabled, username, password } = a;
  return { enabled, username, password };
}
function clearTimer(e: SimulationEngine, d: Device, p: NetworkInterface) {
  e.state.queue = e.state.queue.filter(
    (x) => x.action.kind !== 'dot1x-tick' || x.action.device !== d.id || x.action.port !== p.id
  );
}
function arm(e: SimulationEngine, d: Device, p: NetworkInterface) {
  const a = p.dot1x ?? p.supplicant;
  if (!a?.enabled) return;
  a.tickAt = e.state.clock + 1000;
  e.schedule(1000, { kind: 'dot1x-tick', device: d.id, port: p.id, token: a.token, at: a.tickAt });
}
function reset(e: SimulationEngine, d: Device, p: NetworkInterface) {
  const a = p.dot1x!;
  p.accessVlan = a.baseVlan;
  d.macTable = d.macTable.filter((m) => m.port !== p.id);
  a.phase = 'unauthorized';
  a.lastAt = e.state.clock;
  delete a.mac;
  delete a.session;
  delete a.challenge;
  delete a.username;
  delete a.query;
  delete a.expiresAt;
  delete a.assignedVlan;
}
export function configureDot1x(e: SimulationEngine, d: Device, p: NetworkInterface, input: unknown) {
  const c = dot1xConfigSchema.parse(input),
    wan = d.interfaces.find((p) => p.id === c.underlay);
  if (
    d.type !== 'switch' ||
    !physical(p) ||
    p.mode !== 'access' ||
    p.supplicant ||
    !isUnicast(c.server) ||
    !wan?.ip ||
    wan.mode !== 'routed' ||
    wan.vrf ||
    wan.tunnel ||
    wan.vxlan ||
    wan === p
  )
    throw new Error('802.1X exige porta access física e underlay IPv4 routed para RADIUS.');
  const baseVlan = p.dot1x?.baseVlan ?? p.accessVlan;
  clearTimer(e, d, p);
  if (p.dot1x) reset(e, d, p);
  p.dot1x = {
    ...c,
    baseVlan,
    phase: 'unauthorized',
    token: e.id('dot1x'),
    lastAt: e.state.clock,
    attempts: 0,
  };
  arm(e, d, p);
  e.emit(
    'CONFIG_CHANGED',
    d.id,
    'Controle de acesso 802.1X ' + (c.enabled ? 'habilitado' : 'desabilitado') + '.',
    { port: p.id }
  );
}
export function configureSupplicant(e: SimulationEngine, d: Device, p: NetworkInterface, input: unknown) {
  const c = supplicantConfigSchema.parse(input);
  if (d.type === 'switch' || !physical(p) || p.dot1x)
    throw new Error('Supplicant exige porta Ethernet de endpoint/roteador.');
  const old = p.supplicant;
  if (old?.enabled && old.session) send(e, d, p, { type: 'logoff', session: old.session }, old.authenticator);
  clearTimer(e, d, p);
  p.supplicant = {
    ...c,
    phase: 'unauthorized',
    token: e.id('supplicant'),
    lastAt: e.state.clock,
    attempts: 0,
  };
  arm(e, d, p);
  e.emit('CONFIG_CHANGED', d.id, 'Supplicant 802.1X de rede configurado.', { port: p.id });
}
function send(e: SimulationEngine, d: Device, p: NetworkInterface, m: Eapol, dst = destination) {
  e.sendFrame(d.id, p.id, { src: p.mac, dst, etherType: 'EAPOL', eapol: m, hops: 1 });
  e.emit('DOT1X_SENT', d.id, 'EAPOL ' + m.type + '.', { port: p.id });
}
function begin(e: SimulationEngine, d: Device, p: NetworkInterface, mac: string) {
  const a = p.dot1x!;
  reset(e, d, p);
  a.mac = mac;
  a.session = e.id('eap');
  a.phase = 'authenticating';
  a.attempts++;
  send(e, d, p, { type: 'identity-request', session: a.session }, mac);
}
export function receiveEapol(e: SimulationEngine, d: Device, p: NetworkInterface, frame: Frame) {
  const m = frame.eapol;
  if (!m || (frame.dst !== p.mac && frame.dst !== destination) || parseInt(frame.src.slice(0, 2), 16) & 1)
    return;
  e.emit('DOT1X_RECEIVED', d.id, 'EAPOL ' + m.type + '.', { port: p.id, frame });
  const a = p.dot1x;
  if (a?.enabled) {
    if (m.type === 'start') {
      if (a.phase === 'unauthorized' || e.state.clock - a.lastAt >= 5000) begin(e, d, p, frame.src);
      return;
    }
    if (m.type === 'logoff' && m.session === a.session && frame.src === a.mac) {
      reset(e, d, p);
      return;
    }
    if (!('session' in m) || m.session !== a.session || frame.src !== a.mac || a.phase !== 'authenticating')
      return;
    if (m.type === 'identity-response' && !a.query) {
      a.username = m.username;
      a.challenge = e.id('eap-challenge');
      a.lastAt = e.state.clock;
      send(e, d, p, { type: 'challenge', session: a.session!, challenge: a.challenge }, frame.src);
    } else if (m.type === 'response' && m.username === a.username && a.challenge && !a.query) {
      const wan = d.interfaces.find((p) => p.id === a.underlay)!;
      const q = startRadius(e, d, {
        username: m.username,
        key: a.key,
        server: a.server,
        sourceIp: wan.ip!,
        challenge: a.challenge,
        proof: m.proof,
        port: p.id,
        mac: frame.src,
        session: a.session,
      });
      a.query = q.id;
      a.lastAt = e.state.clock;
    }
    return;
  }
  const s = p.supplicant;
  if (!s?.enabled) return;
  if (m.type === 'identity-request') {
    s.session = m.session;
    s.authenticator = frame.src;
    s.phase = 'authenticating';
    s.lastAt = e.state.clock;
    delete s.challenge;
    send(e, d, p, { type: 'identity-response', session: m.session, username: s.username }, frame.src);
  } else if ('session' in m && m.session === s.session && frame.src === s.authenticator) {
    if (m.type === 'challenge') {
      s.challenge = m.challenge;
      s.lastAt = e.state.clock;
      send(
        e,
        d,
        p,
        {
          type: 'response',
          session: m.session,
          username: s.username,
          proof: eapProof(s.username, s.password, m.challenge),
        },
        frame.src
      );
    } else if (m.type === 'success' || m.type === 'failure') {
      s.phase = m.type === 'success' ? 'authorized' : 'rejected';
      s.lastAt = e.state.clock;
      e.emit('DOT1X_STATE', d.id, 'Supplicant ' + s.phase + '.', { port: p.id });
    }
  }
}
export function completeDot1x(e: SimulationEngine, d: Device, q: AaaQuery) {
  const p = d.interfaces.find((p) => p.id === q.port),
    a = p?.dot1x;
  if (!p || !a?.enabled || a.query !== q.id || a.session !== q.session || a.mac !== q.mac) return;
  const accepted =
    q.status === 'accepted' &&
    interfaceOperational(e.state, d, p) &&
    (!q.vlan || d.vlans.some((v) => v.id === q.vlan));
  const mac = a.mac!,
    session = a.session!;
  if (accepted) {
    a.phase = 'authorized';
    a.expiresAt = Math.min(q.expiresAt!, e.state.clock + a.reauthMs);
    a.assignedVlan = q.vlan;
    p.accessVlan = q.vlan ?? a.baseVlan;
    d.macTable = d.macTable.filter((m) => m.port !== p.id);
  } else reset(e, d, p);
  send(e, d, p, { type: accepted ? 'success' : 'failure', session }, mac);
  e.emit(
    'DOT1X_STATE',
    d.id,
    accepted
      ? 'Porta autorizada para ' + mac + ' na VLAN ' + p.accessVlan + '.'
      : 'Porta não autorizada; dados bloqueados.',
    { port: p.id }
  );
}
export function permitDot1x(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  frame: Frame,
  direction: 'in' | 'out'
) {
  const a = p.dot1x;
  if (!a?.enabled || frame.eapol || frame.bpdu || frame.lacp) return true;
  const permitted =
    a.phase === 'authorized' &&
    a.expiresAt! > e.state.clock &&
    (direction === 'in'
      ? frame.src === a.mac
      : frame.dst === a.mac || !!(parseInt(frame.dst.slice(0, 2), 16) & 1));
  if (!permitted) {
    e.emit('DOT1X_DENY', d.id, 'Controlled port: frame ' + direction + ' sem autorização 802.1X.', {
      port: p.id,
    });
    e.drop(d, '802.1X: dados bloqueados na porta controlada.', p.id, frame);
  }
  return permitted;
}
export function refreshDot1x(e: SimulationEngine) {
  for (const d of e.state.devices)
    for (const p of d.interfaces) {
      const a = p.dot1x,
        s = p.supplicant;
      if (
        a?.enabled &&
        a.phase !== 'unauthorized' &&
        (!interfaceOperational(e.state, d, p) || (a.phase === 'authorized' && a.expiresAt! <= e.state.clock))
      ) {
        const mac = a.mac;
        reset(e, d, p);
        e.emit('DOT1X_STATE', d.id, 'Autorização retirada por falha/expiração.', { port: p.id });
        if (mac && interfaceOperational(e.state, d, p)) begin(e, d, p, mac);
      }
      if (s?.enabled && s.phase !== 'unauthorized' && !interfaceOperational(e.state, d, p)) {
        s.phase = 'unauthorized';
        delete s.session;
        delete s.authenticator;
        delete s.challenge;
        s.lastAt = e.state.clock;
        s.attempts = 0;
      }
      if (d.networkAuth && d.networkAuth.expiresAt <= e.state.clock) delete d.networkAuth;
    }
}
export function handleDot1xTick(e: SimulationEngine, a: Extract<Action, { kind: 'dot1x-tick' }>) {
  const d = e.device(a.device),
    p = d.interfaces.find((p) => p.id === a.port),
    state = p?.dot1x ?? p?.supplicant;
  if (!p || !state?.enabled || state.token !== a.token || state.tickAt !== a.at) return;
  delete state.tickAt;
  refreshDot1x(e);
  if (interfaceOperational(e.state, d, p)) {
    const s = p.supplicant,
      auth = p.dot1x;
    if (s && s.phase !== 'authorized' && (s.attempts === 0 || e.state.clock - s.lastAt >= 5000)) {
      s.phase = 'unauthorized';
      s.lastAt = e.state.clock;
      s.attempts++;
      send(e, d, p, { type: 'start' });
    }
    if (auth?.phase === 'authenticating' && !auth.query && e.state.clock - auth.lastAt >= 5000)
      reset(e, d, p);
  }
  arm(e, d, p);
}
