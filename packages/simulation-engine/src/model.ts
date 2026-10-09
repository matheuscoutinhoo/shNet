import { databaseStateSchema } from './protocols/database-model';
import { infrastructureConfigSchema, systemStateSchema } from './devices/infrastructure-model';
import {
  eapServerStateSchema,
  eapAuthenticatorStateSchema,
  eapSupplicantStateSchema,
} from './protocols/enterprise-model';
import {
  capwapMessageSchema,
  wlcStateSchema,
  wtpStateSchema,
  capwapTimerSchema,
} from './protocols/capwap-model';
import { meshStateSchema, meshHelloSchema, meshTimerSchema } from './protocols/mesh-model';
import { idsStateSchema } from './protocols/ids-model';
import {
  poeSupplySchema,
  poeDeviceSchema,
  serialSchema,
  consoleSchema,
  consoleSessionsSchema,
  wanHeaderSchema,
} from './devices/hardware-model';
import {
  proxyStateSchema,
  printerStateSchema,
  brokerStateSchema,
  iotStateSchema,
  applicationTimerSchema,
} from './protocols/applications-model';
import {
  phoneStateSchema,
  sipSchema,
  rtpSchema,
  voiceTimerSchema,
  sipAlgBindingSchema,
  sipAlgTimerSchema,
} from './protocols/voice-model';
import { transportAddressSchema } from './protocols/tcp-model';
import {
  dnsRecordSchema,
  dnsQuestionSchema,
  dnsMessageSchema,
  dnsCodeSchema,
  dnsResolverSchema,
  dnssecZoneSchema,
  dnssecProofSchema,
} from './protocols/dns-model';
export { dnsNameSchema, dnsRecordSchema, dnsQuestionSchema, dnsMessageSchema } from './protocols/dns-model';
export type { DnsRecord } from './protocols/dns-model';
import { hairpinBindingSchema, hairpinTimerSchema } from './protocols/nat-hairpin-model';
import { dhcpSnoopingSchema } from './protocols/dhcp-snooping-model';
import {
  fragmentSchema,
  reassemblySchema,
  fragmentPendingSchema,
  fragmentExpireSchema,
  fragmentArpTimerSchema,
} from './protocols/fragment-model';
export * from './protocols/fragment-model';
import {
  telemetryStateSchema,
  collectorStateSchema,
  telemetryMessageSchema,
  telemetryTimerSchema,
  clockConfigSchema,
  ntpStateSchema,
  ntpMessageSchema,
  ntpTimerSchema,
} from './protocols/telemetry-model';
export * from './protocols/telemetry-model';
import {
  remoteStateSchema,
  remoteQuerySchema,
  automationJobSchema,
  remoteTimerSchema,
  automationTimerSchema,
} from './protocols/remote-model';
export * from './protocols/remote-model';
import { inspectionTimerSchema } from './protocols/inspection-model';
export * from './protocols/inspection-model';
import {
  aaaServerSchema,
  aaaClientSchema,
  aaaQuerySchema,
  dot1xStateSchema,
  supplicantStateSchema,
  eapolSchema,
  radiusMessageSchema,
  dot1xTimerSchema,
  aaaTimerSchema,
} from './protocols/aaa-model';
export * from './protocols/aaa-model';
import { vxlanStateSchema, vxlanMessageSchema } from './protocols/vxlan-model';
export * from './protocols/vxlan-model';
import { qosStateSchema, qosTimerSchema } from './protocols/qos-model';
import { mplsConfigSchema, mplsPayloadSchema } from './protocols/mpls-model';
export * from './protocols/qos-model';
export * from './protocols/mpls-model';
import {
  tunnelStateSchema,
  tunnelMessageSchema,
  tunnelTimerSchema,
  sdwanStateSchema,
  sdwanControllerSchema,
  sdwanMessageSchema,
  sdwanTimerSchema,
} from './protocols/tunnel-model';
export * from './protocols/tunnel-model';
import {
  wirelessStateSchema,
  wifiPduSchema,
  wirelessTimerSchema,
  secureWifiSchema,
} from './protocols/wireless-model';
export * from './protocols/wireless-model';
import { bgpStateSchema, bgpTimerSchema } from './protocols/bgp-model';
import { aggregateSchema, lacpPduSchema, lacpTimerSchema } from './protocols/lacp-model';
export * from './protocols/lacp-model';
export * from './protocols/bgp-model';
import { z } from 'zod';
import {
  ipv6InterfaceSchema,
  packet6Schema,
  route6Schema,
  neighbor6Schema,
  pending6Schema,
  resolution6Schema,
  probe6Schema,
  ipv6TickSchema,
  ndpTimerSchema,
  probe6TimerSchema,
} from './protocols/ipv6-model';
export * from './protocols/ipv6-model';
import { vrrpPacketSchema, vrrpStateSchema, vrrpTimerSchema } from './protocols/vrrp-model';
export * from './protocols/vrrp-model';
import { ipv4Schema } from './schemas';
import {
  dhcp6ClientStateSchema,
  dhcp6ServerStateSchema,
  dhcp6TimerSchema,
  dhcp6RelayStateSchema,
} from './protocols/dhcp6-model';
import { udp6ServiceSchema, udp6RecordSchema } from './protocols/udp6-model';
export * from './protocols/dhcp6-model';
export * from './protocols/udp6-model';
import {
  tcpConnectionSchema,
  tcpPacketSchema,
  tcpSettingsSchema,
  tcpServiceSchema,
  tcpTimerSchema,
} from './protocols/tcp-model';
import { firewallSchema, firewallTimerSchema } from './protocols/firewall-model';
import { icmpErrorSchema } from './protocols/icmp-model';
import { ospfPacketSchema, ospfStateSchema, ospfTimerSchema } from './protocols/ospf-model';
export * from './protocols/ospf-model';
import { ripMessageSchema, ripStateSchema, ripTimerSchema } from './protocols/rip-model';
export * from './protocols/rip-model';
import { snmpAgentSchema, snmpMessageSchema, snmpQuerySchema, snmpTimerSchema } from './protocols/snmp-model';
import {
  syslogClientSchema,
  syslogMessageSchema,
  syslogSendSchema,
  syslogServerSchema,
} from './protocols/syslog-model';
export * from './protocols/snmp-model';
export * from './protocols/syslog-model';
export * from './protocols/firewall-model';
export * from './protocols/icmp-model';
export { ipv4Schema } from './schemas';
export * from './protocols/tcp-model';

