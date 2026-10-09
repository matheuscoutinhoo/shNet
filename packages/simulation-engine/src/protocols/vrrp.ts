import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkInterface, Snapshot } from '../model';
import { BROADCAST, LIMITS } from '../model';
import { ipNumber, sameSubnet, subnet, resolveRoute } from './ipv4';
import { interfaceOperational } from './layer3';
import { isUnicast } from './dhcp-config';
import {
  VRRP,
  vrrpConfigSchema,
  vrrpMac,
  type VrrpGroup,
  type VrrpGroupConfig,
  type VrrpPacket,
  type VrrpTimer,
} from './vrrp-model';

export function vrrpPortUp(snapshot: Snapshot, device: Device, port: NetworkInterface) {
  return device.power && port.adminUp && !!port.ip && interfaceOperational(snapshot, device, port);
}
export function activeVrrpGroup(snapshot: Snapshot, device: Device, port: NetworkInterface, vip?: string) {
  if (!device.vrrp?.enabled || !vrrpPortUp(snapshot, device, port)) return;
  return device.vrrp.groups.find(
    (group) => group.port === port.id && group.state === 'ACTIVE' && (vip === undefined || group.vip === vip)
  );
}
export function acceptsVrrpMac(snapshot: Snapshot, device: Device, port: NetworkInterface, mac: string) {
  return !!device.vrrp?.groups.some(
    (group) =>
      group.port === port.id &&
      vrrpMac(group.vrid) === mac &&
      !!activeVrrpGroup(snapshot, device, port, group.vip)
  );
}
export function vrrpConfigGroups(device: Device): VrrpGroupConfig[] {
  return (
    device.vrrp?.groups.map(({ port, vrid, vip, priority, preempt, advertMs, track }) => ({
      port,
      vrid,
      vip,
      priority,
      preempt,
      advertMs,
      ...(track ? { track: structuredClone(track) } : {}),
    })) ?? []
  );
}
function validateConfig(device: Device, groups: VrrpGroupConfig[]) {
  if (device.type !== 'router') throw new Error('VRRP exige roteador.');
  const ids = new Set<string>(),
    ips = new Set<string>();
  for (const group of groups) {
    const port = device.interfaces.find((entry) => entry.id === group.port);
    if (
      !port ||
      port.mode !== 'routed' ||
      !port.ip ||
      port.prefix === undefined ||
      port.prefix < 1 ||
      port.prefix > 30 ||
      port.ipv4Mode === 'dhcp'
    )
      throw new Error('VRRP exige interface routed com IPv4 estático /1 a /30.');
    const range = subnet(port.ip, port.prefix);
    if (
      !isUnicast(port.ip) ||
      port.ip === range.network ||
      port.ip === range.broadcast ||
      !isUnicast(group.vip) ||
      !sameSubnet(group.vip, port.ip, port.prefix) ||
      group.vip === range.network ||
      group.vip === range.broadcast ||
      (group.priority === 255) !== (group.vip === port.ip)
    )
      throw new Error('VIP deve ser host na sub-rede; prioridade 255 é exclusiva do dono do endereço.');
    const key = `${group.port}:${group.vrid}`;
    if (
      ids.has(key) ||
      ips.has(group.vip) ||
      device.interfaces.some((entry) => entry.id !== port.id && entry.ip === group.vip)
    )
      throw new Error('Grupo ou IP virtual VRRP duplicado.');
    if (
      device.nat?.statics.some((entry) => entry.global === group.vip) ||
      device.nat?.pools.some(
        (entry) => ipNumber(group.vip) >= ipNumber(entry.start) && ipNumber(group.vip) <= ipNumber(entry.end)
      )
    )
      throw new Error('VIP VRRP conflita com endereço global NAT.');
    ids.add(key);
    ips.add(group.vip);
    const tracked = new Set<string>();
    if (group.priority === 255 && group.track?.length)
      throw new Error('Dono do VIP não reduz prioridade por tracking.');
    for (const track of group.track ?? []) {
      const key = track.port ?? track.route!;
      if (
        tracked.has(key) ||
        (track.port && !device.interfaces.some((p) => p.id === track.port)) ||
        (track.route && !isUnicast(track.route))
      )
        throw new Error('Tracking VRRP inválido ou duplicado.');
      tracked.add(key);
    }
  }
}
function cancel(engine: SimulationEngine, device: Device, group: VrrpGroup) {
  engine.state.queue = engine.state.queue.filter(
    ({ action }) =>
      action.kind !== 'vrrp-timer' || action.device !== device.id || action.token !== group.token
  );
  delete group.downAt;
  delete group.advertAt;
}
function timer(
  engine: SimulationEngine,
  device: Device,
  group: VrrpGroup,
  kind: VrrpTimer['timer'],
  delay: number
) {
  cancel(engine, device, group);
  const at = engine.state.clock + delay;
  if (kind === 'advertise') group.advertAt = at;
  else group.downAt = at;
  engine.schedule(delay, {
    kind: 'vrrp-timer',
    device: device.id,
    port: group.port,
    vrid: group.vrid,
    token: group.token,
    timer: kind,
    at,
  });
}
function transition(engine: SimulationEngine, device: Device, group: VrrpGroup, state: VrrpGroup['state']) {
  if (group.state === state) return;
  const previous = group.state;
  group.state = state;
  group.changedAt = engine.state.clock;
  engine.emit(
    'VRRP_STATE_CHANGED',
    device.id,
    `VRID ${group.vrid}, VIP ${group.vip}: ${previous} → ${state}.`,
    { port: group.port }
  );
}
export function vrrpEffectivePriority(snapshot: Snapshot, device: Device, group: VrrpGroupConfig) {
  const failed = (group.track ?? []).filter((track) => {
    const port = track.port
      ? device.interfaces.find((p) => p.id === track.port)
      : resolveRoute(device, track.route!)?.port;
    return !port || !interfaceOperational(snapshot, device, port);
  });
  return Math.max(1, group.priority - failed.reduce((sum, track) => sum + track.decrement, 0));
}
const priorityOf = (group: VrrpGroup) => group.effectivePriority ?? group.priority;
function advertise(engine: SimulationEngine, device: Device, group: VrrpGroup, priority = priorityOf(group)) {
  const port = device.interfaces.find((entry) => entry.id === group.port)!;
  if (!vrrpPortUp(engine.state, device, port)) return;
  const frame = {
    src: vrrpMac(group.vrid),
    dst: VRRP.mac,
    etherType: 'IPv4' as const,
    hops: LIMITS.l2Hops,
    packet: {
      src: port.ip!,
      dst: VRRP.ip,
      ttl: 255,
      protocol: 'VRRP' as const,
      version: 3 as const,
      vrid: group.vrid,
      vip: group.vip,
      priority,
      advertMs: group.advertMs,
      bytes: 32 as const,
    },
  };
  group.sent++;
  engine.emit('VRRP_ADVERT_SENT', device.id, `VRID ${group.vrid}: anúncio prioridade ${priority}.`, {
    port: port.id,
    frame,
  });
  engine.sendFrame(device.id, port.id, frame);
}
const skew = (group: VrrpGroup) => ((256 - priorityOf(group)) / 256) * group.activeAdvertMs;
function becomeActive(engine: SimulationEngine, device: Device, group: VrrpGroup) {
  transition(engine, device, group, 'ACTIVE');
  delete group.activeIp;
  delete group.activePriority;
  delete group.lastAdvertAt;
  group.activeAdvertMs = group.advertMs;
  advertise(engine, device, group);
  const mac = vrrpMac(group.vrid);
  engine.sendFrame(device.id, group.port, {
    src: mac,
    dst: BROADCAST,
    etherType: 'ARP',
    hops: LIMITS.l2Hops,
    arp: { kind: 'request', senderIp: group.vip, senderMac: mac, targetIp: group.vip },
  });
  timer(engine, device, group, 'advertise', group.advertMs);
}
function initialize(engine: SimulationEngine, device: Device, group: VrrpGroup) {
  group.activeAdvertMs = group.advertMs;
  if (group.priority === 255) becomeActive(engine, device, group);
  else {
    transition(engine, device, group, 'BACKUP');
    timer(engine, device, group, 'active-down', 3 * group.activeAdvertMs + skew(group));
  }
}
function sameConfig(a: VrrpGroupConfig, b: VrrpGroupConfig) {
  return (
    a.port === b.port &&
    a.vrid === b.vrid &&
    a.vip === b.vip &&
    a.priority === b.priority &&
    a.preempt === b.preempt &&
    a.advertMs === b.advertMs &&
    JSON.stringify(a.track ?? []) === JSON.stringify(b.track ?? [])
  );
}
export function configureVrrp(engine: SimulationEngine, device: Device, input: unknown) {
  const config = vrrpConfigSchema.parse(input);
  validateConfig(device, config.groups);
  const previous = device.vrrp;
  const retained = new Map<string, VrrpGroup>();
  for (const group of previous?.groups ?? []) {
    const next = config.groups.find((entry) => sameConfig(entry, group));
    if (previous!.enabled === config.enabled && next) retained.set(group.token, group);
    else {
      if (group.state === 'ACTIVE') advertise(engine, device, group, 0);
      cancel(engine, device, group);
    }
  }
  device.vrrp = {
    enabled: config.enabled,
    groups: config.groups.map((configGroup) => {
      const old = [...retained.values()].find((group) => sameConfig(configGroup, group));
      return (
        old ?? {
          ...configGroup,
          token: engine.id('vrrp'),
          state: 'INIT',
          changedAt: engine.state.clock,
          activeAdvertMs: configGroup.advertMs,
          sent: 0,
          received: 0,
        }
      );
    }),
  };
  refreshVrrp(engine);
  engine.emit(
    'CONFIG_CHANGED',
    device.id,
    `VRRP ${config.enabled ? 'ativado' : 'desativado'}; ${config.groups.length} grupos.`
  );
}
export function refreshVrrp(engine: SimulationEngine) {
  for (const device of engine.state.devices)
    for (const group of device.vrrp?.groups ?? []) {
      const effective = vrrpEffectivePriority(engine.state, device, group);
      if (group.track?.length && group.effectivePriority !== effective) {
        group.effectivePriority = effective;
        engine.emit(
          'VRRP_TRACK_CHANGED',
          device.id,
          `VRID ${group.vrid}: prioridade configurada ${group.priority}, efetiva ${effective}.`,
          { port: group.port }
        );
        if (group.state === 'ACTIVE') {
          advertise(engine, device, group);
          timer(engine, device, group, 'advertise', group.advertMs);
        } else if (group.state === 'BACKUP') {
          const deadline =
            (group.lastAdvertAt ?? engine.state.clock) + 3 * group.activeAdvertMs + skew(group);
          timer(engine, device, group, 'active-down', Math.max(0.001, deadline - engine.state.clock));
        }
      }
      const port = device.interfaces.find((entry) => entry.id === group.port);
      if (!device.vrrp!.enabled || !port || !vrrpPortUp(engine.state, device, port)) {
        if (group.state !== 'INIT') {
          cancel(engine, device, group);
          transition(engine, device, group, 'INIT');
          delete group.activeIp;
          delete group.activePriority;
          delete group.lastAdvertAt;
        }
      } else if (group.state === 'INIT') initialize(engine, device, group);
    }
}
export function handleVrrpTimer(engine: SimulationEngine, action: VrrpTimer) {
  const device = engine.device(action.device),
    group = device.vrrp?.groups.find((entry) => entry.token === action.token);
  if (!group || group.port !== action.port || group.vrid !== action.vrid) return;
  if (action.timer === 'advertise' && group.state === 'ACTIVE' && group.advertAt === action.at) {
    advertise(engine, device, group);
    timer(engine, device, group, 'advertise', group.advertMs);
  } else if (action.timer === 'active-down' && group.state === 'BACKUP' && group.downAt === action.at)
    becomeActive(engine, device, group);
}
export function receiveVrrp(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  packet: VrrpPacket,
  mac: string
) {
  const group =
    device.vrrp?.enabled &&
    device.vrrp.groups.find((entry) => entry.port === port.id && entry.vrid === packet.vrid);
  if (!group || group.state === 'INIT') return;
  if (
    packet.ttl !== 255 ||
    packet.dst !== VRRP.ip ||
    packet.vip !== group.vip ||
    mac !== vrrpMac(group.vrid) ||
    !isUnicast(packet.src) ||
    !sameSubnet(packet.src, port.ip!, port.prefix!)
  ) {
    engine.drop(device, 'Anúncio VRRP inválido: TTL, origem, VIP ou MAC incompatível.', port.id);
    return;
  }
  if (packet.src === port.ip) return;
  group.received++;
  engine.emit(
    'VRRP_ADVERT_RECEIVED',
    device.id,
    `VRID ${group.vrid}: ${packet.src}, prioridade ${packet.priority}${packet.advertMs !== group.advertMs ? ', intervalo diferente do local' : ''}.`,
    { port: port.id }
  );
  if (group.state === 'BACKUP') {
    if (packet.priority === 0) timer(engine, device, group, 'active-down', skew(group));
    else if (!group.preempt || packet.priority >= priorityOf(group)) {
      group.activeIp = packet.src;
      group.activePriority = packet.priority;
      group.activeAdvertMs = packet.advertMs;
      group.lastAdvertAt = engine.state.clock;
      timer(engine, device, group, 'active-down', 3 * group.activeAdvertMs + skew(group));
    }
  } else if (
    packet.priority > priorityOf(group) ||
    (packet.priority === priorityOf(group) && ipNumber(packet.src) > ipNumber(port.ip!))
  ) {
    transition(engine, device, group, 'BACKUP');
    group.activeIp = packet.src;
    group.activePriority = packet.priority;
    group.activeAdvertMs = packet.advertMs;
    group.lastAdvertAt = engine.state.clock;
    timer(engine, device, group, 'active-down', 3 * group.activeAdvertMs + skew(group));
  } else if (packet.priority < priorityOf(group)) {
    advertise(engine, device, group);
    timer(engine, device, group, 'advertise', group.advertMs);
  }
}
export function validateVrrp(snapshot: Snapshot) {
  const used = new Set<VrrpTimer>();
  for (const device of snapshot.devices) {
    if (!device.vrrp) continue;
    validateConfig(device, device.vrrp.groups);
    const tokens = new Set<string>();
    for (const group of device.vrrp.groups) {
      const timers = snapshot.queue.filter(
        ({ action }) =>
          action.kind === 'vrrp-timer' && action.device === device.id && action.token === group.token
      );
      const expected =
        group.state === 'INIT' ? undefined : group.state === 'ACTIVE' ? group.advertAt : group.downAt;
      if (
        tokens.has(group.token) ||
        (group.track?.length
          ? group.effectivePriority !== vrrpEffectivePriority(snapshot, device, group)
          : group.effectivePriority !== undefined) ||
        group.changedAt > snapshot.clock ||
        (group.lastAdvertAt ?? 0) > snapshot.clock ||
        (!device.vrrp.enabled && group.state !== 'INIT') ||
        (group.state === 'INIT' &&
          (group.downAt !== undefined ||
            group.advertAt !== undefined ||
            group.activeIp !== undefined ||
            group.activePriority !== undefined ||
            group.lastAdvertAt !== undefined)) ||
        (group.state === 'ACTIVE' &&
          (group.downAt !== undefined ||
            group.activeIp !== undefined ||
            group.activePriority !== undefined ||
            group.activeAdvertMs !== group.advertMs)) ||
        (group.state === 'BACKUP' && group.advertAt !== undefined) ||
        (group.activeIp === undefined) !== (group.activePriority === undefined) ||
        (group.activeIp === undefined) !== (group.lastAdvertAt === undefined) ||
        (group.activeIp !== undefined &&
          (!isUnicast(group.activeIp) ||
            !sameSubnet(
              group.activeIp,
              device.interfaces.find((port) => port.id === group.port)!.ip!,
              device.interfaces.find((port) => port.id === group.port)!.prefix!
            ))) ||
        timers.length !== Number(group.state !== 'INIT') ||
        (group.state !== 'INIT' &&
          (expected === undefined ||
            expected < snapshot.clock ||
            expected >
              snapshot.clock +
                (group.state === 'ACTIVE' ? group.advertMs : 3 * group.activeAdvertMs + skew(group)) ||
            timers[0].at !== expected ||
            timers[0].action.kind !== 'vrrp-timer' ||
            timers[0].action.at !== expected ||
            timers[0].action.port !== group.port ||
            timers[0].action.vrid !== group.vrid ||
            timers[0].action.timer !== (group.state === 'ACTIVE' ? 'advertise' : 'active-down')))
      )
        throw new Error('Estado ou timer VRRP inconsistente.');
      tokens.add(group.token);
      for (const timer of timers) used.add(timer.action as VrrpTimer);
    }
  }
  for (const { action } of snapshot.queue)
    if (action.kind === 'vrrp-timer' && !used.has(action))
      throw new Error('Timer VRRP sem grupo correspondente.');
}
