import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkEvent, UdpPacket } from '../model';
import { resolveRoute } from './ipv4';
import { isUnicast } from './dhcp-config';
import { managementPacket } from './management-wire';
import { SYSLOG, syslogClientSchema, syslogMessageSchema, type SyslogMessage } from './syslog-model';

export function configureSyslog(engine: SimulationEngine, device: Device, input: unknown) {
  if (device.type === 'switch' && !device.ipRouting)
    throw new Error('Switch L2 não possui stack IPv4 de gerenciamento.');
  const config = syslogClientSchema.parse(input);
  if (!isUnicast(config.server)) throw new Error('Coletor syslog deve ser unicast.');
  config.sourcePort ??= device.syslogClient?.sourcePort ?? 49152 + (engine.state.sequence % 16384);
  device.syslogClient = config;
  engine.state.queue = engine.state.queue.filter(
    ({ action }) => action.kind !== 'syslog-send' || action.device !== device.id
  );
  engine.emit(
    'CONFIG_CHANGED',
    device.id,
    'Envio syslog/514 ' + (config.enabled ? 'ativado' : 'desativado') + '.'
  );
}
export function setSyslogEnabled(engine: SimulationEngine, device: Device, enabled: boolean) {
  if (device.type !== 'server' && device.type !== 'router' && !(device.type === 'switch' && device.ipRouting))
    throw new Error('Coletor syslog requer servidor ou roteador.');
  device.syslogServer ??= { enabled, entries: [] };
  device.syslogServer.enabled = enabled;
  engine.emit(
    'CONFIG_CHANGED',
    device.id,
    'Coletor syslog/514 ' + (enabled ? 'ativado' : 'desativado') + '.'
  );
}
export function sendSyslog(
  engine: SimulationEngine,
  device: Device,
  text: string,
  severity = 6,
  appName = 'netos'
) {
  const config = device.syslogClient;
  if (!config?.enabled) throw new Error('Configure e habilite o envio syslog.');
  const message = syslogMessageSchema.parse({
    id: engine.id('syslog'),
    timestamp: engine.state.clock,
    hostname: device.hostname,
    facility: config.facility,
    severity,
    appName,
    text,
  });
  if (severity > config.severity) {
    engine.emit(
      'SYSLOG_FILTERED',
      device.id,
      'Severidade ' + severity + ' acima do limite ' + config.severity + '.'
    );
    return message.id;
  }
  if (
    engine.state.queue.filter(({ action }) => action.kind === 'syslog-send' && action.device === device.id)
      .length >= SYSLOG.pending
  ) {
    engine.emit('SYSLOG_FAILED', device.id, 'Limite de 64 mensagens syslog pendentes atingido.');
    return message.id;
  }
  engine.schedule(0.001, { kind: 'syslog-send', device: device.id, server: config.server, message });
  engine.emit('SYSLOG_QUEUED', device.id, 'Mensagem ' + message.id + ' para ' + config.server + ':514.');
  return message.id;
}
export function forwardSyslogEvent(engine: SimulationEngine, device: Device, event: NetworkEvent) {
  if (!device.syslogClient?.enabled || !device.syslogClient.automatic || !device.power) return;
  const severity =
    event.type === 'LINK_DOWN'
      ? 4
      : event.type === 'LINK_UP' || event.type === 'CONFIG_CHANGED'
        ? 5
        : event.type === 'OSPF_NEIGHBOR_CHANGED' ||
            event.type === 'VRRP_STATE_CHANGED' ||
            event.type === 'BGP_STATE_CHANGED' ||
            event.type === 'STP_ROOT_CHANGED' ||
            event.type === 'STP_TOPOLOGY_CHANGED'
          ? 6
          : undefined;
  if (severity !== undefined)
    sendSyslog(engine, device, (event.type + ': ' + event.reason).slice(0, 300), severity);
}
export function handleSyslogSend(
  engine: SimulationEngine,
  device: Device,
  server: string,
  message: SyslogMessage
) {
  if (!device.syslogClient?.enabled || !device.power) {
    engine.emit('SYSLOG_FAILED', device.id, 'Origem syslog desativada antes da transmissão.');
    return;
  }
  const route = resolveRoute(device, server),
    port = route?.port ?? device.interfaces.find((entry) => entry.adminUp && entry.ip);
  if (!port?.ip) {
    engine.emit('SYSLOG_FAILED', device.id, 'Syslog sem endereço IPv4 de origem.');
    return;
  }
  device.syslogClient.sourcePort ??= 49152 + (engine.state.sequence % 16384);
  const packet = managementPacket(port.ip, server, device.syslogClient.sourcePort, SYSLOG.port, {
    protocol: 'SYSLOG',
    message,
  });
  engine.emit(
    'SYSLOG_SENT',
    device.id,
    'Mensagem ' + message.id + ' enviada por UDP/514; sem confirmação de entrega.'
  );
  engine.sendIp(device.id, packet);
}
export function receiveSyslog(engine: SimulationEngine, device: Device, packet: UdpPacket) {
  if (packet.payload.protocol !== 'SYSLOG') return;
  const message = packet.payload.message;
  if (
    !packet.ttl ||
    !isUnicast(packet.src) ||
    !isUnicast(packet.dst) ||
    packet.destinationPort !== SYSLOG.port ||
    message.timestamp > engine.state.clock
  ) {
    engine.drop(device, 'Syslog: datagrama ou timestamp inválido.');
    return;
  }
  if (!device.syslogServer?.enabled) {
    engine.drop(device, 'Coletor syslog desativado.');
    return;
  }
  device.syslogServer.entries.push({
    receivedAt: engine.state.clock,
    source: packet.src,
    message: structuredClone(message),
  });
  if (device.syslogServer.entries.length > SYSLOG.entries) device.syslogServer.entries.shift();
  engine.emit(
    'SYSLOG_RECEIVED',
    device.id,
    message.hostname + ' PRI=' + (message.facility * 8 + message.severity) + ': ' + message.text
  );
}