const id = z.string().min(1).max(80);
const mac = z.string().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i);
const vlan = z.number().int().min(1).max(4094);
const finite = z.number().finite();
export const canvasItemSchema = z
  .object({
    id,
    kind: z.enum(['note', 'region', 'group', 'drawing', 'comment']),
    text: z.string().max(1000),
    position: z.object({ x: finite.min(-100000).max(100000), y: finite.min(-100000).max(100000) }).strict(),
    width: finite.min(80).max(5000),
    height: finite.min(40).max(5000),
    color: z.enum(['cyan', 'lime', 'blue', 'rose']),
    members: z.array(id).max(200).optional(),
    points: z
      .array(z.object({ x: finite.min(0).max(5000), y: finite.min(0).max(5000) }).strict())
      .min(2)
      .max(512)
      .optional(),
    anchor: z
      .object({ kind: z.enum(['device', 'link']), target: id })
      .strict()
      .optional(),
  })
  .strict();
export type CanvasItem = z.infer<typeof canvasItemSchema>;
export const subnetSchema = z
  .object({ network: ipv4Schema, prefix: z.number().int().min(0).max(32) })
  .strict();
export const aclRuleSchema = z
  .object({
    sequence: z.number().int().min(1).max(65535),
    action: z.enum(['permit', 'deny']),
    protocol: z.enum(['ip', 'icmp', 'udp', 'tcp', 'ospf', 'vrrp']),
    source: subnetSchema,
    destination: subnetSchema,
    sourcePort: z.number().int().min(1).max(65535).optional(),
    destinationPort: z.number().int().min(1).max(65535).optional(),
    hits: z.number().int().nonnegative().default(0),
  })
  .strict()
  .refine(
    (rule) =>
      ['udp', 'tcp'].includes(rule.protocol) ||
      (rule.sourcePort === undefined && rule.destinationPort === undefined),
    'Portas exigem protocolo UDP ou TCP.'
  );
export const aclSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
    rules: z.array(aclRuleSchema).max(256),
    implicitDrops: z.number().int().nonnegative().default(0),
  })
  .strict();
export type AccessList = z.infer<typeof aclSchema>;
export type AclRule = z.infer<typeof aclRuleSchema>;
const natPoolSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
    source: subnetSchema,
    outside: id,
    start: ipv4Schema,
    end: ipv4Schema,
    overload: z.boolean(),
  })
  .strict();
const natBindingSchema = z
  .object({
    id,
    pool: z.string().max(32),
    inside: ipv4Schema,
    global: ipv4Schema,
    protocol: z.enum(['ip', 'ICMP', 'UDP', 'TCP']),
    insideToken: z.string().max(80).optional(),
    globalToken: z.string().max(80).optional(),
    remote: ipv4Schema.optional(),
    remotePort: z.number().int().min(0).max(65535).optional(),
    expiresAt: finite.nonnegative(),
  })
  .strict();
export const natSchema = z
  .object({
    enabled: z.boolean(),
    hairpin: z.boolean().optional(),
    algSip: z.boolean().optional(),
    sipBindings: z.array(sipAlgBindingSchema).max(256).optional(),
    hairpins: z.array(hairpinBindingSchema).max(256).optional(),
    statics: z.array(z.object({ inside: ipv4Schema, global: ipv4Schema, outside: id }).strict()).max(128),
    pools: z.array(natPoolSchema).max(8),
    bindings: z.array(natBindingSchema).max(1024).default([]),
  })
  .strict();
export type NatConfig = z.infer<typeof natSchema>;
export type NatBinding = z.infer<typeof natBindingSchema>;
const bridgeIdSchema = z
  .object({
    priority: z.number().int().min(0).max(61440).multipleOf(4096),
    mac,
    instance: z.number().int().min(0).max(4094).optional(),
  })
  .strict();
export const bpduSchema = z
  .object({
    mode: z.enum(['stp', 'rstp']),
    root: bridgeIdSchema,
    cost: z.number().int().min(0).max(4294967295),
    bridge: bridgeIdSchema,
    portId: z.number().int().min(1).max(4095),
    age: finite.min(0).max(20000),
    proposal: z.boolean(),
    agreement: z.boolean(),
    changeId: id.optional(),
    instance: z.number().int().min(0).max(4094).optional(),
    domain: z.enum(['pvst', 'mstp']).optional(),
    region: z.string().max(4096).optional(),
  })
  .strict();
export const spanningTreePortSchema = z
  .object({
    role: z.enum(['root', 'designated', 'alternate', 'disabled']),
    state: z.enum(['discarding', 'learning', 'forwarding']),
    operational: z.boolean().optional(),
    token: id.optional(),
    transitionAt: finite.nonnegative().optional(),
    proposed: z.boolean().optional(),
    agreed: z.boolean().optional(),
    received: z
      .object({ bpdu: bpduSchema, at: finite.nonnegative(), expiresAt: finite.nonnegative() })
      .strict()
      .optional(),
  })
  .strict();
