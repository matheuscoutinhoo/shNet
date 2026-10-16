import type { Action, Device, Snapshot } from '../model';
import type { SimulationEngine } from '../core/engine';
import { dhcpHaPairSchema } from './dhcp-ha-model';
import { canonicalScenarioJson as canonicalJson } from '../canonical-json';
import { cableMetrics, linkOperational } from '../links/physical';
import { random } from '../core/queue';
import { availablePoolAddress, validateDhcpDevice } from './dhcp-config';
import { sendDhcpServerResponse } from './dhcp-wire';

type Transfer = Extract<Action, { kind: 'dhcp-ha-deliver' | 'dhcp-ha-confirm' }>;
type Reply = Extract<Action, { kind: 'dhcp-ha-reply' }>;
const heartbeatMs = 1000;
// Reservations outlive the advertised lease. A delayed commit is never allowed
// to consume this guard and then advertise a fresh full-duration lease.
export const DHCP_HA_RESERVE_MS = 30000;
export const DHCP_HA_REPLY_MS = 5000;

function channel(s: Snapshot, d: Device) {
  const c = d.dhcpHa,
    peer = s.devices.find((p) => p.id === c?.peer);
  if (!c || peer?.dhcpHa?.peer !== d.id) return;
  const link = s.links.find(
    (l) =>
      [l.a, l.b].some((p) => p.device === d.id && p.port === c.port) &&
      [l.a, l.b].some((p) => p.device === peer.id && p.port === peer.dhcpHa!.port)
  );
  return link && { peer, link };
}
export function dhcpHaCompatible(a: Device, b: Device) {
  const pools = (d: Device) =>
    d.dhcpServer?.pools
      .map(({ port: _port, ...p }) => {
        void _port;
        return p;
      })
      .sort((x, y) => x.name.localeCompare(y.name));
  return canonicalJson(pools(a)) === canonicalJson(pools(b));
}
export function dhcpHaStatus(s: Snapshot, d: Device) {
  if (!d.dhcpHa) return 'disabled';
  if (d.dhcpHa.solo) return 'fenced-active';
  const c = channel(s, d);
  if (!c || !dhcpHaCompatible(d, c.peer)) return 'configuration-mismatch';
  if (!linkOperational(s, c.link)) return 'unavailable';
  const active = d.dhcpHa.role === 'active' ? d : c.peer;
  return active.dhcpHa!.confirmed === active.dhcpHa!.revision ? 'synchronized' : 'synchronizing';
}
function cancel(e: SimulationEngine, ids: Set<string>, transfersOnly = false) {
  e.state.queue = e.state.queue.filter(
    ({ action: a }) =>
      !(
        (a.kind === 'dhcp-ha-deliver' ||
          a.kind === 'dhcp-ha-confirm' ||
          a.kind === 'dhcp-ha-reply' ||
          (!transfersOnly && a.kind === 'dhcp-ha-tick')) &&
        ids.has(a.device)
      )
  );
}
export function disableDhcpHa(e: SimulationEngine, d: Device) {
  if (!d.dhcpHa) return;
  const peer = e.state.devices.find((p) => p.id === d.dhcpHa!.peer);
  const members = [d, ...(peer?.dhcpHa?.peer === d.id ? [peer] : [])];
  for (const member of members) {
    // Unpairing must not silently turn the standby into a competing allocator.
    if (member.dhcpHa?.role === 'standby' && member.dhcpServer) member.dhcpServer.enabled = false;
    delete member.dhcpHa;
  }
  cancel(e, new Set(members.map((p) => p.id)));
  e.emit('CONFIG_CHANGED', d.id, 'Par DHCP removido; serviço da antiga reserva desativado.');
  e.refreshVrrp();
}
function validatePair(a: Device, b: Device) {
  if (a.id === b.id || !['server', 'router'].includes(a.type) || !['server', 'router'].includes(b.type))
    throw new Error('HA DHCP exige dois servidores/roteadores distintos.');
  if (!a.dhcpServer?.pools.length || !b.dhcpServer?.pools.length || !dhcpHaCompatible(a, b))
    throw new Error('Configure pools DHCP com os mesmos nomes e políticas nos dois membros.');
  for (const d of [a, b]) {
    const c = d.dhcpHa!,
      p = d.interfaces.find((p) => p.id === c.port);
    if (
      !p ||
      p.media !== 'rj45' ||
      p.logical ||
      p.bond ||
      p.aggregate ||
      p.ip ||
      p.ipv6 ||
      p.dhcp ||
      p.dhcp6 ||
      p.tunnel ||
      p.vxlan ||
      p.loopback ||
      d.interfaces.some((i) => i.bond?.members.includes(p.id) || i.aggregate?.members.includes(p.id)) ||
      d.dhcpServer!.pools.some((pool) => pool.port === p.id) ||
      d.stateSync?.port === p.id ||
      Object.values(d.quorum?.ports ?? {}).includes(p.id)
    )
      throw new Error('HA DHCP exige uma porta RJ45 física dedicada, sem endereço ou grupo.');
    for (const pool of d.dhcpServer!.pools)
      for (const member of [a, b])
        for (const ip of member.interfaces.flatMap((i) => (i.ip ? [i.ip] : [])))
          if (availablePoolAddress(d, pool, ip))
            throw new Error('Exclua dos pools os endereços físicos dos dois servidores DHCP.');
  }
}
export function configureDhcpHaPair(e: SimulationEngine, a: Device, b: Device, input: unknown) {
  const c = dhcpHaPairSchema.parse(input);
  if (a.dhcpHa || b.dhcpHa) throw new Error('Remova o par DHCP existente antes de reconfigurar.');
  if (b.dhcpServer?.bindings.length || b.dhcpServer?.declined?.length)
    throw new Error('A reserva deve começar sem concessões ou quarentenas próprias.');
  const config = (peer: string, port: string, role: 'active' | 'standby') => ({
    peer,
    port,
    role,
    token: 'dhcp-ha-candidate',
    revision: 1,
    applied: 0,
    confirmed: 0,
    solo: false,
    sent: 0,
    received: 0,
  });
  a.dhcpHa = config(b.id, c.portA, 'active');
  b.dhcpHa = config(a.id, c.portB, 'standby');
  try {
    validatePair(a, b);
    if (!channel(e.state, a)) throw new Error('Conecte as portas dedicadas por um cabo direto.');
  } catch (error) {
    delete a.dhcpHa;
    delete b.dhcpHa;
    throw error;
  }
  a.dhcpHa.token = e.id('dhcp-ha');
  b.dhcpHa.token = e.id('dhcp-ha');
  for (const d of [a, b])
    e.schedule(heartbeatMs, { kind: 'dhcp-ha-tick', device: d.id, token: d.dhcpHa!.token });
  transmit(e, a);
  e.emit(
    'CONFIG_CHANGED',
    a.id,
    'DHCP ativo/reserva com ' + b.hostname + '; promoção administrativa com desligamento do antigo ativo.'
  );
}
export function dhcpHaChanged(e: SimulationEngine, d: Device) {
  if (d.dhcpHa?.role !== 'active') return;
  d.dhcpHa.revision++;
  transmit(e, d);
}
export function deferDhcpHaResponse(
  e: SimulationEngine,
  d: Device,
  response: Omit<Reply, 'kind' | 'device' | 'token' | 'revision'>
) {
  const c = d.dhcpHa;
  if (!c || c.solo) return false;
  const pending = e.state.queue.filter(({ action: a }) => a.kind === 'dhcp-ha-reply' && a.device === d.id);
  const duplicate = pending.some(
    ({ action: a }) =>
      a.kind === 'dhcp-ha-reply' &&
      a.type === response.type &&
      a.request.transactionId === response.request.transactionId &&
      a.request.clientMac.toLowerCase() === response.request.clientMac.toLowerCase()
  );
  if (!duplicate && pending.length < 128)
    e.scheduleAt(response.deadline, {
      kind: 'dhcp-ha-reply',
      device: d.id,
      token: c.token,
      revision: c.revision,
      ...structuredClone(response),
    });
  else if (!duplicate)
    e.emit(
      'HA_SYNC_REJECTED',
      d.id,
      'DHCP: limite de 128 respostas aguardando réplica; cliente deverá tentar novamente.'
    );
  transmit(e, d);
  return true;
}
function scheduleTransfer(e: SimulationEngine, source: Device, a: Transfer) {
  const c = channel(e.state, source);
  if (!c || c.link.id !== a.link || !linkOperational(e.state, c.link)) return;
  const p = source.interfaces.find((p) => p.id === source.dhcpHa!.port)!;
  p.tx++;
  source.dhcpHa!.sent++;
  e.emit('HA_SYNC_SENT', source.id, 'DHCP: ' + a.kind + ', revisão ' + a.revision + '.', {
    peer: c.peer.id,
    port: p.id,
    link: c.link.id,
  });
  if (random(e.state) < c.link.loss) return;
  // Confirmation carries only the revision on the modeled wire; the queued
  // snapshot is retained for deterministic validation and matching the reply.
  const bytes = a.kind === 'dhcp-ha-confirm' ? 64 : new TextEncoder().encode(JSON.stringify(a)).length;
  e.schedule(
    Math.max(
      0.001,
      cableMetrics(c.link).latency +
        (random(e.state) * 2 - 1) * c.link.jitter +
        (bytes * 8) / (p.speed * 1000)
    ),
    a
  );
}
function transmit(e: SimulationEngine, d: Device) {
  const c = channel(e.state, d),
    ha = d.dhcpHa;
  if (!c || !ha || ha.role !== 'active' || !dhcpHaCompatible(d, c.peer)) return;
  // At most one full-database transfer/confirmation per pair is in flight.
  // Changes accumulated during the round trip are sent after confirmation.
  if (
    e.state.queue.some(
      ({ action: a }) =>
        (a.kind === 'dhcp-ha-deliver' || a.kind === 'dhcp-ha-confirm') &&
        a.device === d.id &&
        a.token === ha.token
    )
  )
    return;
  scheduleTransfer(e, d, {
    kind: 'dhcp-ha-deliver',
    device: d.id,
    peer: c.peer.id,
    token: ha.token,
    peerToken: c.peer.dhcpHa!.token,
    link: c.link.id,
    revision: ha.revision,
    bindings: structuredClone(d.dhcpServer!.bindings),
    declined: structuredClone(d.dhcpServer!.declined ?? []),
  });
}
function install(e: SimulationEngine, d: Device, a: Transfer) {
  const candidate = {
    ...d,
    dhcpServer: {
      ...d.dhcpServer!,
      bindings: structuredClone(a.bindings.filter((b) => b.expiresAt > e.state.clock)),
      declined: structuredClone(a.declined.filter((b) => b.expiresAt > e.state.clock)),
    },
  };
  validateDhcpDevice(candidate, e.state.clock);
  d.dhcpServer = candidate.dhcpServer;
  d.dhcpHa!.applied = a.revision;
  e.state.queue = e.state.queue.filter(
    ({ action: q }) => q.kind !== 'dhcp-binding-expire' || q.device !== d.id
  );
  for (const binding of d.dhcpServer.bindings)
    e.scheduleAt(binding.expiresAt, {
      kind: 'dhcp-binding-expire',
      device: d.id,
      binding: binding.id,
      expiresAt: binding.expiresAt,
    });
}
export function handleDhcpHa(
  e: SimulationEngine,
  a: Extract<Action, { kind: 'dhcp-ha-tick' | 'dhcp-ha-reply' }> | Transfer
) {
  const d = e.state.devices.find((d) => d.id === a.device);
  if (!d?.dhcpHa || d.dhcpHa.token !== a.token) return;
  if (a.kind === 'dhcp-ha-reply') {
    e.drop(d, 'DHCP: resposta suspensa; réplica não confirmada em 5 s.', a.port);
    return;
  }
  if (a.kind === 'dhcp-ha-tick') {
    if (d.power && d.dhcpHa.role === 'active' && d.dhcpHa.confirmed !== d.dhcpHa.revision) transmit(e, d);
    e.schedule(heartbeatMs, a);
    return;
  }
  const c = channel(e.state, d);
  if (
    !c ||
    c.peer.id !== a.peer ||
    c.link.id !== a.link ||
    c.peer.dhcpHa!.token !== a.peerToken ||
    !linkOperational(e.state, c.link) ||
    !dhcpHaCompatible(d, c.peer) ||
    d.dhcpHa.role !== 'active' ||
    c.peer.dhcpHa!.role !== 'standby'
  )
    return;
  const receiver = a.kind === 'dhcp-ha-deliver' ? c.peer : d;
  receiver.dhcpHa!.received++;
  receiver.dhcpHa!.lastReceivedAt = e.state.clock;
  receiver.interfaces.find((p) => p.id === receiver.dhcpHa!.port)!.rx++;
  if (a.kind === 'dhcp-ha-deliver') {
    if (a.revision > d.dhcpHa.revision) return;
    if (a.revision > c.peer.dhcpHa!.applied) install(e, c.peer, a);
    scheduleTransfer(e, c.peer, { ...a, kind: 'dhcp-ha-confirm' });
    return;
  }
  d.dhcpHa.confirmed = Math.max(d.dhcpHa.confirmed, a.revision);
  e.emit('HA_SYNC_RECEIVED', d.id, 'DHCP: réplica confirmada, revisão ' + a.revision + '.', {
    peer: c.peer.id,
  });
  if (d.dhcpHa.confirmed === d.dhcpHa.revision) d.dhcpHa.solo = false;
  const pending = e.state.queue.filter(
    ({ action: r }) =>
      r.kind === 'dhcp-ha-reply' &&
      r.device === d.id &&
      r.token === d.dhcpHa!.token &&
      r.revision <= a.revision
  );
  const replied = new Set<number>();
  for (const item of pending) {
    const r = item.action as Reply;
    if (e.state.clock > r.deadline || !d.dhcpServer?.enabled) continue;
    const pool = d.dhcpServer.pools.find((p) => p.name === r.pool);
    const binding = d.dhcpServer.bindings.find(
      (b) =>
        b.pool === r.pool &&
        b.address === r.address &&
        b.clientMac.toLowerCase() === r.request.clientMac.toLowerCase() &&
        (r.type === 'offer' || b.status === 'bound')
    );
    const replica = a.bindings.find(
      (b) =>
        b.id === binding?.id &&
        b.address === r.address &&
        b.pool === r.pool &&
        b.clientMac.toLowerCase() === r.request.clientMac.toLowerCase() &&
        (r.type === 'offer' || b.status === 'bound')
    );
    const port = d.interfaces.find((p) => p.id === r.port);
    if (
      !pool ||
      !binding ||
      !replica ||
      replica.expiresAt <= e.state.clock + (r.type === 'ack' ? pool.leaseMs : 0) ||
      !port?.adminUp ||
      !port.ip
    )
      continue;
    sendDhcpServerResponse(e, d, port, r.request, r.type, pool, r.address);
    replied.add(item.order);
  }
  e.state.queue = e.state.queue.filter((q) => !replied.has(q.order));
  if (d.dhcpHa.confirmed < d.dhcpHa.revision) transmit(e, d);
}

