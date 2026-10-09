import type { SimulationEngine } from '../core/engine';
import {
  frameSchema,
  interfaceSchema,
  LIMITS,
  type Action,
  type Device,
  type Frame,
  type NetworkInterface,
  type UdpPacket,
} from '../model';
import { tunnelConfigSchema, tunnelMessageSchema } from './tunnel-model';
import { hashHex, hmacHex, keyShare, deriveSecret, sealRecord, openRecord } from './security-crypto';
import { resolveUnderlay } from './underlay';
import { sendWithArp } from './arp';
import { interfaceOperational } from './layer3';
import { receiveIp, sameSubnet, subnet } from './ipv4';
import { receiveIp6 } from './ipv6';
import { permitPacket } from './acl';
type Message = Extract<UdpPacket['payload'], { protocol: 'TUNNEL' }>['message'];
export function tunnelConfig(p: NetworkInterface) {
  if (!p.tunnel) throw new Error('Interface sem túnel.');
  return tunnelConfigSchema.parse(
    Object.fromEntries(
      Object.keys(tunnelConfigSchema.shape).map((key) => [key, p.tunnel![key as keyof typeof p.tunnel]])
    )
  );
}
function signature(key: string, m: Message) {
  const copy = { ...tunnelMessageSchema.parse(m), proof: '' };
  return hmacHex(key, JSON.stringify(copy));
}
function newIke(
  e: SimulationEngine,
  retired: string[] = []
): NonNullable<NonNullable<NetworkInterface['tunnel']>['ike']> {
  return {
    phase: 'INIT',
    secret: hashHex(e.id('ike-dh')),
    localSpi: hashHex(e.id('ike-spi')).slice(0, 16),
    localChildSpi: hashHex(e.id('esp-spi')).slice(0, 8),
    retired,
  };
}
function bindIke(
  e: SimulationEngine,
  t: NonNullable<NetworkInterface['tunnel']>,
  m: Extract<Message, { kind: 'hello' | 'ack' }>
) {
  const ike = (t.ike ??= newIke(e));
  if (ike.retired.includes(m.session)) throw new Error('IKE SA antiga foi retirada.');
  if (t.peerNonce && t.peerNonce !== m.session) {
    ike.retired = [...ike.retired, t.peerNonce].slice(-16);
    t.txSequence = 0;
    t.receivedSequences = [];
    delete ike.expiresAt;
    ike.phase = 'INIT';
    t.status = 'negotiating';
  }
  const binding = [
    t.token + '|' + keyShare(ike.secret) + '|' + ike.localSpi,
    m.session + '|' + m.keyShare + '|' + m.ikeSpi,
  ]
    .sort()
    .join('|');
  ike.master = deriveSecret(ike.secret, m.keyShare, t.key, 'IKEv2|' + binding);
  ike.peerShare = m.keyShare;
  ike.peerSpi = m.ikeSpi;
  ike.peerChildSpi = m.childSpi;
  ike.phase = ike.phase === 'ESTABLISHED' ? 'ESTABLISHED' : 'AUTH';
  t.peerNonce = m.session;
}
function negotiation(
  t: NonNullable<NetworkInterface['tunnel']>,
  kind: 'hello' | 'ack',
  nonce: string
): Extract<Message, { kind: 'hello' | 'ack' }> {
  const ike = t.ike!;
  return {
    kind,
    session: t.token,
    channel: t.channel,
    nonce,
    proof: '00'.repeat(32),
    proposal: 'X25519/AES256GCM/SHA256',
    keyShare: keyShare(ike.secret),
    ikeSpi: ike.localSpi,
    childSpi: ike.localChildSpi,
    prefixes: structuredClone(t.advertise),
  };
}
function authentication(
  t: NonNullable<NetworkInterface['tunnel']>,
  kind: 'auth' | 'auth-ack',
  nonce: string
): Extract<Message, { kind: 'auth' | 'auth-ack' }> {
  return {
    kind,
    session: t.token,
    channel: t.channel,
    nonce,
    proof: '00'.repeat(32),
    ikeSpi: t.ike!.localSpi,
    childSpi: t.ike!.localChildSpi,
    prefixes: structuredClone(t.advertise),
  };
}
function selectors(t: NonNullable<NetworkInterface['tunnel']>, frame: Frame, outgoing: boolean) {
  if (!frame.packet) return !!frame.ipv6; // IPv6 selectors are interface scope; no IPv4 prefix applies to it.
  const source = outgoing ? t.advertise : t.remotePrefixes,
    destination = outgoing ? t.remotePrefixes : t.advertise;
  return (
    (frame.packet.src === (outgoing ? t.ip : t.peerIp) ||
      source.some((r) => sameSubnet(frame.packet!.src, r.network, r.prefix))) &&
    (frame.packet.dst === (outgoing ? t.peerIp : t.ip) ||
      destination.some((r) => sameSubnet(frame.packet!.dst, r.network, r.prefix)))
  );
}
export function tunnelMetrics(p: NetworkInterface) {
  const samples = p.tunnel?.samples ?? [],
    success = samples.filter((s) => s.success);
  return {
    rtt: success.length ? success.reduce((sum, s) => sum + s.rtt!, 0) / success.length : Infinity,
    loss: samples.length ? ((samples.length - success.length) * 100) / samples.length : 100,
  };
}
function setState(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  status: 'down' | 'negotiating' | 'up',
  reason: string
) {
  if (p.tunnel!.status !== status) {
    p.tunnel!.status = status;
    e.emit('TUNNEL_STATE', d.id, p.name + ': ' + reason, { port: p.id });
  }
}
export function configureTunnel(e: SimulationEngine, d: Device, input: unknown) {
  const c = tunnelConfigSchema.parse(input),
    underlay = d.interfaces.find((p) => p.id === c.underlay);
  if (
    d.type !== 'router' ||
    !underlay ||
    underlay.tunnel ||
    underlay.vxlan ||
    underlay.channel ||
    underlay.mode !== 'routed' ||
    underlay.vrf ||
    !underlay.ip ||
    underlay.prefix === undefined
  )
    throw new Error('Túnel exige roteador e underlay IPv4 routed na tabela padrão.');
  if (
    c.ip === c.peerIp ||
    !sameSubnet(c.ip, c.peerIp, c.prefix) ||
    c.remote === underlay.ip ||
    c.advertise.some((r) => subnet(r.network, r.prefix).network !== r.network)
  )
    throw new Error('Endereços/prefixos do túnel inválidos.');
  let p = d.interfaces.find((p) => p.tunnel?.number === c.number);
  if (
    d.interfaces.some(
      (p) =>
        p.tunnel &&
        p !== d.interfaces.find((p) => p.tunnel?.number === c.number) &&
        p.tunnel.channel === c.channel &&
        p.tunnel.remote === c.remote
    )
  )
    throw new Error('Canal/peer de túnel duplicados.');
  if (!p) {
    if (d.interfaces.length >= 48) throw new Error('Limite de interfaces.');
    const base = d.interfaces[0];
    p = interfaceSchema.parse({
      ...base,
      id: 'tun' + c.number,
      name: 'Tunnel' + c.number,
      mac: base.mac.split(':').slice(0, 4).join(':') + ':04:' + c.number.toString(16).padStart(2, '0'),
      media: 'rj45',
      transceiver: undefined,
      dot1x: undefined,
      supplicant: undefined,
      logical: undefined,
      qos: undefined,
      vxlan: undefined,
      aggregate: undefined,
      channel: undefined,
      ipv6: undefined,
      ip: undefined,
      prefix: undefined,
      ipv4Mode: undefined,
      dhcp: undefined,
      dhcpRelay: undefined,
      gateway: undefined,
      dns: undefined,
      vrf: undefined,
      natRole: undefined,
      aclIn: undefined,
      aclOut: undefined,
      spanningTree: undefined,
      stpEdge: undefined,
      stpCost: undefined,
      mode: 'routed',
      adminUp: true,
      description: 'Túnel sobre UDP/4500 do modelo',
      rx: 0,
      tx: 0,
      errors: 0,
    });
    d.interfaces.push(p);
  }
  p.ip = c.ip;
  p.prefix = c.prefix;
  p.mtu = c.mtu;
  p.tunnel = {
    ...c,
    token: e.id('tunnel'),
    tickAt: e.state.clock + 0.001,
    status: 'down',
    samples: [],
    remotePrefixes: [],
    txSequence: 0,
    receivedSequences: [],
    sent: 0,
    received: 0,
    ike: newIke(e),
  };
  d.arpTable = d.arpTable.filter((a) => a.port !== p.id);
  d.pending = d.pending.filter((a) => a.port !== p.id);
  d.arpResolutions = d.arpResolutions?.filter((a) => a.port !== p.id);
  e.state.queue = e.state.queue.filter(
    ({ action: a }) =>
      !((a.kind === 'tunnel-tick' || a.kind === 'arp-timeout') && a.device === d.id && a.port === p!.id)
  );
  e.schedule(0.001, { kind: 'tunnel-tick', device: d.id, port: p.id, token: p.tunnel.token });
  e.emit('CONFIG_CHANGED', d.id, p.name + ' / ' + c.transport + ' configurado sobre ' + underlay.name + '.', {
    port: p.id,
  });
  return p;
}
function transport(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  message: Message,
  endpoint?: { ip: string; port: number }
) {
  const t = p.tunnel!,
    underlay = d.interfaces.find((p) => p.id === t.underlay)!,
    remote = endpoint ?? { ip: t.remote, port: t.remotePort },
    route = resolveUnderlay(d, underlay, remote.ip);
  if (!route || !interfaceOperational(e.state, d, underlay)) {
    e.drop(d, 'Underlay sem rota/carrier para ' + remote.ip + '.', underlay.id);
    return;
  }
  const packet: UdpPacket = {
    src: underlay.ip!,
    dst: remote.ip,
    ttl: 64,
    protocol: 'UDP',
    sourcePort: 4500,
    destinationPort: remote.port,
    payload: { protocol: 'TUNNEL', message },
    bytes: message.kind === 'data' ? message.innerBytes + 68 : 128 + message.prefixes.length * 8,
  };
  e.emit('TUNNEL_SENT', d.id, p.name + ' ' + message.kind + ' pelo underlay ' + underlay.name + '.', {
    port: p.id,
    frame: { src: p.mac, dst: p.mac, etherType: 'IPv4', packet, hops: LIMITS.l2Hops },
  });
  sendWithArp(e, d, route.port, route.nextHop, packet);
}
export function handleTunnelTick(e: SimulationEngine, a: Extract<Action, { kind: 'tunnel-tick' }>) {
  const d = e.device(a.device),
    p = d.interfaces.find((p) => p.id === a.port),
    t = p?.tunnel;
  if (!p || !t || a.token !== t.token || t.tickAt !== e.state.clock) return;
  const carrier = d.interfaces.find((p) => p.id === t.underlay)!;
  if (!t.enabled || !p.adminUp || !interfaceOperational(e.state, d, carrier)) {
    setState(e, d, p, 'down', 'underlay indisponível.');
    delete t.pending;
  } else {
    if (t.ike?.expiresAt !== undefined && t.ike.expiresAt <= e.state.clock) {
      t.ike = newIke(e, t.ike.retired);
      t.token = e.id('tunnel');
      t.txSequence = 0;
      t.receivedSequences = [];
      delete t.pending;
      delete t.lastRx;
      setState(e, d, p, 'negotiating', 'IKE SA expirou; rekey com novo DH/SPI.');
    }
    t.ike ??= newIke(e);
    if (t.lastRx !== undefined && e.state.clock - t.lastRx >= 3000)
      setState(e, d, p, 'down', 'dead timer sem resposta do peer.');
    if (t.pending && e.state.clock - t.pending.at >= 2000) {
      t.samples.push({ at: e.state.clock, success: false });
      t.samples = t.samples.slice(-16);
      delete t.pending;
    }
    if (!t.pending) {
      t.pending = { nonce: e.id('tunnel-probe'), at: e.state.clock };
      const m = negotiation(t, 'hello', t.pending.nonce);
      m.proof = signature(t.key, m);
      transport(e, d, p, m, t.peerEndpoint);
      if (t.status === 'down') setState(e, d, p, 'negotiating', 'autenticando peer pelo underlay.');
    }
  }
  t.tickAt = e.state.clock + 1000;
  e.schedule(1000, { kind: 'tunnel-tick', device: d.id, port: p.id, token: t.token });
}
export function sendTunnelFrame(e: SimulationEngine, d: Device, p: NetworkInterface, frame: Frame) {
  const t = p.tunnel!;
  if (!t.enabled || !p.adminUp || t.status !== 'up' || !t.peerNonce || !d.power) {
    e.drop(d, 'Túnel sem associação autenticada.', p.id, frame);
    return;
  }
  const bytes = frame.packet?.bytes ?? frame.fragment?.bytes ?? frame.ipv6?.bytes;
  if (!bytes || frame.wifi || frame.secure || frame.lacp || frame.eapol || frame.bpdu || frame.arp) {
    e.drop(d, 'Túnel L3 aceita IPv4/IPv6.', p.id, frame);
    return;
  }
  if (bytes > p.mtu) {
    e.drop(d, 'MTU do túnel excedida; sem fragmentação.', p.id, frame);
    return;
  }
  if (frame.packet && !permitPacket(e, d, p, 'out', frame.packet)) return;
  if (!t.ike?.master || t.ike.phase !== 'ESTABLISHED' || !selectors(t, frame, true)) {
    e.drop(d, 'ESP: SA/seletor de tráfego não autorizado.', p.id, frame);
    return;
  }
  const sequence = ++t.txSequence,
    nonce = t.token + '-' + sequence,
    ciphertext = sealRecord(
      hashHex(t.ike.master + '|ESP|' + t.token),
      0,
      sequence,
      JSON.stringify(frameSchema.parse(frame)),
      t.ike.peerChildSpi! + '|' + t.channel
    ),
    sealed = { body: ciphertext.slice(0, -32), tag: ciphertext.slice(-32) };
  const m: Message = {
    kind: 'data',
    session: t.token,
    channel: t.channel,
    nonce,
    proof: '00'.repeat(32),
    spi: t.ike.peerChildSpi!,
    sequence,
    innerBytes: bytes,
    ...sealed,
  };
  m.proof = signature(t.ike.master, m);
  p.tx++;
  t.sent++;
  transport(e, d, p, m, t.peerEndpoint);
}
export function receiveTunnel(e: SimulationEngine, d: Device, ingress: NetworkInterface, packet: UdpPacket) {
  if (packet.payload.protocol !== 'TUNNEL') return;
  const m = packet.payload.message;
  const p = d.interfaces.find(
      (p) =>
        p.adminUp && p.tunnel?.enabled && p.tunnel.channel === m.channel && p.tunnel.remote === packet.src
    ),
    t = p?.tunnel;
  if (
    !p ||
    !t ||
    packet.destinationPort !== 4500 ||
    ingress.id !== t.underlay ||
    ingress.vrf ||
    m.proof !== signature(m.kind === 'hello' || m.kind === 'ack' ? t.key : (t.ike?.master ?? ''), m)
  ) {
    e.emit('TUNNEL_AUTH_FAILED', d.id, 'Peer/canal/prova do túnel recusados.');
    return;
  }
  e.emit('TUNNEL_RECEIVED', d.id, p.name + ' ' + m.kind + ' de ' + packet.src + '.', { port: p.id });
  if (m.kind === 'hello' || m.kind === 'ack') {
    if (m.kind === 'ack' && t.pending?.nonce !== m.nonce) return;
    try {
      bindIke(e, t, m);
    } catch (error) {
      e.drop(d, (error as Error).message, p.id);
      return;
    }
    t.peerEndpoint = { ip: packet.src, port: packet.sourcePort };
    if (m.kind === 'hello') {
      const ack = negotiation(t, 'ack', m.nonce);
      ack.proof = signature(t.key, ack);
      transport(e, d, p, ack, t.peerEndpoint);
    } else {
      t.pending!.stage = 'AUTH';
      const auth = authentication(t, 'auth', m.nonce);
      auth.proof = signature(t.ike!.master!, auth);
      transport(e, d, p, auth, t.peerEndpoint);
    }
    return;
  }
  if (m.kind === 'auth' || m.kind === 'auth-ack') {
    const ike = t.ike;
    if (
      !ike?.master ||
      m.session !== t.peerNonce ||
      m.ikeSpi !== ike.peerSpi ||
      m.childSpi !== ike.peerChildSpi ||
      packet.sourcePort !== t.peerEndpoint?.port
    )
      return;
    if (m.kind === 'auth') {
      const ack = authentication(t, 'auth-ack', m.nonce);
      ack.proof = signature(ike.master, ack);
      transport(e, d, p, ack, t.peerEndpoint);
      return;
    }
    if (t.pending?.nonce !== m.nonce || t.pending.stage !== 'AUTH') return;
    t.samples.push({ at: e.state.clock, rtt: e.state.clock - t.pending.at, success: true });
    t.samples = t.samples.slice(-16);
    delete t.pending;
    t.lastRx = e.state.clock;
    ike.phase = 'ESTABLISHED';
    ike.expiresAt ??= e.state.clock + t.lifetimeMs;
    t.remotePrefixes = m.prefixes.filter((r) => subnet(r.network, r.prefix).network === r.network);
    setState(e, d, p, 'up', 'IKE_AUTH concluído; Child SA ESP e seletores instalados.');
    return;
  }
  if (
    m.kind !== 'data' ||
    m.nonce !== m.session + '-' + m.sequence ||
    t.status !== 'up' ||
    m.session !== t.peerNonce ||
    t.ike?.phase !== 'ESTABLISHED' ||
    m.spi !== t.ike.localChildSpi ||
    !p.adminUp ||
    m.innerBytes > p.mtu ||
    packet.sourcePort !== t.peerEndpoint?.port
  )
    return;
  const max = Math.max(0, ...t.receivedSequences);
  if (t.receivedSequences.includes(m.sequence) || m.sequence <= max - 64) {
    e.drop(d, 'Replay do túnel recusado.', p.id);
    return;
  }
  try {
    const frame = frameSchema.parse(
      JSON.parse(
        openRecord(
          hashHex(t.ike!.master + '|ESP|' + m.session),
          0,
          m.sequence,
          m.body + m.tag,
          m.spi + '|' + t.channel
        )
      )
    );
    if (
      (!frame.packet && !frame.ipv6) ||
      frame.secure ||
      !selectors(t, frame, false) ||
      m.innerBytes !== (frame.packet?.bytes ?? frame.fragment?.bytes ?? frame.ipv6?.bytes)
    )
      throw new Error('Payload interno do túnel inválido.');
    t.receivedSequences = [...t.receivedSequences, m.sequence].sort((a, b) => a - b).slice(-64);
    t.received++;
    p.rx++;
    if (frame.packet) receiveIp(e, d, p, frame.packet, frame.src);
    else receiveIp6(e, d, p, frame);
  } catch (error) {
    e.drop(d, (error as Error).message, p.id);
  }
}