export const spanningTreeSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(['stp', 'rstp']),
    instance: z.number().int().min(0).max(4094).optional(),
    priority: z.number().int().min(0).max(61440).multipleOf(4096),
    root: bridgeIdSchema,
    cost: z.number().int().min(0).max(4294967295),
    rootPort: id.optional(),
    token: id,
    helloAt: finite.nonnegative(),
    changes: z.number().int().nonnegative(),
    changeId: id.optional(),
    changeUntil: finite.nonnegative(),
    seenChanges: z.array(id).max(64),
  })
  .strict();
export const multiSpanningTreeConfigSchema = z
  .object({
    mode: z.enum(['pvst', 'mstp']),
    region: z.string().min(1).max(32).default('SHLAB'),
    revision: z.number().int().min(0).max(65535).default(0),
    priorities: z
      .array(
        z
          .object({
            instance: z.number().int().min(0).max(4094),
            priority: z.number().int().min(0).max(61440).multipleOf(4096),
          })
          .strict()
      )
      .max(65)
      .default([]),
    mappings: z
      .array(z.object({ vlan, instance: z.number().int().min(0).max(64) }).strict())
      .max(256)
      .default([]),
  })
  .strict();
const multiSpanningTreeSchema = multiSpanningTreeConfigSchema
  .extend({
    instances: z
      .array(z.object({ id: z.number().int().min(1).max(4094), tree: spanningTreeSchema }).strict())
      .max(64),
  })
  .strict();
const dnsQuerySchema = z
  .object({
    id,
    question: dnsQuestionSchema,
    servers: z.array(transportAddressSchema).min(1).max(8),
    server: transportAddressSchema,
    port: id,
    sourceIp: transportAddressSchema,
    sourcePort: z.number().int().min(49152).max(65535),
    transactionId: z.number().int().min(0).max(65535),
    attempts: z.number().int().min(0).max(16),
    mode: z.enum(['auto', 'udp', 'tcp']).optional(),
    transport: z.enum(['udp', 'tcp']).optional(),
    tcpConnection: id.optional(),
    tcpFallback: z.boolean().optional(),
    startedAt: finite.nonnegative(),
    deadline: finite.nonnegative(),
    status: z.enum([
      'pending',
      'success',
      'nxdomain',
      'nodata',
      'servfail',
      'refused',
      'truncated',
      'timeout',
      'cancelled',
    ]),
    answers: z.array(dnsRecordSchema).max(64),
    code: dnsCodeSchema.optional(),
    elapsed: finite.nonnegative().optional(),
    fromCache: z.boolean(),
    security: z.enum(['secure', 'insecure', 'bogus']).optional(),
    pingTtl: z.number().int().min(1).max(255).optional(),
    probeId: id.optional(),
  })
  .strict();
const dnsCacheSchema = z
  .object({
    question: dnsQuestionSchema,
    server: transportAddressSchema,
    answers: z.array(dnsRecordSchema).min(1).max(64),
    storedAt: finite.nonnegative(),
    expiresAt: finite.nonnegative(),
    proof: dnssecProofSchema.optional(),
    security: z.enum(['secure', 'insecure']).optional(),
  })
  .strict();
export type DnsQuestion = z.infer<typeof dnsQuestionSchema>;
export type DnsMessage = z.infer<typeof dnsMessageSchema>;
export type DnsQuery = z.infer<typeof dnsQuerySchema>;
export type DnsCache = z.infer<typeof dnsCacheSchema>;
const dhcpLeaseSchema = z
  .object({
    id,
    address: ipv4Schema,
    prefix: z.number().int().min(1).max(30),
    server: transportAddressSchema,
    serverMac: mac,
    gateway: ipv4Schema.optional(),
    dns: z.array(ipv4Schema).max(8),
    acquiredAt: finite.nonnegative(),
    renewAt: finite.nonnegative(),
    rebindAt: finite.nonnegative(),
    expiresAt: finite.nonnegative(),
  })
  .strict()
  .refine(
    (lease) =>
      lease.acquiredAt < lease.renewAt && lease.renewAt < lease.rebindAt && lease.rebindAt < lease.expiresAt,
    'Temporizadores de lease inválidos'
  );
const dhcpClientSchema = z
  .object({
    status: z.enum([
      'selecting',
      'requesting',
      'probing',
      'bound',
      'renewing',
      'rebinding',
      'released',
      'expired',
      'failed',
    ]),
    transactionId: id,
    attempts: z.number().int().min(0).max(4),
    requestedAt: finite.nonnegative().optional(),
    restarts: z.number().int().min(0).max(4).optional(),
    offer: z.object({ address: ipv4Schema, server: ipv4Schema }).strict().optional(),
    lease: dhcpLeaseSchema.optional(),
    pendingLease: dhcpLeaseSchema.optional(),
    probeAt: finite.nonnegative().optional(),
  })
  .strict();
export const dhcpPoolSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/),
    port: id,
    network: ipv4Schema,
    prefix: z.number().int().min(1).max(30),
    start: ipv4Schema,
    end: ipv4Schema,
    gateway: ipv4Schema.optional(),
    dns: z.array(ipv4Schema).max(8),
    leaseMs: z.number().int().min(8000).max(604800000),
    excluded: z.array(ipv4Schema).max(256),
    relayAddress: ipv4Schema.optional(),
    reservations: z
      .array(
        z.object({ clientMac: mac.transform((value) => value.toLowerCase()), address: ipv4Schema }).strict()
      )
      .max(128)
      .optional(),
  })
  .strict();
const dhcpBindingSchema = z
  .object({
    id,
    pool: z.string().min(1).max(32),
    clientMac: mac,
    address: ipv4Schema,
    status: z.enum(['offered', 'bound']),
    expiresAt: finite.nonnegative(),
  })
  .strict();
