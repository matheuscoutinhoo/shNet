import { fragmentArpPending, flushFragmentArp, clearFragmentWork } from './fragment';
import type { z } from 'zod';
import type { mplsPayloadSchema } from './mpls-model';
import {
  BROADCAST,
  LIMITS,
  type Action,
  type Device,
  type Frame,
  type NetworkInterface,
  type Packet,
  type Snapshot,
} from '../model';
import type { SimulationEngine } from '../core/engine';
import { activeVrrpGroup } from './vrrp';
import { vrrpMac } from './vrrp-model';
import { natOwnsAddress } from './nat';
import { isUnicast } from './dhcp-config';
import { observeDhcpArp } from './dhcp-client';

type Resolution = NonNullable<Device['arpResolutions']>[number];
type ArpTimer = Extract<Action, { kind: 'arp-timeout' }>;
const retryMs = 1000;
export function isDhcpRelease(packet: Packet) {
  return (
    packet.protocol === 'UDP' &&
    packet.payload.protocol === 'DHCP' &&
    packet.payload.message.type === 'release'
  );
}

export function clearArpPending(engine: SimulationEngine, device: Device) {
  clearFragmentWork(engine, device);
  device.pending = device.pending.filter((entry) => isDhcpRelease(entry.packet));
  retainArpResolutions(engine, device);
}

function cancel(engine: SimulationEngine, device: Device, port: string, ip: string) {
  device.arpResolutions = device.arpResolutions?.filter((entry) => entry.port !== port || entry.ip !== ip);
  engine.state.queue = engine.state.queue.filter(
    ({ action }) =>
      action.kind !== 'arp-timeout' || action.device !== device.id || action.port !== port || action.ip !== ip
  );
}

export function retainArpResolutions(engine: SimulationEngine, device: Device) {
  for (const entry of [...(device.arpResolutions ?? [])])
    if (!device.pending.some((pending) => pending.port === entry.port && pending.nextHop === entry.ip))
      cancel(engine, device, entry.port, entry.ip);
}

function request(engine: SimulationEngine, device: Device, port: NetworkInterface, resolution: Resolution) {
  const virtual = activeVrrpGroup(engine.state, device, port, resolution.sourceIp);
  const sourceMac = virtual ? vrrpMac(virtual.vrid) : port.mac;
  const frame: Frame = {
    src: sourceMac,
    dst: BROADCAST,
    etherType: 'ARP',
    hops: LIMITS.l2Hops,
    arp: { kind: 'request', senderIp: resolution.sourceIp, senderMac: sourceMac, targetIp: resolution.ip },
  };
  engine.emit(
    'ARP_REQUEST',
    device.id,
    'Cache ARP sem ' + resolution.ip + ': broadcast, tentativa ' + resolution.attempts + '/3.',
    { port: port.id, frame }
  );
  engine.sendFrame(device.id, port.id, frame);
  resolution.nextAt = resolution.startedAt + resolution.attempts * retryMs;
  engine.schedule(resolution.nextAt - engine.state.clock, {
    kind: 'arp-timeout',
    device: device.id,
    port: port.id,
    ip: resolution.ip,
    token: resolution.token,
  });
}

