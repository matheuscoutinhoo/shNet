import {
  interfaceSchema,
  LIMITS,
  type Device,
  type Frame,
  type NetworkInterface,
  type Snapshot,
  type Action,
} from '../model';
import type { SimulationEngine } from '../core/engine';
import { LACP, lacpPduSchema, type LacpPdu } from './lacp-model';
import { lacpMembers } from './lacp-members';
import { linkOperational } from '../links/physical';
import { rebuildSpanningTree } from './stp';

const carrier = (s: Snapshot, d: Device, port: string) =>
  s.links.some(
    (l) => [l.a, l.b].some((end) => end.device === d.id && end.port === port) && linkOperational(s, l)
  );
export function configureLacp(
  e: SimulationEngine,
  d: Device,
  number: number,
  mode: 'active' | 'passive',
  members: string[],
  minLinks = 1
) {
  if (
    !['router', 'switch'].includes(d.type) ||
    !Number.isInteger(number) ||
    number < 1 ||
    number > 64 ||
    !['active', 'passive'].includes(mode) ||
    !Number.isInteger(minLinks) ||
    minLinks < 1 ||
    minLinks > 8 ||
    !members.length ||
    members.length > 8 ||
    new Set(members).size !== members.length
  )
    throw new Error('Configuração EtherChannel inválida.');
  const old = d.interfaces.find((p) => p.aggregate?.number === number);
  const physical = members.map((id) => d.interfaces.find((p) => p.id === id));
  if (
    physical.some(
      (p) =>
        !p ||
        p.logical ||
        p.media === 'wifi' ||
        p.tunnel ||
        p.vxlan ||
        p.dot1x ||
        p.supplicant ||
        p.ipv6 ||
        p.aggregate ||
        (p.channel && p.channel !== old?.id) ||
        p.ip ||
        p.dhcp ||
        p.dhcpRelay?.length ||
        p.vrf ||
        p.aclIn ||
        p.aclOut ||
        p.natRole
    )
  )
    throw new Error('Membros devem ser portas físicas livres de stack IP/políticas e de outro grupo.');
  const base = physical[0]!;
  if (physical.some((p) => p!.speed !== base.speed || p!.duplex !== 'full' || p!.mode !== base.mode))
    throw new Error('Membros exigem mesma velocidade, modo e full duplex.');
  if (!old && d.interfaces.length >= 48) throw new Error('Limite de interfaces.');
  const token = e.id('lacp');
  const port = interfaceSchema.parse({
    ...(old ?? base),
    id: old?.id ?? 'po' + number,
    name: 'Port-channel' + number,
    mac:
      old?.mac ?? base.mac.split(':').slice(0, 4).join(':') + ':02:' + number.toString(16).padStart(2, '0'),
    dot1x: undefined,
    supplicant: undefined,
    logical: undefined,
    qos: undefined,
    tunnel: undefined,
    vxlan: undefined,
    channel: undefined,
    ip: old?.ip,
    prefix: old?.prefix,
    vrf: old?.vrf,
    aggregate: {
      number,
      mode,
      members,
      minLinks,
      token,
      tickAt: e.state.clock + 0.001,
      received: [],
      selected: [],
    },
    spanningTree: undefined,
    rx: old?.rx ?? 0,
    tx: old?.tx ?? 0,
    errors: old?.errors ?? 0,
  });
  for (const p of d.interfaces) if (p.channel === old?.id && p.channel) delete p.channel;
  for (const p of physical) {
    p!.channel = port.id;
    delete p!.spanningTree;
  }
  d.interfaces = [...d.interfaces.filter((p) => p !== old), port];
  e.state.queue = e.state.queue.filter(
    ({ action }) => action.kind !== 'lacp-tick' || action.device !== d.id || action.port !== port.id
  );
  e.schedule(0.001, { kind: 'lacp-tick', device: d.id, port: port.id, token });
  if (d.spanningTree?.enabled) rebuildSpanningTree(e, d);
  e.emit(
    'CONFIG_CHANGED',
    d.id,
    `EtherChannel ${number}: ${mode}, ${members.length} membros, mínimo ${minLinks}.`,
    { port: port.id }
  );
  return port;
}
export function removeLacp(e: SimulationEngine, d: Device, port: NetworkInterface) {
  if (!port.aggregate) throw new Error('EtherChannel inexistente.');
  if (
    port.ipv6 ||
    port.ip ||
    port.vrf ||
    port.aclIn ||
    port.aclOut ||
    port.natRole ||
    d.interfaces.some((p) => p.logical?.parent === port.id) ||
    d.dhcpServer?.pools.some((p) => p.port === port.id) ||
    d.firewall?.trustedPorts.includes(port.id) ||
    d.firewall?.zonePolicy?.zones.some((z) => z.ports.includes(port.id)) ||
    d.ospf?.interfaces.some((p) => p.port === port.id) ||
    d.rip?.interfaces.some((p) => p.port === port.id) ||
    d.vrrp?.groups.some((g) => g.port === port.id || g.track?.some((t) => t.port === port.id))
  )
    throw new Error('Remova endereços e referências antes de excluir o EtherChannel.');
  for (const p of d.interfaces) if (p.channel === port.id) delete p.channel;
  d.interfaces = d.interfaces.filter((p) => p !== port);
  d.macTable = d.macTable.filter((m) => m.port !== port.id);
  d.arpTable = d.arpTable.filter((a) => a.port !== port.id);
  e.state.queue = e.state.queue.filter(
    ({ action }) => action.kind !== 'lacp-tick' || action.device !== d.id || action.port !== port.id
  );
  if (d.spanningTree?.enabled) rebuildSpanningTree(e, d);
  e.emit('CONFIG_CHANGED', d.id, 'EtherChannel removido.');
}
function send(e: SimulationEngine, d: Device, aggregate: NetworkInterface, member: NetworkInterface) {
  const agg = aggregate.aggregate!,
    received = agg.received.find((r) => r.port === member.id && r.expiresAt > e.state.clock);
  if (
    !d.power ||
    !aggregate.adminUp ||
    !carrier(e.state, d, member.id) ||
    (agg.mode === 'passive' && !received)
  )
    return;
  const pdu: LacpPdu = lacpPduSchema.parse({
    version: 1,
    active: agg.mode === 'active',
    actor: { system: d.interfaces[0].mac, key: agg.number, port: member.id },
    ...(received ? { partner: { ...received.pdu.actor } } : {}),
  });
  const frame: Frame = { src: member.mac, dst: LACP.mac, etherType: 'LACP', lacp: pdu, hops: LIMITS.l2Hops };
  e.emit('LACP_SENT', d.id, `LACP ${aggregate.name} por ${member.name}.`, { port: member.id, frame });
  e.sendFrame(d.id, member.id, frame);
}
export function refreshLacp(e: SimulationEngine) {
  for (const d of e.state.devices)
    for (const port of d.interfaces.filter((p) => p.aggregate)) {
      const agg = port.aggregate!,
        selected = lacpMembers(e.state, d, port);
      if (JSON.stringify(agg.selected) === JSON.stringify(selected)) continue;
      agg.selected = selected;
      d.macTable = d.macTable.filter((m) => m.port !== port.id);
      e.emit(
        'LACP_STATE_CHANGED',
        d.id,
        `${port.name}: ${selected.length} membros coletando/distribuindo${selected.length ? ', ' + selected.join(', ') : '; grupo indisponível'}.`,
        { port: port.id }
      );
    }
}
export function handleLacpTick(e: SimulationEngine, action: Extract<Action, { kind: 'lacp-tick' }>) {
  const d = e.device(action.device),
    port = d.interfaces.find((p) => p.id === action.port),
    agg = port?.aggregate;
  if (!port || !agg || agg.token !== action.token || agg.tickAt !== e.state.clock) return;
  agg.received = agg.received.filter((r) => r.expiresAt > e.state.clock);
  refreshLacp(e);
  for (const id of agg.members)
    send(
      e,
      d,
      port,
      d.interfaces.find((p) => p.id === id)!
    );
  agg.tickAt = e.state.clock + LACP.tickMs;
  e.schedule(LACP.tickMs, action);
}
export function receiveLacp(e: SimulationEngine, d: Device, member: NetworkInterface, frame: Frame) {
  const port = d.interfaces.find((p) => p.id === member.channel),
    agg = port?.aggregate,
    pdu = frame.lacp;
  if (
    !port ||
    !agg ||
    !pdu ||
    frame.dst !== LACP.mac ||
    !port.adminUp ||
    pdu.actor.system === d.interfaces[0].mac
  )
    return;
  const old = agg.received.find((r) => r.port === member.id);
  const changed = !old || JSON.stringify(old.pdu) !== JSON.stringify(pdu);
  agg.received = [
    ...agg.received.filter((r) => r.port !== member.id),
    { port: member.id, pdu, at: e.state.clock, expiresAt: e.state.clock + LACP.timeoutMs },
  ];
  e.emit('LACP_RECEIVED', d.id, `${port.name}: parceiro ${pdu.actor.system}, key ${pdu.actor.key}.`, {
    port: member.id,
    frame,
  });
  refreshLacp(e);
  if (changed) send(e, d, port, member);
}
export function lacpOutput(e: SimulationEngine, d: Device, port: NetworkInterface, frame: Frame) {
  const members = lacpMembers(e.state, d, port);
  if (!members.length) {
    e.drop(d, 'LACP: grupo sem mínimo de membros sincronizados.', port.id, frame);
    return;
  }
  const packet = frame.packet ?? frame.ipv6;
  const key = packet
    ? `${packet.src}|${packet.dst}|${packet.protocol}|${'sourcePort' in packet ? packet.sourcePort : ''}|${'destinationPort' in packet ? packet.destinationPort : ''}`
    : `${frame.src}|${frame.dst}|${frame.vlan ?? ''}`;
  let hash = 2166136261;
  for (const c of key) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
  port.tx++;
  e.sendFrame(d.id, members[hash % members.length], frame);
}
export function validateLacp(snapshot: Snapshot) {
  for (const link of snapshot.links)
    for (const end of [link.a, link.b])
      if (
        snapshot.devices.find((d) => d.id === end.device)?.interfaces.find((p) => p.id === end.port)
          ?.aggregate
      )
        throw new Error('Cabo em porta agregada inválido.');
  const used = new Set<object>();
  for (const d of snapshot.devices) {
    for (const p of d.interfaces) {
      if (p.channel && !d.interfaces.some((a) => a.id === p.channel && a.aggregate?.members.includes(p.id)))
        throw new Error('Membro sem EtherChannel.');
      const agg = p.aggregate;
      if (!agg) continue;
      if (
        !['router', 'switch'].includes(d.type) ||
        p.logical ||
        p.channel ||
        p.duplex !== 'full' ||
        new Set(agg.members).size !== agg.members.length ||
        d.interfaces.some((other) => other !== p && other.aggregate?.number === agg.number)
      )
        throw new Error('EtherChannel inválido/duplicado.');
      for (const id of agg.members) {
        const member = d.interfaces.find((m) => m.id === id);
        if (
          !member ||
          member.channel !== p.id ||
          member.logical ||
          member.media === 'wifi' ||
          member.tunnel ||
          member.vxlan ||
          member.dot1x ||
          member.supplicant ||
          member.ipv6 ||
          member.aggregate ||
          member.ip ||
          member.dhcp ||
          member.vrf ||
          member.aclIn ||
          member.aclOut ||
          member.natRole ||
          member.speed !== p.speed ||
          member.duplex !== 'full' ||
          member.spanningTree
        )
          throw new Error('Membro EtherChannel incompatível.');
      }
      if (
        new Set(agg.received.map((r) => r.port)).size !== agg.received.length ||
        agg.received.some(
          (r) =>
            !agg.members.includes(r.port) || r.at > snapshot.clock || r.expiresAt !== r.at + LACP.timeoutMs
        ) ||
        JSON.stringify(agg.selected) !== JSON.stringify(lacpMembers(snapshot, d, p))
      )
        throw new Error('Estado LACP inconsistente.');
      const timers = snapshot.queue.filter(
        ({ action }) => action.kind === 'lacp-tick' && action.device === d.id && action.port === p.id
      );
      if (
        timers.length !== 1 ||
        timers[0].at !== agg.tickAt ||
        timers[0].action.kind !== 'lacp-tick' ||
        timers[0].action.token !== agg.token ||
        agg.tickAt < snapshot.clock
      )
        throw new Error('Timer LACP inconsistente.');
      used.add(timers[0].action);
    }
  }
  for (const { action } of snapshot.queue)
    if (action.kind === 'lacp-tick' && !used.has(action)) throw new Error('Timer LACP órfão.');
}
