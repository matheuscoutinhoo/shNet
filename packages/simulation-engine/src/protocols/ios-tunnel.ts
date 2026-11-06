import type { SimulationEngine } from '../core/engine';
import { protocolDevices, invalidateProtocolIndex } from '../core/protocol-index';
import {
  interfaceSchema,
  packetSchema,
  type Action,
  type Device,
  type Frame,
  type NetworkInterface,
  type Packet,
  type Snapshot,
  type UdpPacket,
} from '../model';
import type { CryptoConfig, IkeMessage, IosTunnel, TunnelSa } from './ios-tunnel-model';
import { deriveSecret, hashHex, hmacHex, keyShare, openRecord, sealRecord } from './security-crypto';
import { interfaceOperational } from './layer3';
import { ipNumber, receiveIp, resolveRoute } from './ipv4';
import { permitPacket } from './acl';

type Tick = Extract<Action, { kind: 'ios-tunnel-tick' }>;
type Gre = Extract<Packet, { protocol: 'GRE' }>;
type Esp = Extract<Packet, { protocol: 'ESP' }>;
const IKE_PORT = 500;
const IKE_RETRY_MS = 5000;
const IKE_LIFETIME_S = 86400;
const IPSEC_LIFETIME_S = 3600;
const REKEY_BEFORE_MS = 60000;
// GRE: 20-byte outer IPv4 header plus 4 bytes of GRE header (8 with a key).
const GRE_OVERHEAD = 24;
// ESP tunnel/transport overhead with AES and an HMAC/ICV: header, IV, padding, trailer and ICV.
const ESP_OVERHEAD = 58;
export const TUNNEL_BANDWIDTH_KBPS = 100;

export const ipLiteral = (value: string) => /^\d+\.\d+\.\d+\.\d+$/.test(value);
export function tunnelSourcePort(d: Device, t: IosTunnel) {
  if (!t.source) return undefined;
  return ipLiteral(t.source)
    ? d.interfaces.find((p) => p.ip === t.source && !p.iosTunnel)
    : d.interfaces.find((p) => p.name.toLowerCase() === t.source!.toLowerCase());
}
export function tunnelSourceIp(d: Device, t: IosTunnel) {
  return t.source && ipLiteral(t.source) ? t.source : tunnelSourcePort(d, t)?.ip;
}
/** IPsec protects the tunnel: a VTI, or GRE with "tunnel protection ipsec profile". */
export const protectedTunnel = (t: IosTunnel) => t.mode === 'ipsec' || !!t.protection;
/** IOS default MTU of a tunnel interface: the transport MTU less encapsulation overhead. */
export function defaultTunnelMtu(t: Pick<IosTunnel, 'mode' | 'key' | 'protection'>) {
  if (t.mode === 'ipsec') return 1500 - ESP_OVERHEAD - 4;
  return 1500 - GRE_OVERHEAD - (t.key !== undefined ? 4 : 0) - (t.protection ? ESP_OVERHEAD : 0);
}

/** "interface TunnelN": a point-to-point GRE tunnel until its mode is changed. */
export function addTunnelInterface(e: SimulationEngine, d: Device, number: number) {
  if (!['router', 'switch'].includes(d.type)) throw new Error('Tunnel interfaces need a router or switch.');
  if (!Number.isInteger(number) || number < 0 || number > 65535) throw new Error('Tunnel number is 0-65535.');
  const name = 'Tunnel' + number,
    existing = d.interfaces.find((p) => p.name === name);
  if (existing) return existing;
  if (d.interfaces.length >= 48) throw new Error('Limite de 48 interfaces.');
  const used = new Set(e.state.devices.flatMap((x) => x.interfaces.map((p) => p.mac)));
  let suffix = 0,
    mac: string;
  do {
    mac =
      d.interfaces[0].mac.split(':').slice(0, 4).join(':') +
      ':07:' +
      (suffix++).toString(16).padStart(2, '0');
  } while (used.has(mac));
  const tunnel: IosTunnel = {
    mode: 'gre',
    status: 'down',
    reason: 'no tunnel source',
    token: e.id('ios-tunnel'),
  };
  const p = interfaceSchema.parse({
    id: e.id('tunnel-if'),
    name,
    mac,
    mode: 'routed',
    media: 'rj45',
    adminUp: true,
    speed: 1000,
    duplex: 'full',
    mtu: defaultTunnelMtu(tunnel),
    accessVlan: 1,
    nativeVlan: 1,
    allowedVlans: [1],
    rx: 0,
    tx: 0,
    errors: 0,
    description: '',
    iosTunnel: tunnel,
  });
  d.interfaces.push(p);
  invalidateProtocolIndex(e.state);
  e.emit('CONFIG_CHANGED', d.id, '%LINK-3-UPDOWN: Interface ' + name + ', changed state to up', {
    port: p.id,
  });
  return p;
}

