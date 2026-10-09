import type { SimulationEngine } from '../core/engine';
import type { Action, Device, NetworkInterface, Packet, Snapshot } from '../model';
type Binding = NonNullable<NonNullable<Device['nat']>['sipBindings']>[number];
function touch(e: SimulationEngine, d: Device, b: Binding) {
  b.expiresAt = e.state.clock + 60000;
  e.state.queue = e.state.queue.filter(
    (q) => q.action.kind !== 'sip-alg-expire' || q.action.device !== d.id || q.action.id !== b.id
  );
  e.schedule(60000, { kind: 'sip-alg-expire', device: d.id, id: b.id, expiresAt: b.expiresAt });
}
function remove(e: SimulationEngine, d: Device, b: Binding) {
  d.nat!.sipBindings = d.nat!.sipBindings?.filter((v) => v !== b);
  e.state.queue = e.state.queue.filter(
    (q) => q.action.kind !== 'sip-alg-expire' || q.action.device !== d.id || q.action.id !== b.id
  );
}
export function sipMediaOutbound(
  e: SimulationEngine,
  d: Device,
  input: NetworkInterface | undefined,
  output: NetworkInterface,
  p: Packet
): Packet | undefined {
  if (!d.nat?.enabled || !d.nat.algSip || p.protocol !== 'UDP' || p.payload.protocol !== 'RTP') return;
  const callId = p.payload.message.callId;
  const b = d.nat.sipBindings?.find(
    (b) =>
      b.call === callId &&
      b.expiresAt > e.state.clock &&
      b.inside === p.src &&
      b.insidePort === p.sourcePort &&
      b.remote === p.dst &&
      b.remoteMedia === p.destinationPort &&
      b.input === input?.id &&
      b.output === output.id
  );
  if (!b) return;
  touch(e, d, b);
  return { ...p, src: b.global, sourcePort: b.globalPort };
}
export function sipOutbound(
  e: SimulationEngine,
  d: Device,
  input: NetworkInterface | undefined,
  output: NetworkInterface,
  original: Packet,
  translated: Packet | undefined
) {
  if (
    !translated ||
    !d.nat?.enabled ||
    !d.nat.algSip ||
    input?.natRole !== 'inside' ||
    output.natRole !== 'outside' ||
    original.protocol !== 'UDP' ||
    translated.protocol !== 'UDP' ||
    original.payload.protocol !== 'SIP'
  )
    return translated;
  const m = original.payload.message;
  let b = d.nat.sipBindings?.find(
    (b) =>
      b.call === m.callId &&
      b.inside === original.src &&
      b.remote === original.dst &&
      b.controlInside === original.sourcePort &&
      b.controlRemote === original.destinationPort
  );
  if (m.method === 'BYE' && b) {
    if (!m.status && m.cseq > b.inviteCseq) remove(e, d, b);
    return translated;
  }
  if (
    m.method !== 'INVITE' ||
    m.status ||
    !m.media ||
    m.media.address !== original.src ||
    m.contact !== original.src ||
    m.via !== original.src
  )
    return translated;
  if (b && m.cseq < b.inviteCseq) return translated;
  if (!b) {
    const bindings = (d.nat.sipBindings ??= []);
    if (bindings.length >= 256) {
      e.drop(d, 'SIP ALG: limite de diálogos.');
      return;
    }
    let port = 49152 + (e.state.sequence % 16384);
    while (
      bindings.some((v) => v.global === translated.src && v.globalPort === port) ||
      d.nat.bindings.some((v) => v.global === translated.src && v.globalToken === String(port))
    )
      port = port === 65535 ? 49152 : port + 1;
    b = {
      id: e.id('sip-alg'),
      call: m.callId,
      inviteCseq: m.cseq,
      inside: original.src,
      global: translated.src,
      insidePort: m.media.port,
      globalPort: port,
      controlInside: original.sourcePort,
      controlGlobal: translated.sourcePort,
      remote: original.dst,
      controlRemote: original.destinationPort,
      input: input.id,
      output: output.id,
      expiresAt: 0,
    };
    bindings.push(b);
  }
  if (m.cseq > b.inviteCseq) {
    b.inviteCseq = m.cseq;
    b.insidePort = m.media.port;
    delete b.remoteMedia;
  } else if (m.media.port !== b.insidePort) return translated;
  touch(e, d, b);
  e.emit('NAT_TRANSLATED', d.id, `SIP ALG: SDP ${b.inside}:${b.insidePort} → ${b.global}:${b.globalPort}.`);
  return {
    ...translated,
    payload: {
      protocol: 'SIP' as const,
      message: {
        ...m,
        via: b.global,
        contact: b.global,
        media: { ...m.media, address: b.global, port: b.globalPort },
      },
    },
  };
}
export function sipInbound(
  e: SimulationEngine,
  d: Device,
  port: NetworkInterface,
  p: Packet
): Packet | undefined {
  if (!d.nat?.enabled || !d.nat.algSip || port.natRole !== 'outside' || p.protocol !== 'UDP') return;
  if (p.payload.protocol === 'RTP') {
    const id = p.payload.message.callId;
    const b = d.nat.sipBindings?.find(
      (b) =>
        b.call === id &&
        b.expiresAt > e.state.clock &&
        b.global === p.dst &&
        b.globalPort === p.destinationPort &&
        b.remote === p.src &&
        b.remoteMedia === p.sourcePort &&
        b.output === port.id
    );
    if (b) {
      touch(e, d, b);
      return { ...p, dst: b.inside, destinationPort: b.insidePort };
    }
  }
  if (p.payload.protocol === 'SIP') {
    const m = p.payload.message;
    const b = d.nat.sipBindings?.find(
      (b) =>
        b.call === m.callId &&
        b.expiresAt > e.state.clock &&
        b.global === p.dst &&
        b.controlGlobal === p.destinationPort &&
        b.remote === p.src &&
        b.controlRemote === p.sourcePort &&
        b.output === port.id
    );
    if (
      b &&
      m.method === 'INVITE' &&
      m.status === 200 &&
      m.cseq === b.inviteCseq &&
      m.media?.address === p.src
    ) {
      b.remoteMedia = m.media.port;
      touch(e, d, b);
    }
    if (b && m.method === 'BYE' && !m.status && m.cseq > b.inviteCseq) remove(e, d, b);
  }
}
export function sipRelated(
  d: Device,
  input: NetworkInterface,
  output: NetworkInterface,
  p: Packet,
  clock: number
) {
  if (!d.nat?.algSip || p.protocol !== 'UDP' || p.payload.protocol !== 'RTP') return false;
  const id = p.payload.message.callId;
  return (
    d.nat.sipBindings?.some(
      (b) =>
        b.call === id &&
        b.expiresAt > clock &&
        ((b.inside === p.src &&
          b.insidePort === p.sourcePort &&
          b.remote === p.dst &&
          b.remoteMedia === p.destinationPort &&
          b.input === input.id &&
          b.output === output.id) ||
          (b.inside === p.dst &&
            b.insidePort === p.destinationPort &&
            b.remote === p.src &&
            b.remoteMedia === p.sourcePort &&
            b.input === output.id &&
            b.output === input.id)) &&
        d.firewall?.sessions.some(
          (s) =>
            s.protocol === 'UDP' &&
            s.expiresAt > clock &&
            s.clientIp === b.inside &&
            s.clientPort === b.controlInside &&
            s.serverIp === b.remote &&
            s.serverPort === b.controlRemote &&
            s.inside === b.input &&
            s.outside === b.output
        )
    ) ?? false
  );
}
export function expireSipAlg(e: SimulationEngine, a: Extract<Action, { kind: 'sip-alg-expire' }>) {
  const d = e.device(a.device),
    b = d.nat?.sipBindings?.find((b) => b.id === a.id && b.expiresAt === a.expiresAt);
  if (b) remove(e, d, b);
}
export function validateSipAlg(s: Snapshot) {
  const used = new Set<object>();
  for (const d of s.devices) {
    const ids = new Set<string>(),
      ports = new Set<string>();
    for (const b of d.nat?.sipBindings ?? []) {
      const key = b.global + ':' + b.globalPort;
      if (
        !d.nat?.enabled ||
        !d.nat.algSip ||
        ids.has(b.id) ||
        ports.has(key) ||
        d.interfaces.find((p) => p.id === b.input)?.natRole !== 'inside' ||
        d.interfaces.find((p) => p.id === b.output)?.natRole !== 'outside' ||
        b.expiresAt <= s.clock
      )
        throw new Error('Binding SIP ALG inválido.');
      ids.add(b.id);
      ports.add(key);
      const q = s.queue.filter(
        (q) => q.action.kind === 'sip-alg-expire' && q.action.device === d.id && q.action.id === b.id
      );
      if (
        q.length !== 1 ||
        q[0].at !== b.expiresAt ||
        q[0].action.kind !== 'sip-alg-expire' ||
        q[0].action.expiresAt !== b.expiresAt
      )
        throw new Error('SIP ALG sem timer.');
      used.add(q[0].action);
    }
  }
  for (const q of s.queue)
    if (q.action.kind === 'sip-alg-expire' && !used.has(q.action)) throw new Error('Timer SIP ALG órfão.');
}
