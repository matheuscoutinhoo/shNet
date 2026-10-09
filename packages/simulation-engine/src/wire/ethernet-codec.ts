import { frameSchema, type Frame, type Packet, type Packet6, type TcpPacket } from '../model';
import { encodeRip } from '../protocols/rip-codec';
import { tcpPacketSchema } from '../protocols/tcp-model';
import { encodeDhcp6, decodeDhcp6 } from './dhcp6-codec';
import { encodeDns } from './dns-codec';
import { concat, checksum, hex, ip4, ip6, need, pseudo, readIp6, text, u16, u32, view } from './binary';
const mac = (value: string) => hex(value.replaceAll(':', ''));
const flags = { FIN: 1, SYN: 2, RST: 4, PSH: 8, ACK: 16, ECE: 64, CWR: 128 };
function tcp(input: TcpPacket) {
  const p = tcpPacketSchema.parse(input),
    o = p.options,
    options: Uint8Array[] = [];
  if (o?.mss) options.push(new Uint8Array([2, 4]), u16(o.mss));
  if (o?.sackPermitted) options.push(new Uint8Array([4, 2]));
  if (o?.timestamp) options.push(new Uint8Array([8, 10]), u32(o.timestamp.value), u32(o.timestamp.echo));
  if (o?.sack)
    options.push(
      new Uint8Array([5, 2 + 8 * o.sack.length]),
      ...o.sack.map((b) => concat(u32(b.left), u32(b.right)))
    );
  const raw = concat(...options),
    padded = concat(raw, new Uint8Array((4 - (raw.length % 4)) % 4)),
    header = concat(
      u16(p.sourcePort),
      u16(p.destinationPort),
      u32(p.sequence),
      u32(p.acknowledgment),
      new Uint8Array([((20 + padded.length) / 4) << 4, p.flags.reduce((n, f) => n | flags[f], 0)]),
      u16(p.window),
      new Uint8Array(4),
      padded,
      text(p.data)
    );
  view(header).setUint16(16, checksum(concat(pseudo(p.src, p.dst, 6, header.length), header)));
  return header;
}
function udp(src: string, dst: string, sourcePort: number, destinationPort: number, payload: Uint8Array) {
  const body = concat(
    u16(sourcePort),
    u16(destinationPort),
    u16(8 + payload.length),
    new Uint8Array(2),
    payload
  );
  view(body).setUint16(6, checksum(concat(pseudo(src, dst, 17, body.length), body)) || 65535);
  return body;
}
function quote4(q: NonNullable<Extract<Packet, { protocol: 'ICMP' }>['error']>['quote']) {
  const transport =
    q.protocol === 'TCP'
      ? concat(u16(q.sourcePort), u16(q.destinationPort), u32(q.sequence))
      : q.protocol === 'UDP'
        ? concat(u16(q.sourcePort), u16(q.destinationPort), new Uint8Array(4))
        : concat(
            new Uint8Array([q.kind === 'echo-request' ? 8 : 0, 0, 0, 0]),
            u16(identifier(q.probeId)),
            u16(1)
          );
  return ipv4(q.src, q.dst, q.ttl, q.protocol === 'TCP' ? 6 : q.protocol === 'UDP' ? 17 : 1, transport);
}
const identifier = (id: string) => {
  let value = 0;
  for (const c of id) value = (value * 31 + c.charCodeAt(0)) & 65535;
  return value;
};
function icmp4(p: Extract<Packet, { protocol: 'ICMP' }>) {
  let body;
  if (p.kind === 'echo-request' || p.kind === 'echo-reply')
    body = concat(
      new Uint8Array([p.kind === 'echo-request' ? 8 : 0, 0, 0, 0]),
      u16(identifier(p.probeId)),
      u16(1),
      new Uint8Array(Math.max(0, p.bytes - 28))
    );
  else {
    if (!p.error) throw new Error('ICMP sem citação.');
    body = concat(
      new Uint8Array([p.kind === 'unreachable' ? 3 : 11, p.error.code, 0, 0]),
      u16(0),
      u16(p.error.mtu ?? 0),
      quote4(p.error.quote)
    );
  }
  view(body).setUint16(2, checksum(body));
  return body;
}
export function ipv4(
  src: string,
  dst: string,
  ttl: number,
  protocol: number,
  body: Uint8Array,
  dscp = 0,
  ecn = 0,
  df = false
) {
  if (body.length + 20 > 65535) throw new Error('IPv4 excede comprimento.');
  const header = concat(
    new Uint8Array([0x45, (dscp << 2) | ecn]),
    u16(body.length + 20),
    u16(0),
    u16(df ? 0x4000 : 0),
    new Uint8Array([ttl, protocol]),
    u16(0),
    ip4(src),
    ip4(dst)
  );
  view(header).setUint16(10, checksum(header));
  return concat(header, body);
}
function ipv6(src: string, dst: string, ttl: number, protocol: number, body: Uint8Array, dscp = 0, ecn = 0) {
  if (body.length > 65535) throw new Error('Jumbogramas não suportados.');
  return concat(
    u32((0x60000000 | (((dscp << 2) | ecn) << 20)) >>> 0),
    u16(body.length),
    new Uint8Array([protocol, ttl]),
    ip6(src),
    ip6(dst),
    body
  );
}
function icmp6(p: Extract<Packet6, { protocol: 'ICMPv6' }>) {
  let body: Uint8Array;
  const optionMac = (code: number, value: string) => concat(new Uint8Array([code, 1]), mac(value));
  if (p.kind === 'echo-request' || p.kind === 'echo-reply')
    body = concat(
      new Uint8Array([p.kind === 'echo-request' ? 128 : 129, 0, 0, 0]),
      u16(identifier(p.probeId!)),
      u16(1),
      new Uint8Array(Math.max(0, p.bytes - 48))
    );
  else if (p.kind === 'ns' || p.kind === 'na')
    body = concat(
      new Uint8Array([p.kind === 'ns' ? 135 : 136, 0, 0, 0]),
      u32(
        p.kind === 'na'
          ? ((p.router ? 0x80000000 : 0) | (p.solicited ? 0x40000000 : 0) | (p.override ? 0x20000000 : 0)) >>>
              0
          : 0
      ),
      ip6(p.target!),
      p.mac ? optionMac(p.kind === 'ns' ? 1 : 2, p.mac) : new Uint8Array()
    );
  else if (p.kind === 'rs')
    body = concat(new Uint8Array([133, 0, 0, 0]), u32(0), p.mac ? optionMac(1, p.mac) : new Uint8Array());
  else if (p.kind === 'ra')
    body = concat(
      new Uint8Array([134, 0, 0, 0, 64, 0]),
      u16(Math.floor((p.lifetimeMs ?? 0) / 1000)),
      u32(0),
      u32(0),
      ...(p.mac ? [optionMac(1, p.mac)] : []),
      ...(p.prefixes ?? []).map((prefix) =>
        concat(
          new Uint8Array([3, 4, prefix.prefix, (prefix.onLink ? 128 : 0) | (prefix.autonomous ? 64 : 0)]),
          u32(Math.floor(prefix.validMs / 1000)),
          u32(Math.floor(prefix.preferredMs / 1000)),
          u32(0),
          ip6(prefix.network)
        )
      )
    );
  else {
    if (!p.quote) throw new Error('ICMPv6 sem citação.');
    const q = p.quote,
      transport =
        'protocol' in q
          ? concat(u16(q.sourcePort), u16(q.destinationPort), u32(q.sequence))
          : concat(new Uint8Array([128, 0, 0, 0]), u16(identifier(q.probeId)), u16(1));
    body = concat(
      new Uint8Array([p.kind === 'packet-too-big' ? 2 : p.kind === 'time-exceeded' ? 3 : 1, 0, 0, 0]),
      u32(p.kind === 'packet-too-big' ? p.mtu! : 0),
      ipv6(q.src, q.dst, 64, 'protocol' in q ? 6 : 58, transport)
    );
  }
  view(body).setUint16(2, checksum(concat(pseudo(p.src, p.dst, 58, body.length), body)));
  return body;
}
export function encodeEthernet(input: Frame): Uint8Array {
  const f = frameSchema.parse(input);
  let body: Uint8Array, type: number;
  if (f.wan || f.secure || f.wifi || f.mpls || f.bpdu || f.lacp || f.eapol || f.meshHello || f.fragment)
    throw new Error('Envelope didático ou enlace sem codec Ethernet interoperável.');
  if (f.arp) {
    const a = f.arp;
    type = 0x0806;
    body = concat(
      u16(1),
      u16(0x0800),
      new Uint8Array([6, 4]),
      u16(a.kind === 'request' ? 1 : 2),
      mac(a.senderMac),
      ip4(a.senderIp),
      a.kind === 'reply' ? mac(f.dst) : new Uint8Array(6),
      ip4(a.targetIp)
    );
  } else if (f.packet) {
    const p = f.packet;
    type = 0x0800;
    let protocol: number, transport: Uint8Array;
    if (p.protocol === 'TCP') {
      protocol = 6;
      transport = tcp(p);
    } else if (p.protocol === 'ICMP') {
      protocol = 1;
      transport = icmp4(p);
    } else if (p.protocol === 'UDP') {
      protocol = 17;
      let payload: Uint8Array;
      const v = p.payload;
      if (v.protocol === 'DNS') payload = encodeDns(v.message);
      else if (v.protocol === 'RIP') payload = encodeRip(v.message);
      else if (v.protocol === 'RADIUS') payload = hex(v.message.wire);
      else if (v.protocol === 'EAP-RADIUS') payload = hex(v.wire);
      else throw new Error('Payload UDP ' + v.protocol + ' sem codec binário.');
      transport = udp(p.src, p.dst, p.sourcePort, p.destinationPort, payload);
    } else throw new Error('Protocolo IP ' + p.protocol + ' sem codec binário.');
    body = ipv4(
      p.src,
      p.dst,
      p.ttl,
      protocol,
      transport,
      p.dscp,
      p.protocol === 'TCP' ? p.ecn : 0,
      'df' in p ? p.df : false
    );
  } else if (f.ipv6) {
    const p = f.ipv6;
    type = 0x86dd;
    let protocol: number,
      transport: Uint8Array,
      ecn = 0;
    if (p.protocol === 'TCP') {
      protocol = 6;
      transport = tcp(p.segment);
      ecn = p.segment.ecn ?? 0;
    } else if (p.protocol === 'ICMPv6') {
      protocol = 58;
      transport = icmp6(p);
    } else {
      protocol = 17;
      const d = p.datagram,
        v = d.payload;
      let payload: Uint8Array;
      if (v.protocol === 'RAW') payload = text(v.data);
      else if (v.protocol === 'DNS') payload = encodeDns(v.message);
      else if (v.protocol === 'DHCPv6') payload = encodeDhcp6(v.message);
      else payload = encodeDhcp6(v.relay);
      transport = udp(p.src, p.dst, d.sourcePort, d.destinationPort, payload);
    }
    body = ipv6(p.src, p.dst, p.hopLimit, protocol, transport, p.dscp, ecn);
  } else throw new Error('Frame sem payload suportado.');
  const ethernet = concat(
    mac(f.dst),
    mac(f.src),
    ...(f.vlan ? [u16(0x8100), u16(f.vlan)] : []),
    u16(type),
    body
  );
  return ethernet.length < 60 ? concat(ethernet, new Uint8Array(60 - ethernet.length)) : ethernet;
}
export interface DecodedEthernet {
  srcMac: string;
  dstMac: string;
  vlan?: number;
  etherType: number;
  family?: 4 | 6;
  src?: string;
  dst?: string;
  ttl?: number;
  ecn?: number;
  protocol?: number;
  arp?: { operation: number; senderIp: string; targetIp: string };
  transport?: {
    sourcePort?: number;
    destinationPort?: number;
    sequence?: number;
    acknowledgment?: number;
    flags?: string[];
    options?: { kind: number; data: number[] }[];
    payload: Uint8Array;
    dhcp6?: ReturnType<typeof decodeDhcp6>;
  };
}
export function decodeEthernet(bytes: Uint8Array): DecodedEthernet {
  if (bytes.length > 65600) throw new Error('Frame excede limite.');
  need(bytes, 0, 14);
  const dv = view(bytes),
    formatMac = (at: number) =>
      Array.from(bytes.subarray(at, at + 6), (b) => b.toString(16).padStart(2, '0')).join(':'),
    r: DecodedEthernet = { dstMac: formatMac(0), srcMac: formatMac(6), etherType: dv.getUint16(12) };
  let at = 14;
  if (r.etherType === 0x8100) {
    need(bytes, at, 4);
    r.vlan = dv.getUint16(at) & 4095;
    r.etherType = dv.getUint16(at + 2);
    at += 4;
  }
  const format4 = (at: number) => Array.from(bytes.subarray(at, at + 4)).join('.');
  if (r.etherType === 0x0806) {
    need(bytes, at, 28);
    if (
      dv.getUint16(at) !== 1 ||
      dv.getUint16(at + 2) !== 0x0800 ||
      bytes[at + 4] !== 6 ||
      bytes[at + 5] !== 4
    )
      throw new Error('ARP não Ethernet/IPv4.');
    r.arp = { operation: dv.getUint16(at + 6), senderIp: format4(at + 14), targetIp: format4(at + 24) };
    return r;
  }
  let end: number;
  if (r.etherType === 0x0800) {
    need(bytes, at, 20);
    const h = (bytes[at] & 15) * 4,
      size = dv.getUint16(at + 2);
    if (bytes[at] >>> 4 !== 4 || h < 20 || size < h) throw new Error('Cabeçalho IPv4 inválido.');
    need(bytes, at, size);
    if (checksum(bytes.subarray(at, at + h))) throw new Error('Checksum IPv4 inválido.');
    if (dv.getUint16(at + 6) & 0x3fff)
      throw new Error('Reassemble fragmentos antes de decodificar transporte.');
    r.family = 4;
    r.src = format4(at + 12);
    r.dst = format4(at + 16);
    r.ttl = bytes[at + 8];
    r.ecn = bytes[at + 1] & 3;
    r.protocol = bytes[at + 9];
    end = at + size;
    at += h;
  } else if (r.etherType === 0x86dd) {
    need(bytes, at, 40);
    if (bytes[at] >>> 4 !== 6) throw new Error('Versão IPv6 inválida.');
    const size = dv.getUint16(at + 4);
    need(bytes, at, 40 + size);
    r.family = 6;
    r.src = readIp6(bytes.subarray(at + 8, at + 24));
    r.dst = readIp6(bytes.subarray(at + 24, at + 40));
    r.ttl = bytes[at + 7];
    r.ecn = (bytes[at + 1] >>> 4) & 3;
    r.protocol = bytes[at + 6];
    end = at + 40 + size;
    at += 40;
  } else throw new Error('EtherType sem decoder.');
  const body = bytes.subarray(at, end),
    v = view(body);
  if (r.protocol === 6) {
    need(body, 0, 20);
    const header = (body[12] >>> 4) * 4;
    if (header < 20) throw new Error('Data offset TCP inválido.');
    need(body, 0, header);
    if (checksum(concat(pseudo(r.src!, r.dst!, 6, body.length), body)))
      throw new Error('Checksum TCP inválido.');
    const options: { kind: number; data: number[] }[] = [];
    for (let i = 20; i < header;) {
      const kind = body[i];
      if (kind === 0) break;
      if (kind === 1) {
        i++;
        continue;
      }
      need(body, i, 2);
      const length = body[i + 1];
      if (length < 2) throw new Error('Opção TCP inválida.');
      need(body, i, length);
      if (i + length > header) throw new Error('Opção TCP fora do cabeçalho.');
      if (
        (kind === 2 && length !== 4) ||
        (kind === 4 && length !== 2) ||
        (kind === 8 && length !== 10) ||
        (kind === 5 && (length < 10 || (length - 2) % 8))
      )
        throw new Error('Tamanho de opção TCP inválido.');
      options.push({ kind, data: [...body.subarray(i + 2, i + length)] });
      i += length;
    }
    r.transport = {
      sourcePort: v.getUint16(0),
      destinationPort: v.getUint16(2),
      sequence: v.getUint32(4),
      acknowledgment: v.getUint32(8),
      flags: Object.entries(flags)
        .filter(([, mask]) => body[13] & mask)
        .map(([name]) => name),
      options,
      payload: body.subarray(header),
    };
  } else if (r.protocol === 17) {
    need(body, 0, 8);
    const size = v.getUint16(4);
    if (size !== body.length) throw new Error('Comprimento UDP inconsistente.');
    if (
      (r.family === 6 && !v.getUint16(6)) ||
      (v.getUint16(6) && checksum(concat(pseudo(r.src!, r.dst!, 17, size), body)))
    )
      throw new Error('Checksum UDP inválido.');
    r.transport = { sourcePort: v.getUint16(0), destinationPort: v.getUint16(2), payload: body.subarray(8) };
    if (r.family === 6 && [546, 547].includes(r.transport.destinationPort!))
      r.transport.dhcp6 = decodeDhcp6(r.transport.payload);
  } else if (r.protocol === 1 || r.protocol === 58) {
    need(body, 0, 8);
    if (checksum(r.protocol === 58 ? concat(pseudo(r.src!, r.dst!, 58, body.length), body) : body))
      throw new Error('Checksum ICMP inválido.');
    r.transport = { payload: body };
  } else throw new Error('Next Header/protocolo sem decoder.');
  return r;
}