/** Why the tunnel cannot carry traffic, before keepalives and IPsec are considered. */
function transportProblem(s: Snapshot, d: Device, p: NetworkInterface) {
  const t = p.iosTunnel!;
  if (!d.power) return 'device is powered off';
  if (!p.adminUp) return 'administratively down';
  if (!t.source) return 'no tunnel source';
  const source = tunnelSourcePort(d, t);
  if (!source?.ip || source.iosTunnel || !interfaceOperational(s, d, source))
    return 'tunnel source ' + t.source + ' is down or has no address';
  if (!t.destination) return 'no tunnel destination';
  const route = resolveRoute(d, t.destination, source.vrf, s);
  if (!route) return 'no route to the tunnel destination ' + t.destination;
  // %TUN-5-RECURDOWN: the transport must not depend on a tunnel.
  if (route.port.iosTunnel || route.port.tunnel) return 'recursive routing to the tunnel destination';
  return undefined;
}
function lineProblem(s: Snapshot, d: Device, p: NetworkInterface) {
  const t = p.iosTunnel!;
  return (
    transportProblem(s, d, p) ??
    (t.keepalive && (t.keepaliveMisses ?? 0) >= t.keepalive.retries
      ? 'keepalives not answered by ' + t.destination
      : t.mode === 'ipsec' && t.sa?.phase !== 'established'
        ? 'no IPsec security association with ' + t.destination
        : undefined)
  );
}
function updateStatus(e: SimulationEngine, d: Device, p: NetworkInterface) {
  const t = p.iosTunnel!,
    reason = lineProblem(e.state, d, p),
    status = reason ? 'down' : 'up';
  if (reason) t.reason = reason;
  else delete t.reason;
  if (status === t.status) return;
  t.status = status;
  e.emit(
    status === 'up' ? 'LINK_UP' : 'LINK_DOWN',
    d.id,
    `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${p.name}, changed state to ${status}` +
      (reason ? ' (' + reason + ')' : ''),
    { port: p.id }
  );
}
const ticking = (p: NetworkInterface) =>
  !!p.iosTunnel && (!!p.iosTunnel.keepalive || protectedTunnel(p.iosTunnel));
