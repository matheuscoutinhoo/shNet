import type { z } from 'zod';
import {
  frameSchema,
  interfaceSchema,
  type Action,
  type Device,
  type Frame,
  type NetworkInterface,
  type Snapshot,
  type UdpPacket,
} from '../model';
import type { SimulationEngine } from '../core/engine';
import { capwapMessageSchema, capwapRecordSchema, wlcConfigSchema, wtpConfigSchema } from './capwap-model';
import { configureWireless, wirelessConfig } from './wireless';
import { hashHex, hmacHex, keyShare, deriveSecret, sealRecord, openRecord } from './security-crypto';
import { switchFrame } from './ethernet';
type Message = z.infer<typeof capwapMessageSchema>;
type Record = z.infer<typeof capwapRecordSchema>;
type Session = NonNullable<Device['wlc']>['sessions'][number];
function proof(m: Message, key: string) {
  const fields = { ...m };
  delete fields.authenticator;
  return hmacHex(key, JSON.stringify(fields));
}
function send(
  e: SimulationEngine,
  d: Device,
  underlay: string,
  dst: string,
  destinationPort: number,
  sourcePort: number,
  m: Message,
  key?: string
) {
  const p = d.interfaces.find((p) => p.id === underlay);
  if (!p?.ip || !d.power) return;
  if (key) m = { ...m, authenticator: proof(m, key) };
  e.sendIp(d.id, {
    protocol: 'UDP',
    src: p.ip,
    dst,
    ttl: 64,
    sourcePort,
    destinationPort,
    bytes: 48 + (m.ciphertext?.length ?? 128) / 2,
    payload: { protocol: 'CAPWAP', message: m },
  });
  e.emit('WIFI_SENT', d.id, `CAPWAP ${m.kind} UDP/${destinationPort}; WTP ${m.wtp}.`);
}
function schedule(e: SimulationEngine, d: Device, role: 'wlc' | 'wtp') {
  const c = d[role]!;
  e.state.queue = e.state.queue.filter(
    (q) => q.action.kind !== 'capwap-tick' || q.action.device !== d.id || q.action.role !== role
  );
  c.nextAt = e.state.clock + 1000;
  e.schedule(1000, { kind: 'capwap-tick', device: d.id, role, token: c.token });
}
function underlay(d: Device, id: string) {
  const p = d.interfaces.find((p) => p.id === id);
  if (!p?.ip || p.mode !== 'routed' || p.capwapPeer || p.meshPeer)
    throw new Error('CAPWAP exige underlay routed/SVI com IPv4.');
  return p;
}
export function configureWlc(e: SimulationEngine, d: Device, input: unknown) {
  const c = wlcConfigSchema.parse(input);
  if (d.type !== 'switch') throw new Error('WLC central exige switch com SVI ou porta routed.');
  if (c.enabled) underlay(d, c.underlay);
  if (
    new Set(c.profiles.map((p) => p.name)).size !== c.profiles.length ||
    c.profiles.some((p) => p.wireless.role !== 'ap')
  )
    throw new Error('Perfis WLC exigem nomes distintos e papel AP.');
  for (const p of d.interfaces.filter((p) => p.capwapPeer)) p.adminUp = false;
  d.wlc = { ...c, sessions: [], token: e.id('wlc'), nextAt: e.state.clock + 1000 };
  schedule(e, d, 'wlc');
  e.emit('CONFIG_CHANGED', d.id, 'WLC CAPWAP configurado.');
}
export function configureWtp(e: SimulationEngine, d: Device, input: unknown) {
  const c = wtpConfigSchema.parse(input);
  if (d.wireless?.role !== 'ap') throw new Error('WTP exige AP configurado.');
  underlay(d, c.underlay);
  const nonce = e.id('wtp-nonce');
  d.wtp = {
    ...c,
    token: e.id('wtp'),
    nextAt: e.state.clock + 1000,
    session: e.id('capwap-session'),
    nonce,
    secret: hashHex(String(e.state.seed) + '|' + nonce),
    phase: 'DISCOVERY',
    lastAt: e.state.clock,
    txSequence: 0,
    receivedSequences: [],
    attempts: 0,
  };
  configureWireless(e, d, { ...wirelessConfig(d), enabled: false });
  schedule(e, d, 'wtp');
  e.emit('CONFIG_CHANGED', d.id, 'WTP CAPWAP: aguardando controller.');
}
function recordToWlc(e: SimulationEngine, d: Device, r: Record) {
  const c = d.wtp!;
  if (!c.sessionKey) return;
  const sequence = ++c.txSequence,
    ciphertext = sealRecord(c.sessionKey, 0, sequence, JSON.stringify(r), c.session);
  send(e, d, c.underlay, c.controller, r.type === 'data' ? 5247 : 5246, 55000, {
    kind: 'record',
    wtp: d.id,
    session: c.session,
    sequence,
    ciphertext,
  });
}
function recordToWtp(e: SimulationEngine, d: Device, s: Session, r: Record) {
  const c = d.wlc!,
    sequence = ++s.txSequence,
    ciphertext = sealRecord(s.key, 1, sequence, JSON.stringify(r), s.session);
  send(e, d, c.underlay, s.address, s.clientPort, r.type === 'data' ? 5247 : 5246, {
    kind: 'record',
    wtp: s.wtp,
    session: s.session,
    sequence,
    ciphertext,
  });
}
function open(key: string, direction: number, m: Message, seen: number[]) {
  if (!m.ciphertext || m.sequence < 1 || seen.includes(m.sequence) || m.sequence <= Math.max(0, ...seen) - 64)
    throw new Error('CAPWAP: ciphertext/replay inválido.');
  const r = capwapRecordSchema.parse(
    JSON.parse(openRecord(key, direction, m.sequence, m.ciphertext, m.session))
  );
  seen.push(m.sequence);
  seen.sort((a, b) => a - b);
  if (seen.length > 64) seen.splice(0, seen.length - 64);
  return r;
}
function virtualPort(e: SimulationEngine, d: Device, s: Session, vlan: number) {
  let p = d.interfaces.find((p) => p.capwapPeer === s.wtp);
  if (!p) {
    if (d.interfaces.length >= 48) throw new Error('WLC sem portas virtuais disponíveis.');
    const n = d.interfaces.length;
    p = interfaceSchema.parse({
      id: e.id('capwap-port'),
      name: 'CAPWAP' + n,
      mac: d.interfaces[0].mac.slice(0, -2) + n.toString(16).padStart(2, '0'),
      media: 'rj45',
      capwapPeer: s.wtp,
      adminUp: true,
      speed: 1000,
      duplex: 'full',
      mtu: 1500,
      mode: 'access',
      accessVlan: vlan,
      nativeVlan: 1,
      allowedVlans: [vlan],
      description: 'WTP centralizado',
      tx: 0,
      rx: 0,
      errors: 0,
      stpEdge: true,
    });
    d.interfaces.push(p);
  }
  if (!d.vlans.some((v) => v.id === vlan)) {
    if (d.vlans.length >= 256) throw new Error('Limite de VLANs WLC.');
    d.vlans.push({ id: vlan, name: 'WLAN' + vlan });
  }
  p.adminUp = true;
  p.accessVlan = vlan;
  s.port = p.id;
  return p;
}
export function receiveCapwap(e: SimulationEngine, d: Device, p: UdpPacket) {
  if (p.payload.protocol !== 'CAPWAP') return;
  const m = p.payload.message;
  try {
    if (d.wlc?.enabled && [5246, 5247].includes(p.destinationPort)) {
      const c = d.wlc,
        local = underlay(d, c.underlay);
      if (p.dst !== local.ip || (c.allowedWtps.length && !c.allowedWtps.includes(m.wtp)))
        throw new Error('WTP/origem não autorizados.');
      if (m.kind !== 'record' && m.authenticator !== proof(m, c.key))
        throw new Error('CAPWAP: prova PSK inválida.');
      if (m.kind === 'discovery') {
        send(
          e,
          d,
          c.underlay,
          p.src,
          p.sourcePort,
          5246,
          { kind: 'discovery-response', wtp: m.wtp, session: m.session, sequence: 0 },
          c.key
        );
        return;
      }
      let s = c.sessions.find((s) => s.wtp === m.wtp && s.session === m.session);
      if (m.kind === 'join') {
        if (!m.keyShare || !m.nonce) throw new Error('JOIN sem key share/nonce.');
        if (!s) {
          if (c.sessions.length >= 64) throw new Error('WLC: limite de sessões.');
          const old = c.sessions.find((s) => s.wtp === m.wtp);
          if (old?.port) d.interfaces.find((p) => p.id === old.port)!.adminUp = false;
          c.sessions = c.sessions.filter((s) => s.wtp !== m.wtp);
          const nonce = e.id('wlc-nonce'),
            secret = hashHex(String(e.state.seed) + '|' + nonce);
          s = {
            wtp: m.wtp,
            address: p.src,
            clientPort: p.sourcePort,
            session: m.session,
            clientNonce: m.nonce,
            serverNonce: nonce,
            keyShare: keyShare(secret),
            secret,
            key: deriveSecret(secret, m.keyShare, c.key, m.nonce + '|' + nonce + '|' + m.session),
            phase: 'CONFIGURE',
            lastAt: e.state.clock,
            txSequence: 0,
            receivedSequences: [],
          };
          c.sessions.push(s);
        }
        send(
          e,
          d,
          c.underlay,
          p.src,
          p.sourcePort,
          5246,
          {
            kind: 'joined',
            wtp: m.wtp,
            session: m.session,
            sequence: 0,
            nonce: s.serverNonce,
            keyShare: s.keyShare,
          },
          c.key
        );
        return;
      }
      if (!s || s.address !== p.src || s.clientPort !== p.sourcePort || m.kind !== 'record')
        throw new Error('CAPWAP sem sessão/tuple correspondente.');
      const r = open(s.key, 0, m, s.receivedSequences);
      s.lastAt = e.state.clock;
      if (r.type === 'configure') {
        const profile = c.profiles.find((c) => c.name === r.profile);
        if (!profile) throw new Error('Perfil WLAN não encontrado.');
        s.profile = profile.name;
        virtualPort(e, d, s, profile.vlan);
        recordToWtp(e, d, s, { type: 'configured', config: profile });
      } else if (r.type === 'run' && s.profile) {
        s.phase = 'RUN';
        recordToWtp(e, d, s, { type: 'running' });
      } else if (r.type === 'echo' && s.phase === 'RUN') recordToWtp(e, d, s, { type: 'echo-reply' });
      else if (r.type === 'data' && s.phase === 'RUN' && s.port && r.frame) {
        if (p.destinationPort !== 5247) throw new Error('CAPWAP data exige UDP/5247.');
        const inner = frameSchema.parse(JSON.parse(r.frame));
        checkInner(inner);
        switchFrame(
          e,
          d,
          d.interfaces.find((p) => p.id === s!.port)!,
          inner
        );
      } else throw new Error('CAPWAP: transição de estado inválida.');
    } else if (d.wtp?.enabled) {
      const c = d.wtp;
      if (
        p.src !== c.controller ||
        p.dst !== underlay(d, c.underlay).ip ||
        p.destinationPort !== 55000 ||
        ![5246, 5247].includes(p.sourcePort) ||
        m.wtp !== d.id ||
        m.session !== c.session
      )
        throw new Error('CAPWAP controller/tuple divergente.');
      if (m.kind !== 'record' && m.authenticator !== proof(m, c.key))
        throw new Error('CAPWAP: controller sem prova PSK.');
      if (m.kind !== 'record') c.lastAt = e.state.clock;
      if (m.kind === 'discovery-response' && c.phase === 'DISCOVERY') {
        c.phase = 'JOIN';
        sendJoin(e, d);
      } else if (m.kind === 'joined' && m.keyShare && m.nonce && ['JOIN', 'CONFIGURE'].includes(c.phase)) {
        c.serverNonce = m.nonce;
        c.sessionKey = deriveSecret(c.secret, m.keyShare, c.key, c.nonce + '|' + m.nonce + '|' + c.session);
        c.phase = 'CONFIGURE';
        recordToWlc(e, d, { type: 'configure', profile: c.profile });
      } else if (m.kind === 'record' && c.sessionKey) {
        const r = open(c.sessionKey, 1, m, c.receivedSequences);
        c.lastAt = e.state.clock;
        if (r.type === 'configured' && r.config && c.phase === 'CONFIGURE') {
          configureWireless(e, d, { ...r.config.wireless, enabled: true });
          d.interfaces.find((p) => p.id === d.wireless!.port)!.accessVlan = r.config.vlan;
          c.radioConfigured = true;
          if (!d.vlans.some((v) => v.id === r.config!.vlan))
            d.vlans.push({ id: r.config.vlan, name: 'WLAN' + r.config.vlan });
          recordToWlc(e, d, { type: 'run' });
        } else if (r.type === 'running') {
          c.phase = 'RUN';
          e.emit('WIFI_STATE', d.id, 'CAPWAP RUN: rádio e canal de dados ativos.');
        } else if (r.type === 'data' && c.phase === 'RUN' && r.frame) {
          if (p.sourcePort !== 5247) throw new Error('CAPWAP data exige UDP/5247.');
          const inner = frameSchema.parse(JSON.parse(r.frame));
          checkInner(inner);
          e.sendFrame(d.id, d.wireless!.port, inner);
        } else if (r.type !== 'echo-reply') throw new Error('CAPWAP: resposta incompatível com estado.');
      }
    }
  } catch (error) {
    e.drop(d, error instanceof Error ? error.message : 'CAPWAP inválido.');
  }
}
function checkInner(f: Frame) {
  if (
    f.wifi ||
    f.secure ||
    f.bpdu ||
    f.eapol ||
    f.lacp ||
    f.meshHello ||
    f.wan ||
    (f.packet?.protocol === 'UDP' && f.packet.payload.protocol === 'CAPWAP')
  )
    throw new Error('CAPWAP payload de dados não permitido.');
}
function sendJoin(e: SimulationEngine, d: Device) {
  const c = d.wtp!;
  send(
    e,
    d,
    c.underlay,
    c.controller,
    5246,
    55000,
    {
      kind: 'join',
      wtp: d.id,
      session: c.session,
      sequence: 0,
      nonce: c.nonce,
      keyShare: keyShare(c.secret),
    },
    c.key
  );
}
export function capwapFromRadio(e: SimulationEngine, d: Device, port: NetworkInterface, frame: Frame) {
  if (!d.wtp?.enabled || d.wireless?.port !== port.id) return false;
  if (d.wtp.phase !== 'RUN') e.drop(d, 'WTP sem canal de dados CAPWAP.', port.id);
  else {
    checkInner(frame);
    recordToWlc(e, d, { type: 'data', frame: JSON.stringify(frame) });
  }
  return true;
}
export function sendCapwapFrame(e: SimulationEngine, d: Device, port: NetworkInterface, frame: Frame) {
  const s = d.wlc?.sessions.find((s) => s.wtp === port.capwapPeer && s.phase === 'RUN');
  if (!d.wlc?.enabled || !s || !port.adminUp) {
    e.drop(d, 'WLC: WTP/canal de dados indisponível.', port.id);
    return;
  }
  checkInner(frame);
  recordToWtp(e, d, s, {
    type: 'data',
    frame: JSON.stringify({ ...frame, hops: Math.max(0, frame.hops - 1) }),
  });
}
export function handleCapwapTick(e: SimulationEngine, a: Extract<Action, { kind: 'capwap-tick' }>) {
  const d = e.device(a.device),
    c = d[a.role];
  if (!c || c.token !== a.token) return;
  if (a.role === 'wlc' && d.wlc) {
    for (const s of d.wlc.sessions.filter((s) => e.state.clock - s.lastAt > 5000)) {
      if (s.port) d.interfaces.find((p) => p.id === s.port)!.adminUp = false;
      d.wlc.sessions = d.wlc.sessions.filter((v) => v !== s);
      e.emit('WIFI_STATE', d.id, 'CAPWAP: WTP ' + s.wtp + ' expirou.');
    }
  } else if (d.wtp?.enabled && d.power) {
    const w = d.wtp;
    if (e.state.clock - w.lastAt > 4000 && w.phase !== 'DISCOVERY') {
      const nonce = e.id('wtp-nonce');
      w.nonce = nonce;
      w.secret = hashHex(String(e.state.seed) + '|' + nonce);
      w.session = e.id('capwap-session');
      w.phase = 'DISCOVERY';
      w.radioConfigured = false;
      w.txSequence = 0;
      w.receivedSequences = [];
      delete w.sessionKey;
      delete w.serverNonce;
      configureWireless(e, d, { ...wirelessConfig(d), enabled: false });
    }
    w.attempts++;
    if (w.phase === 'DISCOVERY')
      send(
        e,
        d,
        w.underlay,
        w.controller,
        5246,
        55000,
        { kind: 'discovery', wtp: d.id, session: w.session, sequence: 0 },
        w.key
      );
    else if (w.phase === 'JOIN') sendJoin(e, d);
    else if (w.phase === 'CONFIGURE')
      recordToWlc(e, d, w.radioConfigured ? { type: 'run' } : { type: 'configure', profile: w.profile });
    else recordToWlc(e, d, { type: 'echo' });
  }
  schedule(e, d, a.role);
}
export function validateCapwap(s: Snapshot) {
  const used = new Set<object>();
  for (const d of s.devices)
    for (const role of ['wlc', 'wtp'] as const) {
      const c = d[role];
      if (!c) continue;
      if (c.enabled) underlay(d, c.underlay);
      const q = s.queue.filter(
        (q) => q.action.kind === 'capwap-tick' && q.action.device === d.id && q.action.role === role
      );
      if (
        q.length !== 1 ||
        q[0].at !== c.nextAt ||
        q[0].action.kind !== 'capwap-tick' ||
        q[0].action.token !== c.token
      )
        throw new Error('CAPWAP sem timer.');
      used.add(q[0].action);
      if (role === 'wlc' && d.wlc) {
        if (d.type !== 'switch' || new Set(d.wlc.sessions.map((v) => v.wtp)).size !== d.wlc.sessions.length)
          throw new Error('WLC/sessão duplicada.');
        for (const v of d.wlc.sessions)
          if (
            v.lastAt > s.clock ||
            (v.phase === 'RUN' &&
              (!v.port ||
                d.interfaces.find((p) => p.id === v.port)?.capwapPeer !== v.wtp ||
                !d.wlc.profiles.some((p) => p.name === v.profile))) ||
            new Set(v.receivedSequences).size !== v.receivedSequences.length
          )
            throw new Error('Sessão WLC inválida.');
      }
      if (
        role === 'wtp' &&
        d.wtp &&
        (d.wireless?.role !== 'ap' ||
          (d.wtp.phase === 'RUN' && !d.wtp.sessionKey) ||
          d.wtp.lastAt > s.clock ||
          new Set(d.wtp.receivedSequences).size !== d.wtp.receivedSequences.length)
      )
        throw new Error('WTP sem rádio/chaves ou relógio válido.');
    }
  for (const q of s.queue)
    if (q.action.kind === 'capwap-tick' && !used.has(q.action)) throw new Error('Timer CAPWAP órfão.');
}
