import type { SimulationEngine } from '../core/engine';
import type { Device, Frame, NetworkInterface, Packet6, Action } from '../model';
import { LIMITS } from '../model';
import { multicast6, multicastMac6, sameSubnet6, solicitedNode6 } from './ipv6-address';
import { source6 } from './ipv6-routing';
import { interfaceOperational } from './layer3';

export function permit6(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  direction: 'in' | 'out',
  packet: Packet6
) {
  const rules = direction === 'in' ? p.ipv6?.aclIn : p.ipv6?.aclOut;
  if (!rules?.length) return true;
  const kind = ['ns', 'na', 'rs', 'ra'].includes(packet.kind)
    ? 'ndp'
    : ['unreachable', 'time-exceeded', 'packet-too-big'].includes(packet.kind)
      ? 'error'
      : packet.kind;
  const rule = rules.find(
    (r) =>
      (r.kind === 'any' || r.kind === kind) &&
      sameSubnet6(packet.src, r.source, r.sourcePrefix) &&
      sameSubnet6(packet.dst, r.destination, r.destinationPrefix)
  );
  if (rule) rule.hits++;
  if (rule?.action === 'permit') return true;
  e.drop(d, 'ACL IPv6 ' + direction + ': ' + (rule ? rule.action : 'deny implícito') + '.', p.id);
  return false;
}
export function frame6(e: SimulationEngine, d: Device, p: NetworkInterface, packet: Packet6, mac?: string) {
  const frame: Frame = {
    src: p.mac,
    dst: mac ?? multicastMac6(packet.dst),
    etherType: 'IPv6',
    ipv6: packet,
    hops: LIMITS.l2Hops,
  };
  if (['ns', 'na', 'rs', 'ra'].includes(packet.kind))
    e.emit('NDP_SENT', d.id, 'ICMPv6 ' + packet.kind.toUpperCase() + ' → ' + packet.dst, {
      port: p.id,
      frame,
    });
  e.sendFrame(d.id, p.id, frame);
}
function cancel(e: SimulationEngine, d: Device, port: string, ip: string) {
  d.resolutions6 = d.resolutions6?.filter((r) => r.port !== port || r.ip !== ip);
  e.state.queue = e.state.queue.filter(
    ({ action: a }) => a.kind !== 'ndp-timer' || a.device !== d.id || a.port !== port || a.ip !== ip
  );
}
function request(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  r: NonNullable<Device['resolutions6']>[number]
) {
  frame6(e, d, p, {
    src: r.source,
    dst: solicitedNode6(r.ip),
    hopLimit: 255,
    protocol: 'ICMPv6',
    kind: 'ns',
    bytes: 72,
    target: r.ip,
    mac: p.mac,
  });
  r.nextAt = e.state.clock + 1000;
  e.schedule(1000, { kind: 'ndp-timer', device: d.id, port: p.id, ip: r.ip, token: r.token });
}
export function sendWithNdp(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  ip: string,
  packet: Packet6
) {
  if (multicast6(packet.dst)) {
    frame6(e, d, p, packet);
    return;
  }
  const cached = d.neighbors6?.find((n) => n.port === p.id && n.ip === ip && n.state !== 'FAILED');
  if (cached) {
    if ((cached.state ?? 'REACHABLE') === 'REACHABLE' && cached.expiresAt <= e.state.clock)
      cached.state = 'STALE';
    if (cached.state === 'STALE') {
      cached.state = 'DELAY';
      cached.probeAt = e.state.clock + 5000;
      cached.probes = 0;
      e.emit('NDP_UPDATED', d.id, ip + ': STALE → DELAY; tráfego usa o MAC conhecido.', { port: p.id });
    }
    frame6(e, d, p, packet, cached.mac);
    return;
  }
  if ((d.pending6?.length ?? 0) >= 256) {
    e.drop(d, 'Fila NDP cheia.', p.id);
    return;
  }
  const source = source6(p, ip);
  if (!source) {
    e.drop(d, 'NDP exige endereço utilizável na interface.', p.id);
    return;
  }
  (d.pending6 ??= []).push({ port: p.id, nextHop: ip, packet });
  if (d.resolutions6?.some((r) => r.port === p.id && r.ip === ip)) return;
  const r = {
    port: p.id,
    ip,
    source,
    token: e.id('ndp'),
    attempts: 1,
    nextAt: e.state.clock + 1000,
    state: 'INCOMPLETE' as const,
  };
  (d.resolutions6 ??= []).push(r);
  request(e, d, p, r);
}
export function learnNeighbor6(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  ip: string,
  mac: string,
  solicited = false,
  override = true,
  router?: boolean
) {
  const previous = d.neighbors6?.find((n) => n.ip === ip && n.port === p.id);
  if (previous && previous.mac !== mac && !override) {
    previous.state = 'STALE';
    return;
  }
  d.neighbors6 = (d.neighbors6 ?? []).filter((n) => !(n.ip === ip && n.port === p.id));
  d.neighbors6.push({
    ...(previous?.mac === mac && !solicited && previous.state !== 'FAILED' ? previous : {}),
    port: p.id,
    ip,
    mac,
    expiresAt: previous?.mac === mac && !solicited ? previous.expiresAt : e.state.clock + 30000,
    state: solicited
      ? 'REACHABLE'
      : previous?.mac === mac && previous.state !== 'FAILED'
        ? (previous.state ?? 'REACHABLE')
        : 'STALE',
    ...(router !== undefined
      ? { router }
      : previous?.router !== undefined
        ? { router: previous.router }
        : {}),
  });
  if (d.neighbors6.length > 2048) d.neighbors6.shift();
  if (previous?.router && router === false && p.ipv6)
    p.ipv6.routers = p.ipv6.routers.filter((r) => r.ip !== ip);
  e.emit('NDP_UPDATED', d.id, ip + ' → ' + mac + '; ' + (solicited ? 'REACHABLE' : 'STALE') + '.', {
    port: p.id,
  });
  const pending = d.pending6?.filter((n) => n.port === p.id && n.nextHop === ip) ?? [];
  d.pending6 = d.pending6?.filter((n) => !pending.includes(n));
  cancel(e, d, p.id, ip);
  for (const item of pending) sendWithNdp(e, d, p, ip, item.packet);
}
export function handleNdpTimer(e: SimulationEngine, a: Extract<Action, { kind: 'ndp-timer' }>) {
  const d = e.device(a.device),
    p = d.interfaces.find((p) => p.id === a.port);
  const r = d.resolutions6?.find((r) => r.port === a.port && r.ip === a.ip);
  if (!p || r?.token !== a.token || r.nextAt !== e.state.clock) return;
  if (interfaceOperational(e.state, d, p) && source6(p, r.ip) === r.source && r.attempts < 3) {
    r.attempts++;
    request(e, d, p, r);
    return;
  }
  d.pending6 = d.pending6?.filter((n) => n.port !== p.id || n.nextHop !== r.ip);
  cancel(e, d, p.id, r.ip);
  e.drop(d, 'NDP expirou: ' + r.ip + ' não respondeu após ' + r.attempts + ' tentativa(s).', p.id);
  if (p.ipv6) p.ipv6.routers = p.ipv6.routers.filter((v) => v.ip !== r.ip);
}
export function confirmNeighbor6(e: SimulationEngine, d: Device, p: NetworkInterface, ip: string) {
  const n = d.neighbors6?.find((n) => n.port === p.id && n.ip === ip);
  if (!n) return;
  n.state = 'REACHABLE';
  n.expiresAt = e.state.clock + 30000;
  n.probes = 0;
  delete n.probeAt;
}
export function refreshNud6(e: SimulationEngine, d: Device, p: NetworkInterface) {
  for (const n of d.neighbors6?.filter((n) => n.port === p.id) ?? []) {
    if ((n.state ?? 'REACHABLE') === 'REACHABLE' && n.expiresAt <= e.state.clock) n.state = 'STALE';
    if (!['DELAY', 'PROBE'].includes(n.state ?? '') || n.probeAt === undefined || n.probeAt > e.state.clock)
      continue;
    if ((n.probes ?? 0) >= 3 || !interfaceOperational(e.state, d, p)) {
      n.state = 'FAILED';
      delete n.probeAt;
      if (p.ipv6) p.ipv6.routers = p.ipv6.routers.filter((r) => r.ip !== n.ip);
      e.emit('NDP_UPDATED', d.id, n.ip + ': PROBE → FAILED; gateway removido se necessário.', { port: p.id });
      continue;
    }
    const src = source6(p, n.ip);
    if (!src) continue;
    n.state = 'PROBE';
    n.probes = (n.probes ?? 0) + 1;
    n.probeAt = e.state.clock + 1000;
    frame6(
      e,
      d,
      p,
      { src, dst: n.ip, hopLimit: 255, protocol: 'ICMPv6', kind: 'ns', target: n.ip, mac: p.mac, bytes: 72 },
      n.mac
    );
    e.emit('NDP_UPDATED', d.id, n.ip + ': PROBE ' + n.probes + '/3 unicast.', { port: p.id });
  }
}
export function clearIpv6Port(e: SimulationEngine, d: Device, p: NetworkInterface) {
  d.pending6 = d.pending6?.filter((n) => n.port !== p.id);
  d.neighbors6 = d.neighbors6?.filter((n) => n.port !== p.id);
  d.resolutions6 = d.resolutions6?.filter((n) => n.port !== p.id);
  e.state.queue = e.state.queue.filter(
    ({ action: a }) =>
      !((a.kind === 'ndp-timer' || a.kind === 'ipv6-tick') && a.device === d.id && a.port === p.id)
  );
}
