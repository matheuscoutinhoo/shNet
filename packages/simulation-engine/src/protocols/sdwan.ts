import type { SimulationEngine } from '../core/engine';
import { type Action, type Device, type Packet, type UdpPacket } from '../model';
import { sdwanConfigSchema, sdwanControllerSchema, sdwanMessageSchema } from './tunnel-model';
import { resolveUnderlay } from './underlay';
import { hmacHex } from './security-crypto';
import { sendWithArp } from './arp';
import { interfaceOperational } from './layer3';
import { sameSubnet, subnet } from './ipv4';
import { tunnelMetrics } from './tunnel';
type Message = Extract<UdpPacket['payload'], { protocol: 'SDWAN' }>['message'];
function signature(key: string, message: Message) {
  return hmacHex(key, JSON.stringify({ ...sdwanMessageSchema.parse(message), proof: '' }));
}
export function configureSdwan(e: SimulationEngine, d: Device, input: unknown) {
  const c = sdwanConfigSchema.parse(input);
  if (d.type !== 'router') throw new Error('SD-WAN edge exige roteador.');
  if (
    new Set(c.policies.map((p) => p.name)).size !== c.policies.length ||
    c.policies.some(
      (p) =>
        subnet(p.match.destination.network, p.match.destination.prefix).network !==
        p.match.destination.network
    )
  )
    throw new Error('Políticas SD-WAN duplicadas ou rede desalinhada.');
  const p = d.interfaces.find((p) => p.id === c.underlay);
  if (c.controller && (!p?.ip || p.tunnel || p.vrf || p.mode !== 'routed' || p.channel))
    throw new Error('Controller exige underlay IPv4 routed.');
  d.sdwan = {
    ...c,
    receivedPolicies: [],
    token: e.id('sdwan'),
    tickAt: e.state.clock + 0.001,
    requests: 0,
    selected: [],
  };
  e.state.queue = e.state.queue.filter(({ action: a }) => a.kind !== 'sdwan-tick' || a.device !== d.id);
  e.schedule(0.001, { kind: 'sdwan-tick', device: d.id, token: d.sdwan.token });
  e.emit('CONFIG_CHANGED', d.id, 'SD-WAN site ' + c.site + ' configurado.');
}
export function configureSdwanController(e: SimulationEngine, d: Device, input: unknown) {
  const c = sdwanControllerSchema.parse(input);
  if (!['server', 'router', 'switch'].includes(d.type))
    throw new Error('Controller exige servidor ou roteador/switch L3.');
  if (
    new Set(c.sites.map((s) => s.site)).size !== c.sites.length ||
    c.sites.some(
      (s) =>
        new Set(s.policies.map((p) => p.name)).size !== s.policies.length ||
        s.policies.some(
          (p) =>
            subnet(p.match.destination.network, p.match.destination.prefix).network !==
            p.match.destination.network
        )
    )
  )
    throw new Error('Site/política inválidos.');
  d.sdwanController = c;
  e.emit('CONFIG_CHANGED', d.id, 'Controller SD-WAN ' + (c.enabled ? 'ativado.' : 'desativado.'));
}
export function handleSdwanTick(e: SimulationEngine, a: Extract<Action, { kind: 'sdwan-tick' }>) {
  const d = e.device(a.device),
    s = d.sdwan;
  if (!s || s.token !== a.token || s.tickAt !== e.state.clock) return;
  if (
    s.enabled &&
    s.controller &&
    s.key &&
    s.underlay &&
    d.power &&
    (!s.pendingAt || e.state.clock - s.pendingAt >= 5000) &&
    (!s.lastController || e.state.clock - s.lastController >= 5000)
  ) {
    const p = d.interfaces.find((p) => p.id === s.underlay)!,
      route = resolveUnderlay(d, p, s.controller);
    if (route && interfaceOperational(e.state, d, p)) {
      s.pendingNonce = e.id('sdwan-request');
      s.pendingAt = e.state.clock;
      s.requests++;
      const m: Message = { kind: 'request', site: s.site, nonce: s.pendingNonce, proof: '00'.repeat(32) };
      m.proof = signature(s.key, m);
      const packet: UdpPacket = {
        protocol: 'UDP',
        src: p.ip!,
        dst: s.controller,
        ttl: 64,
        sourcePort: 5001,
        destinationPort: 5000,
        payload: { protocol: 'SDWAN', message: m },
        bytes: 160,
      };
      sendWithArp(e, d, p, route.nextHop, packet);
    }
  }
  s.tickAt = e.state.clock + 1000;
  e.schedule(1000, { kind: 'sdwan-tick', device: d.id, token: s.token });
}
export function receiveSdwan(e: SimulationEngine, d: Device, packet: UdpPacket) {
  if (packet.payload.protocol !== 'SDWAN') return;
  const m = packet.payload.message;
  if (m.kind === 'request') {
    const c = d.sdwanController,
      site = c?.sites.find((s) => s.site === m.site);
    if (!c?.enabled || !site || packet.destinationPort !== 5000 || m.proof !== signature(c.key, m)) {
      e.drop(d, 'Controller SD-WAN recusou site/chave/porta.');
      return;
    }
    const response: Message = {
      kind: 'policies',
      site: m.site,
      nonce: m.nonce,
      proof: '00'.repeat(32),
      policies: structuredClone(site.policies),
    };
    response.proof = signature(c.key, response);
    e.sendIp(d.id, {
      protocol: 'UDP',
      src: packet.dst,
      dst: packet.src,
      ttl: 64,
      sourcePort: 5000,
      destinationPort: packet.sourcePort,
      payload: { protocol: 'SDWAN', message: response },
      bytes: 160 + response.policies.length * 64,
    });
    e.emit('SDWAN_POLICY', d.id, 'Políticas enviadas para site ' + m.site + '.');
    return;
  }
  const s = d.sdwan;
  if (
    !s?.enabled ||
    !s.key ||
    packet.src !== s.controller ||
    packet.destinationPort !== 5001 ||
    m.site !== s.site ||
    m.nonce !== s.pendingNonce ||
    m.proof !== signature(s.key, m)
  ) {
    e.drop(d, 'SD-WAN: resposta do controller inválida.');
    return;
  }
  const old = new Map(s.receivedPolicies.map((p) => [p.name, p.hits]));
  s.receivedPolicies = m.policies.map((p) => ({ ...structuredClone(p), hits: old.get(p.name) ?? 0 }));
  s.lastController = e.state.clock;
  delete s.pendingAt;
  delete s.pendingNonce;
  e.emit('SDWAN_POLICY', d.id, 'Políticas do controller aplicadas por tráfego UDP.');
}
export function selectSdwan(e: SimulationEngine, d: Device, packet: Packet) {
  const s = d.sdwan;
  if (!s?.enabled) return;
  const policies = s.receivedPolicies.length ? s.receivedPolicies : s.policies,
    policy = policies.find(
      (p) =>
        sameSubnet(p.match.destination.network, packet.dst, p.match.destination.prefix) &&
        (p.match.protocol === 'ip' || p.match.protocol.toUpperCase() === packet.protocol) &&
        (p.match.destinationPort === undefined ||
          ('destinationPort' in packet && packet.destinationPort === p.match.destinationPort))
    );
  if (!policy) return;
  const choices = d.interfaces
    .filter(
      (p) =>
        p.tunnel?.mode === 'sdwan' &&
        interfaceOperational(e.state, d, p) &&
        p.tunnel.remotePrefixes.some((r) => sameSubnet(r.network, packet.dst, r.prefix))
    )
    .map((p) => ({ p, ...tunnelMetrics(p) }));
  if (!choices.length) {
    e.emit('SDWAN_PATH', d.id, policy.name + ': nenhum transporte disponível.');
    return { blocked: true as const };
  }
  const compliant = choices.filter((p) => p.rtt <= policy.maxRtt && p.loss <= policy.maxLoss),
    pool = compliant.length ? compliant : policy.fallback ? choices : [];
  pool.sort((a, b) => {
    const rank = (p: typeof a) => {
      const at = policy.prefer.indexOf(p.p.tunnel!.transport);
      return at < 0 ? 10 : at;
    };
    return rank(a) - rank(b) || a.rtt - b.rtt || a.loss - b.loss || a.p.id.localeCompare(b.p.id);
  });
  const selected = pool[0];
  if (!selected) {
    e.emit('SDWAN_PATH', d.id, policy.name + ': SLA indisponível; política exige bloqueio.');
    return { blocked: true as const };
  }
  policy.hits++;
  const prior = s.selected.find((p) => p.policy === policy.name);
  s.selected = s.selected.filter((p) => p.policy !== policy.name);
  s.selected.push({ policy: policy.name, port: selected.p.id, at: e.state.clock });
  if (s.selected.length > 32) s.selected.shift();
  if (prior?.port !== selected.p.id)
    e.emit(
      'SDWAN_PATH',
      d.id,
      policy.name +
        ' → ' +
        selected.p.name +
        ' (' +
        selected.p.tunnel!.transport +
        '): RTT ' +
        selected.rtt.toFixed(3) +
        ' ms, perda ' +
        selected.loss.toFixed(1) +
        '%' +
        (compliant.length ? '' : ' / fallback') +
        '.',
      { port: selected.p.id }
    );
  const prefix = Math.max(
    ...selected.p
      .tunnel!.remotePrefixes.filter((r) => sameSubnet(r.network, packet.dst, r.prefix))
      .map((r) => r.prefix)
  );
  return { route: { port: selected.p, nextHop: selected.p.tunnel!.peerIp, prefix } };
}
export function sdwanConfig(d: Device) {
  const s = d.sdwan;
  return s
    ? sdwanConfigSchema.parse({
        enabled: s.enabled,
        site: s.site,
        controller: s.controller,
        underlay: s.underlay,
        key: s.key,
        policies: s.policies,
      })
    : { enabled: true, site: 'Site-1', policies: [] };
}
