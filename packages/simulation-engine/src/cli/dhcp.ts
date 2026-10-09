import { ALL_MODES, CONFIG_MODES, CommandRegistry, type Context } from './registry';
import type { Device, DhcpPool } from '../model';
import { defaultDhcpPool, dhcpPoolStats } from '../protocols/dhcp-config';
import { parsePrefix } from '../protocols/ipv4';

function selectedPool(device: Device, context: Context) {
  const pool = device.dhcpServer?.pools.find((entry) => entry.name === context.pool);
  if (!pool) throw new Error('Selecione um pool com ip dhcp pool NAME.');
  return pool;
}

function portByName(device: Device, name?: string, context?: Context) {
  if (!name) return device.interfaces.find((entry) => entry.id === context?.port) ?? device.interfaces[0];
  const normalized = name
    .replace(/\s/g, '')
    .replace(/^gigabitEthernet/i, 'Gi')
    .toLowerCase();
  const port = device.interfaces.find((entry) => entry.name.toLowerCase() === normalized);
  if (!port) throw new Error('Interface inexistente.');
  return port;
}

export function registerDhcpCommands(registry: CommandRegistry) {
  registry.register({
    pattern: /^ip dhcp snooping configure (.+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureDhcpSnooping(d.id, JSON.parse(m[1])),
  });
  registry.register({
    pattern: /^show ip dhcp snooping$/i,
    modes: ALL_MODES,
    run: (_m, _e, d) => JSON.stringify(d.dhcpSnooping ?? { enabled: false }, null, 2),
  });
  registry.register({
    pattern: /^(no )?ip dhcp conflict-detection$/i,
    modes: ['interface'],
    run: (m, e, d, c) => e.setDhcpConflictDetection(d.id, portByName(d, undefined, c).id, !m[1]),
  });

  registry.register({
    pattern: /^(no )?ip helper-address(?: ([\d.]+))?$/i,
    modes: ['interface'],
    run: (matches, engine, device, context) => {
      const port = portByName(device, undefined, context);
      const previous = port.dhcpRelay ?? [];
      if (!matches[1] && !matches[2]) throw new Error('Informe o IPv4 do servidor DHCP.');
      engine.configureDhcpRelay(
        device.id,
        port.id,
        matches[1]
          ? previous.filter((entry) => matches[2] && entry !== matches[2])
          : [...new Set([...previous, matches[2]])]
      );
    },
  });
  registry.register({
    pattern: /^ip dhcp pool ([a-z0-9][a-z0-9_-]{0,31}) relay ([\d.]+)\/(\d+)(?: interface (.+))?$/i,
    modes: CONFIG_MODES,
    run: (matches, engine, device, context) => {
      const port = matches[4] ? portByName(device, matches[4]) : undefined;
      const existing = device.dhcpServer?.pools.find((entry) => entry.name === matches[1]);
      if (
        existing &&
        (existing.relayAddress !== matches[2] ||
          existing.prefix !== Number(matches[3]) ||
          (port && existing.port !== port.id))
      )
        throw new Error('Pool existente usa outro relay, prefixo ou interface. Edite-o pelo painel DHCP.');
      const pool = existing ?? defaultDhcpPool(device, matches[1], port?.id, matches[2], Number(matches[3]));
      engine.configureDhcpPool(device.id, pool);
      context.pool = pool.name;
      context.mode = 'dhcp';
    },
  });
  registry.register({
    pattern: /^(no )?reservation ([a-f0-9:]+)(?: ([\d.]+))?$/i,
    modes: ['dhcp'],
    run: (matches, engine, device, context) => {
      const pool = selectedPool(device, context),
        clientMac = matches[2].toLowerCase();
      if (!matches[1] && !matches[3]) throw new Error('Informe MAC e IPv4 da reserva.');
      const reservations = (pool.reservations ?? []).filter((entry) => entry.clientMac !== clientMac);
      if (!matches[1]) reservations.push({ clientMac, address: matches[3] });
      engine.configureDhcpPool(device.id, { ...pool, reservations });
    },
  });
  registry.register({
    pattern: /^show ip dhcp relay$/i,
    modes: ALL_MODES,
    run: (_matches, _engine, device) =>
      device.interfaces
        .filter((port) => port.dhcpRelay?.length)
        .map((port) => port.name + ' giaddr=' + port.ip + ' servers=' + port.dhcpRelay!.join(', '))
        .join('\n') || 'Nenhum relay configurado',
  });
  registry.register({
    pattern: /^ip address dhcp$/i,
    modes: ['interface'],
    run: (_matches, engine, device, context) => {
      engine.requestDhcp(device.id, portByName(device, undefined, context).id);
      return 'DHCP iniciado. Avance a simulação para processar as mensagens UDP.';
    },
  });
  registry.register({
    pattern: /^ip dhcp (renew|release)(?:\s+(.+))?$/i,
    modes: ALL_MODES,
    run: (matches, engine, device, context) => {
      const port = portByName(device, matches[2], context);
      if (matches[1].toLowerCase() === 'release') engine.releaseDhcp(device.id, port.id);
      else engine.renewDhcp(device.id, port.id);
    },
  });
  registry.register({
    pattern: /^ip dhcp pool ([a-z0-9][a-z0-9_-]{0,31})(?: interface (.+))?$/i,
    modes: CONFIG_MODES,
    run: (matches, engine, device, context) => {
      const existing = device.dhcpServer?.pools.find((entry) => entry.name === matches[1]);
      const port = matches[2] ? portByName(device, matches[2]) : undefined;
      const pool = existing
        ? { ...existing, port: port?.id ?? existing.port }
        : defaultDhcpPool(device, matches[1], port?.id);
      engine.configureDhcpPool(device.id, pool);
      context.pool = pool.name;
      context.mode = 'dhcp';
    },
  });
  registry.register({
    pattern: /^no ip dhcp pool ([a-z0-9][a-z0-9_-]{0,31})$/i,
    modes: CONFIG_MODES,
    run: (matches, engine, device) => engine.removeDhcpPool(device.id, matches[1]),
  });
  registry.register({
    pattern: /^(no )?service dhcp$/i,
    modes: CONFIG_MODES,
    run: (matches, engine, device) => engine.setDhcpEnabled(device.id, !matches[1]),
  });
  registry.register({
    pattern: /^network ([\d.]+)(?:\/|\s+)([\d.]+)$/i,
    modes: ['dhcp'],
    run: (matches, engine, device, context) => {
      engine.configureDhcpPool(device.id, {
        ...selectedPool(device, context),
        network: matches[1],
        prefix: parsePrefix(matches[2]),
      });
    },
  });
  registry.register({
    pattern: /^range ([\d.]+) ([\d.]+)$/i,
    modes: ['dhcp'],
    run: (matches, engine, device, context) => {
      engine.configureDhcpPool(device.id, {
        ...selectedPool(device, context),
        start: matches[1],
        end: matches[2],
      });
    },
  });
  registry.register({
    pattern: /^lease (\d+)$/i,
    modes: ['dhcp'],
    run: (matches, engine, device, context) => {
      engine.configureDhcpPool(device.id, {
        ...selectedPool(device, context),
        leaseMs: Number(matches[1]) * 1000,
      });
    },
  });
  registry.register({
    pattern: /^default-router ([\d.]+)$/i,
    modes: ['dhcp'],
    run: (matches, engine, device, context) => {
      engine.configureDhcpPool(device.id, { ...selectedPool(device, context), gateway: matches[1] });
    },
  });
  registry.register({
    pattern: /^dns-server ([\d. ]+)$/i,
    modes: ['dhcp'],
    run: (matches, engine, device, context) => {
      engine.configureDhcpPool(device.id, {
        ...selectedPool(device, context),
        dns: matches[1].trim().split(/\s+/),
      });
    },
  });
  registry.register({
    pattern: /^no (default-router|dns-server)$/i,
    modes: ['dhcp'],
    run: (matches, engine, device, context) => {
      const pool: DhcpPool = { ...selectedPool(device, context) };
      if (matches[1].toLowerCase() === 'default-router') delete pool.gateway;
      else pool.dns = [];
      engine.configureDhcpPool(device.id, pool);
    },
  });
  registry.register({
    pattern: /^(no )?excluded-address ([\d. ]+)$/i,
    modes: ['dhcp'],
    run: (matches, engine, device, context) => {
      const pool = selectedPool(device, context);
      const addresses = matches[2].trim().split(/\s+/);
      engine.configureDhcpPool(device.id, {
        ...pool,
        excluded: matches[1]
          ? pool.excluded.filter((address) => !addresses.includes(address))
          : [...new Set([...pool.excluded, ...addresses])],
      });
    },
  });
  registry.register({
    pattern: /^show ip dhcp pool$/i,
    modes: ALL_MODES,
    run: (_matches, engine, device) => {
      const server = device.dhcpServer;
      return (
        'DHCP ' +
        (server?.enabled ? 'enabled' : 'disabled') +
        '\n' +
        (server?.pools
          .map((pool) => {
            const stats = dhcpPoolStats(device, pool, engine.state.clock);
            return (
              pool.name +
              ' ' +
              pool.network +
              '/' +
              pool.prefix +
              ' ' +
              pool.start +
              '-' +
              pool.end +
              ' lease=' +
              pool.leaseMs / 1000 +
              's free=' +
              stats.available +
              ' reserved=' +
              stats.reserved +
              (pool.relayAddress ? ' relay=' + pool.relayAddress : '') +
              ' offered=' +
              stats.offered +
              ' bound=' +
              stats.bound
            );
          })
          .join('\n') || 'Nenhum pool configurado')
      );
    },
  });
  registry.register({
    pattern: /^show ip dhcp binding$/i,
    modes: ALL_MODES,
    run: (_matches, engine, device) =>
      'ADDRESS           CLIENT MAC         POOL       STATE     REMAINING(s)\n' +
      (device.dhcpServer?.bindings
        .map(
          (binding) =>
            binding.address.padEnd(18) +
            binding.clientMac +
            '  ' +
            binding.pool.padEnd(11) +
            binding.status.padEnd(10) +
            Math.max(0, (binding.expiresAt - engine.state.clock) / 1000).toFixed(1)
        )
        .join('\n') || 'Nenhuma concessão'),
  });
  registry.register({
    pattern: /^show dhcp lease$/i,
    modes: ALL_MODES,
    run: (_matches, engine, device) =>
      device.interfaces
        .map((port) => {
          const lease = port.dhcp?.lease;
          return (
            port.name +
            ' ' +
            (port.dhcp?.status ?? 'static') +
            (lease
              ? '\n  address ' +
                lease.address +
                '/' +
                lease.prefix +
                '\n  server ' +
                lease.server +
                '\n  gateway ' +
                (lease.gateway ?? '-') +
                '\n  dns ' +
                (lease.dns.join(', ') || '-') +
                '\n  T1=' +
                lease.renewAt.toFixed(3) +
                ' T2=' +
                lease.rebindAt.toFixed(3) +
                ' expires=' +
                lease.expiresAt.toFixed(3) +
                ' ms; remaining=' +
                Math.max(0, (lease.expiresAt - engine.state.clock) / 1000).toFixed(1) +
                's'
              : '')
          );
        })
        .join('\n'),
  });
}

export function dhcpRunningConfig(device: Device): string[] {
  const server = device.dhcpServer;
  const relays = device.interfaces
    .filter((port) => port.dhcpRelay?.length)
    .flatMap((port) => [
      'interface ' + port.name,
      ...port.dhcpRelay!.map((address) => ' ip helper-address ' + address),
      ' exit',
    ]);
  if (!server) return relays;
  return [
    ...relays,
    server.enabled ? 'service dhcp' : 'no service dhcp',
    ...server.pools.flatMap((pool) => [
      'ip dhcp pool ' +
        pool.name +
        (pool.relayAddress ? ' relay ' + pool.relayAddress + '/' + pool.prefix : '') +
        ' interface ' +
        device.interfaces.find((port) => port.id === pool.port)!.name,
      ' network ' + pool.network + '/' + pool.prefix,
      ' range ' + pool.start + ' ' + pool.end,
      ' lease ' + pool.leaseMs / 1000,
      ...(pool.gateway ? [' default-router ' + pool.gateway] : []),
      ...(pool.dns.length ? [' dns-server ' + pool.dns.join(' ')] : []),
      ...(pool.excluded.length ? [' excluded-address ' + pool.excluded.join(' ')] : []),
      ...(pool.reservations ?? []).map((entry) => ' reservation ' + entry.clientMac + ' ' + entry.address),
      ' exit',
    ]),
  ];
}
