import { ALL_MODES, CONFIG_MODES, CommandRegistry, type Context } from './registry';
import {
  DHCP_LIMITS,
  DHCP_MAX_LEASE_MS,
  dhcpPendingPoolSchema,
  ipv4Schema,
  type Device,
  type DhcpPendingPool,
  type DhcpPool,
} from '../model';
import type { SimulationEngine } from '../core/engine';
import {
  defaultDhcpPool,
  dhcpPoolStats,
  globallyExcluded,
  iosPoolDeclaration,
  iosPoolProblem,
  refreshDhcpPools,
} from '../protocols/dhcp-config';
import { ipNumber, ipString, mask, parsePrefix, sameSubnet, subnet } from '../protocols/ipv4';
import { dhcpHaStatus } from '../protocols/dhcp-ha';

// IOS default lease: one day.
const IOS_LEASE_MS = 86400000;
type PoolDraft = DhcpPendingPool & Partial<Pick<DhcpPool, 'port' | 'relayAddress' | 'relayAddresses' | 'ios'>>;

function savePending(device: Device, draft: DhcpPendingPool) {
  const entry = dhcpPendingPoolSchema.parse(draft),
    server = device.dhcpServer!;
  server.pendingPools = [...(server.pendingPools ?? []).filter((item) => item.name !== entry.name), entry];
  const problem = iosPoolProblem(device, entry);
  if (problem) throw new Error(problem);
  refreshDhcpPools(device);
}

/**
 * Applies a pool-mode command to an explicit (interface-bound) pool, an IOS pool already serving
 * clients, or an IOS pool still waiting for its network or interface.
 */
function editPool(
  engine: SimulationEngine,
  device: Device,
  context: Context,
  edit: (draft: PoolDraft) => void
) {
  const server = device.dhcpServer,
    pool = server?.pools.find((entry) => entry.name === context.pool),
    pending = server?.pendingPools?.find((entry) => entry.name === context.pool);
  if (!pool && !pending) throw new Error('Selecione um pool com ip dhcp pool NAME.');
  if (pool) {
    const draft: PoolDraft = structuredClone(pool);
    edit(draft);
    if (!pool.ios || (draft.network === pool.network && draft.prefix === pool.prefix)) {
      engine.configureDhcpPool(device.id, draft);
      return;
    }
    // A new network moves the IOS pool to another interface or giaddr scope; old leases are released.
    engine.removeDhcpPool(device.id, pool.name);
    savePending(device, iosPoolDeclaration(draft as DhcpPool));
    return;
  }
  const draft: PoolDraft = structuredClone(pending!);
  edit(draft);
  savePending(device, draft);
}

function declareIosPool(device: Device, name: string) {
  if (device.type !== 'server' && device.type !== 'router')
    throw new Error('Serviço DHCP requer servidor ou roteador.');
  device.dhcpServer ??= { enabled: true, pools: [], bindings: [] };
  const server = device.dhcpServer;
  if (server.pools.length + (server.pendingPools?.length ?? 0) >= DHCP_LIMITS.pools)
    throw new Error('Limite de ' + DHCP_LIMITS.pools + ' pools DHCP por equipamento.');
  const entry: DhcpPendingPool = { name, dns: [], leaseMs: IOS_LEASE_MS };
  server.pendingPools = [...(server.pendingPools ?? []), entry];
  // Server profiles start on their own LAN (one-step setup); "network" moves the pool elsewhere.
  const lan =
    device.type === 'server'
      ? device.interfaces.find(
          (p) =>
            p.mode === 'routed' &&
            p.ip &&
            p.prefix !== undefined &&
            p.prefix >= 1 &&
            p.prefix <= 30 &&
            p.ipv4Mode !== 'dhcp' &&
            !p.dhcpRelay?.length
        )
      : undefined;
  if (lan) {
    const local = { ...entry, network: subnet(lan.ip!, lan.prefix!).network, prefix: lan.prefix };
    if (!iosPoolProblem(device, local)) Object.assign(entry, local);
  }
  refreshDhcpPools(device);
}

export function leaseLine(ms: number) {
  if (ms >= DHCP_MAX_LEASE_MS) return ' lease infinite';
  if (ms % 60000) return ' lease seconds ' + ms / 1000;
  const minutes = ms / 60000,
    days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60),
    rest = minutes % 60;
  return ' lease ' + days + (hours || rest ? ' ' + hours : '') + (rest ? ' ' + rest : '');
}