export function promoteDhcpHa(e: SimulationEngine, d: Device) {
  const c = d.dhcpHa,
    peer = e.state.devices.find((p) => p.id === c?.peer);
  if (!c || c.role !== 'standby' || peer?.dhcpHa?.role !== 'active' || !d.power || !d.dhcpServer?.enabled)
    throw new Error('A promoção requer uma reserva DHCP ligada e habilitada.');
  if (!dhcpHaCompatible(d, peer) || c.applied !== peer.dhcpHa.revision)
    throw new Error('A reserva não recebeu a revisão atual; recupere e sincronize o par antes da promoção.');
  // This is an explicit management-plane power fence, never an inference from
  // a lost heartbeat. There is intentionally no automatic election in this model.
  e.setDevicePower(peer.id, false);
  if (peer.power) throw new Error('Não foi possível desligar o antigo ativo.');
  cancel(e, new Set([d.id, peer.id]), true);
  c.role = 'active';
  c.solo = true;
  c.revision = peer.dhcpHa.revision + 1;
  c.confirmed = 0;
  peer.dhcpHa.role = 'standby';
  peer.dhcpHa.solo = false;
  peer.dhcpHa.applied = 0;
  e.emit(
    'CONFIG_CHANGED',
    d.id,
    'DHCP promovido; ' +
      peer.hostname +
      ' desligado por fencing administrativo. Operação sem segunda cópia até resincronizar.'
  );
  transmit(e, d);
}
export function validateDhcpHa(s: Snapshot) {
  for (const d of s.devices) {
    const c = d.dhcpHa;
    if (!c) continue;
    const peer = s.devices.find((p) => p.id === c.peer);
    if (
      !peer?.dhcpHa ||
      peer.dhcpHa.peer !== d.id ||
      peer.dhcpHa.role === c.role ||
      (c.solo && c.role !== 'active') ||
      c.confirmed > c.revision ||
      (c.lastReceivedAt !== undefined && c.lastReceivedAt > s.clock) ||
      (c.role === 'active' && c.confirmed > peer.dhcpHa.applied) ||
      (c.role === 'standby' && c.applied > peer.dhcpHa.revision)
    )
      throw new Error('Par DHCP, papel ou revisão inválidos.');
    validatePair(d, peer);
    const actions = s.queue.map((q) => q.action).filter((a) => 'device' in a && a.device === d.id);
    if (actions.filter((a) => a.kind === 'dhcp-ha-tick' && a.token === c.token).length !== 1)
      throw new Error('Par DHCP exige exatamente um timer de sincronização.');
    if (
      actions.filter((a) => a.kind === 'dhcp-ha-reply').length > 128 ||
      actions.filter((a) => a.kind === 'dhcp-ha-deliver' || a.kind === 'dhcp-ha-confirm').length > 1
    )
      throw new Error('Fila de replicação HA DHCP excede os limites.');
  }
  for (const { at, action: a } of s.queue) {
    if (a.kind === 'dhcp-ha-reply') {
      const d = s.devices.find((d) => d.id === a.device);
      if (
        !d?.dhcpHa ||
        d.dhcpHa.token !== a.token ||
        d.dhcpHa.role !== 'active' ||
        a.revision > d.dhcpHa.revision ||
        !d.dhcpServer?.pools.some((p) => p.name === a.pool && p.port === a.port) ||
        a.deadline < s.clock ||
        a.deadline !== at ||
        a.deadline > s.clock + DHCP_HA_REPLY_MS ||
        (a.type === 'offer' ? a.request.type !== 'discover' : a.request.type !== 'request')
      )
        throw new Error('Resposta HA DHCP pendente inválida.');
    } else if (a.kind === 'dhcp-ha-tick') {
      if (s.devices.find((d) => d.id === a.device)?.dhcpHa?.token !== a.token)
        throw new Error('Timer HA DHCP órfão.');
    } else if (a.kind === 'dhcp-ha-deliver' || a.kind === 'dhcp-ha-confirm') {
      const d = s.devices.find((d) => d.id === a.device),
        c = d && channel(s, d);
      if (
        !d?.dhcpHa ||
        !c ||
        c.link.id !== a.link ||
        c.peer.id !== a.peer ||
        d.dhcpHa.token !== a.token ||
        c.peer.dhcpHa!.token !== a.peerToken ||
        d.dhcpHa.role !== 'active' ||
        a.revision > d.dhcpHa.revision ||
        (a.kind === 'dhcp-ha-confirm' && a.revision > c.peer.dhcpHa!.applied)
      )
        throw new Error('Transferência HA DHCP inválida.');
      validateDhcpDevice({
        ...c.peer,
        dhcpServer: { ...c.peer.dhcpServer!, bindings: a.bindings, declined: a.declined },
      });
    }
  }
}

export function assertDhcpHaPoolEditable(d: Device) {
  if (d.dhcpHa) throw new Error('Remova o par HA DHCP antes de alterar os pools.');
}