const dhcpServerSchema = z
  .object({
    enabled: z.boolean(),
    pools: z.array(dhcpPoolSchema).max(16),
    bindings: z.array(dhcpBindingSchema).max(2048),
    declined: z
      .array(z.object({ address: ipv4Schema, expiresAt: finite.nonnegative() }).strict())
      .max(256)
      .optional(),
  })
  .strict();
export const interfaceSchema = z
  .object({
    id,
    name: z.string().min(1).max(50),
    mac,
    media: z.enum(['rj45', 'sfp', 'qsfp', 'wifi', 'serial', 'console', 'mesh']),
    capwapPeer: id.optional(),
    meshPeer: id.optional(),
    serial: serialSchema.optional(),
    console: consoleSchema.optional(),
    transceiver: z.enum(['single-mode', 'multi-mode', 'dac']).optional(),
    adminUp: z.boolean(),
    speed: z.union([z.literal(100), z.literal(1000), z.literal(10000), z.literal(40000), z.literal(100000)]),
    duplex: z.enum(['full', 'half']),
    mtu: z.number().int().min(576).max(9216),
    mode: z.enum(['access', 'trunk', 'routed']),
    logical: z
      .object({ kind: z.enum(['subinterface', 'svi']), vlan, parent: id.optional() })
      .strict()
      .optional(),
    aggregate: aggregateSchema.optional(),
    tunnel: tunnelStateSchema.optional(),
    vxlan: vxlanStateSchema.optional(),
    qos: qosStateSchema.optional(),
    dot1x: dot1xStateSchema.optional(),
    supplicant: supplicantStateSchema.optional(),
    channel: id.optional(),
    vrf: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,32}$/)
      .optional(),
    accessVlan: vlan,
    nativeVlan: vlan,
    allowedVlans: z.array(vlan).max(4094),
    ip: ipv4Schema.optional(),
    prefix: z.number().int().min(0).max(32).optional(),
    ipv6: ipv6InterfaceSchema.optional(),
    dhcp6: dhcp6ClientStateSchema.optional(),
    dhcp6Relay: dhcp6RelayStateSchema.optional(),
    ipv4Mode: z.enum(['static', 'dhcp']).optional(),
    gateway: ipv4Schema.optional(),
    dns: z.array(ipv4Schema).max(8).optional(),
    dhcp: dhcpClientSchema.optional(),
    dhcpConflictDetection: z.boolean().optional(),
    dhcpRelay: z.array(ipv4Schema).max(8).optional(),
    spanningTree: spanningTreePortSchema.optional(),
    spanningInstances: z
      .array(z.object({ id: z.number().int().min(1).max(4094), state: spanningTreePortSchema }).strict())
      .max(64)
      .optional(),
    mstBoundary: z.boolean().optional(),
    stpEdge: z.boolean().optional(),
    stpCost: z.number().int().min(1).max(200000000).optional(),
    description: z.string().max(160),
    aclIn: z.string().max(32).optional(),
    aclOut: z.string().max(32).optional(),
    natRole: z.enum(['inside', 'outside']).optional(),
    rx: z.number().int().nonnegative(),
    tx: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (i) => (i.ip === undefined) === (i.prefix === undefined),
    'IP e prefixo devem ser definidos juntos'
  );
const dhcpIdentity = z
  .object({
    transactionId: id,
    clientMac: mac,
    clientIp: ipv4Schema,
    giaddr: ipv4Schema.optional(),
    hops: z.number().int().min(0).max(16).optional(),
  })
  .strict();
const dhcpOptions = {
  address: ipv4Schema,
  prefix: z.number().int().min(1).max(30),
  server: ipv4Schema,
  gateway: ipv4Schema.optional(),
  dns: z.array(ipv4Schema).max(8),
  leaseMs: z.number().int().min(8000).max(604800000),
};
export const dhcpMessageSchema = z.discriminatedUnion('type', [
  dhcpIdentity.extend({ type: z.literal('discover') }),
  dhcpIdentity.extend({ type: z.literal('offer'), ...dhcpOptions }),
  dhcpIdentity.extend({
    type: z.literal('request'),
    requestedIp: ipv4Schema,
    server: ipv4Schema.optional(),
  }),
  dhcpIdentity.extend({ type: z.literal('ack'), ...dhcpOptions }),
  dhcpIdentity.extend({ type: z.literal('nak'), server: ipv4Schema }),
  dhcpIdentity.extend({ type: z.literal('release'), server: ipv4Schema }),
  dhcpIdentity.extend({ type: z.literal('decline'), server: ipv4Schema, requestedIp: ipv4Schema }),
]);
const icmpPacketSchema = z
  .object({
    src: ipv4Schema,
    dst: ipv4Schema,
    ttl: z.number().int().min(0).max(255),
    df: z.boolean().optional(),
    dscp: z.number().int().min(0).max(63).optional(),
    protocol: z.literal('ICMP'),
    kind: z.enum(['echo-request', 'echo-reply', 'time-exceeded', 'unreachable']),
    probeId: id,
    traceId: id.optional(),
    error: icmpErrorSchema.optional(),
    bytes: z.number().int().min(28).max(65535),
  })
  .strict();
