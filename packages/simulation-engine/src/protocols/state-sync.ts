import type { Action, Device, FirewallSession, NatBinding, Snapshot } from '../model';
import type { SimulationEngine } from '../core/engine';
import { random } from '../core/queue';
import { cableMetrics, linkOperational } from '../links/physical';
import { canonicalScenarioJson as canonicalJson } from '../canonical-json';
import { firewallRule, firewallUnicast } from './firewall-policy';
import { ipNumber, sameSubnet } from './ipv4';
import { stateSyncPairSchema, type StateSyncRecord } from './state-sync-model';

type Delivery = Extract<Action, { kind: 'state-sync-deliver' }>;
const heartbeatMs = 1000;
const key = (r: StateSyncRecord) => r.table + ':' + r.id;
function validSession(s: FirewallSession) {
  return (
    firewallUnicast(s.clientIp) &&
    firewallUnicast(s.serverIp) &&
    s.clientIp.includes(':') === s.serverIp.includes(':') &&
    (s.protocol !== 'TCP' ||
      ((s.state === 'SYN-SENT' || (s.serverInitial !== undefined && s.serverNext !== undefined)) &&
        (s.state !== 'CLOSING' || s.clientFin || s.serverFin)))
  );
}
function validBinding(b: NatBinding) {
  const port = (p: string | undefined) =>
    p !== undefined && /^\d+$/.test(p) && Number(p) >= 1 && Number(p) <= 65535;
  if (!firewallUnicast(b.inside) || !firewallUnicast(b.global)) return false;
  if (b.protocol === 'ip') return !b.insideToken && !b.globalToken && !b.remote && b.remotePort === undefined;
  if (
    !b.insideToken ||
    !b.globalToken ||
    !b.remote ||
    !firewallUnicast(b.remote) ||
    b.remotePort === undefined
  )
    return false;
  return b.protocol === 'ICMP'
    ? /^nat-icmp-\d+$/.test(b.globalToken)
    : port(b.insideToken) && port(b.globalToken);
}
function record(device: Device, table: StateSyncRecord['table'], id: string) {
  return device.stateSync?.records.find((r) => r.table === table && r.id === id);
}
function channel(s: Snapshot, d: Device) {
  const peer = s.devices.find((p) => p.id === d.stateSync?.peer);
  if (!d.stateSync || peer?.stateSync?.peer !== d.id) return;
  const link = s.links.find(
    (l) =>
      [l.a, l.b].some((p) => p.device === d.id && p.port === d.stateSync!.port) &&
      [l.a, l.b].some((p) => p.device === peer.id && p.port === peer.stateSync!.port)
  );
  return link && { peer, link };
}
function mapped(d: Device, port: string) {
  return d.stateSync?.portMap.find((p) => p.local === port)?.remote;
}
// Compare policies and shared NAT ranges after translating interface identities.
// Runtime counters, sessions and physical IPs are deliberately excluded.
export function stateSyncCompatible(d: Device, peer: Device) {
  const firewall = (x: Device, translate: boolean) => {
    const c = x.firewall;
    if (!c) return null;
    const port = (id: string) => (translate ? mapped(x, id) : id);
    return {
      enabled: c.enabled,
      trustedPorts: c.trustedPorts.map(port).sort(),
      protocols: [...(c.protocols ?? ['TCP'])].sort(),
      zones: c.zonePolicy?.zones
        .map((z) => ({ name: z.name, ports: z.ports.map(port).sort() }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      rules: c.zonePolicy?.rules.slice().sort((a, b) => a.sequence - b.sequence),
    };
  };
  const nat = (x: Device, translate: boolean) =>
    x.nat
      ? {
          enabled: x.nat.enabled,
          statics: x.nat.statics.map((p) => ({
            ...p,
            outside: translate ? mapped(x, p.outside) : p.outside,
          })),
          pools: x.nat.pools.map((p) => ({ ...p, outside: translate ? mapped(x, p.outside) : p.outside })),
        }
      : null;
  return (
    canonicalJson(firewall(d, true)) === canonicalJson(firewall(peer, false)) &&
    canonicalJson(nat(d, true)) === canonicalJson(nat(peer, false))
  );
}
export function stateSyncStatus(s: Snapshot, d: Device) {
  if (!d.stateSync) return 'disabled';
  const c = channel(s, d);
  if (!c || !linkOperational(s, c.link)) return 'unavailable';
  if (!stateSyncCompatible(d, c.peer)) return 'policy-mismatch';
  return 'ready';
}
export function stateSyncPending(s: Snapshot, d: Device) {
  const peer = s.devices.find((p) => p.id === d.stateSync?.peer);
  return (
    d.stateSync?.records.filter(
      (r) => r.expiresAt > s.clock && (peer ? (record(peer, r.table, r.id)?.revision ?? 0) : 0) < r.revision
    ).length ?? 0
  );
}
export function disableStateSync(e: SimulationEngine, d: Device) {
  const peer = e.state.devices.find((p) => p.id === d.stateSync?.peer);
  const ids = new Set([d.id]);
  if (peer?.stateSync?.peer === d.id) ids.add(peer.id);
  for (const p of e.state.devices) if (ids.has(p.id)) delete p.stateSync;
  e.state.queue = e.state.queue.filter(
    ({ action: a }) =>
      (a.kind !== 'state-sync-tick' && a.kind !== 'state-sync-deliver') ||
      (!ids.has(a.device) && (a.kind !== 'state-sync-deliver' || !ids.has(a.peer)))
  );
  e.emit(
    'CONFIG_CHANGED',
    d.id,
    'Sincronização de estado desativada; réplicas expiram pelos timers originais.'
  );
}
export function configureStateSyncPair(e: SimulationEngine, a: Device, b: Device, input: unknown) {
  const c = stateSyncPairSchema.parse(input);
  if (a.id === b.id || a.type !== 'router' || b.type !== 'router')
    throw new Error('Sincronização HA exige dois roteadores distintos.');
  if ((a.stateSync && a.stateSync.peer !== b.id) || (b.stateSync && b.stateSync.peer !== a.id))
    throw new Error('Desative o par HA existente antes de trocar o peer.');
  const savedA = a.stateSync,
    savedB = b.stateSync;
  // Validate without consuming IDs or clearing the existing pair on failure.
  const candidate = (peer: string, port: string, reverse: boolean) => ({
    peer,
    port,
    token: 'state-sync-candidate',
    portMap: c.mappings.map((p) => ({ local: reverse ? p.b : p.a, remote: reverse ? p.a : p.b })),
    records: [],
    sent: 0,
    received: 0,
    rejected: 0,
  });
  a.stateSync = candidate(b.id, c.portA, false);
  b.stateSync = candidate(a.id, c.portB, true);
  try {
    validateStateSyncPair(a, b);
    if (!channel(e.state, a)) throw new Error('Conecte diretamente as portas dedicadas de sincronização HA.');
    if (!stateSyncCompatible(a, b))
      throw new Error('O par HA exige políticas de firewall e pools NAT equivalentes.');
  } finally {
    a.stateSync = savedA;
    b.stateSync = savedB;
  }
  disableStateSync(e, a);
  a.stateSync = { ...candidate(b.id, c.portA, false), token: e.id('state-sync') };
  b.stateSync = { ...candidate(a.id, c.portB, true), token: e.id('state-sync') };
  for (const d of [a, b]) {
    e.schedule(heartbeatMs, { kind: 'state-sync-tick', device: d.id, token: d.stateSync!.token });
    for (const session of d.firewall?.sessions ?? []) syncFirewall(e, d, session);
    for (const binding of d.nat?.bindings ?? []) syncNat(e, d, binding);
  }
  e.emit(
    'CONFIG_CHANGED',
    a.id,
    'Par HA configurado com ' + b.hostname + '; cópia sujeita ao enlace dedicado.'
  );
}
function remember(
  e: SimulationEngine,
  d: Device,
  table: StateSyncRecord['table'],
  entry: FirewallSession | NatBinding,
  deleted: boolean
) {
  const c = d.stateSync;
  if (!c) return;
  c.records = c.records.filter(
    (r) => r.expiresAt > e.state.clock && !(r.table === table && r.id === entry.id)
  );
  if (c.records.length >= 4096) {
    c.rejected++;
    e.emit('HA_SYNC_REJECTED', d.id, 'Limite de 4096 registros HA; estado não replicado.');
    return;
  }
  const r: StateSyncRecord = {
    table,
    id: entry.id,
    revision: ++e.state.sequence,
    expiresAt: entry.expiresAt,
    deleted,
  };
  c.records.push(r);
  transmit(e, d, r);
}
export function syncFirewall(e: SimulationEngine, d: Device, entry: FirewallSession, deleted = false) {
  remember(e, d, 'firewall', entry, deleted);
}
export function syncNat(e: SimulationEngine, d: Device, entry: NatBinding, deleted = false) {
  remember(e, d, 'nat', entry, deleted);
}
function transmit(e: SimulationEngine, d: Device, r: StateSyncRecord) {
  const c = channel(e.state, d);
  if (!c || !linkOperational(e.state, c.link) || !d.stateSync || !c.peer.stateSync) return;
  if (!r.deleted && !stateSyncCompatible(d, c.peer)) return;
  if ((record(c.peer, r.table, r.id)?.revision ?? 0) >= r.revision) return;
  // One in-flight update per record and direction. New mutations are sent after
  // delivery or retried by the heartbeat; continuous traffic cannot postpone it.
  if (
    e.state.queue.some(
      ({ action: a }) =>
        a.kind === 'state-sync-deliver' &&
        a.device === d.id &&
        a.peer === c.peer.id &&
        key(a.record) === key(r)
    )
  )
    return;
  const session =
    !r.deleted && r.table === 'firewall' ? d.firewall?.sessions.find((p) => p.id === r.id) : undefined;
  const binding = !r.deleted && r.table === 'nat' ? d.nat?.bindings.find((p) => p.id === r.id) : undefined;
  if (!r.deleted && !session && !binding) return;
  const action: Delivery = {
    kind: 'state-sync-deliver',
    device: d.id,
    peer: c.peer.id,
    token: d.stateSync.token,
    peerToken: c.peer.stateSync.token,
    link: c.link.id,
    record: r,
    ...(session ? { session } : {}),
    ...(binding ? { binding } : {}),
  };
  const port = d.interfaces.find((p) => p.id === d.stateSync!.port)!;
  port.tx++;
  d.stateSync.sent++;
  e.emit('HA_SYNC_SENT', d.id, 'Estado ' + r.table + '/' + r.id + ' revisão ' + r.revision + '.', {
    port: port.id,
    peer: c.peer.id,
    link: c.link.id,
  });
  if (random(e.state) < c.link.loss) return;
  const bytes = new TextEncoder().encode(JSON.stringify(action)).length;
  e.schedule(
    Math.max(
      0.001,
      cableMetrics(c.link).latency +
        (random(e.state) * 2 - 1) * c.link.jitter +
        (bytes * 8) / (port.speed * 1000)
    ),
    action
  );
}
function install(e: SimulationEngine, d: Device, source: Device, a: Delivery) {
  const r = a.record;
  if (r.table === 'firewall') {
    const config = d.firewall;
    if (!config) return r.deleted;
    let session = a.session && structuredClone(a.session);
    if (!r.deleted) {
      if (
        !session ||
        !validSession(session) ||
        session.id !== r.id ||
        session.expiresAt !== r.expiresAt ||
        !config.enabled
      )
        return false;
      const inside = mapped(source, session.inside),
        outside = mapped(source, session.outside);
      if (!inside || !outside) return false;
      session = { ...session, inside, outside };
      const allows = config.zonePolicy
        ? firewallRule(
            d,
            inside,
            outside,
            session.protocol,
            session.protocol === 'ICMP' ? undefined : session.serverPort
          )?.action === 'inspect'
        : (config.protocols ?? ['TCP']).includes(session.protocol) &&
          config.trustedPorts.includes(inside) &&
          !config.trustedPorts.includes(outside);
      if (
        !allows ||
        config.sessions.some(
          (p) =>
            p.id !== r.id &&
            p.protocol === session!.protocol &&
            p.inside === inside &&
            p.outside === outside &&
            p.clientIp === session!.clientIp &&
            p.serverIp === session!.serverIp &&
            (p.protocol === 'ICMP' && session!.protocol === 'ICMP'
              ? p.probeId === session!.probeId
              : p.protocol !== 'ICMP' &&
                session!.protocol !== 'ICMP' &&
                p.clientPort === session!.clientPort &&
                p.serverPort === session!.serverPort)
        )
      )
        return false;
      if (!config.sessions.some((p) => p.id === r.id) && config.sessions.length >= 1024) return false;
    }
    config.sessions = config.sessions.filter((p) => p.id !== r.id);
    e.state.queue = e.state.queue.filter(
      ({ action: p }) => p.kind !== 'firewall-expire' || p.device !== d.id || p.session !== r.id
    );
    if (!r.deleted && session) {
      config.sessions.push(session);
      e.scheduleAt(r.expiresAt, {
        kind: 'firewall-expire',
        device: d.id,
        session: r.id,
        at: r.expiresAt,
      });
    }
  } else {
    const config = d.nat;
    if (!config) return r.deleted;
    const binding = a.binding && structuredClone(a.binding);
    if (!r.deleted) {
      if (
        !binding ||
        !validBinding(binding) ||
        binding.id !== r.id ||
        binding.expiresAt !== r.expiresAt ||
        !config.enabled
      )
        return false;
      const pool = config.pools.find((p) => p.name === binding.pool);
      if (
        !pool ||
        !sameSubnet(pool.source.network, binding.inside, pool.source.prefix) ||
        ipNumber(binding.global) < ipNumber(pool.start) ||
        ipNumber(binding.global) > ipNumber(pool.end) ||
        pool.overload === (binding.protocol === 'ip')
      )
        return false;
      if (
        config.bindings.some(
          (p) =>
            p.id !== r.id &&
            p.global === binding.global &&
            (p.protocol === 'ip' ||
              binding.protocol === 'ip' ||
              (p.protocol === binding.protocol && p.globalToken === binding.globalToken))
        )
      )
        return false;
      if (!config.bindings.some((p) => p.id === r.id) && config.bindings.length >= 1024) return false;
    }
    config.bindings = config.bindings.filter((p) => p.id !== r.id);
    e.state.queue = e.state.queue.filter(
      ({ action: p }) => p.kind !== 'nat-expire' || p.device !== d.id || p.binding !== r.id
    );
    if (!r.deleted && binding) {
      config.bindings.push(binding);
      e.scheduleAt(r.expiresAt, {
        kind: 'nat-expire',
        device: d.id,
        binding: r.id,
        expiresAt: r.expiresAt,
      });
    }
  }
  return true;
}
export function handleStateSync(
  e: SimulationEngine,
  a: Extract<Action, { kind: 'state-sync-tick' | 'state-sync-deliver' }>
) {
  const d = e.state.devices.find((p) => p.id === a.device);
  if (!d?.stateSync || d.stateSync.token !== a.token) return;
  if (a.kind === 'state-sync-tick') {
    d.stateSync.records = d.stateSync.records.filter((r) => r.expiresAt > e.state.clock);
    for (const r of d.stateSync.records) transmit(e, d, r);
    e.schedule(heartbeatMs, a);
    return;
  }
  const c = channel(e.state, d);
  if (
    !c ||
    c.peer.id !== a.peer ||
    c.link.id !== a.link ||
    c.peer.stateSync?.token !== a.peerToken ||
    !linkOperational(e.state, c.link)
  )
    return;
  const peer = c.peer,
    config = peer.stateSync!;
  const sourceRecord = record(d, a.record.table, a.record.id);
  if (
    a.record.expiresAt > e.state.clock &&
    !(!a.record.deleted && sourceRecord?.deleted && sourceRecord.revision >= a.record.revision) &&
    (record(peer, a.record.table, a.record.id)?.revision ?? 0) < a.record.revision
  ) {
    const compatible = a.record.deleted || stateSyncCompatible(d, peer);
    config.records = config.records.filter((r) => r.expiresAt > e.state.clock);
    if (
      !compatible ||
      (!record(peer, a.record.table, a.record.id) && config.records.length >= 4096) ||
      !install(e, peer, d, a)
    ) {
      config.rejected++;
      e.emit('HA_SYNC_REJECTED', peer.id, 'Estado recusado: política, colisão ou limite HA.', {
        peer: d.id,
        link: c.link.id,
      });
    } else {
      config.records = config.records.filter((r) => key(r) !== key(a.record));
      config.records.push(structuredClone(a.record));
      config.received++;
      config.lastReceivedAt = e.state.clock;
      peer.interfaces.find((p) => p.id === config.port)!.rx++;
      e.emit(
        'HA_SYNC_RECEIVED',
        peer.id,
        'Estado ' + a.record.table + '/' + a.record.id + ' revisão ' + a.record.revision + '.',
        { peer: d.id, link: c.link.id }
      );
    }
  }
  const latest = record(d, a.record.table, a.record.id);
  if (latest && latest.revision > a.record.revision) transmit(e, d, latest);
}
function validateStateSyncPair(d: Device, peer: Device) {
  const c = d.stateSync!,
    p = peer.stateSync!;
  const physical = (x: Device, id: string) =>
    x.interfaces.find(
      (p) =>
        p.id === id &&
        p.mode === 'routed' &&
        !p.logical &&
        !p.loopback &&
        !p.aggregate &&
        !p.channel &&
        !p.tunnel &&
        !p.vxlan &&
        ['rj45', 'sfp', 'qsfp'].includes(p.media)
    );
  if (
    d.type !== 'router' ||
    peer.type !== 'router' ||
    d.id === peer.id ||
    p.peer !== d.id ||
    !physical(d, c.port) ||
    !physical(peer, p.port)
  )
    throw new Error('Par HA ou interface dedicada inválida.');
  for (const x of [d, peer]) {
    const s = x.stateSync!;
    if (
      new Set(s.portMap.map((p) => p.local)).size !== s.portMap.length ||
      new Set(s.portMap.map((p) => p.remote)).size !== s.portMap.length
    )
      throw new Error('Mapeamento HA duplicado.');
    for (const m of s.portMap) {
      const other = x.id === d.id ? peer : d;
      const local = x.interfaces.find((p) => p.id === m.local),
        remote = other.interfaces.find((p) => p.id === m.remote);
      if (
        !local ||
        !remote ||
        local.mode !== 'routed' ||
        remote.mode !== 'routed' ||
        m.local === s.port ||
        m.remote === other.stateSync!.port ||
        local.vrf !== remote.vrf ||
        local.natRole !== remote.natRole ||
        !other.stateSync!.portMap.some((p) => p.local === m.remote && p.remote === m.local)
      )
        throw new Error('Mapeamento HA inválido ou não recíproco.');
    }
    const used = [
      ...x.interfaces
        .filter(
          (p) =>
            p.mode === 'routed' &&
            !p.loopback &&
            p.id !== s.port &&
            (p.ip || p.natRole || p.ipv6?.addresses.some((a) => !a.ip.startsWith('fe80:')))
        )
        .map((p) => p.id),
      ...(x.firewall?.trustedPorts ?? []),
      ...(x.firewall?.zonePolicy?.zones.flatMap((z) => z.ports) ?? []),
      ...(x.nat?.pools.map((p) => p.outside) ?? []),
      ...(x.nat?.statics.map((p) => p.outside) ?? []),
    ];
    if (used.includes(s.port) || used.some((id) => !s.portMap.some((p) => p.local === id)))
      throw new Error('Mapeie todas as interfaces de firewall/NAT e reserve uma porta dedicada.');
    const syncPort = x.interfaces.find((p) => p.id === s.port)!;
    if (
      syncPort.ip ||
      syncPort.natRole ||
      x.vrrp?.groups.some((g) => g.port === s.port) ||
      x.interfaces.some((p) => p.logical?.parent === s.port)
    )
      throw new Error('A porta HA deve ser dedicada, sem IP, NAT, VRRP ou subinterfaces.');
  }
}
export function validateStateSync(s: Snapshot) {
  for (const d of s.devices) {
    const c = d.stateSync;
    if (!c) continue;
    const peer = s.devices.find((p) => p.id === c.peer);
    if (!peer?.stateSync) throw new Error('Peer HA ausente.');
    validateStateSyncPair(d, peer);
    if (
      (c.lastReceivedAt !== undefined && c.lastReceivedAt > s.clock) ||
      new Set(c.records.map(key)).size !== c.records.length ||
      c.records.some((r) => r.revision > s.sequence)
    )
      throw new Error('Registros de sincronização HA inválidos.');
    const timers = s.queue.filter(({ action: a }) => a.kind === 'state-sync-tick' && a.device === d.id);
    if (
      timers.length !== 1 ||
      timers[0].action.kind !== 'state-sync-tick' ||
      timers[0].action.token !== c.token ||
      timers[0].at > s.clock + heartbeatMs
    )
      throw new Error('Par HA sem timer de reconciliação válido.');
  }
  for (const { action: a } of s.queue) {
    if (a.kind !== 'state-sync-tick' && a.kind !== 'state-sync-deliver') continue;
    const source = s.devices.find((p) => p.id === a.device);
    if (!source?.stateSync || source.stateSync.token !== a.token) throw new Error('Timer HA órfão.');
    if (a.kind === 'state-sync-deliver') {
      const peer = s.devices.find((p) => p.id === a.peer);
      if (
        peer?.stateSync?.peer !== source.id ||
        peer.stateSync.token !== a.peerToken ||
        source.stateSync.peer !== peer.id ||
        channel(s, source)?.link.id !== a.link ||
        a.record.revision > s.sequence ||
        (a.record.deleted && (a.session || a.binding)) ||
        (!a.record.deleted &&
          (a.record.table === 'firewall' ? !a.session || !!a.binding : !a.binding || !!a.session)) ||
        (a.session &&
          (!validSession(a.session) ||
            a.session.id !== a.record.id ||
            a.session.expiresAt !== a.record.expiresAt ||
            !source.stateSync.portMap.some((p) => p.local === a.session!.inside) ||
            !source.stateSync.portMap.some((p) => p.local === a.session!.outside))) ||
        (a.binding &&
          (!validBinding(a.binding) ||
            a.binding.id !== a.record.id ||
            a.binding.expiresAt !== a.record.expiresAt))
      )
        throw new Error('Entrega HA inválida.');
    }
  }
}
