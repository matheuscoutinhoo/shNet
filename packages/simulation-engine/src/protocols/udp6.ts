import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkInterface, Packet6 } from '../model';
import { normalize6, linkLocal6, unicast6, multicast6 } from './ipv6-address';
import { requireVrf } from './layer3';
import { resolveRoute6, source6 } from './ipv6-routing';
import { frame6 } from './ipv6-wire';
import { udp6PayloadBytes, udp6ServiceSchema, udp6DatagramSchema } from './udp6-model';
import { receiveDhcp6 } from './dhcp6';
import { receiveDnsAnswer } from './dns-client';
import { buildDnsResponse } from './dnssec';
import { dnsMessageLength } from './dns-wire';
import { portNumberSchema } from '../schemas';

export function sendDatagram6(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  src: string,
  dst: string,
  input: unknown
) {
  const datagram = udp6DatagramSchema.parse(input),
    packet: Packet6 = {
      src,
      dst,
      hopLimit: 64,
      protocol: 'UDP',
      kind: 'udp',
      datagram,
      bytes: 48 + udp6PayloadBytes(datagram.payload),
    };
  if (packet.bytes > p.mtu) throw new Error('UDP IPv6 excede MTU; reduza o datagrama.');
  e.emit('PACKET_SENT', d.id, `UDP/IPv6 ${datagram.sourcePort} → ${dst}:${datagram.destinationPort}.`, {
    port: p.id,
  });
  if (multicast6(dst)) frame6(e, d, p, packet);
  else e.sendIp6(d.id, packet, undefined, p.vrf, linkLocal6(dst) ? p.id : undefined);
}
export function configureUdp6Service(e: SimulationEngine, d: Device, input: unknown) {
  const service = udp6ServiceSchema.parse(input);
  if ([546, 547].includes(service.port)) throw new Error('UDP/546 e /547 reservados para DHCPv6.');
  const others = d.udp6Services?.filter((s) => s.port !== service.port) ?? [];
  if (others.length >= 32) throw new Error('Limite de serviços UDP IPv6.');
  d.udp6Services = [...others, service];
  e.emit('CONFIG_CHANGED', d.id, 'Serviço UDP IPv6 configurado.');
}
export function sendUdp6(
  e: SimulationEngine,
  d: Device,
  target: string,
  port: number,
  data: string,
  vrf?: string,
  scope?: string
) {
  const dst = normalize6(target);
  portNumberSchema.parse(port);
  requireVrf(d, vrf);
  if (!unicast6(dst) || !d.power) throw new Error('UDP IPv6 exige destino unicast e origem ligada.');
  if (linkLocal6(dst) && !scope) throw new Error('UDP IPv6 link-local exige interface.');
  const route = resolveRoute6(d, dst, e.state.clock, vrf, scope),
    p = route?.port,
    src = p && source6(p, dst);
  if (!p || !src) throw new Error('Configure IPv6/rota e aguarde DAD.');
  const id = e.id('udp6'),
    sourcePort = 55000 + (e.state.sequence % 10000);
  sendDatagram6(e, d, p, src, dst, {
    sourcePort,
    destinationPort: port,
    payload: { protocol: 'RAW', id, data, reply: false },
  });
  return id;
}
export function receiveUdp6(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  packet: Extract<Packet6, { protocol: 'UDP' }>
) {
  const { sourcePort, destinationPort, payload } = packet.datagram;
  if (payload.protocol === 'DHCPv6' || payload.protocol === 'DHCPv6-RELAY') {
    receiveDhcp6(e, d, p, packet);
    return;
  }
  if (payload.protocol === 'DNS') {
    if (payload.message.type === 'query' && destinationPort === 53 && d.dnsServer?.enabled) {
      const response = buildDnsResponse(d, payload.message, e.state.clock);
      const limit = Math.min(payload.message.edns?.udpSize ?? 512, p.mtu - 48);
      if (dnsMessageLength(response) > limit) {
        response.truncated = true;
        response.answers = [];
        delete response.dnssec;
      }
      sendDatagram6(e, d, p, packet.dst, packet.src, {
        sourcePort: 53,
        destinationPort: sourcePort,
        payload: { protocol: 'DNS', message: response },
      });
    } else if (payload.message.type === 'response' && sourcePort === 53)
      receiveDnsAnswer(e, d, payload.message, {
        src: packet.src,
        dst: packet.dst,
        destinationPort,
        transport: 'udp',
      });
    else e.drop(d, 'DNS IPv6: porta ou serviço inválido.');
    return;
  }
  (d.udp6Records ??= []).push({
    id: payload.id,
    source: packet.src,
    target: packet.dst,
    sourcePort,
    destinationPort,
    data: payload.data,
    reply: payload.reply,
    at: e.state.clock,
    port: p.id,
  });
  if (d.udp6Records.length > 256) d.udp6Records.shift();
  e.emit('PACKET_RECEIVED', d.id, 'UDP IPv6: ' + payload.data.length + ' caracteres recebidos.', {
    port: p.id,
  });
  if (!payload.reply && d.udp6Services?.some((s) => s.enabled && s.port === destinationPort))
    sendDatagram6(e, d, p, packet.dst, packet.src, {
      sourcePort: destinationPort,
      destinationPort: sourcePort,
      payload: { ...payload, reply: true },
    });
}