const udpPacketSchema = z
  .object({
    src: ipv4Schema,
    dst: ipv4Schema,
    ttl: z.number().int().min(0).max(255),
    df: z.boolean().optional(),
    dscp: z.number().int().min(0).max(63).optional(),
    protocol: z.literal('UDP'),
    sourcePort: z.number().int().min(1).max(65535),
    destinationPort: z.number().int().min(1).max(65535),
    payload: z.discriminatedUnion('protocol', [
      z.object({ protocol: z.literal('TELEMETRY'), message: telemetryMessageSchema }).strict(),
      z.object({ protocol: z.literal('NTP'), message: ntpMessageSchema }).strict(),
      z.object({ protocol: z.literal('RADIUS'), message: radiusMessageSchema }).strict(),
      z.object({ protocol: z.literal('VXLAN'), message: vxlanMessageSchema }).strict(),
      z.object({ protocol: z.literal('TUNNEL'), message: tunnelMessageSchema }).strict(),
      z.object({ protocol: z.literal('SDWAN'), message: sdwanMessageSchema }).strict(),
      z.object({ protocol: z.literal('DHCP'), message: dhcpMessageSchema }).strict(),
      z
        .object({
          protocol: z.literal('EAP-RADIUS'),
          wire: z
            .string()
            .max(8192)
            .regex(/^(?:[a-f0-9]{2})+$/),
        })
        .strict(),
      z.object({ protocol: z.literal('CAPWAP'), message: capwapMessageSchema }).strict(),
      z.object({ protocol: z.literal('SIP'), message: sipSchema }).strict(),
      z.object({ protocol: z.literal('RTP'), message: rtpSchema }).strict(),
      z.object({ protocol: z.literal('DNS'), message: dnsMessageSchema }).strict(),
      z.object({ protocol: z.literal('RIP'), message: ripMessageSchema }).strict(),
      z.object({ protocol: z.literal('SNMP'), message: snmpMessageSchema }).strict(),
      z.object({ protocol: z.literal('SYSLOG'), message: syslogMessageSchema }).strict(),
    ]),
    bytes: z.number().int().min(28).max(65535),
  })
  .strict();
export const packetSchema = z
  .discriminatedUnion('protocol', [
    icmpPacketSchema,
    udpPacketSchema,
    tcpPacketSchema,
    ospfPacketSchema,
    vrrpPacketSchema,
  ])
  .superRefine((packet, ctx) => {
    if (packet.protocol === 'TCP' && packet.family === 6)
      ctx.addIssue({ code: 'custom', message: 'TCP IPv6 exige encapsulamento IPv6.' });
    if (packet.protocol !== 'ICMP' || !packet.error) return;
    if (
      !['time-exceeded', 'unreachable'].includes(packet.kind) ||
      (packet.kind === 'time-exceeded' && packet.error.code !== 0) ||
      packet.bytes < 56 ||
      packet.dst !== packet.error.quote.src
    )
      ctx.addIssue({ code: 'custom', message: 'Erro ICMP e cabeçalho citado incompatíveis.' });
  });
export const arpSchema = z
  .object({ kind: z.enum(['request', 'reply']), senderIp: ipv4Schema, senderMac: mac, targetIp: ipv4Schema })
  .strict();
export const frameSchema = z
  .object({
    src: mac,
    dst: mac,
    vlan: vlan.optional(),
    etherType: z.enum([
      'ARP',
      'IPv4',
      'IPv6',
      'STP',
      'LACP',
      '802.11',
      '802.11-secure',
      'MPLS',
      'EAPOL',
      'MESH',
    ]),
    eapol: eapolSchema.optional(),
    wan: wanHeaderSchema.optional(),
    meshHello: meshHelloSchema.optional(),
    wifi: wifiPduSchema.optional(),
    secure: secureWifiSchema.optional(),
    mpls: mplsPayloadSchema.optional(),
    ipv6: packet6Schema.optional(),
    lacp: lacpPduSchema.optional(),
    arp: arpSchema.optional(),
    packet: packetSchema.optional(),
    fragment: fragmentSchema.optional(),
    bpdu: bpduSchema.optional(),
    hops: z.number().int().min(0).max(64),
  })
  .strict()
  .refine((f) => {
    const payloads = [
      f.lacp,
      f.arp,
      f.packet,
      f.fragment,
      f.ipv6,
      f.bpdu,
      f.wifi,
      f.secure,
      f.mpls,
      f.eapol,
      f.meshHello,
    ].filter(Boolean);
    if (payloads.length !== 1) return false;
    if (f.etherType === 'MESH') return !!f.meshHello && f.vlan === undefined;
    if (f.etherType === 'EAPOL') return !!f.eapol && f.vlan === undefined;
    if (f.etherType === 'MPLS') return !!f.mpls;
    if (f.etherType === '802.11-secure') return !!f.secure && f.vlan === undefined;
    if (f.etherType === '802.11') return !!f.wifi && f.vlan === undefined;
    if (f.etherType === 'LACP') return !!f.lacp && f.vlan === undefined;
    if (f.etherType === 'STP')
      return !!f.bpdu && (f.vlan === undefined || (f.bpdu.domain === 'pvst' && f.bpdu.instance === f.vlan));
    return f.etherType === 'ARP' ? !!f.arp : f.etherType === 'IPv6' ? !!f.ipv6 : !!f.packet || !!f.fragment;
  }, 'Payload incompatível com EtherType');
export const routeSchema = z
  .object({
    network: ipv4Schema,
    prefix: z.number().int().min(0).max(32),
    nextHop: ipv4Schema,
    metric: z.number().int().min(0).max(65535),
    vrf: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,32}$/)
      .optional(),
  })
  .strict();