function arm(e: SimulationEngine, d: Device, p: NetworkInterface, delay = 1000) {
  const t = p.iosTunnel!;
  if (t.tickAt !== undefined || !ticking(p)) return;
  t.tickAt = e.state.clock + delay;
  e.scheduleAt(t.tickAt, { kind: 'ios-tunnel-tick', device: d.id, port: p.id, token: t.token });
}
/** Re-evaluates line protocol and timers of every IOS tunnel (routes and links change it). */
export function refreshIosTunnels(e: SimulationEngine) {
  for (const d of protocolDevices(e.state, 'ios-tunnel'))
    for (const p of d.interfaces) {
      const t = p.iosTunnel;
      if (!t) continue;
      if (t.sa && transportProblem(e.state, d, p)) clearSa(e, d, p, 'transport lost');
      updateStatus(e, d, p);
      arm(e, d, p, 1);
    }
}
/** A configuration change restarts the tunnel: SAs, keepalive counters and timers. */
export function resetIosTunnel(e: SimulationEngine, d: Device, p: NetworkInterface) {
  const t = p.iosTunnel!;
  e.state.queue = e.state.queue.filter(
    ({ action: a }) => !(a.kind === 'ios-tunnel-tick' && a.device === d.id && a.port === p.id)
  );
  delete t.tickAt;
  delete t.sa;
  delete t.negotiation;
  delete t.previous;
  delete t.keepaliveMisses;
  delete t.keepaliveAt;
  t.token = e.id('ios-tunnel');
  invalidateProtocolIndex(e.state);
  updateStatus(e, d, p);
  arm(e, d, p, 1);
}
function clearSa(e: SimulationEngine, d: Device, p: NetworkInterface, why: string) {
  const t = p.iosTunnel!;
  if (!t.sa && !t.negotiation) return;
  delete t.sa;
  delete t.negotiation;
  delete t.previous;
  e.emit(
    'TUNNEL_STATE',
    d.id,
    `%CRYPTO-5-SESSION_STATUS: Crypto tunnel is DOWN. Peer ${t.destination}:500 (${why})`,
    {
      port: p.id,
    }
  );
}

// --- IKE / IPsec policy ---------------------------------------------------------------------------
const crypto = (d: Device): CryptoConfig | undefined => d.crypto;
function ipsecProfile(d: Device, t: IosTunnel) {
  return t.protection ? crypto(d)?.ipsecProfiles.find((x) => x.name === t.protection) : undefined;
}
const masked = (ip: string, mask: string) => (ipNumber(ip) & ipNumber(mask)) >>> 0;
const matches = (peer: string, address: string, mask: string) => masked(peer, mask) === masked(address, mask);
const maskBits = (mask: string) => ipNumber(mask).toString(2).replace(/0/g, '').length;
function ikeVersion(d: Device, t: IosTunnel): 1 | 2 {
  return ipsecProfile(d, t)?.ikev2Profile ? 2 : 1;
}
/** The pre-shared key for a peer: "crypto isakmp key" (IKEv1) or the IKEv2 profile's keyring. */
export function presharedKey(d: Device, t: IosTunnel, peer: string) {
  const c = crypto(d);
  if (!c) return undefined;
  if (ikeVersion(d, t) === 1)
    return c.isakmpKeys
      .filter((k) => matches(peer, k.address, k.mask))
      .sort((a, b) => maskBits(b.mask) - maskBits(a.mask))[0]?.key;
  const profile = c.ikev2Profiles.find((x) => x.name === ipsecProfile(d, t)!.ikev2Profile);
  if (!profile || !profile.remote.some((r) => matches(peer, r.address, r.mask))) return undefined;
  return c.ikev2Keyrings
    .find((k) => k.name === profile.keyring)
    ?.peers.filter((x) => x.address && x.key && matches(peer, x.address, x.mask ?? '255.255.255.255'))
    .sort((a, b) => maskBits(b.mask ?? '255.255.255.255') - maskBits(a.mask ?? '255.255.255.255'))[0]?.key;
}
// IOS defaults when nothing is configured: default ISAKMP suites, IKEv2 smart defaults and the
// default IPsec transform sets.
const DEFAULT_V1 = [
  'aes 256/sha512/pre-share/group16',
  'aes/sha256/pre-share/group14',
  'aes/sha/pre-share/group14',
];
const DEFAULT_V2 = ['aes-cbc-256/sha512/group19', 'aes-cbc-256/sha256/group14'];
const DEFAULT_TRANSFORMS = ['esp-aes esp-sha-hmac', 'esp-3des esp-sha-hmac'];
export function ikeProposals(d: Device, t: IosTunnel) {
  const c = crypto(d);
  if (ikeVersion(d, t) === 1) {
    const policies = [...(c?.isakmpPolicies ?? [])].sort((a, b) => a.priority - b.priority);
    return policies.length
      ? policies
          .filter((x) => x.authentication === 'pre-share')
          .map((x) => `${x.encryption}/${x.hash}/${x.authentication}/group${x.group}`)
      : DEFAULT_V1;
  }
  const proposals = (c?.ikev2Policies ?? [])
    .flatMap((policy) => policy.proposals)
    .flatMap((name) => c?.ikev2Proposals.filter((x) => x.name === name) ?? []);
  const combos = proposals.flatMap((x) =>
    x.encryption.flatMap((enc) =>
      x.integrity.flatMap((int) => x.groups.map((g) => `${enc}/${int}/group${g}`))
    )
  );
  return combos.length ? combos : DEFAULT_V2;
}
export function ipsecTransforms(d: Device, t: IosTunnel) {
  const c = crypto(d),
    profile = ipsecProfile(d, t);
  const sets = (profile?.transformSets ?? [])
    .map((name) => c?.transformSets.find((x) => x.name === name))
    .filter((x) => !!x)
    .map((x) => [...x.transforms].sort().join(' '));
  return sets.length ? sets : DEFAULT_TRANSFORMS;
}
// The endpoint with the lower transport address initiates; the other one answers.
const initiates = (d: Device, t: IosTunnel) =>
  ipNumber(tunnelSourceIp(d, t) ?? '0.0.0.0') < ipNumber(t.destination ?? '255.255.255.255');
