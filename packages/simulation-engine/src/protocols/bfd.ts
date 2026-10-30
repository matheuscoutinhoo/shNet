import type { SimulationEngine } from '../core/engine';
import { random } from '../core/queue';
import type { Device, NetworkInterface, UdpPacket, Snapshot } from '../model';
import { interfaceOperational } from './layer3';
import { sameSubnet } from './ipv4';
import { sendWithArp } from './arp';
import { ospfBfdDown } from './ospf';
import { bgpBfdDown } from './bgp';
import { bgpNextHop } from './bgp-routing';
import { bfdConfigSchema, type BfdConfig, type BfdSession, type BfdMessage } from './bfd-model';
import { keyChainKeys, keyChainBoundary, validateKeyChains } from './key-chain';
import { bfdAuthenticator, bfdDigestMatches } from '../wire/bfd-auth';
import { encodeBfd } from '../wire/bfd-codec';
const configuration = (p: NetworkInterface) =>
  p.bfd
    ? bfdConfigSchema.parse(
        Object.fromEntries(
          Object.keys(bfdConfigSchema.shape).map((k) => [
            k,
            p.bfd![k as keyof NonNullable<NetworkInterface['bfd']>],
          ])
        )
      )
    : undefined;
const newDiscriminator = (e: SimulationEngine) => ++e.state.sequence % 4294967295 || 1;
function sendKey(e: SimulationEngine, d: Device, p: NetworkInterface) {
  const auth = p.bfd?.authentication;
  return auth ? keyChainKeys(d, auth.keyChain, 'send', e.state.clock)[0] : undefined;
}
function jitter(e: SimulationEngine, interval: number, multiplier: number) {
  return interval * (0.75 + random(e.state) * (multiplier === 1 ? 0.15 : 0.25));
}
function txInterval(p: NetworkInterface, s: BfdSession) {
  return Math.max(s.state === 'Up' ? (s.localTx ?? p.bfd!.intervalMs) : 1000, s.remoteRx);
}
function arm(e: SimulationEngine, d: Device, p: NetworkInterface) {
  const c = p.bfd;
  if (!c) return;
  e.state.queue = e.state.queue.filter(
    (q) => q.action.kind !== 'bfd-tick' || q.action.device !== d.id || q.action.port !== p.id
  );
  const boundary = c.authentication
    ? keyChainBoundary(d, c.authentication.keyChain, e.state.clock)
    : undefined;
  const deadlines = c.sessions.flatMap((s) => [s.nextAt, ...(s.deadline !== undefined ? [s.deadline] : [])]);
  c.tickAt = Math.max(
    e.state.clock + 0.001,
    Math.min(
      e.state.clock + (c.sessions.length ? 1000 : Math.min(c.intervalMs, 500)),
      ...deadlines,
      ...(boundary !== undefined ? [boundary] : [])
    )
  );
  e.scheduleAt(c.tickAt, { kind: 'bfd-tick', device: d.id, port: p.id, token: c.token });
}
function transmit(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  s: BfdSession,
  flags: { final?: boolean; state?: BfdMessage['state'] } = {}
) {
  const c = p.bfd!,
    key = sendKey(e, d, p);
  if (!p.ip || !interfaceOperational(e.state, d, p) || (c.authentication && !key)) return false;
  const m: BfdMessage = {
    state: flags.state ?? s.state,
    my: s.my,
    your: s.remote,
    desiredTx: (s.state === 'Up' ? c.intervalMs : 1000) * 1000,
    requiredRx: c.minRxMs * 1000,
    multiplier: c.multiplier,
    ...(s.diagnostic ? { diagnostic: s.diagnostic } : {}),
    ...(flags.final ? { final: true } : s.polling ? { poll: true } : {}),
  };
  if (c.authentication && key) {
    const size = c.authentication.type.includes('md5') ? 16 : 20;
    s.authSequence ??= Math.floor(random(e.state) * 0x100000000);
    s.authSequence = (s.authSequence + 1) >>> 0;
    m.authentication = {
      type: c.authentication.type,
      keyId: key.id,
      sequence: s.authSequence,
      digest: '00'.repeat(size),
    };
    m.authentication.digest = bfdAuthenticator(m, key.keyString!);
  }
  const packet: UdpPacket = {
    protocol: 'UDP',
    src: p.ip,
    dst: s.ip,
    ttl: 255,
    sourcePort: 49152 + (s.my % 16384),
    destinationPort: 3784,
    bytes: 28 + encodeBfd(m).length,
    payload: { protocol: 'BFD', message: m },
  };
  sendWithArp(e, d, p, s.ip, packet);
  s.sent++;
  if (!flags.final) {
    s.lastSent = e.state.clock;
    s.nextAt = e.state.clock + jitter(e, txInterval(p, s), c.multiplier);
  }
  return true;
}
function down(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  s: BfdSession,
  diagnostic = 1,
  reason = 'Control detection time expired'
) {
  if (s.state === 'Up' && s.hadUp) {
    e.emit('CONFIG_CHANGED', d.id, `BFD session Down: ${s.ip}; ${reason}.`, { port: p.id });
    if (p.bfd?.ospf && s.clients.includes('ospf')) ospfBfdDown(e, d, p.id, s.ip);
    if (s.clients.includes('bgp')) bgpBfdDown(e, d, p.id, s.ip);
  }
  s.state = 'Down';
  s.remote = 0;
  s.remoteRx = 1000;
  s.remoteTx = 1000;
  s.diagnostic = diagnostic;
  s.polling = false;
  s.localTx = p.bfd!.intervalMs;
  s.localRx = p.bfd!.minRxMs;
  delete s.deadline;
  s.nextAt = e.state.clock;
}
function clients(e: SimulationEngine, d: Device, p: NetworkInterface) {
  const c = p.bfd!,
    desired = new Map<string, Set<'ospf' | 'bgp'>>();
  const add = (ip: string, client: 'ospf' | 'bgp') => {
    if (!p.ip || p.prefix === undefined || ip === p.ip || !sameSubnet(p.ip, ip, p.prefix)) return;
    let set = desired.get(ip);
    if (!set) {
      set = new Set();
      desired.set(ip, set);
    }
    set.add(client);
  };
  if (c.ospf && d.ospf?.enabled && d.ospf.interfaces.some((i) => i.port === p.id && !i.passive)) {
    for (const n of d.ospf.neighbors.filter((n) => n.port === p.id)) add(n.ip, 'ospf');
    for (const s of c.sessions) if (s.clients.includes('ospf') || s.clients.length === 0) add(s.ip, 'ospf');
  }
  if (d.bgp?.enabled)
    for (const n of d.bgp.neighbors.filter((n) => n.bfd)) {
      const route = bgpNextHop(d, n.ip, e.state),
        existing = c.sessions.find((s) => s.ip === n.ip && s.clients.includes('bgp'));
      if ((route?.port.id === p.id && route.nextHop === n.ip) || (!route && existing)) add(n.ip, 'bgp');
    }
  return desired;
}
function reconcile(e: SimulationEngine, d: Device, p: NetworkInterface) {
  const c = p.bfd!,
    desired = clients(e, d, p),
    hasKey = !c.authentication || !!sendKey(e, d, p);
  for (const s of [...c.sessions]) {
    const wanted = desired.get(s.ip);
    if (!wanted) {
      transmit(e, d, p, s, { state: 'AdminDown' });
      down(e, d, p, s, 7, 'Routing client removed');
      c.sessions = c.sessions.filter((v) => v !== s);
    } else {
      s.clients = [...wanted].sort();
      s.localTx ??= c.intervalMs;
      s.localRx ??= c.minRxMs;
      s.receivedAuth ??= [];
    }
  }
  if (hasKey)
    for (const [ip, wanted] of desired)
      if (!c.sessions.some((s) => s.ip === ip) && c.sessions.length < 32)
        c.sessions.push({
          ip,
          my: newDiscriminator(e),
          remote: 0,
          state: 'Down',
          hadUp: false,
          clients: [...wanted].sort(),
          localTx: c.intervalMs,
          localRx: c.minRxMs,
          nextAt: e.state.clock,
          remoteTx: 1000,
          remoteRx: 1000,
          sent: 0,
          received: 0,
          receivedAuth: [],
        });
}
export function configureBfd(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  input?:
    BfdConfig | { intervalMs: number; minRxMs: number; multiplier: number; ospf?: boolean; template?: string }
) {
  if (
    p.mode !== 'routed' ||
    p.vrf ||
    p.loopback ||
    p.tunnel ||
    p.vxlan ||
    ['wifi', 'serial', 'console', 'mesh'].includes(p.media)
  )
    throw new Error('BFD requires a routed IPv4 Ethernet underlay interface.');
  const old = p.bfd,
    owned =
      old &&
      (old.tickAt === e.state.clock ||
        e.state.queue.some(
          (q) =>
            q.action.kind === 'bfd-tick' &&
            q.action.device === d.id &&
            q.action.port === p.id &&
            q.action.token === old.token
        ));
  if (!input) {
    if (old)
      for (const s of old.sessions) {
        transmit(e, d, p, s, { state: 'AdminDown' });
        down(e, d, p, s, 7, 'BFD administratively disabled');
      }
    delete p.bfd;
    e.state.queue = e.state.queue.filter(
      (q) => q.action.kind !== 'bfd-tick' || q.action.device !== d.id || q.action.port !== p.id
    );
    return;
  }
  const template = input.template ? d.bfdTemplates?.find((t) => t.name === input.template) : undefined;
  if (input.template && !template) throw new Error('BFD template is not configured.');
  const c = bfdConfigSchema.parse(
    Object.fromEntries(
      Object.keys(bfdConfigSchema.shape).map((k) => [
        k,
        (template && ['intervalMs', 'minRxMs', 'multiplier', 'authentication'].includes(k)
          ? template
          : input)[k as keyof typeof input],
      ])
    )
  );
  c.ospf = input.ospf ?? old?.ospf ?? false;
  if (c.authentication && !c.template)
    throw new Error('IOS BFD authentication requires a single-hop template.');
  const changedAuth = JSON.stringify(old?.authentication) !== JSON.stringify(c.authentication),
    sessions = owned ? old!.sessions : [];
  if (old && owned && changedAuth)
    for (const s of sessions) {
      transmit(e, d, p, s, { state: 'AdminDown' });
      down(e, d, p, s, 7, 'Authentication configuration changed');
      s.my = newDiscriminator(e);
      delete s.authSequence;
      s.receivedAuth = [];
    }
  for (const s of sessions) {
    if (s.state === 'Up' && old && (old.intervalMs !== c.intervalMs || old.minRxMs !== c.minRxMs)) {
      s.localTx = Math.min(s.localTx ?? old.intervalMs, c.intervalMs);
      s.localRx = Math.max(s.localRx ?? old.minRxMs, c.minRxMs);
      s.polling = true;
    } else if (s.state !== 'Up') {
      s.localTx = c.intervalMs;
      s.localRx = c.minRxMs;
    }
  }
  p.bfd = { ...c, token: owned ? old!.token : e.id('bfd'), sessions, tickAt: e.state.clock + 0.001 };
  reconcile(e, d, p);
  arm(e, d, p);
}
export function refreshBfdTemplates(e: SimulationEngine, d: Device) {
  for (const p of d.interfaces)
    if (p.bfd?.template) {
      const c = configuration(p)!;
      configureBfd(e, d, p, c);
    }
}
export function bfdTick(e: SimulationEngine, d: Device, p: NetworkInterface, token: string) {
  const c = p.bfd;
  if (!c || c.token !== token) return;
  reconcile(e, d, p);
  const usable = !!p.ip && interfaceOperational(e.state, d, p),
    hasKey = !c.authentication || !!sendKey(e, d, p);
  for (const s of c.sessions) {
    if (!usable || !hasKey) {
      down(
        e,
        d,
        p,
        s,
        hasKey ? 5 : 7,
        hasKey ? 'Interface unavailable' : 'No active authentication send key'
      );
      s.nextAt = e.state.clock + 1000;
      continue;
    }
    if (s.deadline !== undefined && s.deadline <= e.state.clock) down(e, d, p, s);
    if (
      s.lastReceived !== undefined &&
      e.state.clock - s.lastReceived >=
        2 * (s.remoteMultiplier ?? c.multiplier) * Math.max(s.localRx ?? c.minRxMs, s.remoteTx)
    )
      s.receivedAuth = [];
    if (s.remoteRx === 0) {
      s.nextAt = e.state.clock + 1000;
      continue;
    }
    if (s.nextAt <= e.state.clock) transmit(e, d, p, s);
  }
  arm(e, d, p);
}
function authenticate(e: SimulationEngine, d: Device, p: NetworkInterface, s: BfdSession, m: BfdMessage) {
  const c = p.bfd!,
    auth = m.authentication;
  if (!c.authentication) return !auth;
  if (!auth || auth.type !== c.authentication.type) return false;
  const key = keyChainKeys(d, c.authentication.keyChain, 'accept', e.state.clock).find(
    (k) => k.id === auth.keyId
  );
  if (!key || !bfdDigestMatches(auth.digest, bfdAuthenticator(m, key.keyString!))) return false;
  const old = s.receivedAuth.find((a) => a.keyId === auth.keyId),
    known =
      old &&
      e.state.clock - old.at <
        2 * (s.remoteMultiplier ?? c.multiplier) * Math.max(s.localRx ?? c.minRxMs, s.remoteTx);
  if (known) {
    const advance = (auth.sequence - old.sequence) >>> 0;
    if (advance > 3 * m.multiplier || (auth.type.startsWith('meticulous') && advance === 0)) return false;
  }
  s.receivedAuth = [
    ...s.receivedAuth.filter((a) => a.keyId !== auth.keyId),
    { keyId: auth.keyId, sequence: auth.sequence, at: e.state.clock },
  ];
  return true;
}
export function receiveBfd(e: SimulationEngine, d: Device, p: NetworkInterface, packet: UdpPacket) {
  const c = p.bfd;
  if (
    !c ||
    packet.payload.protocol !== 'BFD' ||
    packet.ttl !== 255 ||
    packet.destinationPort !== 3784 ||
    packet.sourcePort < 49152 ||
    packet.sourcePort > 65535 ||
    packet.dst !== p.ip ||
    !p.ip ||
    p.prefix === undefined ||
    !sameSubnet(p.ip, packet.src, p.prefix) ||
    !interfaceOperational(e.state, d, p)
  )
    return;
  const m = packet.payload.message;
  if (
    !m.my ||
    (m.poll && m.final) ||
    packet.bytes !== 28 + encodeBfd(m).length ||
    (!m.your && !['Down', 'AdminDown'].includes(m.state))
  )
    return;
  reconcile(e, d, p);
  const s = m.your ? c.sessions.find((s) => s.my === m.your) : c.sessions.find((s) => s.ip === packet.src);
  if (!s || s.ip !== packet.src || !authenticate(e, d, p, s, m)) return;
  const old = s.state,
    oldRx = s.remoteRx;
  s.received++;
  s.remote = m.my;
  s.remoteTx = m.desiredTx / 1000;
  s.remoteRx = m.requiredRx / 1000;
  s.remoteMultiplier = m.multiplier;
  s.lastReceived = e.state.clock;
  if (m.final && s.polling) {
    s.polling = false;
    s.localTx = c.intervalMs;
    s.localRx = c.minRxMs;
  }
  if (m.state === 'AdminDown' || (old === 'Up' && m.state === 'Down'))
    down(e, d, p, s, 3, 'Neighbor signaled session Down');
  else if (old === 'Down' && m.state === 'Down') s.state = 'Init';
  else if (
    (old === 'Down' && m.state === 'Init') ||
    (old === 'Init' && (m.state === 'Init' || m.state === 'Up'))
  )
    s.state = 'Up';
  if (s.state === 'Up') {
    s.hadUp = true;
    s.diagnostic = 0;
    if (old !== 'Up') {
      s.localTx = c.intervalMs;
      s.localRx = c.minRxMs;
      s.polling = true;
      e.emit('CONFIG_CHANGED', d.id, 'BFD session Up: ' + s.ip, { port: p.id });
    }
  }
  if (s.state !== 'Down')
    s.deadline = e.state.clock + m.multiplier * Math.max(s.localRx ?? c.minRxMs, s.remoteTx);
  if (old !== s.state || s.remoteRx < oldRx || m.final)
    s.nextAt = Math.min(
      s.nextAt,
      Math.max(e.state.clock, (s.lastSent ?? e.state.clock) + jitter(e, txInterval(p, s), c.multiplier))
    );
  if (m.poll) transmit(e, d, p, s, { final: true });
  arm(e, d, p);
}
export function bfdPeerAvailable(d: Device, ip: string, strict = false) {
  const sessions = d.interfaces.flatMap(
    (p) => p.bfd?.sessions.filter((s) => s.ip === ip && s.clients.includes('bgp')) ?? []
  );
  return strict ? sessions.some((s) => s.state === 'Up') : !sessions.some((s) => s.hadUp && s.state !== 'Up');
}
export function validateBfd(s: Snapshot) {
  for (const d of s.devices) {
    validateKeyChains(d);
    if (new Set(d.bfdTemplates?.map((t) => t.name)).size !== (d.bfdTemplates?.length ?? 0))
      throw new Error('Duplicate BFD template.');
    for (const p of d.interfaces) {
      const b = p.bfd;
      if (!b) continue;
      const timers = s.queue.filter(
          (q) => q.action.kind === 'bfd-tick' && q.action.device === d.id && q.action.port === p.id
        ),
        template = b.template ? d.bfdTemplates?.find((t) => t.name === b.template) : undefined;
      if (
        p.mode !== 'routed' ||
        p.vrf ||
        p.loopback ||
        timers.length !== 1 ||
        timers[0].at !== b.tickAt ||
        timers[0].action.kind !== 'bfd-tick' ||
        timers[0].action.token !== b.token ||
        new Set(b.sessions.map((v) => v.ip)).size !== b.sessions.length ||
        new Set(b.sessions.map((v) => v.my)).size !== b.sessions.length ||
        (b.template && !template) ||
        (b.authentication && !b.template) ||
        (template &&
          (['intervalMs', 'minRxMs', 'multiplier', 'authentication'] as const).some(
            (k) => JSON.stringify(b[k]) !== JSON.stringify(template[k])
          ))
      )
        throw new Error('Invalid BFD configuration, template or timer.');
      if (b.authentication) {
        const size = b.authentication.type.includes('md5') ? 16 : 20;
        if (
          d.keyChains
            ?.find((c) => c.name === b.authentication!.keyChain)
            ?.keys.some(
              (k) => k.id <= 255 && k.keyString && new TextEncoder().encode(k.keyString).length > size
            )
        )
          throw new Error('BFD authentication key exceeds digest length.');
      }
      for (const session of b.sessions)
        if (
          !session.my ||
          session.ip === p.ip ||
          new Set(session.clients).size !== session.clients.length ||
          (session.lastSent !== undefined && session.lastSent > s.clock) ||
          (session.lastReceived !== undefined && session.lastReceived > s.clock) ||
          session.receivedAuth.some((a) => a.at > s.clock) ||
          new Set(session.receivedAuth.map((a) => a.keyId)).size !== session.receivedAuth.length ||
          (session.state === 'Up' &&
            (!session.hadUp ||
              !session.remote ||
              session.deadline === undefined ||
              session.deadline < s.clock)) ||
          (session.state !== 'Down' && session.deadline === undefined)
        )
          throw new Error('Invalid BFD session state.');
    }
  }
  for (const q of s.queue)
    if (
      q.action.kind === 'bfd-tick' &&
      !s.devices.some(
        (d) =>
          d.id === q.action.device &&
          d.interfaces.some((p) => p.id === q.action.port && p.bfd?.token === q.action.token)
      )
    )
      throw new Error('Orphan BFD timer.');
}