export const deviceSchema = z
  .object({
    id,
    type: z.enum(['pc', 'switch', 'router', 'server']),
    profile: z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/)
      .optional(),
    hostname: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/),
    position: z.object({ x: finite.min(-100000).max(100000), y: finite.min(-100000).max(100000) }).strict(),
    power: z.boolean(),
    reassemblies: z.array(reassemblySchema).max(64).optional(),
    fragmentPending: z.array(fragmentPendingSchema).max(64).optional(),
    telemetry: telemetryStateSchema.optional(),
    telemetryCollector: collectorStateSchema.optional(),
    networkClock: clockConfigSchema.optional(),
    ntp: ntpStateSchema.optional(),
    remoteManagement: remoteStateSchema.optional(),
    remoteQueries: z.array(remoteQuerySchema).max(128).optional(),
    automationJobs: z.array(automationJobSchema).max(16).optional(),
    aaaServer: aaaServerSchema.optional(),
    aaaClient: aaaClientSchema.optional(),
    aaaQueries: z.array(aaaQuerySchema).max(128).optional(),
    networkAuth: z
      .object({
        query: id,
        commands: z.array(z.string().min(1).max(128)).max(16).default(['*']),
        username: z.string().max(64),
        privilege: z.number().int().min(0).max(15),
        expiresAt: finite.nonnegative(),
      })
      .strict()
      .optional(),
    wireless: wirelessStateSchema.optional(),
    sdwan: sdwanStateSchema.optional(),
    mpls: mplsConfigSchema.optional(),
    sdwanController: sdwanControllerSchema.optional(),
    ipRouting: z.boolean().optional(),
    ipv6Routing: z.boolean().optional(),
    dhcp6Server: dhcp6ServerStateSchema.optional(),
    udp6Services: z.array(udp6ServiceSchema).max(32).optional(),
    udp6Records: z.array(udp6RecordSchema).max(256).optional(),
    routes6: z.array(route6Schema).max(256).optional(),
    neighbors6: z.array(neighbor6Schema).max(2048).optional(),
    pending6: z.array(pending6Schema).max(256).optional(),
    resolutions6: z.array(resolution6Schema).max(256).optional(),
    vrfs: z
      .array(z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/))
      .max(32)
      .optional(),
    interfaces: z.array(interfaceSchema).min(1).max(48),
    gateway: ipv4Schema.optional(),
    dhcpServer: dhcpServerSchema.optional(),
    dhcpSnooping: dhcpSnoopingSchema.optional(),
    dnsServer: z
      .object({
        enabled: z.boolean(),
        records: z.array(dnsRecordSchema).max(256),
        zones: z.array(dnssecZoneSchema).max(16).optional(),
      })
      .strict()
      .optional(),
    wlc: wlcStateSchema.optional(),
    wtp: wtpStateSchema.optional(),
    mesh: meshStateSchema.optional(),
    eapServer: eapServerStateSchema.optional(),
    eapAuthenticator: eapAuthenticatorStateSchema.optional(),
    eapSupplicant: eapSupplicantStateSchema.optional(),
    ids: idsStateSchema.optional(),
    infrastructure: infrastructureConfigSchema.optional(),
    system: systemStateSchema.optional(),
    poeSupply: poeSupplySchema.optional(),
    poeDevice: poeDeviceSchema.optional(),
    consoleSessions: consoleSessionsSchema.optional(),
    proxy: proxyStateSchema.optional(),
    database: databaseStateSchema.optional(),
    printer: printerStateSchema.optional(),
    broker: brokerStateSchema.optional(),
    iot: iotStateSchema.optional(),
    phone: phoneStateSchema.optional(),
    dnsResolver: dnsResolverSchema.optional(),
    dnsQueries: z.array(dnsQuerySchema).max(128).optional(),
    dnsCache: z.array(dnsCacheSchema).max(128).optional(),
    spanningTree: spanningTreeSchema.optional(),
    multiSpanningTree: multiSpanningTreeSchema.optional(),
    accessLists: z.array(aclSchema).max(32).optional(),
    nat: natSchema.optional(),
    tcpServices: z.array(tcpServiceSchema).max(32).optional(),
    tcpConnections: z.array(tcpConnectionSchema).max(128).optional(),
    tcpSettings: tcpSettingsSchema.optional(),
    firewall: firewallSchema.optional(),
    ospf: ospfStateSchema.optional(),
    rip: ripStateSchema.optional(),
    vrrp: vrrpStateSchema.optional(),
    bgp: bgpStateSchema.optional(),
    snmpAgent: snmpAgentSchema.optional(),
    snmpQueries: z.array(snmpQuerySchema).max(128).optional(),
    syslogClient: syslogClientSchema.optional(),
    syslogServer: syslogServerSchema.optional(),
    vlans: z.array(z.object({ id: vlan, name: z.string().min(1).max(32) }).strict()).max(256),
    routes: z.array(routeSchema).max(256),
    macTable: z.array(z.object({ vlan, mac, port: id, expires: finite.nonnegative() }).strict()).max(2048),
    arpTable: z
      .array(z.object({ ip: ipv4Schema, mac, port: id, expires: finite.nonnegative() }).strict())
      .max(2048),
    pending: z
      .array(
        z
          .object({ port: id, nextHop: ipv4Schema, packet: packetSchema, mpls: mplsPayloadSchema.optional() })
          .strict()
      )
      .max(256),
    arpResolutions: z
      .array(
        z
          .object({
            port: id,
            ip: ipv4Schema,
            sourceIp: ipv4Schema,
            token: id,
            attempts: z.number().int().min(1).max(3),
            startedAt: finite.nonnegative(),
            nextAt: finite.nonnegative(),
          })
          .strict()
      )
      .max(256)
      .optional(),
    logs: z.array(z.string().max(300)).max(100),
    dropped: z.number().int().nonnegative(),
  })
  .strict();
export const linkSchema = z
  .object({
    id,
    a: z.object({ device: id, port: id }).strict(),
    b: z.object({ device: id, port: id }).strict(),
    cable: z.enum([
      'copper',
      'crossover',
      'fiber-sm',
      'fiber-mm',
      'dac',
      'wireless',
      'serial',
      'console',
      'mesh',
    ]),
    up: z.boolean(),
    latency: finite.min(0.1).max(10000),
    jitter: finite.min(0).max(10000),
    loss: finite.min(0).max(1),
    distance: finite.min(0).max(100000),
  })
  .strict();
