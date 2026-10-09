import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkInterface, Packet, Snapshot, Action } from '../model';
import { isIcmpError } from './icmp';
import { resolveRoute } from './ipv4';
type Binding = NonNullable<NonNullable<Device['nat']>['hairpins']>[number];
export function hairpinError(d: Device, packet: Packet): Packet | undefined {
  if (!d.nat?.enabled || !d.nat.hairpin || !isIcmpError(packet) || !packet.error) return;
  const q = packet.error.quote;
  const b = d.nat.hairpins?.find(
    (b) =>
      b.protocol === q.protocol &&
      b.snat === q.src &&
      b.server === q.dst &&
      b.snat === packet.dst &&
      b.mappedToken === (q.protocol === 'ICMP' ? q.probeId : String(q.sourcePort)) &&
      (q.protocol === 'ICMP' || b.serverPort === q.destinationPort)
  );
  if (!b) return;
  const quote =
    q.protocol === 'ICMP'
      ? { ...q, src: b.client, dst: b.vip, probeId: b.clientToken }
      : { ...q, src: b.client, dst: b.vip, sourcePort: Number(b.clientToken) };
  return {
    ...packet,
    dst: b.client,
    ...(q.protocol === 'ICMP' ? { probeId: b.clientToken } : {}),
    error: { ...packet.error, quote },
  };
}
function token(p: Packet, source: boolean) {
  return p.protocol === 'ICMP'
    ? p.probeId
    : p.protocol === 'TCP' || p.protocol === 'UDP'
      ? String(source ? p.sourcePort : p.destinationPort)
      : '';
}
function touch(e: SimulationEngine, d: Device, b: Binding) {
  b.expiresAt = e.state.clock + (b.protocol === 'TCP' ? 300000 : b.protocol === 'UDP' ? 120000 : 60000);
  e.state.queue = e.state.queue.filter(
    ({ action: a }) => a.kind !== 'nat-hairpin-expire' || a.device !== d.id || a.binding !== b.id
  );
  e.schedule(b.expiresAt - e.state.clock, {
    kind: 'nat-hairpin-expire',
    device: d.id,
    binding: b.id,
    expiresAt: b.expiresAt,
  });
}
export function hairpinInbound(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  packet: Packet
): Packet | undefined {
  const n = d.nat;
  const error = hairpinError(d, packet);
  if (error) return error;
  if (
    !n?.enabled ||
    !n.hairpin ||
    p.natRole !== 'inside' ||
    packet.protocol === 'OSPF' ||
    packet.protocol === 'VRRP' ||
    isIcmpError(packet)
  )
    return packet;
  n.hairpins ??= [];
  const reverse = n.hairpins.find(
    (b) =>
      b.egress === p.id &&
      b.protocol === packet.protocol &&
      b.server === packet.src &&
      b.snat === packet.dst &&
      b.expiresAt > e.state.clock &&
      b.mappedToken === token(packet, false) &&
      (packet.protocol === 'ICMP' || b.serverPort === packet.sourcePort)
  );
  if (reverse) {
    touch(e, d, reverse);
    return packet.protocol === 'ICMP'
      ? { ...packet, dst: reverse.client, probeId: reverse.clientToken }
      : { ...packet, dst: reverse.client, destinationPort: Number(reverse.clientToken) };
  }
  const fixed = n.statics.find((b) => b.global === packet.dst);
  if (!fixed) return packet;
  const route = resolveRoute(d, fixed.inside);
  if (!route?.port.ip || route.port.natRole !== 'inside') {
    e.drop(d, 'NAT hairpin: servidor sem rota inside. ', p.id);
    return;
  }
  const clientToken = token(packet, true),
    serverPort = packet.protocol === 'ICMP' ? 0 : packet.destinationPort;
  let b = n.hairpins.find(
    (b) =>
      b.ingress === p.id &&
      b.protocol === packet.protocol &&
      b.client === packet.src &&
      b.vip === packet.dst &&
      b.clientToken === clientToken &&
      b.serverPort === serverPort &&
      b.expiresAt > e.state.clock
  );
  if (!b) {
    if (n.hairpins.length === 256) {
      e.drop(d, 'NAT hairpin: limite de bindings.', p.id);
      return;
    }
    const id = e.id('hairpin');
    let mapped = 49152 + (e.state.sequence % 16384);
    while (
      n.hairpins.some(
        (b) => b.snat === route.port.ip && b.protocol === packet.protocol && b.mappedToken === String(mapped)
      ) ||
      d.tcpServices?.some((s) => s.enabled && s.port === mapped) ||
      d.tcpConnections?.some((c) => c.localIp === route.port.ip && c.localPort === mapped)
    )
      mapped = mapped === 65535 ? 49152 : mapped + 1;
    b = {
      id,
      client: packet.src,
      server: fixed.inside,
      vip: packet.dst,
      snat: route.port.ip,
      ingress: p.id,
      egress: route.port.id,
      protocol: packet.protocol,
      clientToken,
      mappedToken: packet.protocol === 'ICMP' ? id : String(mapped),
      serverPort,
      expiresAt: 0,
    };
    n.hairpins.push(b);
  }
  touch(e, d, b);
  e.emit('NAT_TRANSLATED', d.id, 'Hairpin DNAT ' + packet.dst + ' → ' + b.server + '.', { port: p.id });
  return { ...packet, dst: b.server };
}
export function hairpinOutbound(
  e: SimulationEngine,
  d: Device,
  input: NetworkInterface | undefined,
  output: NetworkInterface,
  packet: Packet
): Packet | undefined {
  const n = d.nat;
  if (
    !n?.enabled ||
    !n.hairpin ||
    packet.protocol === 'OSPF' ||
    packet.protocol === 'VRRP' ||
    isIcmpError(packet)
  )
    return;
  const b = n.hairpins?.find(
    (b) =>
      b.protocol === packet.protocol &&
      b.expiresAt > e.state.clock &&
      ((b.ingress === input?.id &&
        b.egress === output.id &&
        b.client === packet.src &&
        b.server === packet.dst &&
        b.clientToken === token(packet, true) &&
        (packet.protocol === 'ICMP' || b.serverPort === packet.destinationPort)) ||
        (b.egress === input?.id &&
          b.ingress === output.id &&
          b.server === packet.src &&
          b.client === packet.dst &&
          b.clientToken === token(packet, false) &&
          (packet.protocol === 'ICMP' || b.serverPort === packet.sourcePort)))
  );
  if (!b) return;
  touch(e, d, b);
  if (packet.src === b.client) {
    e.emit('NAT_TRANSLATED', d.id, 'Hairpin SNAT ' + packet.src + ' → ' + b.snat + '.', { port: output.id });
    return packet.protocol === 'ICMP'
      ? { ...packet, src: b.snat, probeId: b.mappedToken }
      : { ...packet, src: b.snat, sourcePort: Number(b.mappedToken) };
  }
  e.emit('NAT_TRANSLATED', d.id, 'Retorno hairpin ' + packet.src + ' → ' + b.vip + '.', { port: output.id });
  return { ...packet, src: b.vip };
}
export function handleHairpinExpiry(e: SimulationEngine, a: Extract<Action, { kind: 'nat-hairpin-expire' }>) {
  const d = e.device(a.device);
  if (d.nat)
    d.nat.hairpins = d.nat.hairpins?.filter((b) => b.id !== a.binding || b.expiresAt !== a.expiresAt);
}
export function validateHairpins(s: Snapshot) {
  for (const d of s.devices) {
    const n = d.nat;
    if (!n) continue;
    const ids = new Set<string>();
    for (const b of n.hairpins ?? []) {
      if (
        !n.hairpin ||
        ids.has(b.id) ||
        !n.statics.some((v) => v.global === b.vip && v.inside === b.server) ||
        b.expiresAt < s.clock ||
        !d.interfaces.some((p) => p.id === b.ingress && p.natRole === 'inside') ||
        !d.interfaces.some((p) => p.id === b.egress && p.natRole === 'inside' && p.ip === b.snat) ||
        (b.protocol !== 'ICMP' &&
          [b.clientToken, b.mappedToken].some(
            (v) => !/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535
          )) ||
        s.queue.filter(
          (q) =>
            q.action.kind === 'nat-hairpin-expire' &&
            q.action.device === d.id &&
            q.action.binding === b.id &&
            q.at === b.expiresAt &&
            q.action.expiresAt === b.expiresAt
        ).length !== 1
      )
        throw new Error('Binding NAT hairpin ou timer inválido.');
      ids.add(b.id);
    }
  }
  for (const { action: a } of s.queue)
    if (
      a.kind === 'nat-hairpin-expire' &&
      !s.devices.find((d) => d.id === a.device)?.nat?.hairpins?.some((b) => b.id === a.binding)
    )
      throw new Error('Timer NAT hairpin órfão.');
}
