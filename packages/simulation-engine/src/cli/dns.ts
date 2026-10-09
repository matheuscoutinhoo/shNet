import { ALL_MODES, CONFIG_MODES, CommandRegistry, currentPort } from './registry';
import { dnsNameSchema, type Device, type DnsQuery, type DnsQuestion } from '../model';

export function formatDnsQuery(query: DnsQuery) {
  return [
    'DNS [' + query.id + '] ' + query.question.name + ' ' + query.question.type,
    'DNSSEC: ' + (query.security ?? 'insecure'),
    'Transporte: ' +
      (query.transport ?? 'udp').toUpperCase() +
      (query.tcpFallback ? ' (fallback após TC=1)' : ''),
    'Server: ' +
      query.server +
      ' | ' +
      query.status +
      (query.fromCache ? ' (cache)' : '') +
      (query.elapsed !== undefined ? ' | ' + query.elapsed.toFixed(3) + ' ms' : ''),
    ...query.answers.map(
      (record) => record.name + ' ' + record.ttl + ' IN ' + record.type + ' ' + record.value
    ),
    ...(query.status === 'truncated'
      ? ['Resposta truncada (TC=1). Use transporte automático ou TCP para repetir.']
      : []),
  ].join('\n');
}

export function registerDnsCommands(registry: CommandRegistry) {
  registry.register({
    pattern: /^nslookup(?: -(tcp|udp))?(?: -type=(A|AAAA|CNAME))? ([a-z0-9_.-]+)(?: ([a-f\d.:]+))?$/i,
    modes: ALL_MODES,
    run: (match, engine, device) => {
      const id = engine.lookupDns(
        device.id,
        match[3],
        (match[2]?.toUpperCase() ?? 'A') as DnsQuestion['type'],
        match[4],
        undefined,
        (match[1]?.toLowerCase() ?? 'auto') as 'tcp' | 'udp' | 'auto'
      );
      const query = device.dnsQueries!.find((entry) => entry.id === id)!;
      return query.status === 'pending'
        ? 'Consulta DNS enfileirada [' + id + ']. Avance a simulação.'
        : formatDnsQuery(query);
    },
  });
  registry.register({
    pattern: /^dns security configure (.+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const c = JSON.parse(m[1]);
      e.configureDnsSecurity(d.id, c.resolver, c.zones);
    },
  });
  registry.register({
    pattern: /^show dns security$/i,
    modes: ALL_MODES,
    run: (_m, _e, d) => JSON.stringify({ resolver: d.dnsResolver, zones: d.dnsServer?.zones }, null, 2),
  });
  registry.register({
    pattern: /^(no )?service dns$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => engine.setDnsEnabled(device.id, !match[1]),
  });
  registry.register({
    pattern: /^dns record ([a-z0-9_.-]+) (A|AAAA|CNAME) ([a-z0-9_.:-]+)(?: ttl (\d+))?$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      engine.configureDnsRecord(device.id, {
        name: match[1],
        type: match[2].toUpperCase(),
        value: match[3],
        ttl: Number(match[4] ?? 300),
      });
    },
  });
  registry.register({
    pattern: /^no dns record ([a-z0-9_.-]+) (A|AAAA|CNAME) ([a-z0-9_.:-]+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      engine.removeDnsRecord(device.id, {
        name: match[1],
        type: match[2].toUpperCase(),
        value: match[3],
        ttl: 0,
      });
    },
  });
  registry.register({
    pattern: /^ip name-server ([\d. ]+)$/i,
    modes: ['interface'],
    run: (match, engine, device, context) =>
      engine.setDnsServers(device.id, currentPort(device, context).id, match[1].trim().split(/\s+/)),
  });
  registry.register({
    pattern: /^no ip name-server$/i,
    modes: ['interface'],
    run: (_match, engine, device, context) =>
      engine.setDnsServers(device.id, currentPort(device, context).id, []),
  });
  registry.register({
    pattern: /^show dns (records|cache|queries)$/i,
    modes: ALL_MODES,
    run: (match, engine, device) => {
      if (match[1].toLowerCase() === 'records')
        return (
          'DNS ' +
          (device.dnsServer?.enabled ? 'enabled' : 'disabled') +
          '\n' +
          (device.dnsServer?.records
            .map((record) => record.name + ' ' + record.ttl + ' IN ' + record.type + ' ' + record.value)
            .join('\n') || 'Nenhum registro')
        );
      if (match[1].toLowerCase() === 'queries')
        return device.dnsQueries?.map(formatDnsQuery).join('\n\n') || 'Nenhuma consulta';
      return (
        device.dnsCache
          ?.filter((entry) => entry.expiresAt > engine.state.clock)
          .map(
            (entry) =>
              entry.question.name +
              ' ' +
              entry.question.type +
              ' via ' +
              entry.server +
              ' TTL=' +
              Math.ceil((entry.expiresAt - engine.state.clock) / 1000) +
              's ' +
              entry.answers.map((record) => record.value).join(', ')
          )
          .join('\n') || 'Cache DNS vazio'
      );
    },
  });
  registry.register({
    pattern: /^clear dns cache(?: ([a-z0-9_.-]+))?$/i,
    modes: ['privileged', ...CONFIG_MODES],
    run: (match, engine, device) => {
      if (!match[1]) engine.clearDnsCache(device.id);
      else {
        const name = dnsNameSchema.parse(match[1]);
        device.dnsCache = device.dnsCache?.filter((entry) => entry.question.name !== name);
      }
    },
  });
}

export function dnsRunningConfig(device: Device) {
  if (!device.dnsServer) return [];
  return [
    device.dnsServer.enabled ? 'service dns' : 'no service dns',
    ...device.dnsServer.records.map(
      (record) => 'dns record ' + record.name + ' ' + record.type + ' ' + record.value + ' ttl ' + record.ttl
    ),
  ];
}