export const eventSchema = z
  .object({
    id: id,
    time: finite.nonnegative(),
    type: z.enum([
      'TELEMETRY_SENT',
      'TELEMETRY_RECEIVED',
      'NTP_SENT',
      'NTP_STATE',
      'REMOTE_REQUEST',
      'REMOTE_RESPONSE',
      'REMOTE_COMMIT',
      'AUTOMATION_STATE',
      'DOT1X_SENT',
      'DOT1X_RECEIVED',
      'DOT1X_STATE',
      'DOT1X_DENY',
      'AAA_SENT',
      'AAA_RESULT',
      'TUNNEL_SENT',
      'TUNNEL_RECEIVED',
      'TUNNEL_STATE',
      'TUNNEL_AUTH_FAILED',
      'SDWAN_PATH',
      'SDWAN_POLICY',
      'QOS_ENQUEUE',
      'QOS_DEQUEUE',
      'QOS_DROP',
      'QOS_MARK',
      'MPLS_PUSH',
      'MPLS_SWAP',
      'MPLS_POP',
      'VXLAN_ENCAP',
      'VXLAN_DECAP',
      'EVPN_ADVERTISE',
      'EVPN_INSTALL',
      'EVPN_WITHDRAW',
      'WIFI_SENT',
      'WIFI_RECEIVED',
      'WIFI_STATE',
      'WIFI_AUTH_FAILED',
      'IPV6_ADDRESS',
      'NDP_SENT',
      'NDP_RECEIVED',
      'NDP_UPDATED',
      'IPV6_ROUTE',
      'FRAME_SENT',
      'FRAME_RECEIVED',
      'FRAME_FLOODED',
      'MAC_LEARNED',
      'ARP_REQUEST',
      'ARP_REPLY',
      'ARP_TABLE_UPDATED',
      'PACKET_SENT',
      'PACKET_RECEIVED',
      'PACKET_DROPPED',
      'IP_FRAGMENT',
      'IP_REASSEMBLED',
      'IP_REASSEMBLY_TIMEOUT',
      'ROUTE_SELECTED',
      'LINK_UP',
      'LINK_DOWN',
      'CONFIG_CHANGED',
      'PING_SUCCESS',
      'PING_TIMEOUT',
      'DHCP_DISCOVER',
      'DHCP_OFFER',
      'DHCP_REQUEST',
      'DHCP_ACK',
      'DHCP_NAK',
      'DHCP_RELEASE',
      'DHCP_DECLINE',
      'DHCP_PROBE',
      'DHCP_BOUND',
      'DHCP_RENEWING',
      'DHCP_REBINDING',
      'DHCP_EXPIRED',
      'DHCP_FAILED',
      'DHCP_POOL_EXHAUSTED',
      'DHCP_LEASE_EXPIRED',
      'DHCP_RELAY_REQUEST',
      'DHCP_RELAY_REPLY',
      'DNS_QUERY',
      'DNS_RESPONSE',
      'DNS_TCP_FALLBACK',
      'DNS_ANSWER',
      'DNS_CACHE_HIT',
      'DNS_TIMEOUT',
      'DNS_FAILED',
      'BPDU_SENT',
      'BPDU_RECEIVED',
      'STP_ROOT_CHANGED',
      'STP_PORT_CHANGED',
      'STP_TOPOLOGY_CHANGED',
      'ACL_PERMIT',
      'ACL_DENY',
      'NAT_TRANSLATED',
      'NAT_EXPIRED',
      'NAT_EXHAUSTED',
      'TCP_SENT',
      'TCP_RECEIVED',
      'TCP_STATE_CHANGED',
      'TCP_RETRANSMIT',
      'TCP_TIMEOUT',
      'TCP_RESET',
      'APPLICATION_DATA',
      'FIREWALL_APPLICATION',
      'FIREWALL_PERMIT',
      'FIREWALL_DENY',
      'FIREWALL_EXPIRED',
      'OSPF_HELLO',
      'OSPF_SENT',
      'OSPF_RECEIVED',
      'OSPF_NEIGHBOR_CHANGED',
      'OSPF_DR_CHANGED',
      'OSPF_LSA',
      'OSPF_SPF',
      'BGP_STATE_CHANGED',
      'BGP_SENT',
      'BGP_RECEIVED',
      'BGP_ROUTE_REJECTED',
      'BGP_SESSION_CLOSED',
      'VRRP_STATE_CHANGED',
      'VRRP_TRACK_CHANGED',
      'LACP_SENT',
      'LACP_RECEIVED',
      'LACP_STATE_CHANGED',
      'VRRP_ADVERT_SENT',
      'VRRP_ADVERT_RECEIVED',
      'RIP_REQUEST',
      'RIP_UPDATE',
      'RIP_RECEIVED',
      'ROUTE_ADDED',
      'ROUTE_REMOVED',
      'SNMP_QUERY',
      'SNMP_RESPONSE',
      'SNMP_ANSWER',
      'SNMP_REJECTED',
      'SNMP_FAILED',
      'SYSLOG_QUEUED',
      'SYSLOG_SENT',
      'SYSLOG_RECEIVED',
      'SYSLOG_FILTERED',
      'SYSLOG_FAILED',
    ]),
    device: id,
    port: id.optional(),
    peer: id.optional(),
    link: id.optional(),
    reason: z.string().max(500),
    frame: frameSchema.optional(),
  })
  .strict();