function leaseMs(match: RegExpMatchArray) {
  if (match[1]) return DHCP_MAX_LEASE_MS;
  const ms = match[2]
    ? Math.round(Number(match[2]) * 1000)
    : ((Number(match[3]) * 24 + Number(match[4] ?? 0)) * 60 + Number(match[5] ?? 0)) * 60000;
  if (Number(match[3]) > 365 || Number(match[4] ?? 0) > 23 || Number(match[5] ?? 0) > 59)
    throw new Error('Use lease DIAS(0-365) [HORAS(0-23)] [MINUTOS(0-59)] ou lease infinite.');
  if (ms < 8000 || ms > DHCP_MAX_LEASE_MS)
    throw new Error('O lease DHCP deve ficar entre 8 segundos e 365 dias.');
  return ms;
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
    pattern: /^show ip dhcp ha$/i,
    modes: ALL_MODES,
    run: (_m, e, d) =>
      d.dhcpHa
        ? [
            'DHCP HA: ' + dhcpHaStatus(e.state, d),
            'Papel: ' + d.dhcpHa.role + ' · par: ' + e.device(d.dhcpHa.peer).hostname,
            'Revisão: ' +
              d.dhcpHa.revision +
              ' · recebida: ' +
              d.dhcpHa.applied +
              ' · confirmada: ' +
              d.dhcpHa.confirmed,
            'Promoção administrativa com desligamento do antigo ativo; sem eleição automática.',
          ].join('\n')
        : 'HA DHCP desativada.',
  });
  registry.register({
    pattern: /^ip dhcp ha configure (\S+) (.+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const peer = e.state.devices.find((p) => p.id === m[1] || p.hostname === m[1]);
      if (!peer) throw new Error('Servidor reserva DHCP não encontrado.');
      e.configureDhcpHaPair(d.id, peer.id, JSON.parse(m[2]));
    },
  });
  registry.register({
    pattern: /^ip dhcp ha promote-and-fence$/i,
    modes: CONFIG_MODES,
    run: (_m, e, d) => e.promoteDhcpHa(d.id),
  });
  registry.register({
    pattern: /^no ip dhcp ha$/i,
    modes: CONFIG_MODES,
    run: (_m, e, d) => e.disableDhcpHa(d.id),
  });
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
      const clientMac = matches[2].toLowerCase();
      if (!matches[1] && !matches[3]) throw new Error('Informe MAC e IPv4 da reserva.');
      editPool(engine, device, context, (pool) => {
        const reservations = (pool.reservations ?? []).filter((entry) => entry.clientMac !== clientMac);
        if (!matches[1]) reservations.push({ clientMac, address: matches[3] });
        pool.reservations = reservations;
      });
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
      const name = matches[1],
        server = device.dhcpServer,
        existing = server?.pools.find((entry) => entry.name === name);
      const port = matches[2] ? portByName(device, matches[2]) : undefined;
      if (port || (existing && !existing.ios)) {
        // Simulator extension: "interface" pins the pool to one routed interface.
        const pool: PoolDraft = existing
          ? { ...existing, port: port?.id ?? existing.port }
          : defaultDhcpPool(device, name, port?.id);
        if (port) delete pool.ios;
        engine.configureDhcpPool(device.id, pool);
      } else if (!existing && !server?.pendingPools?.some((entry) => entry.name === name)) {
        declareIosPool(device, name);
      }
      context.pool = name;
      context.mode = 'dhcp';
    },
  });
  registry.register({
    pattern: /^no ip dhcp pool ([a-z0-9][a-z0-9_-]{0,31})$/i,
    modes: CONFIG_MODES,
    run: (matches, engine, device) => {
      const server = device.dhcpServer;
      if (!server?.pendingPools?.some((entry) => entry.name === matches[1]))
        return engine.removeDhcpPool(device.id, matches[1]);
      server.pendingPools = server.pendingPools.filter((entry) => entry.name !== matches[1]);
      if (!server.pendingPools.length) delete server.pendingPools;
    },
  });
  registry.register({
    pattern: /^(no )?ip dhcp excluded-address ([\d.]+)(?: ([\d.]+))?$/i,
    syntax: [
      'ip dhcp excluded-address <low-address>',
      'ip dhcp excluded-address <low-address> <high-address>',
      'no ip dhcp excluded-address <low-address>',
      'no ip dhcp excluded-address <low-address> <high-address>',
    ],
    modes: CONFIG_MODES,
    run: (matches, engine, device) => {
      const start = ipv4Schema.parse(matches[2]),
        end = ipv4Schema.parse(matches[3] ?? matches[2]);
      if (ipNumber(start) > ipNumber(end)) throw new Error('O endereço final deve ser maior ou igual ao inicial.');
      if (device.type !== 'server' && device.type !== 'router')
        throw new Error('Serviço DHCP requer servidor ou roteador.');
      device.dhcpServer ??= { enabled: true, pools: [], bindings: [] };
      const server = device.dhcpServer,
        ranges = (server.excludedRanges ?? []).filter((range) => range.start !== start || range.end !== end);
      if (!matches[1]) {
        if (ranges.length >= 64) throw new Error('Limite de 64 exclusões DHCP globais.');
        ranges.push({ start, end });
      }
      if (ranges.length) server.excludedRanges = ranges;
      else delete server.excludedRanges;
      // Leases inside a new exclusion are withdrawn so the address is never offered again.
      const withdrawn = new Set(
        server.bindings.filter((binding) => globallyExcluded(device, binding.address)).map((binding) => binding.id)
      );
      if (!withdrawn.size) return;
      server.bindings = server.bindings.filter((binding) => !withdrawn.has(binding.id));
      engine.state.queue = engine.state.queue.filter(
        ({ action }) =>
          action.kind !== 'dhcp-binding-expire' || action.device !== device.id || !withdrawn.has(action.binding)
      );
    },
  });
  registry.register({
    pattern: /^(no )?service dhcp$/i,
    modes: CONFIG_MODES,
    run: (matches, engine, device) => engine.setDhcpEnabled(device.id, !matches[1]),
  });
  registry.register({
    pattern: /^network ([\d.]+)(?:\s*\/\s*|\s+)([\d.]+)$/i,
    modes: ['dhcp'],
    run: (matches, engine, device, context) => {
      const prefix = parsePrefix(matches[2]);
      editPool(engine, device, context, (pool) => {
        if (pool.port !== undefined && !pool.ios) {
          Object.assign(pool, { network: matches[1], prefix });
          return;
        }
        const network = subnet(matches[1], prefix).network,
          inside = (address?: string) => !!address && sameSubnet(address, network, prefix);
        Object.assign(pool, { network, prefix });
        if (!inside(pool.start) || !inside(pool.end)) {
          delete pool.start;
          delete pool.end;
        }
        pool.excluded = pool.excluded?.filter(inside);
        pool.reservations = pool.reservations?.filter((entry) => inside(entry.address));
      });
    },
  });
  registry.register({
    pattern: /^range ([\d.]+) ([\d.]+)$/i,
    modes: ['dhcp'],
    run: (matches, engine, device, context) =>
      editPool(engine, device, context, (pool) => Object.assign(pool, { start: matches[1], end: matches[2] })),
  });
  registry.register({
    pattern: /^lease (?:(infinite)|seconds (\d+(?:\.\d{1,3})?)|(\d+)(?: (\d+))?(?: (\d+))?)$/i,
    syntax: [
      'lease <days>',
      'lease <days> <hours>',
      'lease <days> <hours> <minutes>',
      'lease infinite',
      'lease seconds <seconds>',
    ],
    modes: ['dhcp'],
    run: (matches, engine, device, context) => {
      const ms = leaseMs(matches);
      editPool(engine, device, context, (pool) => {
        pool.leaseMs = ms;
      });
    },
  });
  registry.register({
    pattern: /^no lease$/i,
    modes: ['dhcp'],
    run: (_matches, engine, device, context) =>
      editPool(engine, device, context, (pool) => {
        pool.leaseMs = IOS_LEASE_MS;
      }),
  });
  registry.register({
    pattern: /^default-router ([\d.]+)$/i,
    modes: ['dhcp'],
    run: (matches, engine, device, context) =>
      editPool(engine, device, context, (pool) => {
        pool.gateway = matches[1];
      }),
  });
  registry.register({
    pattern: /^dns-server ([\d. ]+)$/i,
    modes: ['dhcp'],
    run: (matches, engine, device, context) =>
      editPool(engine, device, context, (pool) => {
        pool.dns = matches[1].trim().split(/\s+/);
      }),
  });
  registry.register({
    pattern: /^(no )?domain-name(?: (\S+))?$/i,
    syntax: ['domain-name <name>', 'no domain-name'],
    modes: ['dhcp'],
    run: (matches, engine, device, context) => {
      if (!matches[1] && !matches[2]) throw new Error('Informe o domínio DNS.');
      editPool(engine, device, context, (pool) => {
        if (matches[1]) delete pool.domainName;
        else pool.domainName = matches[2];
      });
    },
  });
  registry.register({
    pattern: /^no (default-router|dns-server)$/i,
    modes: ['dhcp'],
    run: (matches, engine, device, context) =>
      editPool(engine, device, context, (pool) => {
        if (matches[1].toLowerCase() === 'default-router') delete pool.gateway;
        else pool.dns = [];
      }),
  });
  registry.register({
    pattern: /^(no )?excluded-address ([\d. ]+)$/i,
    modes: ['dhcp'],
    run: (matches, engine, device, context) => {
      const addresses = matches[2].trim().split(/\s+/);
      editPool(engine, device, context, (pool) => {
        const excluded = pool.excluded ?? [];
        pool.excluded = matches[1]
          ? excluded.filter((address) => !addresses.includes(address))
          : [...new Set([...excluded, ...addresses])];
      });
    },
  });
  registry.register({
    pattern: /^show ip dhcp pool$/i,
    modes: ALL_MODES,
    run: (_matches, engine, device) => {
      const server = device.dhcpServer;
      const lines = [
        ...(server?.pools ?? []).map((pool) => {
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
        }),
        ...(server?.pendingPools ?? []).map(
          (entry) =>
            entry.name +
            ' ' +
            (entry.network !== undefined
              ? entry.network + '/' + entry.prefix + ' inactive: no routed IPv4 interface can serve this network'
              : '- inactive: configure network')
        ),
      ];
      return 'DHCP ' + (server?.enabled ? 'enabled' : 'disabled') + '\n' + (lines.join('\n') || 'Nenhum pool configurado');
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
  const c=device.dhcpSnooping;
  const snooping=c?[
    (c.enabled?'':'no ')+'ip dhcp snooping',
    ...(c.vlans.length?['ip dhcp snooping vlan '+c.vlans.join(',')]:[]),
    ...((c.arpInspectionVlans.length||c.arpInspection)?['ip arp inspection vlan '+(c.arpInspectionVlans.length?c.arpInspectionVlans:c.vlans).join(',')]:[]),
    ...device.interfaces.filter(p=>c.trustedPorts.includes(p.id)||c.arpTrustedPorts.includes(p.id)||c.sourceGuardPorts.includes(p.id)||(c.sourceGuard&&p.mode!=='routed')).flatMap(p=>[
      'interface '+p.name,...(c.trustedPorts.includes(p.id)?[' ip dhcp snooping trust']:[]),...(c.arpTrustedPorts.includes(p.id)||(c.arpInspection&&c.trustedPorts.includes(p.id))?[' ip arp inspection trust']:[]),...(c.sourceGuardPorts.includes(p.id)||(c.sourceGuard&&p.mode!=='routed')?[' ip verify source']:[]),'exit'
    ]),
    ...c.staticBindings.map(b=>`ip source binding ${b.mac} vlan ${b.vlan} ${b.ip} interface ${device.interfaces.find(p=>p.id===b.port)!.name}`)
  ]:[];
  if (!server) return [...relays,...snooping];
  const iosPools = [
    ...server.pools.filter((pool) => pool.ios).map(iosPoolDeclaration),
    ...(server.pendingPools ?? []),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [
    ...relays,
    ...snooping,
    server.enabled ? 'service dhcp' : 'no service dhcp',
    ...(server.excludedRanges ?? []).map(
      (range) => 'ip dhcp excluded-address ' + range.start + (range.end !== range.start ? ' ' + range.end : '')
    ),
    ...server.pools
      .filter((pool) => !pool.ios)
      .flatMap((pool) => [
        'ip dhcp pool ' +
          pool.name +
          (pool.relayAddress ? ' relay ' + pool.relayAddress + '/' + pool.prefix : '') +
          ' interface ' +
          device.interfaces.find((port) => port.id === pool.port)!.name,
        ' network ' + pool.network + '/' + pool.prefix,
        ' range ' + pool.start + ' ' + pool.end,
        leaseLine(pool.leaseMs),
        ...(pool.gateway ? [' default-router ' + pool.gateway] : []),
        ...(pool.dns.length ? [' dns-server ' + pool.dns.join(' ')] : []),
        ...(pool.domainName ? [' domain-name ' + pool.domainName] : []),
        ...(pool.excluded.length ? [' excluded-address ' + pool.excluded.join(' ')] : []),
        ...(pool.reservations ?? []).map((entry) => ' reservation ' + entry.clientMac + ' ' + entry.address),
        ' exit',
      ]),
    ...iosPools.flatMap((entry) => [
      'ip dhcp pool ' + entry.name,
      ...(entry.network !== undefined ? [' network ' + entry.network + ' ' + ipString(mask(entry.prefix!))] : []),
      ...(entry.start && entry.end ? [' range ' + entry.start + ' ' + entry.end] : []),
      ...(entry.gateway ? [' default-router ' + entry.gateway] : []),
      ...(entry.dns.length ? [' dns-server ' + entry.dns.join(' ')] : []),
      ...(entry.domainName ? [' domain-name ' + entry.domainName] : []),
      ...(entry.excluded?.length ? [' excluded-address ' + entry.excluded.join(' ')] : []),
      ...(entry.reservations ?? []).map((item) => ' reservation ' + item.clientMac + ' ' + item.address),
      ...(entry.leaseMs !== IOS_LEASE_MS ? [leaseLine(entry.leaseMs)] : []),
      ' exit',
    ]),
  ];
}
