import { startEnterprise, receiveEnterpriseWifi, tickEnterprise } from './enterprise';
import { hmacHex } from './security-crypto';
import type { SimulationEngine } from '../core/engine';
import { interfaceSchema, LIMITS, type Action, type Device, type Frame, type Snapshot } from '../model';
import { wirelessConfigSchema, type WirelessConfig } from './wireless-model';
import { radioDistance, wirelessMetrics, wirelessAssociated } from './wireless-radio';

export const wirelessConfig = (d: Device): WirelessConfig =>
  d.wireless
    ? (Object.fromEntries(
        Object.entries(d.wireless).filter(([k]) =>
          [
            'role',
            'ssid',
            'security',
            'key',
            'band',
            'channel',
            'txPower',
            'noise',
            'attenuation',
            'enabled',
          ].includes(k)
        )
      ) as WirelessConfig)
    : {
        role: d.type === 'switch' ? 'ap' : 'client',
        ssid: 'shLab',
        security: 'open',
        band: '2.4',
        channel: 1,
        txPower: 20,
        noise: -95,
        attenuation: 0,
        enabled: true,
      };
function proof(key: string | undefined, nonce: string, token: string, side: string) {
  if (key?.length === 64) return hmacHex(key, nonce + '|' + token + '|' + side);
  let hash = 2166136261;
  for (const c of [key ?? '', nonce, token, side].join('|'))
    hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
  return hash.toString(16).padStart(8, '0');
}
function state(
  e: SimulationEngine,
  d: Device,
  phase: NonNullable<Device['wireless']>['phase'],
  reason: string
) {
  if (d.wireless!.phase !== phase) {
    d.wireless!.phase = phase;
    e.emit('WIFI_STATE', d.id, reason);
  }
}
function clearClient(
  e: SimulationEngine,
  d: Device,
  phase: 'scanning' | 'disabled' | 'failed',
  reason: string
) {
  const w = d.wireless!;
  delete w.association;
  if (d.eapSupplicant) {
    d.eapSupplicant.phase = 'idle';
    delete d.eapSupplicant.token;
    delete d.eapSupplicant.tlsState;
    delete d.eapSupplicant.lastIdentifier;
    delete d.eapSupplicant.lastResponse;
    d.eapSupplicant.fragments = { incoming: '', outgoing: '', first: false };
  }
  state(e, d, phase, reason);
  d.arpTable = d.arpTable.filter((a) => a.port !== w.port);
  d.neighbors6 = d.neighbors6?.filter((a) => a.port !== w.port);
}
export function configureWireless(e: SimulationEngine, d: Device, input: unknown) {
  const c = wirelessConfigSchema.parse(input);
  if (c.role === 'ap' ? d.type !== 'switch' : !['pc', 'server'].includes(d.type))
    throw new Error('AP exige switch; cliente exige PC/servidor.');
  if (d.wireless && d.wireless.role !== c.role)
    throw new Error('Papel wireless do equipamento não pode mudar.');
  let p = d.interfaces.find((p) => p.id === 'wlan0');
  if (!p) {
    if (d.interfaces.length >= 48) throw new Error('Limite de interfaces.');
    const base = d.interfaces[0];
    p = interfaceSchema.parse({
      ...base,
      id: 'wlan0',
      name: 'Wlan0',
      mac: base.mac.split(':').slice(0, 4).join(':') + ':03:00',
      media: 'wifi',
      transceiver: undefined,
      ip: undefined,
      prefix: undefined,
      ipv6: undefined,
      ipv4Mode: undefined,
      dhcp: undefined,
      dhcpRelay: undefined,
      gateway: undefined,
      dns: undefined,
      aggregate: undefined,
      channel: undefined,
      dot1x: undefined,
      supplicant: undefined,
      logical: undefined,
      vrf: undefined,
      aclIn: undefined,
      aclOut: undefined,
      natRole: undefined,
      spanningTree: undefined,
      stpEdge: true,
      mode: c.role === 'ap' ? 'access' : 'routed',
      adminUp: true,
      description: 'Rádio wireless educacional',
      rx: 0,
      tx: 0,
      errors: 0,
    });
    d.interfaces.push(p);
  }
  if (d.eapAuthenticator) d.eapAuthenticator.queries = [];
  if (d.eapSupplicant) {
    d.eapSupplicant.phase = 'idle';
    delete d.eapSupplicant.token;
  }
  d.wireless = {
    ...c,
    port: p.id,
    token: e.id('wireless'),
    tickAt: e.state.clock + 0.001,
    phase: !c.enabled ? 'disabled' : c.role === 'ap' ? 'ap' : 'scanning',
    peers: [],
    seen: [],
    attempts: 0,
    retryAt: e.state.clock,
  };
  e.state.queue = e.state.queue.filter(({ action: a }) => a.kind !== 'wireless-tick' || a.device !== d.id);
  e.schedule(0.001, { kind: 'wireless-tick', device: d.id, token: d.wireless.token });
  refreshWireless(e);
  e.emit(
    'CONFIG_CHANGED',
    d.id,
    'Wireless ' + c.role + ' configurado: ' + c.ssid + ' / canal ' + c.channel + '.',
    { port: p.id }
  );
}
export function refreshWireless(e: SimulationEngine) {
  const aps = e.state.devices.filter((d) => d.wireless?.role === 'ap'),
    clients = e.state.devices.filter((d) => d.wireless?.role === 'client');
  for (const ap of aps)
    for (const client of clients) {
      const distance = radioDistance(ap, client);
      let link = e.state.links.find(
        (l) => l.cable === 'wireless' && l.a.device === ap.id && l.b.device === client.id
      );
      if (!link && distance <= 300 && e.state.links.length < 800) {
        link = {
          id: e.id('radio'),
          a: { device: ap.id, port: ap.wireless!.port },
          b: { device: client.id, port: client.wireless!.port },
          cable: 'wireless',
          up: true,
          distance,
          latency: 2,
          jitter: 0,
          loss: 0,
        };
        e.state.links.push(link);
      }
      if (link) link.distance = distance;
    }
  for (const d of e.state.devices) {
    const w = d.wireless;
    if (!w) continue;
    const p = d.interfaces.find((p) => p.id === w.port)!;
    if (!w.enabled || !d.power || !p.adminUp) {
      if (w.role === 'client') clearClient(e, d, 'disabled', 'Rádio desabilitado.');
      else {
        w.peers = [];
        state(e, d, 'disabled', 'AP desabilitado.');
      }
      continue;
    }
    if (w.role === 'ap') {
      state(e, d, 'ap', 'AP ativo.');
      w.peers = w.peers.filter((peer) => e.state.clock - peer.lastSeen <= 5000);
    } else if (w.phase === 'disabled') clearClient(e, d, 'scanning', 'Rádio disponível: buscando SSID.');
    else if (w.association) {
      const link = e.state.links.find(
        (l) =>
          l.cable === 'wireless' &&
          l.b.device === d.id &&
          e.state.devices.find((ap) => ap.id === l.a.device)?.interfaces.find((p) => p.id === l.a.port)
            ?.mac === w.association!.bssid
      );
      if (
        !link ||
        !wirelessMetrics(e.state, link).operational ||
        (w.phase === 'associated' && !wirelessAssociated(e.state, link)) ||
        e.state.clock - w.association.lastSeen > 4000
      ) {
        const lost = w.association.bssid;
        w.seen = w.seen.filter((v) => v.bssid !== lost);
        clearClient(e, d, 'scanning', 'Associação perdida: canal, sinal ou beacons indisponíveis.');
        w.attempts = 0;
        w.retryAt = e.state.clock;
      }
    }
  }
}
export function sendWireless(e: SimulationEngine, d: Device, dst: string, pdu: Frame['wifi']) {
  const w = d.wireless!,
    p = d.interfaces.find((p) => p.id === w.port)!;
  const frame: Frame = { src: p.mac, dst, etherType: '802.11', wifi: pdu, hops: LIMITS.l2Hops };
  e.emit('WIFI_SENT', d.id, '802.11 ' + pdu!.kind + ' / ' + w.ssid + '.', { port: p.id, frame });
  e.sendFrame(d.id, p.id, frame);
}
function auth(e: SimulationEngine, d: Device, bssid: string) {
  const w = d.wireless!;
  w.attempts++;
  w.association = {
    bssid,
    token: e.id('wifi-auth'),
    nonce: e.id('client-nonce'),
    lastSeen: e.state.clock,
    startedAt: e.state.clock,
  };
  state(e, d, 'authenticating', 'Autenticação 802.11 com ' + bssid + '.');
  if (w.security === 'wpa3-sae') {
    w.association.saeNonce = w.association.nonce;
    sendWireless(e, d, bssid, {
      kind: 'sae-commit',
      ssid: w.ssid,
      security: w.security,
      token: w.association.token,
      nonce: w.association.saeNonce,
      proof: proof(w.key, w.association.saeNonce, w.association.token, 'sae-client'),
    });
  } else
    sendWireless(e, d, bssid, {
      kind: 'auth-request',
      ssid: w.ssid,
      security: w.security,
      token: w.association.token,
    });
}
export function handleWirelessTick(e: SimulationEngine, a: Extract<Action, { kind: 'wireless-tick' }>) {
  const d = e.device(a.device),
    w = d.wireless;
  if (!w || w.token !== a.token || w.tickAt !== e.state.clock) return;
  tickEnterprise(e, d);
  refreshWireless(e);
  if (w.enabled && d.power && d.interfaces.find((p) => p.id === w.port)?.adminUp) {
    w.seen = w.seen.filter((v) => e.state.clock - v.at < 5000);
    if (w.role === 'ap')
      sendWireless(e, d, 'ff:ff:ff:ff:ff:ff', { kind: 'beacon', ssid: w.ssid, security: w.security });
    else if (w.phase === 'associated' && w.association)
      sendWireless(e, d, w.association.bssid, {
        kind: 'keepalive',
        ssid: w.ssid,
        security: w.security,
        token: w.association.token,
      });
    else if (w.phase === 'failed' && w.retryAt <= e.state.clock) {
      w.attempts = 0;
      clearClient(e, d, 'scanning', 'Nova tentativa de associação.');
    } else if (
      (w.phase === 'authenticating' || w.phase === 'associating') &&
      w.association &&
      e.state.clock - w.association.startedAt >= (w.security === 'wpa2-enterprise' ? 12000 : 2000)
    ) {
      const bssid = w.association.bssid;
      if (w.attempts >= 4) {
        clearClient(e, d, 'failed', 'Negociação Wi-Fi expirou.');
        w.retryAt = e.state.clock + 10000;
      } else auth(e, d, bssid);
    } else if (w.phase === 'scanning' && w.retryAt <= e.state.clock) {
      const candidate = w.seen
        .filter((v) => v.ssid === w.ssid && v.security === w.security)
        .sort((a, b) => b.signal - a.signal || a.bssid.localeCompare(b.bssid))[0];
      if (candidate) auth(e, d, candidate.bssid);
    }
  }
  w.tickAt = e.state.clock + 1000;
  e.schedule(1000, { kind: 'wireless-tick', device: d.id, token: w.token });
}
export function receiveWireless(e: SimulationEngine, d: Device, frame: Frame, linkId: string) {
  const w = d.wireless,
    pdu = frame.wifi,
    link = e.state.links.find((l) => l.id === linkId);
  if (!w || !pdu || !link || link.cable !== 'wireless' || !wirelessMetrics(e.state, link).operational) return;
  const other = e.state.devices.find(
    (v) => v.id === (link.a.device === d.id ? link.b.device : link.a.device)
  )!;
  if (frame.src !== other.interfaces.find((p) => p.id === other.wireless!.port)!.mac) return;
  e.emit('WIFI_RECEIVED', d.id, '802.11 ' + pdu.kind + ' de ' + frame.src + '.', { port: w.port, frame });
  if (w.role === 'client' && pdu.kind === 'beacon') {
    w.seen = w.seen.filter((v) => v.bssid !== frame.src);
    if (w.seen.length >= 32) w.seen.shift();
    w.seen.push({
      bssid: frame.src,
      ssid: pdu.ssid,
      security: pdu.security,
      signal: wirelessMetrics(e.state, link).rssi,
      at: e.state.clock,
    });
    if (w.association?.bssid === frame.src) w.association.lastSeen = e.state.clock;
    return;
  }
  if (pdu.ssid !== w.ssid || pdu.security !== w.security) return;
  if (pdu.kind === 'eap' && pdu.eap && pdu.token) {
    receiveEnterpriseWifi(e, d, frame.src, pdu.token, pdu.eap);
    return;
  }
  if (w.role === 'ap') {
    let peer = w.peers.find((p) => p.mac === frame.src && p.token === pdu.token);
    const respond = (
      kind: NonNullable<Frame['wifi']>['kind'],
      extra: Partial<NonNullable<Frame['wifi']>> = {}
    ) =>
      sendWireless(e, d, frame.src, { kind, ssid: w.ssid, security: w.security, token: pdu.token, ...extra });
    if (pdu.kind === 'auth-request' || pdu.kind === 'sae-commit') {
      if ((w.security === 'wpa3-sae') !== (pdu.kind === 'sae-commit')) return;
      if (pdu.kind === 'sae-commit' && pdu.proof !== proof(w.key, pdu.nonce!, pdu.token!, 'sae-client')) {
        respond('reject');
        e.emit('WIFI_AUTH_FAILED', d.id, 'SAE: confirmação de credencial recusada.');
        return;
      }
      w.peers = w.peers.filter((p) => p.mac !== frame.src);
      if (w.peers.length >= 32) {
        respond('reject');
        return;
      }
      peer = {
        mac: frame.src,
        token: pdu.token!,
        nonce: e.id('ap-nonce'),
        phase: 'challenged',
        lastSeen: e.state.clock,
      };
      w.peers.push(peer);
      if (pdu.kind === 'sae-commit') {
        peer.saeNonce = pdu.nonce;
        respond('sae-confirm', {
          nonce: peer.nonce,
          proof: proof(w.key, peer.saeNonce + '|' + peer.nonce, peer.token, 'sae-ap'),
        });
      } else respond('auth-response', { accepted: true });
      return;
    }
    if (!peer) return;
    peer.lastSeen = e.state.clock;
    if (
      pdu.kind === 'sae-confirm' &&
      peer.saeNonce &&
      pdu.nonce === peer.nonce &&
      pdu.proof === proof(w.key, peer.saeNonce + '|' + peer.nonce, peer.token, 'sae-ack')
    ) {
      delete peer.saeNonce;
      respond('auth-response', { accepted: true });
    } else if (pdu.kind === 'association-request' && !peer.saeNonce) {
      respond('association-response', { accepted: true });
      if (w.security === 'open') {
        peer.phase = 'associated';
        e.emit('WIFI_STATE', d.id, 'Cliente associado: ' + peer.mac + '.');
      } else if (w.security === 'wpa2-enterprise') startEnterprise(e, d, peer.mac, peer.token);
      else respond('key1', { nonce: peer.nonce });
    } else if (pdu.kind === 'key2' && peer.phase === 'challenged') {
      if (
        (w.security === 'wpa2-enterprise' && !peer.pmk) ||
        pdu.nonce !== peer.nonce ||
        pdu.proof !== proof(peer.pmk ?? w.key, peer.nonce, peer.token, 'client')
      ) {
        respond('reject');
        w.peers = w.peers.filter((p) => p !== peer);
        e.emit('WIFI_AUTH_FAILED', d.id, 'Credencial wireless inválida para ' + frame.src + '.');
      } else {
        peer.phase = 'confirmed';
        respond('key3', { nonce: peer.nonce, proof: proof(peer.pmk ?? w.key, peer.nonce, peer.token, 'ap') });
      }
    } else if (
      pdu.kind === 'key4' &&
      peer.phase === 'confirmed' &&
      pdu.proof === proof(peer.pmk ?? w.key, peer.nonce, peer.token, 'ack')
    ) {
      peer.phase = 'associated';
      respond('authorized', { accepted: true });
      e.emit('WIFI_STATE', d.id, 'Cliente autorizado: ' + peer.mac + '.');
    }
    return;
  }
  const a = w.association;
  if (!a || a.bssid !== frame.src || a.token !== pdu.token) return;
  a.lastSeen = e.state.clock;
  const respond = (
    kind: NonNullable<Frame['wifi']>['kind'],
    extra: Partial<NonNullable<Frame['wifi']>> = {}
  ) => sendWireless(e, d, frame.src, { kind, ssid: w.ssid, security: w.security, token: a.token, ...extra });
  if (pdu.kind === 'reject') {
    clearClient(e, d, 'failed', 'Autenticação recusada pelo AP.');
    w.retryAt = e.state.clock + 10000;
    e.emit('WIFI_AUTH_FAILED', d.id, 'Chave ou negociação wireless recusada.');
  } else if (
    pdu.kind === 'sae-confirm' &&
    a.saeNonce &&
    pdu.proof === proof(w.key, a.saeNonce + '|' + pdu.nonce, a.token, 'sae-ap')
  ) {
    respond('sae-confirm', {
      nonce: pdu.nonce,
      proof: proof(w.key, a.saeNonce + '|' + pdu.nonce, a.token, 'sae-ack'),
    });
    delete a.saeNonce;
  } else if (pdu.kind === 'auth-response') {
    state(e, d, 'associating', 'Autenticação 802.11 aceita; solicitando associação.');
    respond('association-request');
  } else if (pdu.kind === 'association-response' && pdu.accepted) {
    if (w.security === 'open') state(e, d, 'associated', 'Cliente associado ao SSID ' + w.ssid + '.');
    else state(e, d, 'authenticating', 'Associação aceita; iniciando troca de chave ' + w.security + '.');
  } else if (pdu.kind === 'key1' && (w.security !== 'wpa2-enterprise' || !!a.pmk)) {
    a.nonce = pdu.nonce!;
    respond('key2', { nonce: a.nonce, proof: proof(a.pmk ?? w.key, a.nonce, a.token, 'client') });
  } else if (
    pdu.kind === 'key3' &&
    pdu.nonce === a.nonce &&
    pdu.proof === proof(a.pmk ?? w.key, a.nonce, a.token, 'ap')
  )
    respond('key4', { proof: proof(a.pmk ?? w.key, a.nonce, a.token, 'ack') });
  else if (pdu.kind === 'authorized' && pdu.accepted)
    state(e, d, 'associated', 'Cliente autorizado no SSID ' + w.ssid + '.');
}
export function validateWireless(s: Snapshot) {
  const used = new Set<Action>(),
    pairs = new Set<string>();
  for (const d of s.devices) {
    const w = d.wireless;
    for (const p of d.interfaces)
      if (p.media === 'wifi' && p.id !== w?.port && !p.meshPeer)
        throw new Error('Rádio sem configuração wireless.');
    if (!w) continue;
    const p = d.interfaces.find((p) => p.id === w.port);
    if (
      !p ||
      p.media !== 'wifi' ||
      p.logical ||
      p.aggregate ||
      p.channel ||
      (w.role === 'ap'
        ? d.type !== 'switch' || p.mode !== 'access'
        : !['pc', 'server'].includes(d.type) || p.mode !== 'routed')
    )
      throw new Error('Papel/interface wireless inválidos.');
    const timers = s.queue.filter((q) => q.action.kind === 'wireless-tick' && q.action.device === d.id);
    if (
      timers.length !== 1 ||
      timers[0].at !== w.tickAt ||
      w.tickAt < s.clock ||
      (timers[0].action as Extract<Action, { kind: 'wireless-tick' }>).token !== w.token
    )
      throw new Error('Timer wireless inconsistente.');
    used.add(timers[0].action);
    if (
      new Set(w.peers.map((p) => p.mac)).size !== w.peers.length ||
      new Set(w.seen.map((p) => p.bssid)).size !== w.seen.length ||
      w.peers.some((p) => p.lastSeen > s.clock) ||
      w.seen.some((p) => p.at > s.clock)
    )
      throw new Error('Vizinhos wireless inconsistentes.');
    if (
      w.role === 'ap'
        ? w.association !== undefined || !['ap', 'disabled'].includes(w.phase) || w.seen.length > 0
        : w.peers.length > 0 || w.phase === 'ap' || (w.phase === 'associated' && !w.association)
    )
      throw new Error('Estado wireless incompatível.');
    for (const peer of [...w.peers, ...(w.association ? [w.association] : [])]) {
      const seq = peer.receivedSequences ?? [];
      if (new Set(seq).size !== seq.length || seq.some((n, i) => i > 0 && n <= seq[i - 1]))
        throw new Error('Janela anti-replay wireless inválida.');
    }
    if (
      w.association &&
      (w.association.lastSeen > s.clock ||
        w.association.startedAt > s.clock ||
        !s.devices.some(
          (a) =>
            a.wireless?.role === 'ap' &&
            a.interfaces.find((p) => p.id === a.wireless?.port)?.mac === w.association!.bssid
        ))
    )
      throw new Error('Associação wireless sem AP.');
  }
  for (const l of s.links.filter((l) => l.cable === 'wireless')) {
    const a = s.devices.find((d) => d.id === l.a.device),
      b = s.devices.find((d) => d.id === l.b.device),
      key = l.a.device + '/' + l.b.device;
    if (
      a?.wireless?.role !== 'ap' ||
      b?.wireless?.role !== 'client' ||
      l.a.port !== a.wireless.port ||
      l.b.port !== b.wireless.port ||
      pairs.has(key)
    )
      throw new Error('Enlace radio inválido.');
    pairs.add(key);
  }
  for (const q of s.queue)
    if (q.action.kind === 'wireless-tick' && !used.has(q.action)) throw new Error('Timer wireless órfão.');
}
export { wirelessAssociated };
