import { scenarioSchema } from './scenarios-model';
import {
  discoveryMessageSchema,
  discoveryStateSchema,
  discoveryTimerSchema,
} from './protocols/discovery-model';
import { hsrpStateSchema, hsrpMessageSchema, hsrpTimerSchema } from './protocols/hsrp-model';
import { iosSecretSchema } from './protocols/local-security-model';
import { routeEntrySchema } from './schemas';
import { databaseStateSchema } from './protocols/database-model';
import { databaseHaSchema } from './protocols/database-ha-model';
import { databaseClientSchema } from './protocols/database-client-model';
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
import { bgpStateSchema, bgpTimerSchema, bgpConfigSchema } from './protocols/bgp-model';
import { aggregateSchema, lacpPduSchema, lacpTimerSchema } from './protocols/lacp-model';
import { bondStateSchema, bondTimerSchema } from './protocols/bond-model';
export * from './protocols/lacp-model';
export * from './protocols/bgp-model';
import { z } from 'zod';
import { iosSystemSchema } from './protocols/ios-system-model';
import { monitoringSchema, monitoringTimerSchema } from './protocols/monitoring-model';
import { udldStateSchema, udldMessageSchema, udldTimerSchema } from './protocols/udld-model';
import { bfdStateSchema, bfdMessageSchema, bfdTimerSchema,bfdTemplatesSchema } from './protocols/bfd-model';
import {keyChainsSchema} from './protocols/key-chain-model';
import {mstBpduSchema} from './protocols/stp-wire-model';
import { routingPolicySchema } from './protocols/routing-policy-model';
import { mqcSchema } from './protocols/mqc-model';
import { modbusConfigSchema } from './protocols/modbus-model';
import {
  plcProcessStateSchema,
  hmiScanStateSchema,
  plcProcessTimerSchema,
  hmiScanTimerSchema,
} from './protocols/industrial-process-model';
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
import { firewallSessionSchema } from './protocols/firewall-model';
import { stateSyncSchema, stateSyncRecordSchema } from './protocols/state-sync-model';
import { dhcpHaSchema } from './protocols/dhcp-ha-model';
import { quorumLabSchema } from './protocols/quorum-lab-model';
import { quorumMessageSchema } from './protocols/quorum';
import { icmpErrorSchema } from './protocols/icmp-model';
import { ospfPacketSchema, ospfStateSchema, ospfTimerSchema, ospfConfigSchema } from './protocols/ospf-model';
import { ripConfigSchema } from './protocols/rip-model';
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
    collapsed: z.literal(true).optional(),
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
    sourceWildcard: ipv4Schema.optional(),
    destinationWildcard: ipv4Schema.optional(),
    sourcePort: z.number().int().min(1).max(65535).optional(),
    destinationPort: z.number().int().min(1).max(65535).optional(),
    established: z.boolean().optional(),
    hits: z.number().int().nonnegative().default(0),
  })
  .strict()
  .refine(
    (rule) =>
      (!rule.established || rule.protocol === 'tcp') &&
      (['udp', 'tcp'].includes(rule.protocol) ||
        (rule.sourcePort === undefined && rule.destinationPort === undefined)),
    'Portas exigem protocolo UDP ou TCP.'
  );
export const aclSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
    kind: z.enum(['standard', 'extended']).optional(),
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
    interfaceRules: z
      .array(z.object({ name: z.string().max(32), acl: z.string().max(32), outside: id }).strict())
      .max(8)
      .optional(),
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
    portState:z.enum(['discarding','learning','forwarding']).optional(),
    mst:mstBpduSchema.optional(),
    role: z.enum(['root', 'designated', 'alternate', 'disabled']).optional(),
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
    guardInconsistent: z.enum(['root', 'loop']).optional(),
    token: id.optional(),
    transitionAt: finite.nonnegative().optional(),
    proposed: z.boolean().optional(),
    agreed: z.boolean().optional(),
    transmit: z
      .object({
        count: z.number().int().min(0).max(6),
        windowStart: finite.nonnegative(),
        pendingAt: finite.nonnegative().optional(),
        agreement: z.boolean().optional(),
        pendingChangeId: id.optional(),
      })
      .strict()
      .optional(),
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
    protocol: z.enum(['stp', 'rstp']).optional(),
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
export const DHCP_MAX_LEASE_MS = 365 * 86400000;
// Per-server limits sized for a central enterprise DHCP server.
export const DHCP_LIMITS = { pools: 64, bindings: 8192 } as const;
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
    leaseMs: z.number().int().min(8000).max(DHCP_MAX_LEASE_MS),
    excluded: z.array(ipv4Schema).max(256),
    relayAddress: ipv4Schema.optional(),
    relayAddresses: z.array(ipv4Schema).max(8).optional(),
    reservations: z
      .array(
        z.object({ clientMac: mac.transform((value) => value.toLowerCase()), address: ipv4Schema }).strict()
      )
      .max(128)
      .optional(),
    // Declared with IOS "ip dhcp pool" + "network": bound to a matching interface or served by giaddr.
    ios: z.literal(true).optional(),
    domainName: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/)
      .optional(),
  })
  .strict();