const lifetimeS = (d: Device, t: IosTunnel) => ipsecProfile(d, t)?.lifetimeS ?? IPSEC_LIFETIME_S;
function newSa(e: SimulationEngine, d: Device, t: IosTunnel, initiator: boolean): TunnelSa {
  return {
    phase: 'init',
    version: ikeVersion(d, t),
    initiator,
    peer: t.destination!,
    spi: hashHex(e.id('ike-spi')).slice(0, 16),
    secret: hashHex(e.id('ike-dh')),
    inSpi: hashHex(e.id('esp-spi')).slice(0, 8),
    startedAt: e.state.clock,
    txSequence: 0,
    rxSequences: [],
    encaps: 0,
    decaps: 0,
  };
}
function ikeBytes(m: IkeMessage) {
  return (
    28 +
    28 +
    (m.kind === 'init'
      ? 36 * m.proposals.length + 28 * m.transforms.length + 72 + 36
      : m.kind === 'init-reply'
        ? 64 + 72 + 36
        : m.kind === 'notify'
          ? 12
          : 96)
  );
}
function sendIke(e: SimulationEngine, d: Device, p: NetworkInterface, message: IkeMessage) {
  const t = p.iosTunnel!,
    src = tunnelSourceIp(d, t);
  if (!src || !t.destination) return;
  const packet: UdpPacket = {
    protocol: 'UDP',
    src,
    dst: t.destination,
    ttl: 255,
    sourcePort: IKE_PORT,
    destinationPort: IKE_PORT,
    payload: { protocol: 'IKE', message },
    bytes: ikeBytes(message),
  };
  e.emit('TUNNEL_SENT', d.id, `IKEv${message.version} ${message.kind} to ${t.destination} (${p.name}).`, {
    port: p.id,
  });
  e.sendIp(d.id, packet);
}
const context = (version: number, initiatorSpi: string, responderSpi: string) =>
  `IKEv${version}|${initiatorSpi}|${responderSpi}`;
const proof = (master: string, role: 'I' | 'R', initiatorSpi: string, responderSpi: string) =>
  hmacHex(master, role + '|' + initiatorSpi + '|' + responderSpi).slice(0, 64);
