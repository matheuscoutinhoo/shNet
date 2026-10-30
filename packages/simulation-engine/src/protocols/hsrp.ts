import type { SimulationEngine } from '../core/engine';
import { invalidateProtocolIndex, protocolDevices } from '../core/protocol-index';
import {
  BROADCAST,
  LIMITS,
  type Action,
  type Device,
  type NetworkInterface,
  type Packet,
  type Snapshot,
} from '../model';
import {
  hsrpConfigSchema,
  hsrpGroupConfigSchema,
  hsrpMac,
  hsrpMulticast,
  type HsrpConfig,
  type HsrpGroup,
} from './hsrp-model';
import { interfaceOperational, routingEnabled } from './layer3';
import { ipNumber, sameSubnet, subnet } from './ipv4';
import { isUnicast } from './dhcp-config';
import { checkDevice, deviceTimers, validatedDevice } from '../core/validation-scope';

export function hsrpConfig(d: Device): HsrpConfig[] {
  return (
    d.hsrp?.groups.map((g) =>
      hsrpGroupConfigSchema.parse(
        Object.fromEntries(
          Object.keys(hsrpGroupConfigSchema.shape).map((key) => [key, g[key as keyof HsrpGroup]])
        )
      )
    ) ?? []
  );
}
const portUp = (s: Snapshot, d: Device, p: NetworkInterface) =>
  routingEnabled(d) && !!p.ip && p.prefix !== undefined && interfaceOperational(s, d, p);
export function activeHsrpGroup(s: Snapshot, d: Device, p: NetworkInterface, vip?: string) {
  return portUp(s, d, p)
    ? d.hsrp?.groups.find(
        (g) => g.port === p.id && g.state === 'ACTIVE' && (vip === undefined || g.vip === vip)
      )
    : undefined;
}
export function acceptsHsrpAddress(s: Snapshot, d: Device, ip: string, vrf?: string) {
  return !!d.hsrp?.groups.some(
    (g) =>
      g.vip === ip &&
      g.state === 'ACTIVE' &&
      d.interfaces.some((p) => p.id === g.port && p.vrf === vrf && portUp(s, d, p))
  );
}
export function acceptsHsrpMac(s: Snapshot, d: Device, p: NetworkInterface, mac: string) {
  return !!d.hsrp?.groups.some(
    (g) => g.port === p.id && hsrpMac(g) === mac && !!activeHsrpGroup(s, d, p, g.vip)
  );
}
function validateConfig(d: Device, groups: HsrpConfig[]) {
  if (!['router', 'switch'].includes(d.type)) throw new Error('HSRP requires an IOS routing device.');
  const keys = new Set<string>(),
    vips = new Set<string>();
  for (const g of groups) {
    const p = d.interfaces.find((p) => p.id === g.port);
    if (
      !p ||
      p.mode !== 'routed' ||
      p.loopback ||
      p.vrf ||
      ['serial', 'console', 'wifi', 'mesh'].includes(p.media) ||
      p.ipv4Mode === 'dhcp' ||
      (g.version === 1 && g.group > 255) ||
      g.holdMs <= g.helloMs ||
      groups.some((x) => x.port === g.port && x.version !== g.version)
    )
      throw new Error('Invalid HSRP interface, version, group or timers.');
    if (keys.has(g.port + ':' + g.group) || (g.vip && vips.has(g.vip)))
      throw new Error('Duplicate HSRP group or virtual address.');
    keys.add(g.port + ':' + g.group);
    if (g.vip) vips.add(g.vip);
    if (g.vip) {
      if (
        !isUnicast(g.vip) ||
        d.interfaces.some((p) => p.ip === g.vip) ||
        d.vrrp?.groups.some((x) => x.vip === g.vip) ||
        d.nat?.statics.some((x) => x.global === g.vip) ||
        d.nat?.pools.some(
          (pool) => ipNumber(g.vip!) >= ipNumber(pool.start) && ipNumber(g.vip!) <= ipNumber(pool.end)
        )
      )
        throw new Error('HSRP VIP must be unique and unicast.');
      if (p.ip && p.prefix !== undefined) {
        const range = subnet(p.ip, p.prefix);
        if (
          p.prefix > 30 ||
          !sameSubnet(g.vip, p.ip, p.prefix) ||
          g.vip === range.network ||
          g.vip === range.broadcast
        )
          throw new Error('HSRP VIP must be a usable address in the interface subnet.');
      }
    }
    if (
      new Set(g.track.map((t) => t.port)).size !== g.track.length ||
      g.track.some((t) => !d.interfaces.some((p) => p.id === t.port))
    )
      throw new Error('Invalid HSRP tracked interface.');
  }
}
const priority = (s: Snapshot, d: Device, g: HsrpConfig) =>
  Math.max(
    0,
    g.priority -
      g.objectTrack
        .filter((t) => !d.monitoring?.tracks.find((o) => o.id === t.object)?.state)
        .reduce((n, t) => n + t.decrement, 0) -
      g.track
        .filter(
          (t) =>
            !interfaceOperational(
              s,
              d,
              d.interfaces.find((p) => p.id === t.port)!
            )
        )
        .reduce((n, t) => n + t.decrement, 0)
  );
