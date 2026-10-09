import { fragmentSchema, type IpFragment } from './fragment-model';
import {
  packetSchema,
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
import { interfaceUp, routingEnabled } from './layer3';
import { receiveIp, resolveRoute } from './ipv4';
import { quotePacket, sendIcmpError, sendIcmpQuoteError } from './icmp';
import { permitPacket } from './acl';

// Frames carry disjoint payload bytes. The simulator's typed transport envelope
// uses a length-prefixed UTF-8 codec, with zero padding for simulated Echo data.
function encode(p: Packet) {
  const json = new TextEncoder().encode(JSON.stringify(p));
  const data = new Uint8Array(Math.max(p.bytes - 20, json.length + 4));
  if (data.length > 65515) throw new Error('Datagrama IPv4 serializado excede 65535 bytes.');
  new DataView(data.buffer).setUint32(0, json.length);
  data.set(json, 4);
  return [...data];
}
function split(f: IpFragment, mtu: number): IpFragment[] {
  const size = Math.floor((mtu - 20) / 8) * 8,
    result: IpFragment[] = [];
  for (let at = 0; at < f.data.length; at += size) {
    const data = f.data.slice(at, at + size);
    result.push({
      ...f,
      offset: f.offset + at,
      more: f.more || at + data.length < f.data.length,
      data,
      bytes: 20 + data.length,
      first: at === 0 ? f.first : undefined,
    });
  }
  return result;
}
export function fragmentFrame(e: SimulationEngine, d: Device, p: NetworkInterface, frame: Frame) {
  const packet = frame.packet;
  if (!packet || packet.bytes <= p.mtu || (d.type === 'switch' && p.mode !== 'routed')) return false;
  if (!permitPacket(e, d, p, 'out', packet)) return true;
  if ('df' in packet && packet.df) {
    e.drop(d, 'IPv4 DF: MTU ' + p.mtu + ' excedida; ICMP Fragmentation Needed.', p.id, frame);
    sendIcmpError(e, d, p, packet, 'unreachable', 4, p.mtu);
    return true;
  }
  const identification = Number(e.id('datagram').split('-').at(-1)) % 65536;
  const data = encode(packet),
    first = quotePacket(packet);
  const fragments = split(
    {
      src: packet.src,
      dst: packet.dst,
      ttl: packet.ttl,
      protocol: packet.protocol,
      identification,
      offset: 0,
      more: false,
      data,
      bytes: 20 + data.length,
      ...(packet.dscp === undefined ? {} : { dscp: packet.dscp }),
      ...('traceId' in packet && packet.traceId ? { traceId: packet.traceId } : {}),
      ...(first ? { first } : {}),
    },
    p.mtu
  );
  e.emit(
    'IP_FRAGMENT',
    d.id,
    'Datagrama ' + identification + ': ' + fragments.length + ' fragmentos; MTU ' + p.mtu + '.',
    { port: p.id }
  );
  for (const fragment of fragments) {
    const wire = { ...frame, fragment };
    delete wire.packet;
    e.sendFrame(d.id, p.id, wire);
  }
  return true;
}
function key(f: Pick<IpFragment, 'src' | 'dst' | 'protocol' | 'identification'>, vrf?: string) {
  return JSON.stringify([vrf, f.src, f.dst, f.protocol, f.identification]);
}
function abandon(
  e: SimulationEngine,
  d: Device,
  r: NonNullable<Device['reassemblies']>[number],
  why: string
) {
  r.failed = true;
  r.fragments = [];
  e.drop(d, 'IPv4 reassembly: ' + why, r.port);
}
function reassemble(e: SimulationEngine, d: Device, p: NetworkInterface, f: IpFragment, sourceMac: string) {
  d.reassemblies ??= [];
  let r = d.reassemblies.find((r) => key(r, p.vrf) === key(f, p.vrf));
  if (!r) {
    if (d.reassemblies.length >= 64) {
      e.drop(d, 'Limite de reassembly IPv4 atingido.', p.id);
      return;
    }
    r = {
      id: e.id('reassembly'),
      port: p.id,
      sourceMac,
      src: f.src,
      dst: f.dst,
      protocol: f.protocol,
      identification: f.identification,
      vrf: p.vrf,
      expiresAt: e.state.clock + 30000,
      fragments: [],
    };
    d.reassemblies.push(r);
    e.schedule(30000, { kind: 'fragment-expire', device: d.id, id: r.id, expiresAt: r.expiresAt });
  }
  if (r.failed) return;
  const old = r.fragments.find((v) => v.offset === f.offset && v.data.length === f.data.length);
  if (old && old.more === f.more && old.data.every((v, i) => v === f.data[i])) return;
  if (r.fragments.some((v) => v.offset < f.offset + f.data.length && f.offset < v.offset + v.data.length)) {
    abandon(e, d, r, 'sobreposição de fragmentos; datagrama rejeitado.');
    return;
  }
  const final = r.fragments.find((v) => !v.more);
  if (
    (!f.more && final && final.offset + final.data.length !== f.offset + f.data.length) ||
    (final && f.offset + f.data.length > final.offset + final.data.length) ||
    (!f.more && r.fragments.some((v) => v.offset + v.data.length > f.offset + f.data.length))
  ) {
    abandon(e, d, r, 'comprimento final contraditório.');
    return;
  }
  if (
    r.fragments.length >= 128 ||
    d.reassemblies.reduce((n, v) => n + v.fragments.reduce((m, f) => m + f.data.length, 0), 0) +
      f.data.length >
      524288
  ) {
    abandon(e, d, r, 'buffer cheio.');
    return;
  }
  r.fragments.push(structuredClone(f));
  r.fragments.sort((a, b) => a.offset - b.offset);
  let length = 0;
  for (const v of r.fragments) {
    if (v.offset !== length) return;
    length += v.data.length;
  }
  if (r.fragments.at(-1)?.more) return;
  let packet: Packet;
  try {
    const data = Uint8Array.from(r.fragments.flatMap((f) => f.data)),
      size = new DataView(data.buffer).getUint32(0);
    if (size < 1 || size > data.length - 4) throw Error('Envelope inválido.');
    packet = packetSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.slice(4, 4 + size)))
    );
    if (
      packet.src !== f.src ||
      packet.dst !== f.dst ||
      packet.protocol !== f.protocol ||
      ('df' in packet && packet.df)
    )
      throw Error('Identidade do datagrama inválida.');
    packet.ttl = Math.min(...r.fragments.map((f) => f.ttl));
  } catch {
    abandon(e, d, r, 'payload ou cabeçalho reconstituído inválido.');
    return;
  }
  d.reassemblies = d.reassemblies.filter((v) => v.id !== r.id);
  e.state.queue = e.state.queue.filter(
    ({ action: a }) => a.kind !== 'fragment-expire' || a.device !== d.id || a.id !== r!.id
  );
  e.emit(
    'IP_REASSEMBLED',
    d.id,
    'Datagrama ' + f.identification + ' reconstituído após ' + r.fragments.length + ' fragmentos.',
    { port: p.id }
  );
  receiveIp(e, d, p, packet, sourceMac);
}
export function receiveFragment(e: SimulationEngine, d: Device, p: NetworkInterface, frame: Frame) {
  const f = fragmentSchema.parse(frame.fragment);
  const local = d.interfaces.some((v) => v.vrf === p.vrf && v.ip === f.dst && interfaceUp(d, v));
  const route = local ? undefined : resolveRoute(d, f.dst, p.vrf);
  // Security gateways normalize before ACL, stateful inspection and translation.
  if (local || d.nat?.enabled || d.firewall?.enabled || p.aclIn || route?.port.aclOut) {
    reassemble(e, d, p, f, frame.src);
    return;
  }
  if (!routingEnabled(d)) return;
  if (f.ttl <= 1) {
    e.drop(d, 'TTL expirou no fragmento IPv4.', p.id, frame);
    if (f.first)
      sendIcmpQuoteError(e, d, p, { ...f.first, ttl: f.ttl }, 'time-exceeded', 0, undefined, f.traceId);
    return;
  }
  if (!route) {
    e.drop(d, 'Fragmento IPv4 sem rota.', p.id, frame);
    if (f.first)
      sendIcmpQuoteError(e, d, p, { ...f.first, ttl: f.ttl }, 'unreachable', 0, undefined, f.traceId);
    return;
  }
  const forwarded = { ...f, ttl: f.ttl - 1 };
  for (const next of forwarded.bytes > route.port.mtu ? split(forwarded, route.port.mtu) : [forwarded])
    sendFragment(e, d, route.port, route.nextHop, next);
}
function transmit(e: SimulationEngine, d: Device, p: NetworkInterface, mac: string, f: IpFragment) {
  e.sendFrame(d.id, p.id, { src: p.mac, dst: mac, etherType: 'IPv4', fragment: f, hops: LIMITS.l2Hops });
}
function requestArp(e: SimulationEngine, d: Device, r: NonNullable<Device['fragmentPending']>[number]) {
  const p = d.interfaces.find((v) => v.id === r.port)!;
  e.sendFrame(d.id, p.id, {
    src: p.mac,
    dst: BROADCAST,
    etherType: 'ARP',
    hops: LIMITS.l2Hops,
    arp: { kind: 'request', senderIp: r.source, senderMac: p.mac, targetIp: r.nextHop },
  });
  r.nextAt = r.startedAt + r.attempts * 1000;
  e.schedule(r.nextAt - e.state.clock, { kind: 'fragment-arp', device: d.id, token: r.token });
}
function sendFragment(e: SimulationEngine, d: Device, p: NetworkInterface, nextHop: string, f: IpFragment) {
  const mac = d.arpTable.find((a) => a.port === p.id && a.ip === nextHop && a.expires > e.state.clock)?.mac;
  if (mac) {
    transmit(e, d, p, mac, f);
    return;
  }
  if (!p.ip) {
    e.drop(d, 'Fragmento sem IPv4 de saída.', p.id);
    return;
  }
  d.fragmentPending ??= [];
  if (
    d.fragmentPending.reduce(
      (sum, pending) => sum + pending.fragments.reduce((n, fragment) => n + fragment.data.length, 0),
      0
    ) +
      f.data.length >
    524288
  ) {
    e.drop(d, 'Buffer ARP de fragmentos cheio.', p.id);
    return;
  }
  let r = d.fragmentPending.find((v) => v.port === p.id && v.nextHop === nextHop);
  if (r) {
    if (r.fragments.length >= 128) {
      e.drop(d, 'Fila ARP de fragmentos cheia.', p.id);
      return;
    }
    r.fragments.push(f);
    return;
  }
  if (d.fragmentPending.length >= 64) {
    e.drop(d, 'Resoluções ARP de fragmentos excedidas.', p.id);
    return;
  }
  r = {
    port: p.id,
    nextHop,
    source: p.ip,
    token: e.id('fragment-arp'),
    startedAt: e.state.clock,
    nextAt: e.state.clock + 1000,
    attempts: 1,
    fragments: [f],
  };
  d.fragmentPending.push(r);
  requestArp(e, d, r);
}
export function fragmentArpPending(d: Device, p: NetworkInterface, ip: string) {
  return d.fragmentPending?.some((v) => v.port === p.id && v.nextHop === ip && v.source === p.ip) ?? false;
}
export function clearFragmentWork(e: SimulationEngine, d: Device) {
  d.fragmentPending = [];
  d.reassemblies = [];
  e.state.queue = e.state.queue.filter(
    ({ action: a }) => (a.kind !== 'fragment-arp' && a.kind !== 'fragment-expire') || a.device !== d.id
  );
}
export function flushFragmentArp(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  ip: string,
  mac: string
) {
  const items = d.fragmentPending?.filter((v) => v.port === p.id && v.nextHop === ip) ?? [];
  d.fragmentPending = d.fragmentPending?.filter((v) => !items.includes(v));
  e.state.queue = e.state.queue.filter(
    ({ action: a }) =>
      a.kind !== 'fragment-arp' || a.device !== d.id || !items.some((v) => v.token === a.token)
  );
  for (const v of items) for (const f of v.fragments) transmit(e, d, p, mac, f);
}
export function handleFragmentAction(
  e: SimulationEngine,
  a: Extract<Action, { kind: 'fragment-arp' | 'fragment-expire' }>
) {
  const d = e.device(a.device);
  if (a.kind === 'fragment-expire') {
    const r = d.reassemblies?.find((v) => v.id === a.id && v.expiresAt === a.expiresAt);
    if (!r) return;
    d.reassemblies = d.reassemblies!.filter((v) => v !== r);
    e.emit('IP_REASSEMBLY_TIMEOUT', d.id, 'Datagrama ' + r.identification + ' incompleto expirou.', {
      port: r.port,
    });
    const first = r.fragments.find((f) => f.offset === 0 && f.first);
    const ingress = d.interfaces.find((p) => p.id === r.port);
    if (!r.failed && first?.first && ingress)
      sendIcmpQuoteError(
        e,
        d,
        ingress,
        { ...first.first, ttl: first.ttl },
        'time-exceeded',
        1,
        undefined,
        first.traceId
      );
    return;
  }
  const r = d.fragmentPending?.find((v) => v.token === a.token);
  if (!r || r.nextAt !== e.state.clock) return;
  const p = d.interfaces.find((p) => p.id === r.port);
  if (p && interfaceUp(d, p) && p.ip === r.source && r.attempts < 3) {
    r.attempts++;
    requestArp(e, d, r);
    return;
  }
  d.fragmentPending = d.fragmentPending!.filter((v) => v !== r);
  e.drop(d, 'ARP de fragmentos expirou.', r.port);
}
export function validateFragments(s: Snapshot) {
  const timers = s.queue.filter(
    (v) => v.action.kind === 'fragment-expire' || v.action.kind === 'fragment-arp'
  );
  const used = new Set<string>();
  for (const d of s.devices) {
    const keys = new Set<string>();
    const ids = new Set<string>();
    if (
      (d.reassemblies ?? []).reduce((sum, r) => sum + r.fragments.reduce((n, f) => n + f.data.length, 0), 0) >
        524288 ||
      (d.fragmentPending ?? []).reduce(
        (sum, r) => sum + r.fragments.reduce((n, f) => n + f.data.length, 0),
        0
      ) > 524288
    )
      throw new Error('Buffer de fragmentos excede 512 KiB.');
    for (const r of d.reassemblies ?? []) {
      const k = key(r, r.vrf),
        port = d.interfaces.find((p) => p.id === r.port);
      const finals = r.fragments.filter((f) => !f.more);
      const end = finals[0] ? finals[0].offset + finals[0].data.length : undefined;
      if (
        keys.has(k) ||
        ids.has(r.id) ||
        !port ||
        port.vrf !== r.vrf ||
        r.expiresAt < s.clock ||
        r.expiresAt > s.clock + 30000 ||
        finals.length > 1 ||
        (end !== undefined && r.fragments.some((f) => f.offset + f.data.length > end)) ||
        (r.failed && r.fragments.length) ||
        r.fragments.some(
          (f, i) =>
            key(f, r.vrf) !== k ||
            (i > 0 && r.fragments[i - 1].offset + r.fragments[i - 1].data.length > f.offset)
        ) ||
        timers.filter(
          (v) =>
            v.action.kind === 'fragment-expire' &&
            v.action.device === d.id &&
            v.action.id === r.id &&
            v.at === r.expiresAt &&
            v.action.expiresAt === r.expiresAt
        ).length !== 1
      )
        throw new Error('Reassembly IPv4 ou timer inválido.');
      keys.add(k);
      ids.add(r.id);
      used.add(d.id + ':' + r.id);
    }
    const arpKeys = new Set<string>();
    for (const r of d.fragmentPending ?? []) {
      const p = d.interfaces.find((p) => p.id === r.port),
        k = r.port + ':' + r.nextHop;
      if (
        arpKeys.has(k) ||
        ids.has(r.token) ||
        !p ||
        p.ip !== r.source ||
        r.startedAt > s.clock ||
        r.nextAt < s.clock ||
        r.nextAt !== r.startedAt + r.attempts * 1000 ||
        timers.filter(
          (v) =>
            v.action.kind === 'fragment-arp' &&
            v.action.device === d.id &&
            v.action.token === r.token &&
            v.at === r.nextAt
        ).length !== 1
      )
        throw new Error('ARP de fragmentos ou timer inválido.');
      arpKeys.add(k);
      ids.add(r.token);
      used.add(d.id + ':' + r.token);
    }
  }
  for (const v of timers)
    if (v.action.kind === 'fragment-expire' || v.action.kind === 'fragment-arp')
      if (
        !used.has(v.action.device + ':' + (v.action.kind === 'fragment-arp' ? v.action.token : v.action.id))
      )
        throw new Error('Timer de fragmentos sem proprietário.');
}