function startIke(e: SimulationEngine, d: Device, p: NetworkInterface) {
  const t = p.iosTunnel!;
  const sa = (t.negotiation = newSa(e, d, t, true));
  sendIke(e, d, p, {
    kind: 'init',
    version: sa.version,
    spi: sa.spi,
    proposals: ikeProposals(d, t),
    transforms: ipsecTransforms(d, t),
    keyShare: keyShare(sa.secret),
  });
}
function establish(e: SimulationEngine, d: Device, p: NetworkInterface, sa: TunnelSa) {
  const t = p.iosTunnel!;
  sa.phase = 'established';
  sa.establishedAt = e.state.clock;
  sa.expiresAt = e.state.clock + Math.min(lifetimeS(d, t), IKE_LIFETIME_S) * 1000;
  if (t.sa?.master) t.previous = { inSpi: t.sa.inSpi, master: t.sa.master, until: e.state.clock + 5000 };
  t.sa = sa;
  delete t.negotiation;
  e.emit(
    'TUNNEL_STATE',
    d.id,
    `%CRYPTO-5-SESSION_STATUS: Crypto tunnel is UP. Peer ${sa.peer}:500 IKEv${sa.version} (${sa.proposal}; ${sa.transform})`,
    { port: p.id }
  );
  updateStatus(e, d, p);
}
function fail(e: SimulationEngine, d: Device, p: NetworkInterface, error: string) {
  const t = p.iosTunnel!;
  if (t.negotiation) t.negotiation.lastError = error;
  e.emit('TUNNEL_AUTH_FAILED', d.id, `${p.name}: IKE with ${t.destination} failed: ${error}.`, {
    port: p.id,
  });
}
export function receiveIke(e: SimulationEngine, d: Device, packet: UdpPacket) {
  if (packet.payload.protocol !== 'IKE') return;
  const m = packet.payload.message;
  const p = d.interfaces.find(
    (q) =>
      q.iosTunnel &&
      q.adminUp &&
      protectedTunnel(q.iosTunnel) &&
      q.iosTunnel.destination === packet.src &&
      tunnelSourceIp(d, q.iosTunnel) === packet.dst
  );
  if (!p || packet.destinationPort !== IKE_PORT) {
    e.drop(d, `IKE from ${packet.src}: no IPsec-protected tunnel to this peer.`);
    return;
  }
  const t = p.iosTunnel!;
  e.emit('TUNNEL_RECEIVED', d.id, `IKEv${m.version} ${m.kind} from ${packet.src} (${p.name}).`, {
    port: p.id,
  });
  const reply = (message: IkeMessage) => sendIke(e, d, p, message);
  if (m.kind === 'init') {
    const version = ikeVersion(d, t);
    const notify = (error: 'NO_PROPOSAL_CHOSEN' | 'NO_PEER_CONFIGURATION') => {
      fail(
        e,
        d,
        p,
        error === 'NO_PROPOSAL_CHOSEN' ? 'no acceptable proposal' : 'no pre-shared key for the peer'
      );
      reply({
        kind: 'notify',
        version: m.version,
        spi: hashHex(e.id('ike-spi')).slice(0, 16),
        peerSpi: m.spi,
        error,
      });
    };
    if (m.version !== version) return notify('NO_PROPOSAL_CHOSEN');
    const proposals = ikeProposals(d, t),
      transforms = ipsecTransforms(d, t);
    const proposal = m.proposals.find((x) => proposals.includes(x)),
      transform = m.transforms.find((x) => transforms.includes(x));
    if (!proposal || !transform) return notify('NO_PROPOSAL_CHOSEN');
    const psk = presharedKey(d, t, packet.src);
    if (!psk) return notify('NO_PEER_CONFIGURATION');
    const sa = newSa(e, d, t, false);
    Object.assign(sa, {
      phase: 'auth',
      peerSpi: m.spi,
      proposal,
      transform,
      master: deriveSecret(sa.secret, m.keyShare, psk, context(version, m.spi, sa.spi)),
    });
    t.negotiation = sa;
    reply({
      kind: 'init-reply',
      version,
      spi: sa.spi,
      peerSpi: m.spi,
      proposal,
      transform,
      keyShare: keyShare(sa.secret),
    });
    return;
  }
  const sa = t.negotiation;
  if (m.kind === 'notify') {
    if (sa && m.peerSpi === sa.spi) fail(e, d, p, m.error.toLowerCase().replace(/_/g, ' '));
    return;
  }
  if (!sa || m.peerSpi !== sa.spi) return;
  if (m.kind === 'init-reply' && sa.initiator && sa.phase === 'init') {
    const psk = presharedKey(d, t, packet.src);
    if (!psk) return fail(e, d, p, 'no pre-shared key for the peer');
    Object.assign(sa, {
      phase: 'auth',
      peerSpi: m.spi,
      proposal: m.proposal,
      transform: m.transform,
      master: deriveSecret(sa.secret, m.keyShare, psk, context(sa.version, sa.spi, m.spi)),
    });
    reply({
      kind: 'auth',
      version: sa.version,
      spi: sa.spi,
      peerSpi: m.spi,
      proof: proof(sa.master!, 'I', sa.spi, m.spi),
      childSpi: sa.inSpi,
    });
    return;
  }
  if (m.kind === 'auth' && !sa.initiator && sa.phase === 'auth') {
    // A different pre-shared key derives a different master secret: the proof does not verify.
    if (m.proof !== proof(sa.master!, 'I', sa.peerSpi!, sa.spi)) {
      fail(e, d, p, 'authentication failed (pre-shared key mismatch)');
      reply({
        kind: 'notify',
        version: sa.version,
        spi: sa.spi,
        peerSpi: m.spi,
        error: 'AUTHENTICATION_FAILED',
      });
      delete t.negotiation;
      return;
    }
    sa.outSpi = m.childSpi;
    reply({
      kind: 'auth-reply',
      version: sa.version,
      spi: sa.spi,
      peerSpi: m.spi,
      proof: proof(sa.master!, 'R', sa.peerSpi!, sa.spi),
      childSpi: sa.inSpi,
    });
    establish(e, d, p, sa);
    return;
  }
  if (m.kind === 'auth-reply' && sa.initiator && sa.phase === 'auth') {
    if (m.proof !== proof(sa.master!, 'R', sa.spi, sa.peerSpi!))
      return fail(e, d, p, 'authentication failed (pre-shared key mismatch)');
    sa.outSpi = m.childSpi;
    establish(e, d, p, sa);
  }
}