export function sendWithArp(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  nextHop: string,
  packet: Packet,
  mpls?: z.infer<typeof mplsPayloadSchema>
) {
  if (port.media === 'serial') {
    const l = engine.state.links.find(
      (l) => l.cable === 'serial' && [l.a, l.b].some((x) => x.device === device.id && x.port === port.id)
    );
    const end = l && (l.a.device === device.id ? l.b : l.a),
      peer =
        end &&
        engine.state.devices.find((d) => d.id === end.device)?.interfaces.find((p) => p.id === end.port);
    if (!peer) {
      engine.drop(device, 'Serial sem peer.', port.id);
      return;
    }
    engine.sendFrame(device.id, port.id, {
      src: port.mac,
      dst: peer.mac,
      etherType: 'IPv4',
      packet,
      hops: LIMITS.l2Hops,
    });
    return;
  }
  const entry = device.arpTable.find(
    (row) => row.port === port.id && row.ip === nextHop && row.expires > engine.state.clock
  );
  if (entry) {
    const virtual = activeVrrpGroup(engine.state, device, port, port.ip);
    engine.sendFrame(device.id, port.id, {
      src: virtual && virtual.vip === port.ip ? vrrpMac(virtual.vrid) : port.mac,
      dst: entry.mac,
      etherType: mpls ? 'MPLS' : 'IPv4',
      ...(mpls ? { mpls } : { packet }),
      hops: LIMITS.l2Hops,
    });
    return;
  }
  if (device.pending.length >= 256) {
    engine.drop(device, 'Fila ARP cheia.', port.id);
    return;
  }
  if (!port.ip || !isUnicast(port.ip) || !isUnicast(nextHop)) {
    engine.drop(device, 'ARP requer IPv4 unicast na interface e no próximo salto.', port.id);
    return;
  }
  const existing = device.pending.some((pending) => pending.port === port.id && pending.nextHop === nextHop);
  device.pending.push({ port: port.id, nextHop, packet, ...(mpls ? { mpls } : {}) });
  if (existing) return;
  const resolution: Resolution = {
    port: port.id,
    ip: nextHop,
    sourceIp: port.ip,
    token: engine.id('arp-resolution'),
    attempts: 1,
    startedAt: engine.state.clock,
    nextAt: engine.state.clock + retryMs,
  };
  device.arpResolutions ??= [];
  device.arpResolutions.push(resolution);
  request(engine, device, port, resolution);
}

export function handleArpTimer(engine: SimulationEngine, action: ArpTimer) {
  const device = engine.device(action.device),
    port = device.interfaces.find((entry) => entry.id === action.port)!;
  const pending = device.pending.filter((entry) => entry.port === port.id && entry.nextHop === action.ip);
  if (!pending.length) {
    cancel(engine, device, port.id, action.ip);
    return;
  }
  const resolution = device.arpResolutions?.find((entry) => entry.port === port.id && entry.ip === action.ip);
  if (action.token && (resolution?.token !== action.token || resolution.nextAt !== engine.state.clock))
    return;
  const detachedRelease =
    resolution &&
    pending.some((entry) => isDhcpRelease(entry.packet) && entry.packet.src === resolution.sourceIp);
  if (
    resolution &&
    device.power &&
    port.adminUp &&
    (port.ip === resolution.sourceIp || detachedRelease) &&
    resolution.attempts < 3
  ) {
    resolution.attempts++;
    request(engine, device, port, resolution);
    return;
  }
  device.pending = device.pending.filter((entry) => !pending.includes(entry));
  cancel(engine, device, port.id, action.ip);
  engine.drop(
    device,
    'ARP expirou: ' +
      action.ip +
      ' não respondeu no domínio de broadcast; ' +
      pending.length +
      ' pacote(s) removido(s).',
    port.id
  );
}

