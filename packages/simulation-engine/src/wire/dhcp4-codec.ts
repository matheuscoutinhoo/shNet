import { dhcpMessageSchema, type DhcpMessage } from '../model';
import { concat, hex, ip4, need, u32, view } from './binary';

const types = { discover: 1, offer: 2, request: 3, decline: 4, ack: 5, nak: 6, release: 7 } as const;
const names = ['', 'discover', 'offer', 'request', 'decline', 'ack', 'nak', 'release'] as const;
const zero = '0.0.0.0';
const reply = (m: DhcpMessage) => ['offer', 'ack', 'nak'].includes(m.type);
const option = (code: number, bytes: Uint8Array) => concat(new Uint8Array([code, bytes.length]), bytes);

// Native transaction IDs are an injective decimal representation of uint32.
// Opaque legacy IDs remain usable in simulation, but are never hashed/truncated
// into a different transaction in a supposedly faithful capture.
export function dhcp4TransactionNumber(id: string) {
  if (!/^dhcp-(0|[1-9][0-9]*)$/.test(id) || BigInt(id.slice(5)) > 0xffffffffn)
    throw new Error('DHCP: transação legada/opaca ou fora de uint32; captura omitida.');
  return Number(id.slice(5));
}
function body(m: DhcpMessage, exact: boolean) {
  const header = new Uint8Array(240),
    v = view(header);
  if (exact) {
    const mac = hex(m.clientMac.replaceAll(':', ''));
    if (mac[0] & 1 || mac.every((b) => b === 0)) throw new Error('DHCP: chaddr deve ser unicast.');
    if (m.type === 'request' && m.clientIp !== zero && m.requestedIp !== m.clientIp)
      throw new Error('DHCP: renovação com ciaddr e endereço solicitado diferentes.');
    if (m.type === 'request' && m.clientIp !== zero && m.server)
      throw new Error('DHCP: renovação/rebinding não deve conter Server Identifier.');
    if (m.type === 'discover' && m.clientIp !== zero) throw new Error('DHCP: DISCOVER exige ciaddr zero.');
    if (m.type === 'release' && m.clientIp === zero) throw new Error('DHCP: RELEASE exige ciaddr.');
    if (m.type === 'decline' && m.clientIp !== zero) throw new Error('DHCP: DECLINE exige ciaddr zero.');
  }
  header.set([reply(m) ? 2 : 1, 1, 6, m.hops ?? 0]);
  v.setUint32(4, exact ? dhcp4TransactionNumber(m.transactionId) : 0);
  v.setUint16(10, m.clientIp === zero || m.type === 'nak' ? 0x8000 : 0);
  header.set(ip4(m.type === 'nak' ? zero : m.clientIp), 12);
  if ('address' in m) header.set(ip4(m.address), 16);
  header.set(ip4(m.giaddr ?? zero), 24);
  header.set(hex(m.clientMac.replaceAll(':', '')), 28);
  header.set([99, 130, 83, 99], 236);
  const options = [option(53, new Uint8Array([types[m.type]]))];
  if ('server' in m && m.server) options.push(option(54, ip4(m.server)));
  // Renew/rebind use ciaddr, without Requested IP or Server Identifier.
  if ('requestedIp' in m && (m.type === 'decline' || m.clientIp === zero))
    options.push(option(50, ip4(m.requestedIp)));
  if ('leaseMs' in m) {
    if (exact && m.leaseMs % 1000)
      throw new Error('DHCP: lease fracionário em segundos não possui representação binária exata.');
    options.push(option(1, u32((0xffffffff << (32 - m.prefix)) >>> 0)));
    options.push(option(51, u32(Math.floor(m.leaseMs / 1000))));
    // Omitting 58/59 uses RFC defaults, which match the model's 1/2 and 7/8.
    if (m.leaseMs % 8000 === 0) {
      options.push(option(58, u32(m.leaseMs / 2000)));
      options.push(option(59, u32((m.leaseMs * 0.875) / 1000)));
    }
    if (m.gateway) options.push(option(3, ip4(m.gateway)));
    if (m.dns.length) options.push(option(6, concat(...m.dns.map(ip4))));
  }
  return concat(header, ...options, new Uint8Array([255]));
}
/** Size calculation also supports legacy simulation IDs and millisecond leases. */
export function dhcp4MessageSize(input: DhcpMessage) {
  return Math.max(300, body(dhcpMessageSchema.parse(input), false).length);
}
export function encodeDhcp4(input: DhcpMessage, length?: number): Uint8Array {
  const bytes = body(dhcpMessageSchema.parse(input), true),
    min = Math.max(300, bytes.length);
  const size = length ?? min;
  if (!Number.isInteger(size) || size < min || size > 65507)
    throw new Error('DHCP: tamanho do datagrama não comporta cabeçalho e opções.');
  return concat(bytes, new Uint8Array(size - bytes.length));
}