// --- data plane ----------------------------------------------------------------------------------
const espKey = (master: string, spi: string) => hashHex(master + '|ESP|' + spi);
function seal(e: SimulationEngine, d: Device, p: NetworkInterface, inner: Packet): Esp | undefined {
  const t = p.iosTunnel!,
    sa = t.sa;
  if (sa?.phase !== 'established' || !sa.master || !sa.outSpi) {
    e.drop(d, `${p.name}: packet dropped, no IPsec SA with ${t.destination} yet.`, p.id);
    return undefined;
  }
  const sequence = ++sa.txSequence,
    sealed = sealRecord(espKey(sa.master, sa.outSpi), 0, sequence, JSON.stringify(inner), sa.outSpi);
  sa.encaps++;
  return {
    protocol: 'ESP',
    src: tunnelSourceIp(d, t)!,
    dst: t.destination!,
    ttl: 255,
    spi: sa.outSpi,
    sequence,
    body: sealed.slice(0, -32),
    tag: sealed.slice(-32),
    bytes: Math.min(65535, inner.bytes + ESP_OVERHEAD),
  };
}
function encapsulate(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  inner: Packet,
  keepalive?: Gre['keepalive']
) {
  const t = p.iosTunnel!,
    src = tunnelSourceIp(d, t),
    dst = t.destination;
  if (!src || !dst) return;
  let outer: Packet =
    t.mode === 'gre'
      ? {
          protocol: 'GRE',
          src,
          dst,
          ttl: 255,
          ...(t.key !== undefined ? { key: t.key } : {}),
          ...(keepalive ? { keepalive } : {}),
          inner: JSON.stringify(inner),
          bytes: Math.min(65535, inner.bytes + GRE_OVERHEAD + (t.key !== undefined ? 4 : 0)),
        }
      : inner;
  if (protectedTunnel(t)) {
    const esp = seal(e, d, p, outer);
    if (!esp) return;
    outer = esp;
  }
  e.sendIp(d.id, outer);
}
/** Routed traffic leaving a tunnel interface (sendFrame): IPv4 is encapsulated towards the peer. */
export function sendIosTunnel(e: SimulationEngine, d: Device, p: NetworkInterface, frame: Frame) {
  const t = p.iosTunnel!,
    packet = frame.packet;
  if (!packet) {
    e.drop(d, `${p.name}: only IPv4 is carried over this tunnel.`, p.id, frame);
    return;
  }
  if (t.status !== 'up' || !d.power) {
    e.drop(d, `${p.name}: line protocol is down (${t.reason ?? 'down'}).`, p.id, frame);
    return;
  }
  if (packet.bytes > p.mtu) {
    e.drop(d, `${p.name}: packet of ${packet.bytes} bytes exceeds the tunnel IP MTU ${p.mtu}.`, p.id, frame);
    return;
  }
  if (!permitPacket(e, d, p, 'out', packet)) return;
  p.tx++;
  encapsulate(e, d, p, packet);
}
function deliver(e: SimulationEngine, d: Device, p: NetworkInterface, inner: Packet) {
  if (p.iosTunnel!.status !== 'up') {
    e.drop(d, `${p.name}: line protocol is down; decapsulated packet dropped.`, p.id);
    return;
  }
  p.rx++;
  receiveIp(e, d, p, inner, p.mac, true);
}
function receiveGre(e: SimulationEngine, d: Device, packet: Gre, protectedBy?: NetworkInterface) {
  const p = d.interfaces.find(
    (q) =>
      q.iosTunnel?.mode === 'gre' &&
      q.adminUp &&
      q.iosTunnel.destination === packet.src &&
      tunnelSourceIp(d, q.iosTunnel) === packet.dst &&
      q.iosTunnel.key === packet.key
  );
  if (!p) {
    e.drop(d, `GRE from ${packet.src}: no tunnel interface with this source, destination and key.`);
    return;
  }
  const t = p.iosTunnel!;
  if (t.protection && protectedBy !== p) {
    e.drop(d, `${p.name}: cleartext GRE refused on an IPsec-protected tunnel.`, p.id);
    return;
  }
  if (packet.keepalive === 'request') {
    encapsulate(e, d, p, JSON.parse(packet.inner) as Packet, 'reply');
    return;
  }
  if (packet.keepalive === 'reply') {
    t.keepaliveMisses = 0;
    updateStatus(e, d, p);
    return;
  }
  let inner: Packet;
  try {
    inner = packetSchema.parse(JSON.parse(packet.inner));
  } catch {
    e.drop(d, `${p.name}: malformed GRE passenger packet.`, p.id);
    return;
  }
  deliver(e, d, p, inner);
}
function receiveEsp(e: SimulationEngine, d: Device, packet: Esp) {
  const p = d.interfaces.find((q) => {
    const t = q.iosTunnel;
    return (
      t &&
      t.destination === packet.src &&
      ((t.sa?.inSpi === packet.spi && t.sa.phase === 'established') ||
        (t.previous?.inSpi === packet.spi && t.previous.until > e.state.clock))
    );
  });
  if (!p) {
    e.drop(
      d,
      `%CRYPTO-4-RECVD_PKT_INV_SPI: decaps: rec'd IPSEC packet has invalid spi 0x${packet.spi} from ${packet.src}.`
    );
    return;
  }
  const t = p.iosTunnel!,
    current = t.sa?.inSpi === packet.spi,
    master = current ? t.sa!.master! : t.previous!.master;
  if (current) {
    const seen = t.sa!.rxSequences,
      max = Math.max(0, ...seen);
    if (seen.includes(packet.sequence) || packet.sequence <= max - 64) {
      e.drop(d, `%CRYPTO-4-PKT_REPLAY_ERR: replay check failed on ${p.name}.`, p.id);
      return;
    }
    t.sa!.rxSequences = [...seen, packet.sequence].sort((a, b) => a - b).slice(-64);
    t.sa!.decaps++;
  }
  let inner: Packet;
  try {
    inner = packetSchema.parse(
      JSON.parse(
        openRecord(espKey(master, packet.spi), 0, packet.sequence, packet.body + packet.tag, packet.spi)
      )
    );
  } catch {
    e.drop(d, `%CRYPTO-4-RECVD_PKT_MAC_ERR: decrypt/verify failed on ${p.name}.`, p.id);
    return;
  }
  if (inner.protocol === 'GRE' && t.mode === 'gre') receiveGre(e, d, inner, p);
  else if (t.mode === 'ipsec') deliver(e, d, p, inner);
  else e.drop(d, `${p.name}: unexpected ESP passenger.`, p.id);
}
/** IP protocols 47 (GRE) and 50 (ESP) addressed to this router. */
export function receiveTunnelPacket(e: SimulationEngine, d: Device, packet: Packet) {
  if (packet.protocol === 'GRE') receiveGre(e, d, packet);
  else if (packet.protocol === 'ESP') receiveEsp(e, d, packet);
}

