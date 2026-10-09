import type { Device, SnmpQuery } from '../model';
import { ALL_MODES, CONFIG_MODES, type CommandRegistry } from './registry';
import { terminalText } from './tcp';
export function formatSnmpQuery(query: SnmpQuery) {
  return terminalText(
    'SNMP [' +
      query.id +
      '] ' +
      query.operation +
      ' via ' +
      query.server +
      ': ' +
      query.status +
      '\n' +
      query.varbinds
        .map((entry) => entry.oid + ' ' + entry.type + ('value' in entry ? ' = ' + entry.value : ''))
        .join('\n')
  );
}
export function registerManagementCommands(registry: CommandRegistry) {
  registry.register({
    pattern: /^snmp-server community ([a-z0-9_-]+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) =>
      engine.configureSnmpAgent(device.id, {
        enabled: device.snmpAgent?.enabled ?? false,
        community: match[1],
      }),
  });
  registry.register({
    pattern: /^(no )?service snmp$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) =>
      engine.configureSnmpAgent(device.id, {
        enabled: !match[1],
        community: device.snmpAgent?.community ?? 'public',
      }),
  });
  registry.register({
    pattern: /^snmp (get|get-next) ([\d.]+) ([a-z0-9_-]+) ([\d. ]+)$/i,
    modes: ALL_MODES,
    run: (match, engine, device) =>
      'SNMP [' +
      engine.querySnmp(
        device.id,
        match[2],
        match[3],
        match[4].trim().split(/\s+/),
        match[1].toLowerCase() as 'get' | 'get-next'
      ) +
      '] enfileirado. Avance a simulação.',
  });
  registry.register({
    pattern: /^show snmp(?: queries)?$/i,
    modes: ALL_MODES,
    run: (_match, _engine, device) =>
      [
        'Agente SNMP: ' + (device.snmpAgent?.enabled ? 'ativo' : 'desativado'),
        ...(device.snmpQueries?.map(formatSnmpQuery) ?? []),
      ].join('\n'),
  });
  registry.register({
    pattern: /^logging host ([\d.]+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) =>
      engine.configureSyslog(device.id, { ...device.syslogClient, server: match[1], enabled: true }),
  });
  registry.register({
    pattern: /^logging severity ([0-7])$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      if (!device.syslogClient) throw new Error('Configure logging host primeiro.');
      engine.configureSyslog(device.id, { ...device.syslogClient, severity: Number(match[1]) });
    },
  });
  registry.register({
    pattern: /^logging facility (\d+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      if (!device.syslogClient) throw new Error('Configure logging host primeiro.');
      engine.configureSyslog(device.id, { ...device.syslogClient, facility: Number(match[1]) });
    },
  });
  registry.register({
    pattern: /^(no )?logging automatic$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      if (!device.syslogClient) throw new Error('Configure logging host primeiro.');
      engine.configureSyslog(device.id, { ...device.syslogClient, automatic: !match[1] });
    },
  });
  registry.register({
    pattern: /^no logging host$/i,
    modes: CONFIG_MODES,
    run: (_match, engine, device) => {
      if (device.syslogClient) engine.configureSyslog(device.id, { ...device.syslogClient, enabled: false });
    },
  });
  registry.register({
    pattern: /^(no )?service syslog$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => engine.setSyslogEnabled(device.id, !match[1]),
  });
  registry.register({
    pattern: /^syslog send ([0-7]) (.+)$/i,
    modes: ALL_MODES,
    run: (match, engine, device) =>
      'Mensagem [' + engine.sendSyslog(device.id, match[2], Number(match[1])) + '] enfileirada.',
  });
  registry.register({
    pattern: /^show syslog$/i,
    modes: ALL_MODES,
    run: (_match, _engine, device) =>
      terminalText(
        [
          'Coletor: ' +
            (device.syslogServer?.enabled ? 'ativo' : 'desativado') +
            '; destino: ' +
            (device.syslogClient?.enabled ? device.syslogClient.server : 'nenhum'),
          ...(device.syslogServer?.entries.map(
            (entry) =>
              entry.receivedAt.toFixed(3) +
              ' ' +
              entry.source +
              ' ' +
              entry.message.hostname +
              ' PRI=' +
              (entry.message.facility * 8 + entry.message.severity) +
              ' ' +
              entry.message.text
          ) ?? []),
        ].join('\n')
      ),
  });
  registry.register({
    pattern: /^clear syslog$/i,
    modes: ['privileged', ...CONFIG_MODES],
    run: (_match, _engine, device) => {
      if (device.syslogServer) device.syslogServer.entries = [];
    },
  });
}
export function managementRunningConfig(device: Device) {
  return [
    ...(device.snmpAgent
      ? [
          'snmp-server community ' + device.snmpAgent.community,
          (device.snmpAgent.enabled ? '' : 'no ') + 'service snmp',
        ]
      : []),
    ...(device.syslogServer ? [(device.syslogServer.enabled ? '' : 'no ') + 'service syslog'] : []),
    ...(device.syslogClient
      ? [
          'logging host ' + device.syslogClient.server,
          'logging severity ' + device.syslogClient.severity,
          'logging facility ' + device.syslogClient.facility,
          (device.syslogClient.automatic ? '' : 'no ') + 'logging automatic',
          ...(!device.syslogClient.enabled ? ['no logging host'] : []),
        ]
      : []),
  ];
}