export function validDhcp4Ports(op: number, source: number, destination: number) {
  return op === 1
    ? [67, 68].includes(source) && destination === 67
    : op === 2 && source === 67 && [67, 68].includes(destination);
}

export interface DecodedDhcp4 {
  type: DhcpMessage['type'];
  op: number;
  transactionId: number;
  clientMac: string;
  clientIp: string;
  offeredIp: string;
  nextServer: string;
  giaddr: string;
  hops: number;
  seconds: number;
  broadcast: boolean;
  server?: string;
  requestedIp?: string;
  prefix?: number;
  routers: string[];
  dns: string[];
  leaseSeconds?: number;
  renewSeconds?: number;
  rebindSeconds?: number;
  options: { code: number; data: number[] }[];
}
function readOptions(bytes: Uint8Array, options: Map<number, Uint8Array>) {
  let at = 0;
  while (at < bytes.length) {
    const code = bytes[at++];
    if (!code) continue;
    if (code === 255) return;
    need(bytes, at, 1);
    const length = bytes[at++];
    need(bytes, at, length);
    options.set(code, concat(options.get(code) ?? new Uint8Array(), bytes.subarray(at, at + length)));
    at += length;
  }
  throw new Error('DHCP: opção END ausente.');
}
export function decodeDhcp4(bytes: Uint8Array): DecodedDhcp4 {
  if (bytes.length > 65507) throw new Error('DHCP excede o payload UDP IPv4.');
  need(bytes, 0, 240);
  const v = view(bytes),
    options = new Map<number, Uint8Array>();
  if (![1, 2].includes(bytes[0]) || bytes[1] !== 1 || bytes[2] !== 6 || v.getUint32(236) !== 0x63825363)
    throw new Error('DHCP: cabeçalho BOOTP/Ethernet ou magic cookie inválido.');
  readOptions(bytes.subarray(240), options);
  const field = (code: number, length: number) => {
    const b = options.get(code);
    if (b && b.length !== length) throw new Error('DHCP: comprimento inválido da opção ' + code + '.');
    return b;
  };
  const overload = field(52, 1)?.[0];
  if (overload !== undefined) {
    if (overload < 1 || overload > 3) throw new Error('DHCP: option overload inválido.');
    if (overload & 1) readOptions(bytes.subarray(108, 236), options);
    if (overload & 2) readOptions(bytes.subarray(44, 108), options);
    field(52, 1);
  }
  const t = field(53, 1)?.[0],
    type = t && names[t];
  if (!type) throw new Error('DHCP: tipo de mensagem ausente ou fora do subconjunto.');
  if ((['offer', 'ack', 'nak'].includes(type) ? 2 : 1) !== bytes[0])
    throw new Error('DHCP: op BOOTP incompatível com o tipo de mensagem.');
  const ip = (b: Uint8Array) => [...b].join('.');
  const list = (code: number) => {
    const b = options.get(code);
    if (!b) return [];
    if (!b.length || b.length % 4) throw new Error('DHCP: lista IPv4 inválida, opção ' + code + '.');
    return Array.from({ length: b.length / 4 }, (_, i) => ip(b.subarray(i * 4, i * 4 + 4)));
  };
  const address = (code: number) => {
    const b = field(code, 4);
    return b ? ip(b) : undefined;
  };
  const seconds = (code: number) => {
    const b = field(code, 4);
    return b ? view(b).getUint32(0) : undefined;
  };
  const mask = field(1, 4);
  let prefix: number | undefined;
  if (mask) {
    const n = view(mask).getUint32(0),
      inverse = ~n >>> 0;
    if ((inverse & (inverse + 1)) !== 0) throw new Error('DHCP: máscara não contígua.');
    prefix = 0;
    for (let bit = 31; bit >= 0 && (n >>> bit) & 1; bit--) prefix++;
  }
  return {
    type,
    op: bytes[0],
    transactionId: v.getUint32(4),
    clientMac: [...bytes.subarray(28, 34)].map((b) => b.toString(16).padStart(2, '0')).join(':'),
    clientIp: ip(bytes.subarray(12, 16)),
    offeredIp: ip(bytes.subarray(16, 20)),
    nextServer: ip(bytes.subarray(20, 24)),
    giaddr: ip(bytes.subarray(24, 28)),
    hops: bytes[3],
    seconds: v.getUint16(8),
    broadcast: !!(v.getUint16(10) & 0x8000),
    server: address(54),
    requestedIp: address(50),
    prefix,
    routers: list(3),
    dns: list(6),
    leaseSeconds: seconds(51),
    renewSeconds: seconds(58),
    rebindSeconds: seconds(59),
    options: [...options].map(([code, b]) => ({ code, data: [...b] })),
  };
}
