import { validateDatabase } from '../protocols/database';
import { validateDatabaseHa } from '../protocols/database-ha';
import { validateDatabaseClient } from '../protocols/database-client';
import { validateModbus } from '../protocols/modbus';
import { validatePlcProcesses } from '../protocols/plc-process';
import { validateHmiScans } from '../protocols/hmi-scan';
import { validateInfrastructure } from '../devices/infrastructure';
import { validateEnterprise } from '../protocols/enterprise';
import { validateCapwap } from '../protocols/capwap';
import { validateMesh } from '../protocols/mesh';
import { validateIds } from '../protocols/ids';
import { validateHardware } from '../devices/hardware';
import { validateApplications } from '../protocols/applications';
import { validateVoice } from '../protocols/voice';
import { validateFragments } from '../protocols/fragment';
import { validateDhcpSnooping } from '../protocols/dhcp-snooping';
import { deviceProfiles } from '../devices/profiles';
import { validateTelemetry } from '../protocols/telemetry';
import { validateNtp } from '../protocols/ntp';
import { validateRemote } from '../protocols/remote-validation';
import { validateInspection } from '../protocols/inspection';
import { validateAaa } from '../protocols/aaa-validation';
import { validateVxlan } from '../protocols/vxlan';
import { validateQos } from '../protocols/qos';
import { validateMpls } from '../protocols/mpls';
import { validateTunnels } from '../protocols/tunnel-validation';
import { validateWireless } from '../protocols/wireless';
import { validateIpv6 } from '../protocols/ipv6-validation';
import { validateDhcp6 } from '../protocols/dhcp6';
import { validateBgp } from '../protocols/bgp-validation';
import { validateLayer3 } from '../protocols/layer3';
import { validateLacp } from '../protocols/lacp';
import { validateBonds } from '../protocols/bond';
import { validateVrrp } from '../protocols/vrrp';
import {
  deviceSchema,
  queueEntrySchema,
  snapshotSchema,
  snapshotScopedSchema,
  snapshotTrustedLogsSchema,
  type Device,
  type Snapshot,
} from '../model';
import { endpoint, validateMedia } from '../links/physical';
import { validateDhcpDevice } from '../protocols/dhcp-config';
import { validateDnsState } from '../protocols/dns-records';
import { validateSpanningTree } from '../protocols/stp-validation';
import { validateAcls } from '../protocols/acl';
import { validateNatSnapshot } from '../protocols/nat';
import { validateCanvas } from '../canvas';
import { validateTcp } from '../protocols/tcp-validation';
import { validateFirewall } from '../protocols/firewall';
import { validateOspf } from '../protocols/ospf-validation';
import { validateMonitoring } from '../protocols/monitoring';
import { validateUdld } from '../protocols/udld';
import { validateBfd } from '../protocols/bfd';
import { validateRoutingPolicy } from '../protocols/routing-policy';
import { validateMqc } from '../protocols/mqc';
import { validateRip } from '../protocols/rip-validation';
import { validateManagement } from '../protocols/management-validation';
import { validateArp } from '../protocols/arp';
import { validateStateSync } from '../protocols/state-sync';
import { validateDhcpHa } from '../protocols/dhcp-ha';
import { validateQuorumLab } from '../protocols/quorum-lab';
import { validateDiscovery } from '../protocols/discovery';
import { validateHsrp } from '../protocols/hsrp';
import { checkDevice, validatedDevice, withValidationScope } from './validation-scope';
export interface ValidationOptions {
  // Re-validating the live engine state after a local edit: engine-written event/capture records are trusted.
  trustedLogs?: boolean;
  // Only these devices and queue entries changed since the state was last validated (implies trustedLogs).
  changed?: { devices: ReadonlySet<string>; queue: Snapshot['queue'] };
}
/** Full snapshot validation; options narrow it for incremental checks of the live engine state. */
export function validateSnapshot(value: unknown, options: ValidationOptions = {}): Snapshot {
  const scope = options.changed?.devices;
  const s = (
    scope ? snapshotScopedSchema : options.trustedLogs ? snapshotTrustedLogsSchema : snapshotSchema
  ).parse(value) as Snapshot;
  if (scope) {
    s.devices = s.devices.map((d) => (scope.has(d.id) ? (deviceSchema.parse(d) as Device) : d));
    for (const entry of options.changed!.queue) queueEntrySchema.parse(entry);
  }
  return withValidationScope(s, scope, () => validateParsed(s, !!scope || !!options.trustedLogs));
}
function validateParsed(s: Snapshot, trustedLogs: boolean): Snapshot {
  validateMonitoring(s);
  validateMqc(s);
  for (const d of s.devices) if (checkDevice(d.id)) validateRoutingPolicy(d);
  if (s.capture) {
    if (
      s.capture.startedAt > s.clock ||
      s.capture.frames.some((e) => e.type !== 'FRAME_SENT' || !e.frame || e.time > s.clock)
    )
      throw new Error('Captura contém frames ou horários inválidos.');
    if (!trustedLogs || s.capture.bytes === undefined)
      s.capture.bytes = s.capture.frames.reduce((total, e) => total + JSON.stringify(e).length * 2, 0);
    if (s.capture.bytes > 2 * 1024 * 1024) throw new Error('Captura excede o limite de 2 MiB.');
  }
  validateTelemetry(s);
  validateDiscovery(s);
  validateHsrp(s);
  validateNtp(s);
  validateRemote(s);
  validateAaa(s);
  validateWireless(s);
  validateEnterprise(s);
  validateTunnels(s);
  validateQos(s);
  validateMpls(s);
  validateVxlan(s);
  validateLayer3(s);
  validateIpv6(s);
  validateDhcp6(s);
  validateDhcpSnooping(s);
  validateFragments(s);
  validateVoice(s);
  validateApplications(s);
  validateDatabase(s);
  validateHardware(s);
  validateInfrastructure(s);
  validateIds(s);
  validateMesh(s);
  validateCapwap(s);
  validateLacp(s);
  validateBonds(s);
  validateCanvas(s);
  validateTcp(s);
  validateModbus(s);
  validatePlcProcesses(s);
  validateHmiScans(s);
  validateFirewall(s);
  validateStateSync(s);
  validateDhcpHa(s);
  validateQuorumLab(s);
  validateDatabaseHa(s);
  validateDatabaseClient(s);
  validateInspection(s);
  validateOspf(s);
  validateUdld(s);
  validateBfd(s);
  validateRip(s);
  validateManagement(s);
  validateArp(s);
  validateVrrp(s);
  validateBgp(s);
  for (const device of s.devices) if (checkDevice(device.id)) validateAcls(device);
  validateNatSnapshot(s);
  validateSpanningTree(s);
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length) throw new Error(label + ' duplicado');
  };
  unique(
    s.devices.map((d) => d.id),
    'ID de equipamento'
  );
  unique(
    s.links.map((l) => l.id),
    'ID de cabo'
  );
  unique(
    s.devices.flatMap((d) => d.interfaces.map((i) => i.mac)),
    'MAC'
  );
  const occupied = new Set<string>();
  const clientTimers = new Map<string, number>();
  const bindingTimers = new Map<string, { at: number; expiresAt: number }>();
  const dnsTimers = new Map<string, { at: number; attempt: number }>();
  for (const { at, action } of s.queue) {
    if (action.kind === 'dhcp-client-timer')
      clientTimers.set(JSON.stringify([action.device, action.port, action.token, action.timer]), at);
    else if (action.kind === 'dhcp-binding-expire')
      bindingTimers.set(JSON.stringify([action.device, action.binding]), { at, expiresAt: action.expiresAt });
    else if (action.kind === 'dns-timeout')
      dnsTimers.set(JSON.stringify([action.device, action.queryId]), { at, attempt: action.attempt });
  }
  for (const d of s.devices) {
    if (!checkDevice(d.id)) continue;
    if (
      (d.bootManaged || d.startupConfig || d.operatingSystem) &&
      (!['router', 'switch'].includes(d.type) || ['ap', 'mesh', 'wlc'].includes(d.profile ?? ''))
    )
      throw new Error('IOS startup lifecycle requires a core router/switch profile.');
    if (d.profile && !deviceProfiles.some((p) => p.id === d.profile && p.type === d.type))
      throw new Error('Perfil de equipamento inválido.');
    validateDhcpDevice(d, s.clock);
    validateDnsState(d, s.clock, dnsTimers);
    for (const port of d.interfaces) {
      if (port.errDisabled && port.errDisabled.at > s.clock)
        throw new Error('Err-disable timestamp is in the future.');
      const client = port.dhcp;
      if (!client) continue;
      if (client.requestedAt !== undefined && client.requestedAt > s.clock)
        throw new Error('Request DHCP no futuro.');
      const lease = client.lease;
      const timer = (token: string, kind: string) =>
        clientTimers.get(JSON.stringify([d.id, port.id, token, kind]));
      if (client.status === 'probing') {
        if (
          !client.pendingLease ||
          client.lease ||
          port.ip ||
          client.probeAt === undefined ||
          client.probeAt < s.clock ||
          timer(client.pendingLease.id, 'probe') !== client.probeAt ||
          client.pendingLease.expiresAt <= s.clock ||
          !port.dhcpConflictDetection ||
          client.attempts < 1 ||
          client.attempts > 3
        )
          throw new Error('DHCP probing, endereço ou timer inconsistente.');
      } else if (client.pendingLease || client.probeAt !== undefined)
        throw new Error('DHCP probe fora do estado probing.');
      if (lease) {
        if (lease.acquiredAt > s.clock || lease.expiresAt <= s.clock)
          throw new Error('Lease DHCP fora de validade.');
        if (timer(lease.id, 'expire') !== lease.expiresAt)
          throw new Error('Lease DHCP sem timer de expiração.');
        if (client.status === 'bound' && timer(lease.id, 'renew') !== Math.max(s.clock, lease.renewAt))
          throw new Error('Lease DHCP sem timer T1.');
        if (
          client.status !== 'rebinding' &&
          lease.rebindAt > s.clock &&
          timer(lease.id, 'rebind') !== lease.rebindAt
        )
          throw new Error('Lease DHCP sem timer T2.');
      } else if (
        ['selecting', 'requesting'].includes(client.status) &&
        timer(client.transactionId, 'retry') === undefined
      )
        throw new Error('Cliente DHCP sem timer de retransmissão.');
    }
    for (const binding of d.dhcpServer?.bindings ?? []) {
      const timer = bindingTimers.get(JSON.stringify([d.id, binding.id]));
      if (
        binding.expiresAt <= s.clock ||
        timer?.at !== binding.expiresAt ||
        timer.expiresAt !== binding.expiresAt
      )
        throw new Error('Binding DHCP sem timer de expiração válido.');
    }
    unique(
      d.interfaces.map((i) => i.id),
      'ID de interface'
    );
    unique(
      d.vlans.map((v) => String(v.id)),
      'VLAN'
    );
    for (const row of [...d.arpTable, ...d.macTable, ...d.pending])
      if (!d.interfaces.some((i) => i.id === row.port))
        throw new Error('Tabela referencia interface inexistente');
  }
  for (const l of s.links) {
    endpoint(s, l.a);
    endpoint(s, l.b);
    if (l.a.device === l.b.device) throw new Error('Link reflexivo inválido');
    if (l.cable === 'wireless' || l.cable === 'mesh') continue;
    for (const end of [l.a, l.b]) {
      const key = end.device + ':' + end.port;
      if (occupied.has(key)) throw new Error('Porta conectada duas vezes');
      occupied.add(key);
    }
    const a = endpoint(s, l.a).port,
      b = endpoint(s, l.b).port;
    validateMedia(l, a, b);
  }
  unique(
    s.queue.map((q) => String(q.order)),
    'Ordem de evento'
  );
  unique(
    s.probes.map((p) => p.id),
    'ID de probe'
  );
  for (const p of s.probes)
    if (!validatedDevice(s, p.device)) throw new Error('Probe sem origem');
  for (const q of s.queue) {
    if (q.at < s.clock || q.order > s.sequence) throw new Error('Relógio ou ordem de fila inválidos');
    const a = q.action;
    if (a.kind === 'deliver') {
      const link = s.links.find((l) => l.id === a.link);
      if (
        !link ||
        ![link.a, link.b].some((p) => p.device === a.device && p.port === a.port) ||
        ![link.a, link.b].some((p) => p.device === a.from) ||
        a.device === a.from
      )
        throw new Error('Entrega fora do cabo');
    } else if (a.kind === 'arp-timeout' || a.kind === 'dhcp-client-timer')
      endpoint(s, { device: a.device, port: a.port });
    else if (a.kind === 'dhcp-binding-expire') {
      if (!validatedDevice(s, a.device)) throw new Error('Timer DHCP sem servidor.');
    } else if (a.kind === 'dns-timeout') {
      if (!validatedDevice(s, a.device)?.dnsQueries?.some((query) => query.id === a.queryId))
        throw new Error('Timer DNS sem consulta.');
    } else if (
      a.kind === 'stp-hello' ||
      a.kind === 'stp-transition' ||
      a.kind === 'stp-info-expire' ||
      a.kind === 'stp-transmit'
    ) {
      const device = validatedDevice(s, a.device);
      if (!device?.spanningTree?.enabled) throw new Error('Timer STP sem switch ativo.');
      if (a.kind !== 'stp-hello') endpoint(s, { device: a.device, port: a.port });
    } else if (a.kind === 'nat-expire') {
      if (!validatedDevice(s, a.device)?.nat?.bindings.some((entry) => entry.id === a.binding))
        throw new Error('Timer sem tradução NAT.');
    } else if (a.kind === 'probe-timeout' && !s.probes.some((p) => p.id === a.probeId))
      throw new Error('Timeout sem probe');
  }
  s.queue.sort((a, b) => a.at - b.at || a.order - b.order);
  return s;
}
