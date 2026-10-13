import type { SimulationEngine } from './core/engine';
import type { Device } from './model';
import type { Scenario } from './scenarios-model';
import { configureModbus } from './protocols/modbus';
import { validMqttFilter } from './protocols/mqtt-codec';
import { requireVrf } from './protocols/layer3';

type Flow = Scenario['flows'][number];
type Fault = Scenario['faults'][number];
export interface ProtocolAttempt {
  id: string;
  phase?: 'connecting' | 'subscribing' | 'publishing';
  receiverId?: string;
  sentAt?: number;
  publication?: number;
}
export interface ProtocolOutcome {
  at: number;
  valid: boolean;
  reason?: string;
  received: boolean;
}
export const scenarioDevice = (e: SimulationEngine, ref: string) => {
  const d = e.state.devices.find((d) => d.id === ref || d.hostname === ref);
  if (!d) throw new Error('Equipamento inexistente: ' + ref);
  return d;
};
export function validateProtocolFlow(e: SimulationEngine, f: Flow) {
  const d = scenarioDevice(e, f.source);
  requireVrf(d, f.vrf);
  if (f.scope && !d.interfaces.some((p) => p.id === f.scope && p.vrf === f.vrf && p.ipv6))
    throw new Error('Interface IPv6 inexistente na VRF: ' + f.scope);
  if (f.dhcp && !d.interfaces.some((p) => p.id === f.dhcp!.interface || p.name === f.dhcp!.interface))
    throw new Error('Interface DHCP inexistente: ' + f.dhcp.interface);
  if (f.mqtt?.receiver) scenarioDevice(e, f.mqtt.receiver);
  if (f.mqtt?.filter && !validMqttFilter(f.mqtt.filter)) throw new Error('Filtro MQTT inválido.');
}
export function validateScenarioFault(e: SimulationEngine, f: Fault) {
  if (f.kind === 'link') {
    if (!e.state.links.some((l) => l.id === f.target)) throw new Error('Enlace inexistente: ' + f.target);
    return;
  }
  const d = scenarioDevice(e, f.target);
  if (f.kind === 'port' && !d.interfaces.some((p) => p.id === f.port || p.name === f.port))
    throw new Error('Porta inexistente: ' + f.port);
  if (f.kind === 'power' && d.infrastructure?.kind !== 'ups')
    throw new Error('Falha de alimentação exige uma UPS.');
  if (f.kind === 'service') {
    const present =
      f.service === 'http'
        ? d.tcpServices?.some((s) => s.kind === 'http' && s.port === (f.servicePort ?? 80))
        : f.service === 'dns'
          ? d.dnsServer
          : f.service === 'dhcp'
            ? d.dhcpServer
            : f.service === 'mqtt'
              ? d.broker
              : f.service === 'snmp'
                ? d.snmpAgent
                : f.service === 'ntp'
                  ? d.networkClock
                  : f.service === 'syslog'
                    ? d.syslogServer
                    : d.modbus;
    if (!present) throw new Error('Serviço ausente: ' + f.target + '/' + f.service);
  }
}
export function applyScenarioFault(e: SimulationEngine, f: Fault) {
  if (f.kind === 'link') {
    e.state.links.find((l) => l.id === f.target)!.up = f.up;
    e.refreshSpanningTree();
    e.refreshVrrp();
    return;
  }
  const d = scenarioDevice(e, f.target);
  if (f.kind === 'device') e.setDevicePower(d.id, f.up);
  else if (f.kind === 'port')
    e.setPort(d.id, d.interfaces.find((p) => p.id === f.port || p.name === f.port)!.id, f.up);
  else if (f.kind === 'power' && d.infrastructure?.kind === 'ups')
    e.configureInfrastructure(d.id, {
      ...d.infrastructure,
      mains: f.up,
      ...(f.up ? {} : { remainingWh: 0 }),
    });
  else if (f.kind === 'service') {
    switch (f.service) {
      case 'dns':
        e.setDnsEnabled(d.id, f.up);
        break;
      case 'dhcp':
        e.setDhcpEnabled(d.id, f.up);
        break;
      case 'http':
        e.configureTcpService(d.id, {
          ...d.tcpServices!.find((s) => s.port === (f.servicePort ?? 80))!,
          enabled: f.up,
        });
        break;
      case 'modbus':
        configureModbus(e, d, { ...d.modbus!, enabled: f.up });
        break;
      case 'mqtt':
        e.configureBroker(d.id, { enabled: f.up, port: d.broker!.port, users: d.broker!.users });
        break;
      case 'snmp':
        e.configureSnmpAgent(d.id, { enabled: f.up, community: d.snmpAgent!.community });
        break;
      case 'ntp':
        e.configureClock(d.id, { ...d.networkClock!, server: f.up });
        break;
      case 'syslog':
        e.setSyslogEnabled(d.id, f.up);
        break;
    }
  }
}
const dhcpPort = (d: Device, f: Flow) =>
  d.interfaces.find((p) => p.id === f.dhcp!.interface || p.name === f.dhcp!.interface)!;