// An IOS pool that cannot be bound yet (no network statement or no routed IPv4 interface).
export const dhcpPendingPoolSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/),
    network: ipv4Schema.optional(),
    prefix: z.number().int().min(1).max(30).optional(),
    start: ipv4Schema.optional(),
    end: ipv4Schema.optional(),
    gateway: ipv4Schema.optional(),
    dns: z.array(ipv4Schema).max(8),
    leaseMs: z.number().int().min(8000).max(DHCP_MAX_LEASE_MS),
    excluded: z.array(ipv4Schema).max(256).optional(),
    reservations: z
      .array(
        z.object({ clientMac: mac.transform((value) => value.toLowerCase()), address: ipv4Schema }).strict()
      )
      .max(128)
      .optional(),
    domainName: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/)
      .optional(),
  })
  .strict();
export type DhcpPendingPool = z.infer<typeof dhcpPendingPoolSchema>;
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
    pools: z.array(dhcpPoolSchema).max(DHCP_LIMITS.pools),
    bindings: z.array(dhcpBindingSchema).max(DHCP_LIMITS.bindings),
    declined: z
      .array(z.object({ address: ipv4Schema, expiresAt: finite.nonnegative() }).strict())
      .max(256)
      .optional(),
    pendingPools: z.array(dhcpPendingPoolSchema).max(DHCP_LIMITS.pools).optional(),
    // IOS global "ip dhcp excluded-address LOW [HIGH]" ranges, applied to every pool.
    excludedRanges: z
      .array(z.object({ start: ipv4Schema, end: ipv4Schema }).strict())
      .max(64)
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
    // Copper ports negotiate speed by default (IOS "speed auto"); false records a fixed "speed N".
    speedAuto: z.boolean().optional(),
    // Hardware maximum used for auto-negotiation; absent means the configured speed.
    maxSpeed: z
      .union([z.literal(100), z.literal(1000), z.literal(10000), z.literal(40000), z.literal(100000)])
      .optional(),
    duplex: z.enum(['full', 'half']),
    mtu: z.number().int().min(576).max(9216),
    mode: z.enum(['access', 'trunk', 'routed']),
    logical: z
      .object({ kind: z.enum(['subinterface', 'svi']), vlan, parent: id.optional() })
      .strict()
      .optional(),
    aggregate: aggregateSchema.optional(),
    bond: bondStateSchema.optional(),
    installedNic: z.boolean().optional(),
    tunnel: tunnelStateSchema.optional(),
    vxlan: vxlanStateSchema.optional(),
    loopback: z.literal(true).optional(),
    qos: qosStateSchema.optional(),
    ingressQos:qosStateSchema.optional(),
    dot1x: dot1xStateSchema.optional(),
    authenticationControl: z.enum(['auto', 'force-authorized', 'force-unauthorized']).optional(),
    udld: udldStateSchema.optional(),
    bfd: bfdStateSchema.optional(),
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
    stpGuard: z.enum(['root', 'loop']).optional(),
    voiceVlan: z.number().int().min(1).max(4094).optional(),
    portSecurity: z
      .object({
        enabled: z.boolean(),
        maximum: z.number().int().min(1).max(1024).default(1),
        violation: z.enum(['shutdown', 'restrict', 'protect']).default('shutdown'),
        sticky: z.boolean().default(false),
        macs: z.array(mac).max(1024).default([]),
        learned: z.array(mac).max(1024).default([]),
        violations: z.number().int().nonnegative().default(0),
      })
      .strict()
      .optional(),
    ospfAuthentication: z
      .object({
        enabled: z.boolean(),
        keyId: z.number().int().min(1).max(255).optional(),
        key: z.string().min(1).max(16).optional(),
      })
      .strict()
      .optional(),
    // Interface OSPF commands are interface configuration in IOS and may precede "router ospf".
    ospfSettings: z
      .object({
        cost: z.number().int().min(1).max(65535).optional(),
        priority: z.number().int().min(0).max(255).optional(),
        helloMs: z.number().int().min(1000).max(60000).multipleOf(1000).optional(),
        deadMs: z.number().int().min(2000).max(240000).multipleOf(1000).optional(),
        networkType: z.enum(['point-to-point', 'broadcast']).optional(),
      })
      .strict()
      .optional(),
    bpduGuard: z.boolean().optional(),
    cdpEnabled: z.boolean().optional(),
    hsrpVersion: z.union([z.literal(1), z.literal(2)]).optional(),
    lldpTransmit: z.boolean().optional(),
    lldpReceive: z.boolean().optional(),
    errDisabled: z
      .object({ reason: z.enum(['bpduguard', 'psecure-violation', 'udld']), at: finite.nonnegative() })
      .strict()
      .optional(),
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
  leaseMs: z.number().int().min(8000).max(365 * 86400000),
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
      z.object({ protocol: z.literal('HSRP'), message: hsrpMessageSchema }).strict(),
      z.object({ protocol: z.literal('BFD'), message: bfdMessageSchema }).strict(),
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
    pcp:z.number().int().min(0).max(7).optional(),
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
      'CDP',
      'LLDP',
      'UDLD',
    ]),
    eapol: eapolSchema.optional(),
    udld: udldMessageSchema.optional(),
    wan: wanHeaderSchema.optional(),
    meshHello: meshHelloSchema.optional(),
    discovery: discoveryMessageSchema.optional(),
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
    if(f.pcp!==undefined&&f.vlan===undefined)return false;
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
      f.udld,
      f.meshHello,
      f.discovery,
    ].filter(Boolean);
    if (payloads.length !== 1) return false;
    if (f.etherType === 'CDP' || f.etherType === 'LLDP')
      return f.discovery?.protocol === f.etherType && f.vlan === undefined;
    if (f.etherType === 'MESH') return !!f.meshHello && f.vlan === undefined;
    if (f.etherType === 'EAPOL') return !!f.eapol && f.vlan === undefined;
    if (f.etherType === 'UDLD') return !!f.udld && f.vlan === undefined;
    if (f.etherType === 'MPLS') return !!f.mpls;
    if (f.etherType === '802.11-secure') return !!f.secure && f.vlan === undefined;
    if (f.etherType === '802.11') return !!f.wifi && f.vlan === undefined;
    if (f.etherType === 'LACP') return !!f.lacp && f.vlan === undefined;
    if (f.etherType === 'STP')
      return !!f.bpdu && (f.vlan === undefined || (f.bpdu.domain === 'pvst' && f.bpdu.instance === f.vlan));
    return f.etherType === 'ARP' ? !!f.arp : f.etherType === 'IPv6' ? !!f.ipv6 : !!f.packet || !!f.fragment;
  }, 'Payload incompatível com EtherType');
