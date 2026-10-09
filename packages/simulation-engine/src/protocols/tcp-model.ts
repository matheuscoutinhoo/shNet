import { z } from 'zod';
import { idSchema, ipv4Schema, portNumberSchema, timeSchema, uint32Schema } from '../schemas';
import { ipv6Schema } from './ipv6-address';
export const transportAddressSchema = z.union([ipv4Schema, ipv6Schema]);

export const TCP = {
  mss: 536,
  maxMss: 8960,
  buffer: 16384,
  connections: 128,
  initialRto: 1000,
  retries: 5,
  idleMs: 120000,
  timeWaitMs: 120000,
} as const;
export const tcpBytes = (data: string) => new TextEncoder().encode(data).length;
export const tcpAdd = (sequence: number, bytes: number) => (sequence + bytes) >>> 0;
export const tcpDistance = (from: number, to: number) => (to - from) >>> 0;
export const tcpTextSchema = z
  .string()
  .max(TCP.buffer)
  .refine(
    (data) => tcpBytes(data) <= TCP.buffer && !/[\uD800-\uDFFF]/u.test(data),
    'Buffer TCP excedido ou UTF-16 inválido.'
  );
export const tcpSettingsSchema = z
  .object({
    sack: z.boolean(),
    ecn: z.boolean(),
    timestamps: z.boolean(),
    pmtud: z.boolean(),
    mss: z.number().int().min(64).max(TCP.maxMss),
  })
  .strict();
export const tcpOptionsSchema = z
  .object({
    mss: z.number().int().min(64).max(TCP.maxMss).optional(),
    sackPermitted: z.literal(true).optional(),
    sack: z
      .array(
        z
          .object({ left: uint32Schema, right: uint32Schema })
          .strict()
          .refine((b) => tcpDistance(b.left, b.right) > 0 && tcpDistance(b.left, b.right) < 0x80000000)
      )
      .min(1)
      .max(4)
      .optional(),
    timestamp: z.object({ value: uint32Schema, echo: uint32Schema }).strict().optional(),
  })
  .strict();
export const tcpOptionBytes = (options?: z.infer<typeof tcpOptionsSchema>) =>
  options
    ? Math.ceil(
        ((options.mss ? 4 : 0) +
          (options.sackPermitted ? 2 : 0) +
          (options.sack ? 2 + 8 * options.sack.length : 0) +
          (options.timestamp ? 10 : 0)) /
          4
      ) * 4
    : 0;
export const tcpPacketSchema = z
  .object({
    src: transportAddressSchema,
    dst: transportAddressSchema,
    family: z.literal(6).optional(),
    ttl: z.number().int().min(0).max(255),
    df: z.boolean().optional(),
    dscp: z.number().int().min(0).max(63).optional(),
    ecn: z.number().int().min(0).max(3).optional(),
    options: tcpOptionsSchema.optional(),
    protocol: z.literal('TCP'),
    sourcePort: portNumberSchema,
    destinationPort: portNumberSchema,
    sequence: uint32Schema,
    acknowledgment: uint32Schema,
    flags: z
      .array(z.enum(['SYN', 'ACK', 'PSH', 'FIN', 'RST', 'ECE', 'CWR']))
      .min(1)
      .max(7),
    window: z.number().int().min(0).max(65535),
    data: tcpTextSchema,
    traceId: idSchema.optional(),
    bytes: z.number().int().min(40).max(65535),
  })
  .strict()
  .refine(
    (packet) =>
      new Set(packet.flags).size === packet.flags.length &&
      packet.bytes ===
        (packet.family === 6 ? 60 : 40) + tcpOptionBytes(packet.options) + tcpBytes(packet.data) &&
      tcpOptionBytes(packet.options) <= 40 &&
      (!(packet.options?.mss || packet.options?.sackPermitted) || packet.flags.includes('SYN')) &&
      (!packet.options?.sack || (!packet.flags.includes('SYN') && packet.flags.includes('ACK'))) &&
      packet.src.includes(':') === (packet.family === 6) &&
      packet.dst.includes(':') === (packet.family === 6) &&
      !(
        packet.flags.includes('SYN') &&
        (packet.flags.includes('FIN') || packet.flags.includes('RST') || !!packet.data)
      ) &&
      !(
        packet.flags.includes('RST') &&
        (packet.flags.includes('FIN') || packet.flags.includes('PSH') || !!packet.data)
      ),
    'Cabeçalho TCP incompatível com flags ou tamanho do payload.'
  );
export type TcpPacket = z.infer<typeof tcpPacketSchema>;
export const tcpLength = (packet: TcpPacket) =>
  tcpBytes(packet.data) + Number(packet.flags.includes('SYN')) + Number(packet.flags.includes('FIN'));