export function startProtocol(e: SimulationEngine, d: Device, f: Flow): ProtocolAttempt {
  switch (f.protocol) {
    case 'dns':
      if (f.dns!.clearCache) e.clearDnsCache(d.id);
      return { id: e.lookupDns(d.id, f.dns!.name, f.dns!.type, f.target) };
    case 'dhcp': {
      const p = dhcpPort(d, f);
      if (f.dhcp!.fresh && p.dhcp?.lease) e.releaseDhcp(d.id, p.id);
      e.requestDhcp(d.id, p.id);
      if (!p.dhcp) throw new Error('DHCP não iniciou.');
      return { id: p.dhcp.transactionId };
    }
    case 'snmp':
      return { id: e.querySnmp(d.id, f.target, f.snmp!.community, f.snmp!.oids, f.snmp!.operation) };
    case 'ntp':
      e.configureNtp(d.id, { enabled: true, servers: [f.target], intervalMs: 60000 });
      return { id: d.ntp!.token };
    case 'syslog':
      e.configureSyslog(d.id, { enabled: true, server: f.target, automatic: false, severity: 7 });
      return { id: e.sendSyslog(d.id, f.syslog!.text, f.syslog!.severity) };
    case 'mqtt': {
      const receiver = f.mqtt!.receiver ? scenarioDevice(e, f.mqtt!.receiver) : undefined;
      if (receiver)
        e.connectIot(receiver.id, f.target, receiver.hostname, f.port ?? 1883, 30, f.mqtt!.credentials);
      return {
        id: e.connectIot(d.id, f.target, d.hostname, f.port ?? 1883, 30, f.mqtt!.credentials),
        phase: 'connecting',
        receiverId: receiver?.id,
      };
    }
    default:
      throw new Error('Protocolo sem adaptador: ' + f.protocol);
  }
}
export function observeProtocol(
  e: SimulationEngine,
  d: Device,
  f: Flow,
  a: ProtocolAttempt,
  started: number
): ProtocolOutcome | undefined {
  const success = (at: number, valid = true, reason?: string): ProtocolOutcome => ({
    at,
    valid,
    reason,
    received: true,
  });
  if (f.protocol === 'dns') {
    const q = d.dnsQueries?.find((q) => q.id === a.id);
    if (q && q.status !== 'pending') {
      const values = q.answers.map((r) => r.value);
      const valid =
        q.status === 'success' &&
        (!f.dns!.expectedAnswers || f.dns!.expectedAnswers.every((v) => values.includes(v)));
      return {
        at: q.startedAt + (q.elapsed ?? 0),
        valid,
        received: !['timeout', 'cancelled'].includes(q.status),
        reason: valid ? undefined : 'DNS ' + q.status + ': resposta divergente ou ausente',
      };
    }
  } else if (f.protocol === 'dhcp') {
    const p = dhcpPort(d, f),
      c = p.dhcp;
    // A retry may replace the transaction ID; the acquisition timestamp binds the result to this attempt.
    if (c?.status === 'bound' && c.lease && c.lease.acquiredAt >= started) {
      const valid =
        (!f.dhcp!.expectedAddress || p.ip === f.dhcp!.expectedAddress) &&
        (!f.dhcp!.expectedServer || c.lease.server === f.dhcp!.expectedServer);
      return success(c.lease.acquiredAt, valid, valid ? undefined : 'Concessão DHCP divergente');
    }
  } else if (f.protocol === 'snmp') {
    const q = d.snmpQueries?.find((q) => q.id === a.id);
    if (q && q.status !== 'pending') {
      const valid =
        q.status === 'success' &&
        !q.varbinds.some((v) => v.type === 'noSuchObject' || v.type === 'endOfMibView') &&
        (!f.snmp!.expectedVarbinds ||
          JSON.stringify(q.varbinds) === JSON.stringify(f.snmp!.expectedVarbinds));
      return {
        at: q.startedAt + (q.elapsed ?? 0),
        valid,
        received: !['timeout', 'cancelled'].includes(q.status),
        reason: valid ? undefined : 'SNMP ' + q.status + ': resposta divergente ou ausente',
      };
    }
  } else if (f.protocol === 'ntp') {
    const n = d.ntp,
      s = n?.samples.find((s) => s.at >= started && s.server === f.target);
    if (n?.token === a.id && s) {
      const valid = n.synchronized && Math.abs(d.networkClock!.offsetMs) <= f.ntp!.maxOffsetMs;
      return success(s.at, valid, valid ? undefined : 'Offset NTP fora da tolerância');
    }
  } else if (f.protocol === 'syslog') {
    const entry = e.state.devices
      .filter((t) => t.interfaces.some((p) => p.ip === f.target))
      .flatMap((t) => t.syslogServer?.entries ?? [])
      .find((entry) => entry.message.id === a.id);
    if (entry) return success(entry.receivedAt);
  } else if (f.protocol === 'mqtt') {
    const c = d.tcpConnections?.find((c) => c.id === a.id),
      iot = d.iot;
    if (iot?.connection !== a.id)
      return { at: e.state.clock, valid: false, received: false, reason: 'Sessão MQTT substituída' };
    if (iot.state === 'DISCONNECTED' || (c && ['RESET', 'TIMED-OUT'].includes(c.state)))
      return {
        at: iot.lastAt,
        valid: false,
        received: iot.state === 'DISCONNECTED' && c!.bytesReceived > 0,
        reason: 'MQTT desconectado ou recusado',
      };
    const receiver = a.receiverId ? e.device(a.receiverId) : undefined;
    if (
      a.phase === 'connecting' &&
      iot.state === 'CONNECTED' &&
      (!receiver || receiver.iot?.state === 'CONNECTED')
    ) {
      if (f.mqtt!.operation === 'connect') return success(iot.lastAt);
      if (receiver) {
        e.subscribeIot(receiver.id, f.mqtt!.filter!);
        a.phase = 'subscribing';
      } else a.phase = 'publishing';
    }
    if (a.phase === 'subscribing') {
      // Only publish after the broker has installed the receiver's subscription.
      const broker = e.state.devices.find((t) => t.interfaces.some((p) => p.ip === f.target));
      if (
        broker?.broker?.clients.some(
          (c) => c.clientId === receiver!.hostname && c.subscriptions.includes(f.mqtt!.filter!)
        )
      )
        a.phase = 'publishing';
    }
    if (a.phase === 'publishing' && a.publication === undefined) {
      e.publishIot(d.id, f.mqtt!.topic!, f.mqtt!.payload!, f.mqtt!.retain, 1);
      a.publication = iot.publications!.at(-1)!.id;
      a.sentAt = e.state.clock;
    }
    const publication = iot.publications?.find((p) => p.id === a.publication);
    const reading = receiver?.iot?.readings.find(
      (r) => r.at >= a.sentAt! && r.topic === f.mqtt!.topic && r.payload === f.mqtt!.payload
    );
    if (publication?.status === 'acked' && (!receiver || reading))
      return success(Math.max(iot.lastAt, reading?.at ?? 0));
  }
  return undefined;
}