const rank = (a: { ip: string; priority: number }, b: { ip: string; priority: number }) =>
  b.priority - a.priority || ipNumber(b.ip) - ipNumber(a.ip);
function cancel(e: SimulationEngine, d: Device, g: HsrpGroup) {
  e.state.queue = e.state.queue.filter(
    (q) => q.action.kind !== 'hsrp-tick' || q.action.device !== d.id || q.action.token !== g.token
  );
  delete g.tickAt;
}
function send(e: SimulationEngine, d: Device, g: HsrpGroup, opcode: 'hello' | 'coup' | 'resign' = 'hello') {
  const p = d.interfaces.find((p) => p.id === g.port)!;
  if (!g.vip || !portUp(e.state, d, p) || !['SPEAK', 'STANDBY', 'ACTIVE'].includes(g.state)) return;
  const target = hsrpMulticast(g.version);
  e.sendFrame(d.id, p.id, {
    src: g.version === 1 && g.state === 'ACTIVE' ? hsrpMac(g) : p.mac,
    dst: target.mac,
    etherType: 'IPv4',
    hops: LIMITS.l2Hops,
    packet: {
      src: p.ip!,
      dst: target.ip,
      ttl: 1,
      protocol: 'UDP',
      sourcePort: 1985,
      destinationPort: 1985,
      bytes: g.version === 1 ? 48 : 70,
      payload: {
        protocol: 'HSRP',
        message: {
          version: g.version,
          group: g.group,
          opcode,
          state: g.state as 'SPEAK' | 'STANDBY' | 'ACTIVE',
          priority: g.effectivePriority,
          helloMs: g.helloMs,
          holdMs: g.holdMs,
          vip: g.vip,
        },
      },
    },
  });
  g.sent++;
}
function transition(e: SimulationEngine, d: Device, g: HsrpGroup, state: HsrpGroup['state']) {
  if (g.state === state) return;
  const previous = g.state;
  g.state = state;
  g.changedAt = e.state.clock;
  e.emit('HSRP_STATE_CHANGED', d.id, `HSRP ${g.group}, VIP ${g.vip ?? 'unset'}: ${previous} → ${state}.`, {
    port: g.port,
  });
  if (state === 'ACTIVE') {
    e.sendFrame(d.id, g.port, {
      src: hsrpMac(g),
      dst: BROADCAST,
      etherType: 'ARP',
      hops: LIMITS.l2Hops,
      arp: { kind: 'request', senderIp: g.vip!, senderMac: hsrpMac(g), targetIp: g.vip! },
    });
  }
  g.nextHello = e.state.clock;
}
function elect(e: SimulationEngine, d: Device, g: HsrpGroup) {
  const now = e.state.clock,
    p = d.interfaces.find((p) => p.id === g.port)!;
  g.peers = g.peers.filter((peer) => peer.expiresAt > now);
  const self = { ip: p.ip!, priority: g.effectivePriority };
  const active = g.peers.filter((peer) => peer.state === 'ACTIVE').sort(rank)[0];
  if (active) {
    if ((g.state === 'ACTIVE' || g.preempt) && rank(self, active) < 0) {
      if (g.state !== 'ACTIVE') send(e, d, g, 'coup');
      transition(e, d, g, 'ACTIVE');
      return;
    }
    if (g.state === 'ACTIVE') send(e, d, g, 'resign');
    g.activeDeadline = active.expiresAt;
    const standby = g.peers.filter((peer) => peer.state === 'STANDBY').sort(rank)[0];
    if (standby) g.standbyDeadline = standby.expiresAt;
    if (g.state === 'LISTEN' && standby) return;
    if (g.state === 'LISTEN' && !standby && now < g.standbyDeadline) return;
    const candidates = [
      self,
      ...g.peers.filter((peer) => peer.ip !== active.ip && ['SPEAK', 'STANDBY'].includes(peer.state)),
    ].sort(rank);
    transition(e, d, g, candidates[0].ip === self.ip ? 'STANDBY' : 'LISTEN');
    return;
  }
  if (g.state === 'ACTIVE') return;
  if (now < g.activeDeadline) return;
  const candidates = [
    self,
    ...g.peers.filter((peer) => peer.state === 'SPEAK' || peer.state === 'STANDBY'),
  ].sort(rank);
  const won = candidates[0].ip === self.ip;
  transition(e, d, g, won ? 'ACTIVE' : candidates[1]?.ip === self.ip ? 'STANDBY' : 'LISTEN');
  if (!won) g.activeDeadline = now + g.holdMs;
}
function refreshGroup(e: SimulationEngine, d: Device, g: HsrpGroup) {
  const p = d.interfaces.find((p) => p.id === g.port)!;
  if (!g.vip || !portUp(e.state, d, p)) {
    cancel(e, d, g);
    transition(e, d, g, 'INIT');
    g.peers = [];
    return;
  }
  const effective = priority(e.state, d, g);
  if (effective !== g.effectivePriority) g.nextHello = e.state.clock;
  g.effectivePriority = effective;
  if (g.state === 'INIT') {
    g.startedAt = e.state.clock;
    g.activeDeadline = e.state.clock + g.holdMs;
    g.standbyDeadline = e.state.clock + g.holdMs;
    transition(e, d, g, 'SPEAK');
  }
  elect(e, d, g);
  const at = Math.max(
    e.state.clock + 0.001,
    Math.min(
      g.state === 'LISTEN' ? Infinity : g.nextHello,
      g.state === 'ACTIVE' ? Infinity : g.activeDeadline,
      ...g.peers.map((peer) => peer.expiresAt),
      e.state.clock + g.helloMs
    )
  );
  if (g.tickAt === at) return;
  cancel(e, d, g);
  g.tickAt = at;
  e.schedule(at - e.state.clock, { kind: 'hsrp-tick', device: d.id, token: g.token });
}
export function configureHsrp(e: SimulationEngine, d: Device, input: unknown) {
  const c = hsrpConfigSchema.parse(input);
  validateConfig(d, c.groups);
  for (const old of d.hsrp?.groups ?? []) {
    const next = c.groups.find((g) => g.port === old.port && g.group === old.group);
    if (!next || next.version !== old.version || next.vip !== old.vip) {
      if (old.state === 'ACTIVE') send(e, d, old, 'resign');
      cancel(e, d, old);
    }
  }
  const old = d.hsrp?.groups ?? [];
  d.hsrp = {
    groups: c.groups.map((g) => {
      const previous = old.find((x) => x.port === g.port && x.group === g.group);
      if (previous && previous.vip === g.vip && previous.version === g.version)
        return { ...previous, ...g, nextHello: e.state.clock };
      return {
        ...g,
        token: e.id('hsrp'),
        state: 'INIT' as const,
        changedAt: e.state.clock,
        startedAt: e.state.clock,
        effectivePriority: priority(e.state, d, g),
        nextHello: e.state.clock,
        activeDeadline: e.state.clock + g.holdMs,
        standbyDeadline: e.state.clock + g.holdMs,
        peers: [],
        sent: 0,
        received: 0,
      };
    }),
  };
  invalidateProtocolIndex(e.state);
  refreshHsrp(e);
}
export function refreshHsrp(e: SimulationEngine) {
  for (const d of protocolDevices(e.state, 'hsrp')) for (const g of d.hsrp!.groups) refreshGroup(e, d, g);
}
export function handleHsrpTick(e: SimulationEngine, a: Extract<Action, { kind: 'hsrp-tick' }>) {
  const d = e.device(a.device),
    g = d.hsrp?.groups.find((g) => g.token === a.token);
  if (!g) return;
  delete g.tickAt;
  refreshGroup(e, d, g);
  if (g.state !== 'INIT' && g.state !== 'LISTEN' && g.nextHello <= e.state.clock) {
    send(e, d, g);
    g.nextHello = e.state.clock + g.helloMs;
  }
  refreshGroup(e, d, g);
}
export function receiveHsrp(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  packet: Extract<Packet, { protocol: 'UDP' }>
) {
  if (packet.payload.protocol !== 'HSRP') return;
  const m = packet.payload.message,
    g = d.hsrp?.groups.find(
      (g) => g.port === p.id && g.group === m.group && g.version === m.version && g.vip === m.vip
    );
  if (
    !g ||
    !portUp(e.state, d, p) ||
    packet.ttl !== 1 ||
    packet.sourcePort !== 1985 ||
    packet.destinationPort !== 1985 ||
    packet.dst !== hsrpMulticast(m.version).ip ||
    packet.src === p.ip ||
    !sameSubnet(packet.src, p.ip!, p.prefix!) ||
    !isUnicast(packet.src)
  )
    return;
  g.received++;
  g.peers = g.peers.filter((peer) => peer.ip !== packet.src);
  if (m.opcode === 'resign') {
    g.activeDeadline = e.state.clock;
    g.standbyDeadline = e.state.clock;
  } else {
    if (g.peers.length === 32) g.peers.shift();
    g.peers.push({
      ip: packet.src,
      state: m.opcode === 'coup' ? 'ACTIVE' : m.state,
      priority: m.priority,
      expiresAt: e.state.clock + m.holdMs,
    });
  }
  refreshGroup(e, d, g);
}
export function validateHsrp(s: Snapshot) {
  const tokens = new Set<string>();
  for (const d of s.devices) {
    if (!d.hsrp) continue;
    if (!checkDevice(d.id)) {
      for (const g of d.hsrp.groups) {
        if (tokens.has(g.token)) throw new Error('Invalid HSRP runtime state.');
        tokens.add(g.token);
      }
      continue;
    }
    validateConfig(d, hsrpConfig(d));
    for (const g of d.hsrp.groups) {
      const p = d.interfaces.find((p) => p.id === g.port)!,
        timers = deviceTimers(s, d.id, 'hsrp-tick').filter(
          (q) => q.action.kind === 'hsrp-tick' && q.action.token === g.token
        );
      if (
        tokens.has(g.token) ||
        g.changedAt > s.clock ||
        g.startedAt > s.clock ||
        new Set(g.peers.map((peer) => peer.ip)).size !== g.peers.length ||
        g.peers.some((peer) => peer.ip === p.ip)
      )
        throw new Error('Invalid HSRP runtime state.');
      tokens.add(g.token);
      if (
        (g.tickAt !== undefined && (timers.length !== 1 || timers[0].at !== g.tickAt)) ||
        (g.tickAt === undefined && timers.length)
      )
        throw new Error('HSRP timer missing or inconsistent.');
      if (g.state !== 'INIT' && (!g.vip || !portUp(s, d, p)))
        throw new Error('HSRP active state requires an operational IPv4 interface.');
    }
  }
  for (const { action } of s.queue)
    if (
      action.kind === 'hsrp-tick' &&
      !validatedDevice(s, action.device)?.hsrp?.groups.some((g) => g.token === action.token)
    )
      throw new Error('Orphan HSRP timer.');
}
