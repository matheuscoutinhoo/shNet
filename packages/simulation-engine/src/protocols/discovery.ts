import type { SimulationEngine } from '../core/engine';
import type { Action, Device, Frame, NetworkInterface, Snapshot } from '../model';
import { discoveryConfigSchema, type DiscoveryMessage } from './discovery-model';
import { interfaceOperational } from './layer3';
import { invalidateProtocolIndex, protocolDevices } from '../core/protocol-index';
import { phoneVoiceVlans, refreshPhoneVoiceNetwork } from './voice-vlan';

const destination = { CDP: '01:00:0c:cc:cc:cc', LLDP: '01:80:c2:00:00:0e' };
const physical = (p: NetworkInterface) =>
  !p.logical && !p.loopback && !p.aggregate && !p.bond && ['rj45', 'sfp', 'qsfp'].includes(p.media);
export function discoveryConfig(d: Device) {
  return discoveryConfigSchema.parse(
    d.discovery
      ? Object.fromEntries(
          Object.keys(discoveryConfigSchema.shape).map((key) => [
            key,
            d.discovery![key as keyof NonNullable<Device['discovery']>],
          ])
        )
      : {}
  );
}
const enabled = (
  d: Device,
  p: NetworkInterface,
  protocol: DiscoveryMessage['protocol'],
  direction: 'tx' | 'rx'
) =>
  physical(p) &&
  !!d.discovery &&
  (protocol === 'CDP'
    ? d.discovery.cdp && p.cdpEnabled !== false
    : d.discovery.lldp && (direction === 'tx' ? p.lldpTransmit !== false : p.lldpReceive !== false));

