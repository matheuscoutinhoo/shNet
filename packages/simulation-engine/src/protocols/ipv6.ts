import type { SimulationEngine } from '../core/engine';
import type { Device, Frame, NetworkInterface, Packet6 } from '../model';
import { LIMITS } from '../model';
import { normalize6, linkLocal6, multicast6, network6, unicast6 } from './ipv6-address';
import { route6Schema } from './ipv6-model';
import { resolveRoute6, source6, usable6 } from './ipv6-routing';
import { sendWithNdp, permit6, confirmNeighbor6 } from './ipv6-wire';
import { receiveNdp } from './ipv6-control';
import { interfaceUp, requireVrf } from './layer3';
import { receiveTcp } from './tcp';
import { receiveTcpMtu } from './tcp-pmtud';
import { permitIds } from './ids';
import { receiveUdp6 } from './udp6';

export function configureRoute6(e: SimulationEngine, d: Device, input: unknown, remove = false) {
  const r = route6Schema.parse(input),
    p = d.interfaces.find((p) => p.id === r.port);
  requireVrf(d, r.vrf);
  if (
    !p?.ipv6 ||
    p.vrf !== r.vrf ||
    network6(r.network, r.prefix) !== r.network ||
    multicast6(r.network) ||
    (r.nextHop !== '::' &&
      (!unicast6(r.nextHop) ||
        !p.ipv6.addresses.some(
          (a) =>
            a.state !== 'duplicate' &&
            a.onLink &&
            linkLocal6(a.ip) === linkLocal6(r.nextHop) &&
            a.prefix > 0 &&
            network6(a.ip, a.prefix) === network6(r.nextHop, a.prefix)
        )))
  )
    throw new Error('Rota IPv6 exige rede alinhada, interface na VRF e próximo salto on-link utilizável.');
  const routes =
    d.routes6?.filter(
      (v) => !(v.network === r.network && v.prefix === r.prefix && v.port === r.port && v.vrf === r.vrf)
    ) ?? [];
  if (!remove && routes.length >= 256) throw new Error('Limite de rotas IPv6.');
  d.routes6 = remove ? routes : [...routes, r];
  e.emit(
    'CONFIG_CHANGED',
    d.id,
    'Rota IPv6 ' + r.network + '/' + r.prefix + (remove ? ' removida.' : ' configurada.')
  );
}
export function sendIp6(
  e: SimulationEngine,
  d: Device,
  packet: Packet6,
  ingress?: NetworkInterface,
  vrf = ingress?.vrf,
  scope?: string
) {
  requireVrf(d, vrf);
  if (!d.power) {
    e.drop(d, 'IPv6: equipamento desligado.');
    return;
  }
  const local = d.interfaces.find(
    (p) =>
      p.vrf === vrf &&
      (!scope || scope === p.id) &&
      interfaceUp(d, p) &&
      usable6(p).some((a) => a.ip === packet.dst)
  );
  if (local) {
    receiveIp6(
      e,
      d,
      local,
      { src: local.mac, dst: local.mac, etherType: 'IPv6', ipv6: packet, hops: LIMITS.l2Hops },
      false
    );
    return;
  }
  const route = resolveRoute6(d, packet.dst, e.state.clock, vrf, scope);
  if (!route) {
    e.drop(d, 'IPv6: nenhuma rota para ' + packet.dst + '.');
    if (ingress) error6(e, d, ingress, packet, 'unreachable');
    return;
  }
  e.emit(
    'IPV6_ROUTE',
    d.id,
    'Longest prefix match IPv6 /' + route.prefix + ' (' + route.origin + ') via ' + route.nextHop + '.',
    { port: route.port.id }
  );
  if (packet.bytes > route.port.mtu) {
    e.drop(d, 'IPv6: pacote excede MTU ' + route.port.mtu + '; roteador não fragmenta.', route.port.id);
    if (ingress) error6(e, d, ingress, packet, 'packet-too-big', route.port.mtu);
    else if (packet.kind === 'echo-request') {
      const probe = e.state.probes6?.find(
        (p) => p.id === packet.probeId && p.device === d.id && p.status === 'pending'
      );
      if (probe) {
        probe.status = 'packet-too-big';
        probe.mtu = route.port.mtu;
        probe.responder = packet.src;
        probe.rtt = e.state.clock - probe.start;
      }
    }
    return;
  }
  if (route.port.tunnel) {
    e.sendFrame(d.id, route.port.id, {
      src: route.port.mac,
      dst: route.port.mac,
      etherType: 'IPv6',
      ipv6: packet,
      hops: LIMITS.l2Hops,
    });
    return;
  }
  sendWithNdp(e, d, route.port, route.nextHop, packet);
}
function error6(
  e: SimulationEngine,
  d: Device,
  ingress: NetworkInterface,
  original: Packet6,
  kind: 'unreachable' | 'time-exceeded' | 'packet-too-big',
  mtu?: number
) {
  if (
    !(original.protocol === 'TCP' || (original.kind === 'echo-request' && original.probeId)) ||
    !unicast6(original.src) ||
    multicast6(original.dst)
  )
    return;
  const route = resolveRoute6(
    d,
    original.src,
    e.state.clock,
    ingress.vrf,
    linkLocal6(original.src) ? ingress.id : undefined
  );
  const src = route && source6(route.port, original.src);
  if (!src) return;
  sendIp6(
    e,
    d,
    {
      src,
      dst: original.src,
      hopLimit: 64,
      protocol: 'ICMPv6',
      kind,
      bytes: 96,
      quote:
        original.protocol === 'TCP'
          ? {
              protocol: 'TCP',
              src: original.src,
              dst: original.dst,
              sourcePort: original.segment.sourcePort,
              destinationPort: original.segment.destinationPort,
              sequence: original.segment.sequence,
            }
          : { src: original.src, dst: original.dst, probeId: original.probeId! },
      ...(mtu ? { mtu } : {}),
    },
    undefined,
    ingress.vrf,
    linkLocal6(original.src) ? ingress.id : undefined
  );
}
export function receiveIp6(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  frame: Frame,
  inbound = true
) {
  const packet = frame.ipv6;
  if (packet && !permitIds(e, d, p, packet)) return;
  if (!packet || !p.ipv6 || !interfaceUp(d, p)) return;
  if (inbound && !permit6(e, d, p, 'in', packet)) return;
  if (receiveNdp(e, d, p, frame)) return;
  if (
    packet.protocol === 'UDP' &&
    packet.datagram.payload.protocol === 'DHCPv6' &&
    ['ff02::1:2', 'ff05::1:3'].includes(packet.dst)
  ) {
    receiveUdp6(e, d, p, packet);
    return;
  }
  if (!unicast6(packet.src) || multicast6(packet.dst) || packet.hopLimit < 1) {
    e.drop(d, 'IPv6: origem/destino/Hop Limit inválidos.', p.id, frame);
    return;
  }
  const own = d.interfaces.some(
    (v) =>
      v.vrf === p.vrf &&
      interfaceUp(d, v) &&
      (!linkLocal6(packet.dst) || v.id === p.id) &&
      usable6(v).some((a) => a.ip === packet.dst)
  );
  if (own) {
    if (packet.protocol === 'TCP') {
      const connection = d.tcpConnections?.find(
          (c) =>
            c.localIp === packet.dst &&
            c.remoteIp === packet.src &&
            c.localPort === packet.segment.destinationPort &&
            c.remotePort === packet.segment.sourcePort &&
            c.vrf === p.vrf
        ),
        before = connection?.sendUna;
      receiveTcp(
        e,
        d,
        { ...packet.segment, ttl: packet.hopLimit },
        p.vrf,
        linkLocal6(packet.src) || linkLocal6(packet.dst) ? p.id : undefined
      );
      if (connection && connection.sendUna !== before) {
        const route = resolveRoute6(
          d,
          packet.src,
          e.state.clock,
          p.vrf,
          linkLocal6(packet.src) ? p.id : undefined
        );
        if (route) confirmNeighbor6(e, d, route.port, route.nextHop);
      }
      return;
    }
    if (packet.protocol === 'UDP') {
      receiveUdp6(e, d, p, packet);
      return;
    }
    e.emit('PACKET_RECEIVED', d.id, 'ICMPv6 ' + packet.kind + ' de ' + packet.src + '.', {
      port: p.id,
      frame,
    });
    if (packet.kind === 'echo-request')
      sendIp6(
        e,
        d,
        {
          src: packet.dst,
          dst: packet.src,
          hopLimit: 64,
          protocol: 'ICMPv6',
          kind: 'echo-reply',
          bytes: packet.bytes,
          probeId: packet.probeId,
        },
        undefined,
        p.vrf,
        linkLocal6(packet.src) ? p.id : undefined
      );
    else {
      if (packet.quote && 'protocol' in packet.quote) {
        if (packet.kind === 'packet-too-big' && packet.mtu)
          receiveTcpMtu(
            e,
            d,
            packet.quote,
            packet.mtu,
            p.vrf,
            linkLocal6(packet.quote.src) ? p.id : undefined
          );
        return;
      }
      const id = packet.kind === 'echo-reply' ? packet.probeId : packet.quote?.probeId;
      const probe = e.state.probes6?.find(
        (q) => q.id === id && q.device === d.id && q.vrf === p.vrf && q.status === 'pending'
      );
      if (
        !probe ||
        (packet.kind === 'echo-reply' ? packet.src !== probe.target : packet.quote?.dst !== probe.target) ||
        (linkLocal6(probe.target) && probe.port !== p.id)
      )
        return;
      probe.status =
        packet.kind === 'echo-reply'
          ? 'success'
          : (packet.kind as 'unreachable' | 'time-exceeded' | 'packet-too-big');
      probe.rtt = e.state.clock - probe.start;
      probe.responder = packet.src;
      if (packet.kind === 'echo-reply') {
        const route = resolveRoute6(
          d,
          packet.src,
          e.state.clock,
          p.vrf,
          linkLocal6(packet.src) ? p.id : undefined
        );
        if (route) confirmNeighbor6(e, d, route.port, route.nextHop);
      }
      if (packet.mtu) probe.mtu = packet.mtu;
      e.emit(
        packet.kind === 'echo-reply' ? 'PING_SUCCESS' : 'PACKET_DROPPED',
        d.id,
        'IPv6 ' + probe.status + ': ' + packet.src + (packet.mtu ? '; MTU ' + packet.mtu : '') + '.',
        { port: p.id, frame }
      );
    }
    return;
  }
  if (
    !d.ipv6Routing ||
    !['router', 'switch'].includes(d.type) ||
    linkLocal6(packet.src) ||
    linkLocal6(packet.dst)
  ) {
    e.drop(d, 'IPv6: encaminhamento desabilitado ou endereço link-local fora do enlace.', p.id, frame);
    return;
  }
  if (packet.hopLimit <= 1) {
    e.drop(d, 'IPv6: Hop Limit esgotado.', p.id, frame);
    error6(e, d, p, packet, 'time-exceeded');
    return;
  }
  sendIp6(e, d, { ...packet, hopLimit: packet.hopLimit - 1 }, p);
}
export function ping6(
  e: SimulationEngine,
  d: Device,
  target: string,
  hopLimit = 64,
  vrf?: string,
  scope?: string,
  bytes = 104
) {
  const dst = normalize6(target);
  requireVrf(d, vrf);
  if (
    !unicast6(dst) ||
    !Number.isInteger(hopLimit) ||
    hopLimit < 1 ||
    hopLimit > 255 ||
    !Number.isInteger(bytes) ||
    bytes < 48 ||
    bytes > 65535
  )
    throw new Error('Ping IPv6: destino, Hop Limit ou tamanho inválido.');
  if (linkLocal6(dst) && !scope) throw new Error('Destino link-local exige interface de saída.');
  if (scope && !d.interfaces.some((p) => p.id === scope && p.vrf === vrf && p.ipv6))
    throw new Error('Interface IPv6 inexistente na VRF.');
  const route = resolveRoute6(d, dst, e.state.clock, vrf, scope);
  const port =
    route?.port ?? d.interfaces.find((p) => p.vrf === vrf && (!scope || p.id === scope) && source6(p, dst));
  const src = port && source6(port, dst);
  if (!port || !src) throw new Error('Aguarde DAD/SLAAC ou configure um endereço IPv6 de origem.');
  const probes = (e.state.probes6 ??= []);
  if (probes.length >= 200) {
    const at = probes.findIndex((q) => q.status !== 'pending');
    if (at < 0) throw new Error('Muitos probes IPv6 pendentes.');
    const [old] = probes.splice(at, 1);
    e.state.queue = e.state.queue.filter(
      ({ action: a }) => a.kind !== 'probe6-timeout' || a.probeId !== old.id
    );
  }
  const probe = {
    id: e.id('probe6'),
    device: d.id,
    target: dst,
    port: port.id,
    ...(vrf ? { vrf } : {}),
    start: e.state.clock,
    hopLimit,
    bytes,
    status: 'pending' as const,
  };
  probes.push(probe);
  e.emit('PACKET_SENT', d.id, 'ICMPv6 Echo Request → ' + dst + '; Hop Limit ' + hopLimit + '.');
  e.schedule(30000, { kind: 'probe6-timeout', device: d.id, probeId: probe.id });
  sendIp6(
    e,
    d,
    { src, dst, hopLimit, bytes, protocol: 'ICMPv6', kind: 'echo-request', probeId: probe.id },
    undefined,
    vrf,
    scope
  );
  return probe.id;
}
