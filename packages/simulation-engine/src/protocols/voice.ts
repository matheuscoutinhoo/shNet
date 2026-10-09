import type { SimulationEngine } from '../core/engine';
import type { Action, Device, Snapshot, UdpPacket } from '../model';
import { phoneConfigSchema, type sipSchema } from './voice-model';
import type { z } from 'zod';
import { resolveRoute } from './ipv4';
import { isUnicast } from './dhcp-config';
type Call = NonNullable<Device['phone']>['calls'][number];
function sendSip(
  e: SimulationEngine,
  d: Device,
  c: Call,
  method: z.infer<typeof sipSchema>['method'],
  status?: z.infer<typeof sipSchema>['status']
) {
  const p = d.phone!;
  e.sendIp(d.id, {
    src: c.local,
    dst: c.remote,
    ttl: 64,
    protocol: 'UDP',
    sourcePort: p.sipPort,
    destinationPort: c.remotePort,
    bytes: 320,
    payload: {
      protocol: 'SIP',
      message: {
        callId: c.id,
        cseq: c.cseq,
        method,
        ...(status ? { status } : {}),
        from: p.number,
        to: c.remote,
        contact: c.local,
        via: c.local,
        ...(method === 'INVITE' ? { media: { address: c.local, port: p.rtpPort, codec: 'PCMU' } } : {}),
      },
    },
  });
  e.emit('APPLICATION_DATA', d.id, `SIP ${status ?? method} · ${c.id}.`);
}
function schedule(e: SimulationEngine, d: Device, c: Call, delay: number) {
  e.state.queue = e.state.queue.filter(
    (q) => q.action.kind !== 'voice-tick' || q.action.device !== d.id || q.action.call !== c.id
  );
  c.deadline = e.state.clock + delay;
  e.schedule(delay, { kind: 'voice-tick', device: d.id, call: c.id, token: c.token });
}
export function configurePhone(e: SimulationEngine, d: Device, input: unknown) {
  const p = phoneConfigSchema.parse(input);
  if (p.sipPort === p.rtpPort) throw new Error('SIP e RTP exigem portas distintas.');
  e.state.queue = e.state.queue.filter((q) => q.action.kind !== 'voice-tick' || q.action.device !== d.id);
  d.phone = { ...p, calls: [] };
  e.emit('CONFIG_CHANGED', d.id, 'Telefone SIP/RTP configurado.');
}
export function callPhone(e: SimulationEngine, d: Device, target: string, port = 5060) {
  if (!d.phone?.enabled || !d.power || !isUnicast(target))
    throw new Error('Ative o telefone e informe IPv4 unicast.');
  const local = resolveRoute(d, target)?.port.ip;
  if (!local) throw new Error('Telefone sem rota/endereço.');
  if (d.phone.calls.length >= 64) {
    const old = d.phone.calls.findIndex((c) => ['CLOSED', 'FAILED'].includes(c.state));
    if (old < 0) throw new Error('Limite de chamadas.');
    d.phone.calls.splice(old, 1);
  }
  const c: Call = {
    id: e.id('call'),
    role: 'caller',
    remote: target,
    remotePort: port,
    local,
    state: 'CALLING',
    cseq: 1,
    deadline: e.state.clock + 1000,
    attempts: 1,
    sent: 0,
    received: 0,
    token: e.id('voice'),
  };
  d.phone.calls.push(c);
  sendSip(e, d, c, 'INVITE');
  schedule(e, d, c, 1000);
  return c.id;
}
export function hangupPhone(e: SimulationEngine, d: Device, id: string) {
  const c = d.phone?.calls.find((c) => c.id === id);
  if (!c || c.state === 'CLOSED') return;
  c.cseq++;
  sendSip(e, d, c, 'BYE');
  c.state = 'CLOSED';
  e.state.queue = e.state.queue.filter(
    (q) => q.action.kind !== 'voice-tick' || q.action.device !== d.id || q.action.call !== c.id
  );
}
export function receiveVoice(e: SimulationEngine, d: Device, p: UdpPacket) {
  const config = d.phone;
  if (!config?.enabled || !d.power) return;
  if (p.payload.protocol === 'RTP') {
    const m = p.payload.message,
      c = config.calls.find(
        (c) =>
          c.id === m.callId &&
          c.state === 'ESTABLISHED' &&
          c.media?.address === p.src &&
          c.media.port === p.sourcePort &&
          p.destinationPort === config.rtpPort &&
          c.local === p.dst
      );
    if (
      !c ||
      (c.lastSequence !== undefined &&
        ((m.sequence - c.lastSequence + 65536) % 65536 === 0 ||
          (m.sequence - c.lastSequence + 65536) % 65536 > 32768))
    ) {
      e.drop(d, 'RTP sem chamada, tuple ou sequência correspondente.');
      return;
    }
    c.received++;
    c.lastSequence = m.sequence;
    e.emit('APPLICATION_DATA', d.id, `RTP PCMU: pacote ${m.sequence}; chamada ${c.id}.`);
    return;
  }
  if (p.payload.protocol !== 'SIP' || p.destinationPort !== config.sipPort) return;
  const m = p.payload.message;
  let c = config.calls.find((c) => c.id === m.callId);
  if (
    !c &&
    m.method === 'INVITE' &&
    !m.status &&
    config.calls.length < 64 &&
    isUnicast(p.src) &&
    m.media?.address === p.src
  ) {
    c = {
      id: m.callId,
      role: 'callee',
      remote: p.src,
      remotePort: p.sourcePort,
      local: p.dst,
      state: 'RINGING',
      cseq: m.cseq,
      media: m.media,
      deadline: e.state.clock + 30000,
      attempts: 0,
      sent: 0,
      received: 0,
      token: e.id('voice'),
    };
    config.calls.push(c);
  }
  if (
    !c ||
    c.remote !== p.src ||
    c.remotePort !== p.sourcePort ||
    c.local !== p.dst ||
    (m.method === 'BYE' ? m.cseq < c.cseq : m.cseq !== c.cseq)
  ) {
    e.drop(d, 'SIP sem diálogo/CSeq correspondente.');
    return;
  }
  if (m.method === 'INVITE' && !m.status) {
    if (!m.media || m.media.address !== p.src) {
      e.drop(d, 'SDP deve usar o endereço do sinalizador.');
      return;
    }
    c.media = m.media;
    sendSip(e, d, c, 'INVITE', config.autoAnswer ? 200 : 180);
    schedule(e, d, c, 30000);
  } else if (m.method === 'INVITE' && m.status === 200 && c.role === 'caller' && m.media?.address === p.src) {
    c.media = m.media;
    c.state = 'ESTABLISHED';
    sendSip(e, d, c, 'ACK');
    schedule(e, d, c, 20);
  } else if (m.method === 'ACK' && !m.status && c.role === 'callee') {
    c.state = 'ESTABLISHED';
    schedule(e, d, c, 20);
  } else if (m.method === 'BYE' && !m.status) {
    c.cseq = m.cseq;
    c.state = 'CLOSED';
    sendSip(e, d, c, 'BYE', 200);
    e.state.queue = e.state.queue.filter(
      (q) => q.action.kind !== 'voice-tick' || q.action.device !== d.id || q.action.call !== c!.id
    );
  }
}
export function handleVoiceTick(e: SimulationEngine, a: Extract<Action, { kind: 'voice-tick' }>) {
  const d = e.device(a.device),
    c = d.phone?.calls.find((c) => c.id === a.call && c.token === a.token);
  if (!c) return;
  if (c.state === 'CALLING' && c.attempts < 4) {
    c.attempts++;
    sendSip(e, d, c, 'INVITE');
    schedule(e, d, c, 1000 * 2 ** (c.attempts - 1));
  } else if (c.state === 'ESTABLISHED' && c.media) {
    e.sendIp(d.id, {
      src: c.local,
      dst: c.media.address,
      ttl: 64,
      protocol: 'UDP',
      sourcePort: d.phone!.rtpPort,
      destinationPort: c.media.port,
      bytes: 200,
      payload: {
        protocol: 'RTP',
        message: {
          callId: c.id,
          ssrc: 1,
          sequence: c.sent % 65536,
          timestamp: (c.sent * 160) % 4294967296,
          data: 'PCMU '.repeat(32),
        },
      },
    });
    c.sent++;
    // Bounded recording session: five seconds at 50 packets/s, without unbounded queues.
    if (c.sent < 250) schedule(e, d, c, 20);
    else hangupPhone(e, d, c.id);
  } else if (c.state !== 'CLOSED') {
    c.state = 'FAILED';
    e.emit('APPLICATION_DATA', d.id, 'SIP: chamada expirada.');
  }
}
export function validateVoice(s: Snapshot) {
  const used = new Set<object>();
  for (const d of s.devices) {
    if (!d.phone) continue;
    const ids = new Set<string>();
    if (d.phone.sipPort === d.phone.rtpPort) throw new Error('Portas de telefone inválidas.');
    for (const c of d.phone.calls) {
      if (ids.has(c.id) || !isUnicast(c.local) || !isUnicast(c.remote))
        throw new Error('Diálogo SIP inválido.');
      ids.add(c.id);
      const timers = s.queue.filter(
        (q) => q.action.kind === 'voice-tick' && q.action.device === d.id && q.action.call === c.id
      );
      const live = ['CALLING', 'RINGING', 'ESTABLISHED'].includes(c.state);
      if (
        (live &&
          (timers.length !== 1 ||
            timers[0].at !== c.deadline ||
            timers[0].action.kind !== 'voice-tick' ||
            timers[0].action.token !== c.token)) ||
        (!live && timers.length)
      )
        throw new Error('Chamada sem timer correspondente.');
      timers.forEach((q) => used.add(q.action));
    }
  }
  for (const q of s.queue)
    if (q.action.kind === 'voice-tick' && !used.has(q.action)) throw new Error('Timer SIP órfão.');
}
