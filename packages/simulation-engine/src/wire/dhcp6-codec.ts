import {
  dhcp6MessageSchema,
  dhcp6RelayMessageSchema,
  type Dhcp6Message,
  type Dhcp6RelayMessage,
} from '../protocols/dhcp6-model';
import { concat, hex, ip6, readIp6, text, u16, u32, view, need } from './binary';
const types = [
  '',
  'SOLICIT',
  'ADVERTISE',
  'REQUEST',
  '',
  'RENEW',
  'REBIND',
  'REPLY',
  'RELEASE',
  'DECLINE',
  '',
  'INFORMATION-REQUEST',
];
const statuses = { Success: 0, NoAddrsAvail: 2, NoBinding: 3, NotOnLink: 4, NoPrefixAvail: 6 } as const;
const option = (code: number, body: Uint8Array) => concat(u16(code), u16(body.length), body);
const seconds = (ms: number | undefined) => u32(Math.floor((ms ?? 0) / 1000));
export function encodeDhcp6(input: Dhcp6Message | Dhcp6RelayMessage): Uint8Array {
  if ('hops' in input) {
    const relay = dhcp6RelayMessageSchema.parse(input);
    let body = encodeDhcp6(relay.message);
    for (const hop of [...relay.hops].reverse())
      body = concat(
        new Uint8Array([relay.type === 'RELAY-FORW' ? 12 : 13, hop.hopCount]),
        ip6(hop.linkAddress),
        ip6(hop.peerAddress),
        option(18, text(hop.interfaceId)),
        option(9, body)
      );
    return body;
  }
  const m = dhcp6MessageSchema.parse(input),
    options = [option(1, hex(m.clientId))];
  if (m.serverId) options.push(option(2, hex(m.serverId)));
  const ia = concat(u32(m.iaid), seconds(m.t1Ms), seconds(m.t2Ms));
  if (m.requestAddress)
    options.push(
      option(
        3,
        concat(
          ia,
          m.address
            ? option(5, concat(ip6(m.address), seconds(m.preferredMs), seconds(m.validMs)))
            : new Uint8Array()
        )
      )
    );
  if (m.requestPrefix)
    options.push(
      option(
        25,
        concat(
          ia,
          m.delegatedPrefix
            ? option(
                26,
                concat(
                  seconds(m.preferredMs),
                  seconds(m.validMs),
                  new Uint8Array([m.prefixLength!]),
                  ip6(m.delegatedPrefix)
                )
              )
            : new Uint8Array()
        )
      )
    );
  if (m.rapidCommit) options.push(option(14, new Uint8Array()));
  if (m.dns?.length) options.push(option(23, concat(...m.dns.map(ip6))));
  if (m.status) options.push(option(13, u16(statuses[m.status])));
  const xid = u32(m.transactionId).subarray(1);
  return concat(new Uint8Array([types.indexOf(m.type)]), xid, ...options);
}
function options(bytes: Uint8Array, at: number) {
  const result = new Map<number, Uint8Array>();
  while (at < bytes.length) {
    need(bytes, at, 4);
    const code = view(bytes).getUint16(at),
      length = view(bytes).getUint16(at + 2);
    need(bytes, at + 4, length);
    if (result.has(code)) throw new Error('Opção DHCPv6 duplicada.');
    result.set(code, bytes.subarray(at + 4, at + 4 + length));
    at += 4 + length;
  }
  return result;
}
export function decodeDhcp6(bytes: Uint8Array, depth = 0): Dhcp6Message | Dhcp6RelayMessage {
  if (bytes.length > 65535 || depth > 8) throw new Error('DHCPv6 excede tamanho/profundidade.');
  need(bytes, 0, 4);
  if ([12, 13].includes(bytes[0])) {
    need(bytes, 0, 34);
    const opts = options(bytes, 34),
      body = opts.get(9),
      id = opts.get(18);
    if (!body || !id) throw new Error('Relay exige Relay Message e Interface-Id.');
    const inner = decodeDhcp6(body, depth + 1),
      type = bytes[0] === 12 ? 'RELAY-FORW' : 'RELAY-REPL';
    if ('hops' in inner && inner.type !== type) throw new Error('Tipos de relay inconsistentes.');
    return dhcp6RelayMessageSchema.parse({
      type,
      hops: [
        {
          hopCount: bytes[1],
          linkAddress: readIp6(bytes.subarray(2, 18)),
          peerAddress: readIp6(bytes.subarray(18, 34)),
          interfaceId: new TextDecoder('utf-8', { fatal: true }).decode(id),
        },
        ...('hops' in inner ? inner.hops : []),
      ],
      message: 'hops' in inner ? inner.message : inner,
    });
  }
  const opts = options(bytes, 4),
    client = opts.get(1);
  if (!client) throw new Error('DUID do cliente ausente.');
  const toHex = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
  const m: Dhcp6Message = {
    type: types[bytes[0]] as Dhcp6Message['type'],
    transactionId: bytes[1] * 65536 + bytes[2] * 256 + bytes[3],
    clientId: toHex(client),
    iaid: 0,
    requestAddress: opts.has(3),
    requestPrefix: opts.has(25),
  };
  if (opts.has(2)) m.serverId = toHex(opts.get(2)!);
  for (const [code, subcode] of [
    [3, 5],
    [25, 26],
  ]) {
    const body = opts.get(code);
    if (!body) continue;
    need(body, 0, 12);
    const dv = view(body),
      iaid = dv.getUint32(0);
    if (m.iaid && m.iaid !== iaid) throw new Error('IAIDs diferentes não cabem neste modelo.');
    m.iaid = iaid;
    m.t1Ms = dv.getUint32(4) * 1000;
    m.t2Ms = dv.getUint32(8) * 1000;
    const address = options(body, 12).get(subcode);
    if (!address) continue;
    need(address, 0, code === 3 ? 24 : 25);
    if (code === 3) {
      m.address = readIp6(address.subarray(0, 16));
      m.preferredMs = view(address).getUint32(16) * 1000;
      m.validMs = view(address).getUint32(20) * 1000;
    } else {
      m.preferredMs = view(address).getUint32(0) * 1000;
      m.validMs = view(address).getUint32(4) * 1000;
      m.prefixLength = address[8];
      m.delegatedPrefix = readIp6(address.subarray(9, 25));
    }
  }
  if (opts.has(14)) m.rapidCommit = true;
  const dns = opts.get(23);
  if (dns) {
    if (dns.length % 16) throw new Error('Opção DNS DHCPv6 truncada.');
    m.dns = Array.from({ length: dns.length / 16 }, (_, i) => readIp6(dns.subarray(i * 16, i * 16 + 16)));
  }
  const status = opts.get(13);
  if (status) {
    need(status, 0, 2);
    const code = view(status).getUint16(0),
      name = Object.entries(statuses).find(([, v]) => v === code)?.[0];
    if (!name) throw new Error('Status DHCPv6 não suportado.');
    m.status = name as Dhcp6Message['status'];
  }
  return dhcp6MessageSchema.parse(m);
}