export function receiveArp(engine: SimulationEngine, device: Device, port: NetworkInterface, frame: Frame) {
  const arp = frame.arp;
  if (!arp || arp.senderMac !== frame.src) return;
  if (observeDhcpArp(engine, device, port, frame)) return;
  const virtual = activeVrrpGroup(engine.state, device, port, arp.targetIp);
  const configuredVirtual = device.vrrp?.groups.some(
    (group) => group.port === port.id && group.vip === arp.targetIp
  );
  // Gratuitous ARP announces ownership; replying during a handover would move
  // the virtual MAC back to the old active router's switch port.
  if (configuredVirtual && arp.kind === 'request' && arp.senderIp === arp.targetIp) return;
  if (arp.kind === 'request' && configuredVirtual && !virtual) return;
  const resolution = device.arpResolutions?.find(
    (entry) => entry.port === port.id && entry.ip === arp.senderIp && entry.sourceIp === arp.targetIp
  );
  const pending = device.pending.filter((entry) => entry.port === port.id && entry.nextHop === arp.senderIp);
  // A RELEASE already sent may resolve its next hop after the client removes IPv4.
  const detachedRelease =
    !!resolution &&
    pending.some((entry) => isDhcpRelease(entry.packet) && entry.packet.src === resolution.sourceIp);
  if (
    arp.targetIp !== port.ip &&
    !virtual &&
    !natOwnsAddress(device, port, arp.targetIp) &&
    !(arp.kind === 'reply' && detachedRelease)
  )
    return;
  if (arp.kind === 'reply' && !pending.length && !fragmentArpPending(device, port, arp.senderIp)) return;
  if (!port.ip && !detachedRelease) return;
  device.arpTable = device.arpTable.filter(
    (entry) => entry.expires > engine.state.clock && !(entry.port === port.id && entry.ip === arp.senderIp)
  );
  if (arp.senderIp !== '0.0.0.0')
    device.arpTable.push({
      ip: arp.senderIp,
      mac: arp.senderMac,
      port: port.id,
      expires: engine.state.clock + LIMITS.arpAge,
    });
  if (device.arpTable.length > 2048) device.arpTable.shift();
  engine.emit(
    'ARP_TABLE_UPDATED',
    device.id,
    arp.senderIp + ' → ' + arp.senderMac + ' armazenado por 60 s virtuais.',
    { port: port.id, frame }
  );
  if (arp.kind === 'request' && port.ip) {
    const replyMac = virtual ? vrrpMac(virtual.vrid) : port.mac;
    const reply: Frame = {
      src: replyMac,
      dst: arp.senderMac,
      etherType: 'ARP',
      hops: LIMITS.l2Hops,
      arp: { kind: 'reply', senderIp: arp.targetIp, senderMac: replyMac, targetIp: arp.senderIp },
    };
    engine.emit('ARP_REPLY', device.id, 'O IP consultado pertence a esta interface. Resposta unicast.', {
      port: port.id,
      frame: reply,
    });
    engine.sendFrame(device.id, port.id, reply);
  }
  device.pending = device.pending.filter((entry) => !pending.includes(entry));
  cancel(engine, device, port.id, arp.senderIp);
  flushFragmentArp(engine, device, port, arp.senderIp, arp.senderMac);
  for (const item of pending) sendWithArp(engine, device, port, item.nextHop, item.packet, item.mpls);
}

export function validateArp(snapshot: Snapshot) {
  const timers = new Map<string, { at: number; action: ArpTimer }[]>();
  for (const { at, action } of snapshot.queue)
    if (action.kind === 'arp-timeout' && action.token) {
      const key = JSON.stringify([action.device, action.token]);
      const items = timers.get(key) ?? [];
      items.push({ at, action });
      timers.set(key, items);
    }
  const usedTimers = new Set<string>();
  for (const device of snapshot.devices) {
    const keys = new Set<string>(),
      tokens = new Set<string>();
    for (const resolution of device.arpResolutions ?? []) {
      const key = JSON.stringify([resolution.port, resolution.ip]),
        timerKey = JSON.stringify([device.id, resolution.token]);
      const items = timers.get(timerKey) ?? [],
        port = device.interfaces.find((entry) => entry.id === resolution.port);
      const pending = device.pending.filter(
        (entry) => entry.port === resolution.port && entry.nextHop === resolution.ip
      );
      const detachedRelease = pending.some(
        (entry) => isDhcpRelease(entry.packet) && entry.packet.src === resolution.sourceIp
      );
      if (
        keys.has(key) ||
        tokens.has(resolution.token) ||
        !isUnicast(resolution.sourceIp) ||
        !isUnicast(resolution.ip) ||
        !port ||
        !pending.length ||
        (port.ip !== resolution.sourceIp && !detachedRelease) ||
        resolution.startedAt > snapshot.clock ||
        resolution.nextAt < snapshot.clock ||
        resolution.nextAt !== resolution.startedAt + resolution.attempts * retryMs ||
        items.length !== 1 ||
        items[0].at !== resolution.nextAt ||
        items[0].action.port !== resolution.port ||
        items[0].action.ip !== resolution.ip
      )
        throw new Error('Resolução ARP, pacote pendente ou timer inconsistente.');
      keys.add(key);
      tokens.add(resolution.token);
      usedTimers.add(timerKey);
    }
  }
  for (const key of timers.keys())
    if (!usedTimers.has(key)) throw new Error('Timer ARP sem resolução correspondente.');
}