function advertise(
  e: SimulationEngine,
  d: Device,
  protocol: DiscoveryMessage['protocol'],
  ttl?: number,
  portId?: string
) {
  for (const p of d.interfaces) {
    if (
      (portId !== undefined && p.id !== portId) ||
      !enabled(d, p, protocol, 'tx') ||
      !interfaceOperational(e.state, d, p)
    )
      continue;
    const message: DiscoveryMessage = {
      protocol,
      chassisId: d.interfaces[0].mac,
      deviceId: d.hostname,
      portId: p.name,
      platform: 'shLab ' + (d.profile ?? d.type),
      capabilities: d.phone?.enabled
        ? ['Host', 'Phone']
        : d.type === 'router'
          ? ['Router']
          : d.ipRouting
            ? ['Router', 'Switch']
            : ['Switch'],
      addresses: [
        ...new Set(d.interfaces.filter((port) => port.adminUp && port.ip).map((port) => port.ip!)),
      ].slice(0, 8),
      ttl: ttl ?? (protocol === 'CDP' ? d.discovery!.cdpHoldtime : d.discovery!.lldpHoldtime),
      ...(protocol === 'CDP' && d.type === 'switch' && p.mode === 'access' && p.voiceVlan
        ? { voiceVlan: p.voiceVlan }
        : {}),
      ...(protocol === 'CDP' && d.phone?.enabled && d.phone.autoVoiceVlan !== false
        ? { voiceVlanQuery: true }
        : {}),
    };
    e.sendFrame(d.id, p.id, {
      src: p.mac,
      dst: destination[protocol],
      etherType: protocol,
      discovery: message,
      hops: 1,
    });
  }
}
function cancel(e: SimulationEngine, d: Device) {
  e.state.queue = e.state.queue.filter((q) => q.action.kind !== 'discovery-tick' || q.action.device !== d.id);
  if (d.discovery) delete d.discovery.tickAt;
}
function refresh(e: SimulationEngine, d: Device) {
  const s = d.discovery;
  if (!s) return;
  const before = phoneVoiceVlans(e.state, d, true);
  s.neighbors = s.neighbors.filter(
    (n) =>
      n.expiresAt > e.state.clock &&
      d.power &&
      d.interfaces.some(
        (p) => p.id === n.port && enabled(d, p, n.protocol, 'rx') && interfaceOperational(e.state, d, p)
      )
  );
  refreshPhoneVoiceNetwork(e, d, before);
  const signature = JSON.stringify(
    d.interfaces
      .filter(physical)
      .map((p) => [p.id, p.voiceVlan, p.adminUp, p.cdpEnabled, interfaceOperational(e.state, d, p)])
  );
  if (s.voiceSignature !== signature) {
    s.voiceSignature = signature;
    if (s.cdp) s.nextCdp = e.state.clock;
  }
  if (!d.power) {
    cancel(e, d);
    return;
  }
  const at = Math.min(
    s.cdp ? s.nextCdp : Infinity,
    s.lldp ? s.nextLldp : Infinity,
    ...s.neighbors.map((n) => n.expiresAt)
  );
  if (!Number.isFinite(at)) {
    cancel(e, d);
    return;
  }
  const next = Math.max(e.state.clock + 0.001, at);
  if (s.tickAt === next) return;
  cancel(e, d);
  s.tickAt = next;
  e.schedule(next - e.state.clock, { kind: 'discovery-tick', device: d.id, token: s.token });
}
export function configureDiscovery(e: SimulationEngine, d: Device, input: unknown) {
  if ((!['router', 'switch'].includes(d.type) && !d.phone) || ['ap', 'mesh', 'wlc'].includes(d.profile ?? ''))
    throw new Error('CDP/LLDP requires an IOS routing/switching device.');
  const config = discoveryConfigSchema.parse(input),
    old = d.discovery;
  if (old?.lldp && !config.lldp) advertise(e, d, 'LLDP', 0);
  cancel(e, d);
  d.discovery = {
    ...config,
    token: e.id('discovery'),
    nextCdp: e.state.clock,
    nextLldp: e.state.clock,
    neighbors: old?.neighbors ?? [],
  };
  invalidateProtocolIndex(e.state);
  refresh(e, d);
}
export function refreshDiscovery(e: SimulationEngine) {
  for (const d of protocolDevices(e.state, 'discovery')) refresh(e, d);
}
export function handleDiscoveryTick(e: SimulationEngine, a: Extract<Action, { kind: 'discovery-tick' }>) {
  const d = e.device(a.device),
    s = d.discovery;
  if (!s || s.token !== a.token) return;
  delete s.tickAt;
  if (d.power) {
    if (s.cdp && s.nextCdp <= e.state.clock) {
      advertise(e, d, 'CDP');
      s.nextCdp = e.state.clock + s.cdpTimer * 1000;
    }
    if (s.lldp && s.nextLldp <= e.state.clock) {
      advertise(e, d, 'LLDP');
      s.nextLldp = e.state.clock + s.lldpTimer * 1000;
    }
  }
  refresh(e, d);
}
export function receiveDiscovery(e: SimulationEngine, d: Device, p: NetworkInterface, f: Frame) {
  const m = f.discovery,
    s = d.discovery;
  if (
    !m ||
    !s ||
    !enabled(d, p, m.protocol, 'rx') ||
    f.dst !== destination[m.protocol] ||
    f.vlan !== undefined
  )
    return;
  const before = phoneVoiceVlans(e.state, d);
  s.neighbors = s.neighbors.filter(
    (n) =>
      !(n.port === p.id && n.protocol === m.protocol && n.chassisId === m.chassisId && n.portId === m.portId)
  );
  if (m.ttl) {
    if (s.neighbors.length >= 512) s.neighbors.shift();
    s.neighbors.push({
      ...m,
      port: p.id,
      receivedAt: e.state.clock,
      expiresAt: e.state.clock + m.ttl * 1000,
    });
  }
  refreshPhoneVoiceNetwork(e, d, before);
  if (m.protocol === 'CDP' && m.voiceVlanQuery && d.type === 'switch' && p.mode === 'access')
    advertise(e, d, 'CDP', undefined, p.id);
  refresh(e, d);
}
export function validateDiscovery(s: Snapshot) {
  const ticks = new Map<string, Snapshot['queue']>();
  for (const q of s.queue)
    if (q.action.kind === 'discovery-tick') {
      const list = ticks.get(q.action.device);
      if (list) list.push(q);
      else ticks.set(q.action.device, [q]);
    }
  for (const d of s.devices) {
    const state = d.discovery;
    if (!state) continue;
    if (!['router', 'switch'].includes(d.type) && !d.phone)
      throw new Error('Discovery state requires a network device or IP phone.');
    const keys = new Set<string>();
    for (const n of state.neighbors) {
      const key = JSON.stringify([n.port, n.protocol, n.chassisId, n.portId]);
      if (
        keys.has(key) ||
        !d.interfaces.some((p) => p.id === n.port && physical(p)) ||
        n.receivedAt > s.clock ||
        n.expiresAt !== n.receivedAt + n.ttl * 1000
      )
        throw new Error('Invalid discovery neighbor.');
      keys.add(key);
    }
    const timers = ticks.get(d.id) ?? [];
    if (
      state.tickAt !== undefined &&
      (timers.length !== 1 ||
        timers[0].at !== state.tickAt ||
        !('token' in timers[0].action) ||
        timers[0].action.token !== state.token)
    )
      throw new Error('Discovery timer is missing or inconsistent.');
    if (state.tickAt === undefined && timers.length) throw new Error('Unexpected discovery timer.');
  }
  const devices = new Map(s.devices.map((d) => [d.id, d]));
  for (const { action } of s.queue)
    if (action.kind === 'discovery-tick' && devices.get(action.device)?.discovery?.token !== action.token)
      throw new Error('Orphan discovery timer.');
}
