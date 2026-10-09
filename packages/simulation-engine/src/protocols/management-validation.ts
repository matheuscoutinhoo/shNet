import type { Snapshot } from '../model';
import { isUnicast } from './dhcp-config';
import { compareOids } from './snmp-mib';
import { managementBytes } from './management-wire';
import { SNMP } from './snmp-model';

export function validateManagement(snapshot: Snapshot) {
  for (const device of snapshot.devices) {
    if (
      device.type === 'switch' &&
      !device.ipRouting &&
      (device.snmpAgent || device.snmpQueries?.length || device.syslogClient || device.syslogServer)
    )
      throw new Error('Gerenciamento IPv4 não disponível no switch L2.');
    if (device.snmpAgent && device.snmpAgent.startedAt > snapshot.clock)
      throw new Error('Agente SNMP iniciado no futuro.');
    const ids = new Set<string>(),
      ports = new Set<number>();
    for (const query of device.snmpQueries ?? []) {
      if (
        ids.has(query.id) ||
        !isUnicast(query.server) ||
        !isUnicast(query.sourceIp) ||
        query.sourcePort < 49152 ||
        !device.interfaces.some((port) => port.id === query.port) ||
        query.startedAt > snapshot.clock ||
        query.deadline < query.startedAt ||
        (query.elapsed !== undefined && query.elapsed > snapshot.clock - query.startedAt)
      )
        throw new Error('Consulta SNMP inválida.');
      ids.add(query.id);
      const timers = snapshot.queue.filter(
        ({ action }) =>
          action.kind === 'snmp-timeout' && action.device === device.id && action.queryId === query.id
      );
      if (query.status === 'pending') {
        if (
          ports.has(query.sourcePort) ||
          query.varbinds.length ||
          query.elapsed !== undefined ||
          query.deadline < snapshot.clock ||
          query.deadline > snapshot.clock + SNMP.timeout ||
          timers.length !== 1 ||
          timers[0].at !== query.deadline ||
          timers[0].action.kind !== 'snmp-timeout' ||
          timers[0].action.attempt !== query.attempts
        )
          throw new Error('Consulta SNMP pendente sem timer válido.');
        ports.add(query.sourcePort);
      } else if (timers.length || query.elapsed === undefined)
        throw new Error('Consulta SNMP concluída com timer ou duração inválidos.');
      if (query.status === 'success') {
        if (
          query.varbinds.length !== query.oids.length ||
          query.varbinds.some((entry, index) =>
            query.operation === 'get'
              ? entry.oid !== query.oids[index] || entry.type === 'endOfMibView'
              : entry.type === 'endOfMibView'
                ? entry.oid !== query.oids[index]
                : entry.type === 'noSuchObject' || compareOids(entry.oid, query.oids[index]) <= 0
          )
        )
          throw new Error('Resposta SNMP inconsistente com os OIDs consultados.');
      } else if (query.varbinds.length) throw new Error('Consulta SNMP incompleta com dados de resposta.');
    }
    if (device.syslogClient && !isUnicast(device.syslogClient.server))
      throw new Error('Coletor syslog inválido.');
    if (
      device.syslogServer &&
      !['server', 'router'].includes(device.type) &&
      !(device.type === 'switch' && device.ipRouting)
    )
      throw new Error('Tipo inválido para coletor syslog.');
    for (const entry of device.syslogServer?.entries ?? [])
      if (
        !isUnicast(entry.source) ||
        entry.receivedAt > snapshot.clock ||
        entry.message.timestamp > entry.receivedAt
      )
        throw new Error('Registro syslog fora do relógio virtual.');
  }
  const syslogPending = new Map<string, number>();
  const syslogIds = new Set<string>();
  for (const { at, action } of snapshot.queue) {
    const packet = action.kind === 'deliver' ? action.frame.packet : undefined;
    if (
      packet?.protocol === 'UDP' &&
      (packet.payload.protocol === 'SNMP' || packet.payload.protocol === 'SYSLOG') &&
      packet.bytes !== managementBytes(packet.payload)
    )
      throw new Error('Comprimento do datagrama de gerenciamento inválido.');
    if (
      action.kind === 'snmp-timeout' &&
      !snapshot.devices
        .find((device) => device.id === action.device)
        ?.snmpQueries?.some((query) => query.id === action.queryId && query.status === 'pending')
    )
      throw new Error('Timer SNMP sem consulta pendente.');
    if (
      action.kind === 'syslog-send' &&
      (!snapshot.devices.find((device) => device.id === action.device)?.syslogClient?.enabled ||
        !isUnicast(action.server) ||
        action.message.timestamp > snapshot.clock)
    )
      throw new Error('Envio syslog sem origem válida.');
    if (action.kind === 'syslog-send') {
      const count = (syslogPending.get(action.device) ?? 0) + 1;
      const key = action.device + ':' + action.message.id;
      if (count > 64 || syslogIds.has(key) || at !== action.message.timestamp + 0.001)
        throw new Error('Fila syslog inconsistente.');
      syslogPending.set(action.device, count);
      syslogIds.add(key);
    }
  }
}