export function handleIosTunnelTick(e: SimulationEngine, a: Tick) {
  const d = e.device(a.device),
    p = d.interfaces.find((x) => x.id === a.port),
    t = p?.iosTunnel;
  if (!p || !t || t.token !== a.token || t.tickAt !== e.state.clock) return;
  delete t.tickAt;
  const problem = transportProblem(e.state, d, p);
  if (t.keepalive && t.mode === 'gre') {
    if (problem) delete t.keepaliveAt;
    else if (e.state.clock >= (t.keepaliveAt ?? 0)) {
      // Each keepalive counts as missed until its reply resets the counter.
      t.keepaliveMisses = Math.min(255, (t.keepaliveMisses ?? 0) + 1);
      const src = tunnelSourceIp(d, t)!;
      encapsulate(
        e,
        d,
        p,
        { protocol: 'GRE', src: t.destination!, dst: src, ttl: 255, inner: '{}', bytes: 28 },
        'request'
      );
      t.keepaliveAt = e.state.clock + t.keepalive.periodS * 1000;
    }
  }
  if (protectedTunnel(t)) {
    if (problem) clearSa(e, d, p, problem);
    else {
      if (t.sa?.expiresAt !== undefined && t.sa.expiresAt <= e.state.clock) {
        delete t.sa;
        e.emit('TUNNEL_STATE', d.id, `${p.name}: IPsec SA lifetime expired.`, { port: p.id });
      }
      const n = t.negotiation,
        rekey = !t.sa || (t.sa.expiresAt ?? Infinity) - REKEY_BEFORE_MS <= e.state.clock;
      if (initiates(d, t) && rekey && (!n || e.state.clock - n.startedAt >= IKE_RETRY_MS)) startIke(e, d, p);
      if (!initiates(d, t) && n && e.state.clock - n.startedAt >= 2 * IKE_RETRY_MS) delete t.negotiation;
    }
    if (t.previous && t.previous.until <= e.state.clock) delete t.previous;
  }
  updateStatus(e, d, p);
  arm(e, d, p);
}
export function validateIosTunnels(s: Snapshot) {
  for (const d of s.devices)
    for (const p of d.interfaces) {
      const t = p.iosTunnel;
      if (!t) continue;
      if (
        !/^Tunnel\d+$/.test(p.name) ||
        p.mode !== 'routed' ||
        p.logical ||
        p.tunnel ||
        s.links.some((l) => [l.a, l.b].some((end) => end.device === d.id && end.port === p.id)) ||
        (t.sa && (t.sa.phase !== 'established' || !t.sa.master || !t.sa.outSpi))
      )
        throw new Error('Interface Tunnel IOS inválida.');
      const ticks = s.queue.filter(
        (q) => q.action.kind === 'ios-tunnel-tick' && q.action.device === d.id && q.action.port === p.id
      );
      if (
        ticks.length !== (t.tickAt === undefined ? 0 : 1) ||
        (ticks[0] &&
          (ticks[0].at !== t.tickAt || (ticks[0].action as Tick).token !== t.token || t.tickAt! < s.clock))
      )
        throw new Error('Timer de Tunnel IOS inconsistente.');
    }
}
