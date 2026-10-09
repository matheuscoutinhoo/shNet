import type { SimulationEngine } from '../core/engine';
import {
  LIMITS,
  packetSchema,
  type Device,
  type Frame,
  type NetworkInterface,
  type Packet,
  type Snapshot,
} from '../model';
import { mplsConfigSchema, mplsPayloadSchema } from './mpls-model';
import { sameSubnet, subnet, receiveIp } from './ipv4';
import { interfaceUp } from './layer3';
import { sendWithArp } from './arp';
import { sendIcmpError } from './icmp';
import type { z } from 'zod';
type Payload = z.infer<typeof mplsPayloadSchema>;
export function configureMpls(e: SimulationEngine, d: Device, input: unknown) {
  const c = mplsConfigSchema.parse(input);
  if (d.type !== 'router') throw new Error('MPLS exige roteador.');
  validateConfig(d, c);
  d.mpls = c;
  e.emit('CONFIG_CHANGED', d.id, 'MPLS/FEC/LFIB configurado.');
}
function validateConfig(d: Device, c: z.infer<typeof mplsConfigSchema>) {
  const valid = (port?: string, nextHop?: string) => {
    const p = d.interfaces.find((p) => p.id === port);
    return (
      p?.ip &&
      p.prefix !== undefined &&
      !p.vrf &&
      !p.channel &&
      !p.tunnel &&
      p.mode === 'routed' &&
      nextHop &&
      sameSubnet(p.ip, nextHop, p.prefix) &&
      p.ip !== nextHop
    );
  };
  if (
    new Set(c.ingress.map((f) => f.network + '/' + f.prefix)).size !== c.ingress.length ||
    new Set(c.lfib.map((f) => f.incoming)).size !== c.lfib.length ||
    c.ingress.some((f) => subnet(f.network, f.prefix).network !== f.network || !valid(f.port, f.nextHop)) ||
    c.lfib.some(
      (f) =>
        (f.port === undefined) !== (f.nextHop === undefined) ||
        (f.port !== undefined && !valid(f.port, f.nextHop)) ||
        (f.operation === 'swap' ? !f.outgoing || !f.port : f.outgoing !== undefined)
    )
  )
    throw new Error('MPLS: FEC/LFIB, next-hop ou labels inválidos.');
}
export function mplsRoute(d: Device, packet: Packet, vrf?: string) {
  if (vrf || !d.mpls?.enabled || ['OSPF', 'VRRP'].includes(packet.protocol)) return;
  const fec = d.mpls.ingress
      .filter((f) => sameSubnet(f.network, packet.dst, f.prefix))
      .sort((a, b) => b.prefix - a.prefix)[0],
    p = fec && d.interfaces.find((p) => p.id === fec.port);
  if (fec && p && interfaceUp(d, p)) return { port: p, nextHop: fec.nextHop, prefix: fec.prefix, fec };
}
export function pushMpls(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  nextHop: string,
  packet: Packet,
  labels: number[]
) {
  const payload: Payload = {
    labels: labels.map((value) => ({
      value,
      ttl: packet.ttl,
      tc: (('dscp' in packet ? packet.dscp : 0) ?? 0) >> 3,
    })),
    packet: JSON.stringify(packetSchema.parse(packet)),
    bytes: packet.bytes + 4 * labels.length,
  };
  e.emit('MPLS_PUSH', d.id, 'FEC ' + packet.dst + ': push ' + labels.join('/') + '.', { port: p.id });
  sendWithArp(e, d, p, nextHop, packet, payload);
}
export function receiveMpls(e: SimulationEngine, d: Device, p: NetworkInterface, frame: Frame) {
  const m = frame.mpls;
  if (!m) return;
  if (!d.mpls?.enabled || d.type !== 'router' || p.vrf) {
    e.drop(d, 'MPLS não habilitado na entrada.', p.id, frame);
    return;
  }
  let packet: Exclude<Packet, { protocol: 'OSPF' | 'VRRP' }>;
  try {
    const parsed = packetSchema.parse(JSON.parse(m.packet));
    if (parsed.protocol === 'OSPF' || parsed.protocol === 'VRRP')
      throw Error('MPLS: controle link-local não é transportado.');
    packet = parsed;
    if (m.bytes !== packet.bytes + 4 * m.labels.length) throw Error('MPLS: tamanho interno inválido.');
  } catch (error) {
    e.drop(d, (error as Error).message, p.id, frame);
    return;
  }
  const top = m.labels[0],
    entry = d.mpls.lfib.find((f) => f.incoming === top.value);
  if (!entry) {
    e.drop(d, 'MPLS: label ' + top.value + ' sem LFIB.', p.id, frame);
    return;
  }
  if (top.ttl <= 1) {
    sendIcmpError(e, d, p, { ...packet, ttl: top.ttl }, 'time-exceeded', 0);
    e.drop(d, 'MPLS: TTL do label expirou.', p.id, frame);
    return;
  }
  const rest = m.labels.slice(1);
  if (entry.operation === 'pop' && !entry.port) {
    if (rest.length) {
      e.drop(d, 'MPLS: pop local exige último label.', p.id, frame);
      return;
    }
    e.emit('MPLS_POP', d.id, 'Label ' + top.value + ' removido; lookup IP.', { port: p.id, frame });
    receiveIp(e, d, p, { ...packet, ttl: Math.min(packet.ttl, top.ttl) }, frame.src);
    return;
  }
  const out = d.interfaces.find((p) => p.id === entry.port)!;
  if (!interfaceUp(d, out)) {
    e.drop(d, 'MPLS: saída desligada.', out.id, frame);
    return;
  }
  const ttl = top.ttl - 1,
    labels =
      entry.operation === 'swap'
        ? [...entry.outgoing!.map((value) => ({ value, ttl, tc: top.tc })), ...rest]
        : rest.map((l) => ({ ...l, ttl: Math.min(l.ttl, ttl) }));
  if (labels.length > 8) {
    e.drop(d, 'MPLS: pilha de labels excedida.', p.id, frame);
    return;
  }
  packet = { ...packet, ttl: Math.min(packet.ttl, ttl) };
  e.emit(
    entry.operation === 'swap' ? 'MPLS_SWAP' : 'MPLS_POP',
    d.id,
    'Label ' + top.value + ' → ' + (labels.map((l) => l.value).join('/') || 'IPv4') + '.',
    { port: out.id, frame }
  );
  sendWithArp(
    e,
    d,
    out,
    entry.nextHop!,
    packet,
    labels.length
      ? {
          labels,
          packet: JSON.stringify(packetSchema.parse(packet)),
          bytes: packet.bytes + 4 * labels.length,
        }
      : undefined
  );
}
export function validateMpls(s: Snapshot) {
  for (const d of s.devices) {
    if (d.mpls) {
      if (d.type !== 'router') throw new Error('MPLS exige roteador.');
      validateConfig(d, d.mpls);
    }
    for (const n of d.pending) {
      if (n.mpls) {
        const packet = packetSchema.parse(JSON.parse(n.mpls.packet));
        if (
          n.mpls.bytes !== packet.bytes + 4 * n.mpls.labels.length ||
          JSON.stringify(packetSchema.parse(n.packet)) !== JSON.stringify(packet)
        )
          throw new Error('ARP/MPLS pendente inconsistente.');
      }
    }
  }
  const check = (f?: Frame) => {
    if (!f?.mpls) return;
    const p = packetSchema.parse(JSON.parse(f.mpls.packet));
    if (f.mpls.bytes !== p.bytes + 4 * f.mpls.labels.length) throw new Error('Payload MPLS inconsistente.');
  };
  for (const q of s.queue) if (q.action.kind === 'deliver') check(q.action.frame);
  for (const event of s.events) check(event.frame);
}
export function mplsFrame(src: string, dst: string, payload: Payload): Frame {
  return { src, dst, etherType: 'MPLS', mpls: payload, hops: LIMITS.l2Hops };
}