export const tcpServiceSchema = z
  .object({
    port: portNumberSchema,
    kind: z.enum(['echo', 'http', 'proxy', 'load-balancer', 'ipp', 'mqtt', 'database']),
    enabled: z.boolean(),
    body: z.string().max(4096).default('shLab: servidor HTTP simulado.\n'),
  })
  .strict()
  .refine(
    (service) => tcpBytes(service.body) <= 4096 && !/[\uD800-\uDFFF]/u.test(service.body),
    'Resposta HTTP muito grande.'
  );
export type TcpService = z.infer<typeof tcpServiceSchema>;
export const tcpStateSchema = z.enum([
  'SYN-SENT',
  'SYN-RECEIVED',
  'ESTABLISHED',
  'FIN-WAIT-1',
  'FIN-WAIT-2',
  'CLOSE-WAIT',
  'CLOSING',
  'LAST-ACK',
  'TIME-WAIT',
  'CLOSED',
  'RESET',
  'TIMED-OUT',
]);
export const tcpOutstandingSchema = z
  .object({
    packet: tcpPacketSchema,
    retries: z.number().int().min(0).max(TCP.retries),
    deadline: timeSchema,
    sentAt: timeSchema.optional(),
    retransmitted: z.boolean().optional(),
    sacked: z.boolean().optional(),
  })
  .strict();
export const tcpFlowSchema = z
  .object({
    mss: z.number().int().min(1).max(TCP.maxMss),
    cwnd: z.number().finite().min(1).max(TCP.buffer),
    ssthresh: z.number().finite().min(1).max(TCP.buffer),
    duplicateAcks: z.number().int().nonnegative(),
    recovery: uint32Schema.optional(),
    srtt: timeSchema.optional(),
    rttvar: timeSchema.optional(),
    rto: z.number().int().min(1000).max(60000),
    flight: z.array(tcpOutstandingSchema).max(64),
    receiveQueue: z.array(tcpPacketSchema).max(64),
  })
  .strict();
export const tcpConnectionSchema = z
  .object({
    id: idSchema,
    role: z.enum(['client', 'server']),
    vrf: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,32}$/)
      .optional(),
    localIp: transportAddressSchema,
    remoteIp: transportAddressSchema,
    scope: idSchema.optional(),
    localPort: portNumberSchema,
    remotePort: portNumberSchema,
    state: tcpStateSchema,
    service: z.enum([
      'manual',
      'echo',
      'http',
      'dns',
      'bgp',
      'aaa',
      'netconf',
      'restconf',
      'proxy',
      'load-balancer',
      'proxy-upstream',
      'ipp',
      'mqtt',
      'database',
    ]),
    stream: z
      .object({
        readBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        writtenBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .optional(),
    bgpOpen: z
      .object({
        sent: z.boolean(),
        received: z.boolean(),
        routerId: ipv4Schema.optional(),
        evpn: z.boolean().optional(),
      })
      .strict()
      .optional(),
    dnsHandled: z.boolean().optional(),
    aaaHandled: z.boolean().optional(),
    managementHandled: z.boolean().optional(),
    initialSequence: uint32Schema,
    sendUna: uint32Schema,
    sendNext: uint32Schema,
    receiveNext: uint32Schema,
    peerWindow: z.number().int().min(0).max(65535),
    sendBuffer: tcpTextSchema,
    received: tcpTextSchema,
    closeRequested: z.boolean(),
    peerClosed: z.boolean(),
    httpHandled: z.boolean(),
    responseBody: z
      .string()
      .max(4096)
      .refine((body) => tcpBytes(body) <= 4096 && !/[\uD800-\uDFFF]/u.test(body), 'Resposta HTTP inválida.')
      .optional(),
    bytesSent: z.number().int().min(0).max(TCP.buffer),
    bytesReceived: z.number().int().min(0).max(TCP.buffer),
    retransmissions: z.number().int().nonnegative(),
    flow: tcpFlowSchema.optional(),
    extensions: z
      .object({
        local: tcpSettingsSchema,
        sack: z.boolean(),
        ecn: z.boolean(),
        timestamps: z.boolean(),
        timestampRecent: uint32Schema.optional(),
        timestampAt: timeSchema.optional(),
        ecnEcho: z.boolean(),
        cwr: z.boolean(),
        ecnUntil: uint32Schema.optional(),
        pathMtu: z.number().int().min(576).max(9216).optional(),
        lastOutOfOrder: uint32Schema.optional(),
      })
      .strict()
      .optional(),
    startedAt: timeSchema,
    updatedAt: timeSchema,
    expiresAt: timeSchema.optional(),
    pending: tcpOutstandingSchema.optional(),
  })
  .strict();
export type TcpConnection = z.infer<typeof tcpConnectionSchema>;
export const tcpFinished = (connection: TcpConnection) =>
  ['CLOSED', 'RESET', 'TIMED-OUT'].includes(connection.state);
export const tcpTimerSchema = z
  .object({
    kind: z.literal('tcp-timer'),
    device: idSchema,
    connection: idSchema,
    timer: z.enum(['retry', 'expire']),
    at: timeSchema,
  })
  .strict();