export const routeSchema = routeEntrySchema;
export const startupConfigurationSchema = z
  .object({
    version: z.literal(1),
    interfaces: z
      .array(
        z.object(interfaceSchema.shape).pick({
          id: true,
          name: true,
          mac: true,
          media: true,
          transceiver: true,
          logical: true,
          loopback: true,
          installedNic: true,
          serial: true,
          console: true,
        })
      )
      .min(1)
      .max(48),
    commands: z.array(z.string().max(65536)).max(4096),
    protocols: z
      .object({
        ospf: ospfConfigSchema.optional(),
        rip: ripConfigSchema.optional(),
        bgp: bgpConfigSchema.optional(),
        nat: natSchema.omit({ bindings: true, sipBindings: true, hairpins: true }).optional(),
        accessLists: z.array(aclSchema).max(32).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (v) => v.commands.reduce((n, s) => n + s.length, 0) <= 1024 * 1024,
    'Startup configuration exceeds 1 MiB.'
  );
export const deviceSchema = z
  .object({
    id,
    type: z.enum(['pc', 'switch', 'router', 'server']),
    profile: z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/)
      .optional(),
    hostname: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/),
    startupConfig: startupConfigurationSchema.optional(),
    discovery: discoveryStateSchema.optional(),
    hsrp: hsrpStateSchema.optional(),
    enableSecret: iosSecretSchema.optional(),
    bootManaged: z.boolean().optional(),
    booted: z.boolean().optional(),
    bootStartedAt: finite.nonnegative().optional(),
    loopGuardDefault: z.boolean().optional(),
    iosSystem: iosSystemSchema.optional(),
    monitoring: monitoringSchema.optional(),
    dot1xSystemAuthControl: z.boolean().optional(),
    routingPolicy: routingPolicySchema.optional(),
    mqc: mqcSchema.optional(),
    operatingSystem: z
      .object({
        family: z.literal('ios-xe'),
        release: z.literal('17.12'),
        subset: z.literal('shlab-core-v1'),
      })
      .strict()
      .optional(),
    modbus: modbusConfigSchema.optional(),
    plcProcess: plcProcessStateSchema.optional(),
    hmiScan: hmiScanStateSchema.optional(),
    position: z.object({ x: finite.min(-100000).max(100000), y: finite.min(-100000).max(100000) }).strict(),
    physicalPosition: z
      .object({ x: finite.min(-100000).max(100000), y: finite.min(-100000).max(100000) })
      .strict()
      .optional(),
    power: z.boolean(),
    reassemblies: z.array(reassemblySchema).max(64).optional(),
    fragmentPending: z.array(fragmentPendingSchema).max(64).optional(),
    telemetry: telemetryStateSchema.optional(),
    telemetryCollector: collectorStateSchema.optional(),
    networkClock: clockConfigSchema.optional(),
    ntp: ntpStateSchema.optional(),
    keyChains:keyChainsSchema.optional(),
    bfdTemplates:bfdTemplatesSchema.optional(),
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
    // IOS global "ip name-server": resolver servers of a network device (up to six).
    nameServers: z.array(ipv4Schema).min(1).max(6).optional(),
    dhcpServer: dhcpServerSchema.optional(),
    dhcpHa: dhcpHaSchema.optional(),
    quorum: quorumLabSchema.optional(),
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
    databaseHa: databaseHaSchema.optional(),
    databaseClient: databaseClientSchema.optional(),
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
    stateSync: stateSyncSchema.optional(),
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
      'EVPN_ARP_REPLIED',
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
      'HA_SYNC_SENT',
      'HA_SYNC_RECEIVED',
      'HA_SYNC_REJECTED',
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
      'HSRP_STATE_CHANGED',
      'VRRP_TRACK_CHANGED',
      'LACP_SENT',
      'LACP_RECEIVED',
      'LACP_STATE_CHANGED',
      'BOND_STATE_CHANGED',
      'PLC_SCAN',
      'PROCESS_ALARM_CHANGED',
      'HMI_SAMPLE',
      'HMI_STATE_CHANGED',
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
    application: z.string().max(40).optional(),
    frame: frameSchema.optional(),
    packet: packetSchema.optional(),
  })
  .strict();
const dhcpHaReplySchema = z
  .object({
    port: id,
    request: dhcpMessageSchema,
    type: z.enum(['offer', 'ack']),
    pool: z.string().min(1).max(32),
    address: ipv4Schema,
    deadline: finite.nonnegative(),
    revision: z.number().int().positive(),
  })
  .strict();
const dhcpHaTransferSchema = z
  .object({
    device: id,
    peer: id,
    token: id,
    peerToken: id,
    link: id,
    revision: z.number().int().positive(),
    bindings: z.array(dhcpBindingSchema).max(DHCP_LIMITS.bindings),
    declined: z.array(z.object({ address: ipv4Schema, expiresAt: finite.nonnegative() }).strict()).max(256),
  })
  .strict();
export const actionSchema = z.discriminatedUnion('kind', [
  discoveryTimerSchema,
  hsrpTimerSchema,
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
  monitoringTimerSchema,
  udldTimerSchema,
  bfdTimerSchema,
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
  bondTimerSchema,
  plcProcessTimerSchema,
  hmiScanTimerSchema,
  tcpTimerSchema,
  firewallTimerSchema,
  z.object({ kind: z.literal('state-sync-tick'), device: id, token: id }).strict(),
  z.object({ kind: z.literal('dhcp-ha-tick'), device: id, token: id }).strict(),
  z.object({ kind: z.literal('quorum-tick'), device: id, token: id }).strict(),
  z.object({ kind: z.literal('database-client-tick'), device: id, token: id }).strict(),
  z
    .object({
      kind: z.literal('quorum-deliver'),
      device: id,
      token: id,
      link: id,
      message: quorumMessageSchema,
    })
    .strict(),
  dhcpHaReplySchema.extend({ kind: z.literal('dhcp-ha-reply'), device: id, token: id }),
  dhcpHaTransferSchema.extend({ kind: z.literal('dhcp-ha-deliver') }),
  dhcpHaTransferSchema.extend({ kind: z.literal('dhcp-ha-confirm') }),
  z
    .object({
      kind: z.literal('state-sync-deliver'),
      device: id,
      peer: id,
      token: id,
      peerToken: id,
      link: id,
      record: stateSyncRecordSchema,
      session: firewallSessionSchema.optional(),
      binding: natBindingSchema.optional(),
    })
    .strict(),
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
      kind: z.literal('stp-transmit'),
      device: id,
      port: id,
      at: finite.nonnegative(),
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
export const rfObstacleSchema = z
  .object({
    name: z.string().min(1).max(80),
    material: z.enum(['metal', 'concrete', 'brick', 'drywall', 'custom']),
    a: z.object({ x: finite.min(-100000).max(100000), y: finite.min(-100000).max(100000) }).strict(),
    b: z.object({ x: finite.min(-100000).max(100000), y: finite.min(-100000).max(100000) }).strict(),
    lossDb: finite.min(0).max(100),
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
    events: z.array(eventSchema).max(5000),
    diagnostics: z.array(eventSchema).max(10000).optional(),
    capture: z
      .object({
        frames: z.array(eventSchema).max(10000),
        dropped: z.number().int().nonnegative(),
        includeControl: z.boolean(),
        startedAt: finite.nonnegative(),
        bytes: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    probes: z.array(probeSchema).max(1000),
    probes6: z.array(probe6Schema).max(1000).optional(),
    notes: z.string().max(10000),
    rfObstacles: z.array(rfObstacleSchema).max(100).optional(),
    scenarios: z.array(scenarioSchema).max(32).optional(),
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
/**
 * Same contract with the event logs trusted: entries are only written by the engine's emitter, so
 * revalidating thousands of immutable records after every local edit is skipped.
 */
export const snapshotTrustedLogsSchema = snapshotSchema.extend({
  events: z.array(z.any()).max(5000),
  diagnostics: z.array(z.any()).max(10000).optional(),
  capture: z
    .object({
      frames: z.array(z.any()).max(10000),
      dropped: z.number().int().nonnegative(),
      includeControl: z.boolean(),
      startedAt: finite.nonnegative(),
      bytes: z.number().int().nonnegative().optional(),
    })
    .strict()
    .optional(),
});
/** Trusted logs, unchanged devices and existing queue entries; new ones are parsed individually. */
export const snapshotScopedSchema = snapshotTrustedLogsSchema.extend({
  devices: z.array(z.any()).max(2000),
  queue: z.array(z.any()).max(100000),
});
export const queueEntrySchema = z
  .object({ at: finite.nonnegative(), order: z.number().int().nonnegative(), action: actionSchema })
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
  events: 5000,
  capture: 10000,
  diagnostics: 10000,
  probes: 1000,
  devices: 2000,
  macAge: 300000,
  arpAge: 60000,
  arpTimeout: 3000,
  probeTimeout: 30000,
  l2Hops: 32,
} as const;