export const actionSchema = z.discriminatedUnion('kind', [
  fragmentExpireSchema,
  fragmentArpTimerSchema,
  hairpinTimerSchema,
  voiceTimerSchema,
  applicationTimerSchema,
  meshTimerSchema,
  capwapTimerSchema,
  sipAlgTimerSchema,
  dhcp6TimerSchema,
  telemetryTimerSchema,
  ntpTimerSchema,
  remoteTimerSchema,
  automationTimerSchema,
  inspectionTimerSchema,
  dot1xTimerSchema,
  aaaTimerSchema,
  qosTimerSchema,
  sdwanTimerSchema,
  tunnelTimerSchema,
  wirelessTimerSchema,
  ipv6TickSchema,
  ndpTimerSchema,
  probe6TimerSchema,
  lacpTimerSchema,
  tcpTimerSchema,
  firewallTimerSchema,
  ospfTimerSchema,
  ripTimerSchema,
  vrrpTimerSchema,
  bgpTimerSchema,
  snmpTimerSchema,
  syslogSendSchema,
  z
    .object({ kind: z.literal('nat-expire'), device: id, binding: id, expiresAt: finite.nonnegative() })
    .strict(),
  z
    .object({
      kind: z.literal('stp-info-expire'),
      device: id,
      port: id,
      expiresAt: finite.nonnegative(),
      instance: z.number().int().min(0).max(4094).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('stp-hello'),
      device: id,
      token: id,
      instance: z.number().int().min(0).max(4094).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('stp-transition'),
      instance: z.number().int().min(0).max(4094).optional(),
      device: id,
      port: id,
      token: id,
      state: z.enum(['learning', 'forwarding']),
    })
    .strict(),
  z
    .object({ kind: z.literal('deliver'), device: id, port: id, from: id, link: id, frame: frameSchema })
    .strict(),
  z
    .object({ kind: z.literal('arp-timeout'), device: id, port: id, ip: ipv4Schema, token: id.optional() })
    .strict(),
  z.object({ kind: z.literal('probe-timeout'), probeId: id }).strict(),
  z
    .object({
      kind: z.literal('dns-timeout'),
      device: id,
      queryId: id,
      attempt: z.number().int().min(1).max(16),
    })
    .strict(),
  z
    .object({
      kind: z.literal('dhcp-client-timer'),
      device: id,
      port: id,
      token: id,
      timer: z.enum(['retry', 'renew', 'rebind', 'expire', 'probe']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('dhcp-binding-expire'),
      device: id,
      binding: id,
      expiresAt: finite.nonnegative(),
    })
    .strict(),
]);
export const probeSchema = z
  .object({
    id,
    vrf: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,32}$/)
      .optional(),
    device: id,
    target: ipv4Schema,
    start: finite.nonnegative(),
    status: z.enum(['pending', 'success', 'timeout', 'time-exceeded', 'unreachable']),
    rtt: finite.nonnegative().optional(),
    responder: ipv4Schema.optional(),
    ttl: z.number().int().min(1).max(255),
    dscp: z.number().int().min(0).max(63).optional(),
  })
  .strict();
export const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    clock: finite.nonnegative(),
    seed: z.number().int().min(1).max(4294967295),
    sequence: z.number().int().nonnegative(),
    devices: z.array(deviceSchema).max(2000),
    links: z.array(linkSchema).max(8000),
    queue: z
      .array(
        z
          .object({ at: finite.nonnegative(), order: z.number().int().nonnegative(), action: actionSchema })
          .strict()
      )
      .max(100000),
    events: z.array(eventSchema).max(1500),
    probes: z.array(probeSchema).max(200),
    probes6: z.array(probe6Schema).max(200).optional(),
    notes: z.string().max(10000),
    background: z.enum(['light', 'gray', 'dark']),
    pattern: z.enum(['dots', 'grid', 'fine-grid', 'none']),
    snapToGrid: z.boolean().optional(),
    viewport: z
      .object({ x: finite, y: finite, zoom: finite.min(0.15).max(2.5) })
      .strict()
      .optional(),
    canvasItems: z.array(canvasItemSchema).max(100).optional(),
  })
  .strict();
export type Device = z.infer<typeof deviceSchema>;
export type BridgeId = z.infer<typeof bridgeIdSchema>;
export type Bpdu = z.infer<typeof bpduSchema>;
export type NetworkInterface = z.infer<typeof interfaceSchema>;
export type Link = z.infer<typeof linkSchema>;
export type Frame = z.infer<typeof frameSchema>;
export type Packet = z.infer<typeof packetSchema>;
export type IcmpPacket = z.infer<typeof icmpPacketSchema>;
export type UdpPacket = z.infer<typeof udpPacketSchema>;
export type DhcpMessage = z.infer<typeof dhcpMessageSchema>;
export type DhcpPool = z.infer<typeof dhcpPoolSchema>;
export type DhcpBinding = z.infer<typeof dhcpBindingSchema>;
export type DhcpClient = z.infer<typeof dhcpClientSchema>;
export type DhcpLease = z.infer<typeof dhcpLeaseSchema>;
export type NetworkEvent = z.infer<typeof eventSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Probe = z.infer<typeof probeSchema>;
export const BROADCAST = 'ff:ff:ff:ff:ff:ff';
export const STP = {
  destination: '01:80:c2:00:00:00',
  pvstDestination: '01:00:0c:cc:cc:cd',
  hello: 2000,
  forwardDelay: 15000,
  maxAge: 20000,
  rapidAge: 6000,
} as const;
export const DNS = {
  port: 53,
  timeout: 5000,
  attemptsPerServer: 2,
  maxQueries: 128,
  maxCache: 128,
  maxAliases: 8,
  maxUdpBytes: 512,
} as const;
export const DHCP = {
  serverPort: 67,
  clientPort: 68,
  broadcastIp: '255.255.255.255',
  unspecifiedIp: '0.0.0.0',
  retryMs: 4000,
  offerMs: 30000,
  attempts: 4,
} as const;
export const LIMITS = {
  queue: 100000,
  events: 1500,
  probes: 200,
  devices: 2000,
  macAge: 300000,
  arpAge: 60000,
  arpTimeout: 3000,
  probeTimeout: 30000,
  l2Hops: 32,
} as const;
