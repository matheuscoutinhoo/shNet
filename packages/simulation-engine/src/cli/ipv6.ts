import type { Device } from '../model';
import { ipv6Config } from '../protocols/ipv6-control';
import { network6, normalize6 } from '../protocols/ipv6-address';
import { ALL_MODES, CONFIG_MODES, currentPort, type CommandRegistry } from './registry';
function cidr(value: string) {
  const [ip, mask] = value.split('/'),
    prefix = Number(mask);
  if (mask === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 128)
    throw new Error('Prefixo IPv6 entre 0 e 128.');
  return { ip: normalize6(ip), prefix };
}
export function registerIpv6Commands(r: CommandRegistry) {
  r.register({
    pattern: /^dhcp6 server (\{.*\})$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureDhcp6Server(d.id, JSON.parse(m[1])),
  });
  r.register({
    pattern: /^(no )?ipv6 dhcp client(?: (address|prefix|both))?(?: delegate (\S+))?(?: (rapid-commit))?$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c),
        down = m[3] && d.interfaces.find((p) => p.name.toLowerCase() === m[3].toLowerCase());
      if (m[3] && !down) throw new Error('Interface de delegação inexistente.');
      e.configureDhcp6Client(d.id, p.id, {
        enabled: !m[1],
        requestAddress: m[2] !== 'prefix',
        requestPrefix: !!m[2] && m[2] !== 'address',
        ...(down ? { delegatePort: down.id } : {}),
        rapidCommit: !!m[4],
      });
    },
  });
  r.register({
    pattern: /^dhcp6 release (\S+)$/i,
    modes: ALL_MODES,
    run: (m, e, d) => {
      const p = d.interfaces.find((p) => p.name.toLowerCase() === m[1].toLowerCase());
      if (!p) throw new Error('Interface DHCPv6 inexistente.');
      e.releaseDhcp6(d.id, p.id);
    },
  });
  r.register({
    pattern: /^(no )?service udp6 echo (\d+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureUdp6Service(d.id, { enabled: !m[1], kind: 'echo', port: Number(m[2]) }),
  });
  r.register({
    pattern: /^udp6 send (\S+) (\d+) (.+)$/i,
    modes: ALL_MODES,
    run: (m, e, d) => 'UDP IPv6 ' + e.sendUdp6(d.id, m[1], Number(m[2]), m[3]),
  });
  r.register({
    pattern: /^show dhcp6$/i,
    modes: ALL_MODES,
    run: (_m, _e, d) =>
      [
        ...d.interfaces
          .filter((p) => p.dhcp6)
          .map(
            (p) =>
              p.name +
              ' ' +
              p.dhcp6!.state +
              ' ' +
              (p.dhcp6!.address ?? '') +
              (p.dhcp6!.delegatedPrefix
                ? ' PD=' + p.dhcp6!.delegatedPrefix + '/' + p.dhcp6!.prefixLength
                : '')
          ),
        ...(d.dhcp6Server?.leases.map(
          (l) => l.clientId + ' ' + l.state + ' ' + (l.address ?? l.delegatedPrefix)
        ) ?? []),
      ].join('\n') || 'DHCPv6 não configurado.',
  });
  r.register({
    pattern: /^(no )?ipv6 unicast-routing$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      if (!['router', 'switch'].includes(d.type)) throw new Error('IPv6 routing exige roteador/switch L3.');
      d.ipv6Routing = !m[1];
      e.emit(
        'CONFIG_CHANGED',
        d.id,
        'Encaminhamento IPv6 ' + (d.ipv6Routing ? 'habilitado.' : 'desabilitado.')
      );
    },
  });
  r.register({
    pattern: /^ipv6 (enable|address autoconfig|address ([\da-f:.]+\/\d+))$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c),
        config = ipv6Config(p);
      if (m[2]) config.addresses = [...config.addresses.filter((a) => a.ip !== cidr(m[2]).ip), cidr(m[2])];
      if (m[1].toLowerCase() === 'address autoconfig') config.auto = true;
      e.configureIpv6(d.id, p.id, config);
    },
  });
  r.register({
    pattern: /^no ipv6 (enable|address(?: ([\da-f:.]+\/\d+)| (autoconfig))?)$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c);
      if (m[1].toLowerCase() === 'enable') {
        e.configureIpv6(d.id, p.id);
        return;
      }
      const config = ipv6Config(p);
      if (m[3]) config.auto = false;
      else config.addresses = m[2] ? config.addresses.filter((a) => a.ip !== cidr(m[2]).ip) : [];
      e.configureIpv6(d.id, p.id, config);
    },
  });
  r.register({
    pattern: /^ipv6 nd prefix (\S+)(?: valid (\d+) preferred (\d+))?$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c),
        config = ipv6Config(p),
        a = cidr(m[1]);
      config.ra ??= { intervalMs: 3000, lifetimeMs: 9000, prefixes: [] };
      config.ra.prefixes = [
        ...config.ra.prefixes.filter((v) => v.network !== network6(a.ip, a.prefix)),
        {
          network: network6(a.ip, a.prefix),
          prefix: a.prefix,
          onLink: true,
          autonomous: a.prefix === 64,
          validMs: Number(m[2] ?? 60) * 1000,
          preferredMs: Number(m[3] ?? 30) * 1000,
        },
      ];
      e.configureIpv6(d.id, p.id, config);
    },
  });
  r.register({
    pattern: /^no ipv6 nd prefix(?: (\S+))?$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c),
        config = ipv6Config(p);
      if (!m[1]) delete config.ra;
      else if (config.ra) {
        const a = cidr(m[1]);
        config.ra.prefixes = config.ra.prefixes.filter(
          (v) => v.network !== network6(a.ip, a.prefix) || v.prefix !== a.prefix
        );
      }
      e.configureIpv6(d.id, p.id, config);
    },
  });
  r.register({
    pattern:
      /^ipv6 traffic-filter (in|out) (permit|deny) (any|echo-request|echo-reply|ndp|error) (\S+) (\S+)$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c),
        config = ipv6Config(p),
        a = cidr(m[4]),
        b = cidr(m[5]),
        key = m[1].toLowerCase() === 'in' ? 'aclIn' : 'aclOut';
      (config[key] ??= []).push({
        action: m[2].toLowerCase() as 'permit' | 'deny',
        kind: m[3].toLowerCase() as 'any',
        source: a.ip,
        sourcePrefix: a.prefix,
        destination: b.ip,
        destinationPrefix: b.prefix,
        hits: 0,
      });
      e.configureIpv6(d.id, p.id, config);
    },
  });
  r.register({
    pattern: /^(no )?ipv6 route(?: vrf (\S+))? (\S+) (\S+) (\S+)(?: metric (\d+))?$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const a = cidr(m[3]),
        p = d.interfaces.find((p) => p.name.toLowerCase() === m[4].toLowerCase());
      if (!p) throw new Error('Interface não encontrada.');
      e.configureRoute6(
        d.id,
        {
          network: network6(a.ip, a.prefix),
          prefix: a.prefix,
          port: p.id,
          nextHop: m[5],
          metric: Number(m[6] ?? 1),
          ...(m[2] ? { vrf: m[2] } : {}),
        },
        !!m[1]
      );
    },
  });
  r.register({
    pattern: /^ping ipv6 (\S+)(?: interface (\S+))?(?: vrf (\S+))?(?: hop-limit (\d+))?(?: size (\d+))?$/i,
    modes: ALL_MODES,
    run: (m, e, d) => {
      const p = m[2] ? d.interfaces.find((p) => p.name.toLowerCase() === m[2].toLowerCase()) : undefined;
      if (m[2] && !p) throw new Error('Interface não encontrada.');
      return 'Probe IPv6 ' + e.ping6(d.id, m[1], Number(m[4] ?? 64), m[3], p?.id, Number(m[5] ?? 104));
    },
  });
  r.register({
    pattern: /^traceroute ipv6 (\S+)(?: vrf (\S+))?$/i,
    modes: ALL_MODES,
    run: (m, e, d) =>
      Array.from({ length: 8 }, (_, i) => `${i + 1}: ${e.ping6(d.id, m[1], i + 1, m[2])}`).join('\n'),
  });
  r.register({
    pattern: /^show ipv6 (interface|neighbors|route|probes)$/i,
    modes: ALL_MODES,
    run: (m, e, d) => {
      switch (m[1].toLowerCase()) {
        case 'interface':
          return (
            d.interfaces
              .filter((p) => p.ipv6)
              .map(
                (p) =>
                  p.name +
                  ' VRF=' +
                  (p.vrf ?? 'default') +
                  '\n' +
                  p.ipv6!.addresses.map((a) => `${a.ip}/${a.prefix} ${a.origin} ${a.state}`).join('\n') +
                  '\n' +
                  p.ipv6!.routers.map((r) => `RA default via ${r.ip}`).join('\n')
              )
              .join('\n') || 'IPv6 não configurado'
          );
        case 'neighbors':
          return (
            [
              ...(d.neighbors6?.map(
                (n) => `${n.ip} ${n.mac} ${n.port} ${n.state ?? 'REACHABLE'} expires=${n.expiresAt}`
              ) ?? []),
              ...(d.resolutions6?.map((r) => `${r.ip} ${r.port} INCOMPLETE ${r.attempts}/3`) ?? []),
            ].join('\n') || 'Sem vizinhos NDP'
          );
        case 'route':
          return (
            [
              ...d.interfaces
                .filter((p) => p.ipv6)
                .flatMap((p) =>
                  p
                    .ipv6!.addresses.filter((a) => a.onLink && ['preferred', 'deprecated'].includes(a.state))
                    .map(
                      (a) => `C ${network6(a.ip, a.prefix)}/${a.prefix} ${p.name} VRF=${p.vrf ?? 'default'}`
                    )
                ),
              ...(d.routes6 ?? []).map(
                (r) => `S ${r.network}/${r.prefix} via ${r.nextHop} ${r.port} VRF=${r.vrf ?? 'default'}`
              ),
              ...d.interfaces.flatMap(
                (p) => p.ipv6?.routers.map((r) => `RA ::/0 via ${r.ip} ${p.name}`) ?? []
              ),
            ].join('\n') || 'Sem rotas IPv6'
          );
        default:
          return (
            e.state.probes6
              ?.filter((p) => p.device === d.id)
              .map((p) => `${p.id} ${p.target} ${p.status} ${p.rtt ?? '-'} ms${p.mtu ? ' MTU=' + p.mtu : ''}`)
              .join('\n') || 'Sem probes IPv6'
          );
      }
    },
  });
}
export function ipv6RunningConfig(d: Device) {
  return [
    ...(d.dhcp6Server
      ? [
          'dhcp6 server ' +
            JSON.stringify({
              enabled: d.dhcp6Server.enabled,
              rapidCommit: d.dhcp6Server.rapidCommit,
              pools: d.dhcp6Server.pools,
            }),
        ]
      : []),
    ...(d.udp6Services?.map((s) => `${s.enabled ? '' : 'no '}service udp6 echo ${s.port}`) ?? []),
    ...(d.ipv6Routing ? ['ipv6 unicast-routing'] : []),
    ...d.interfaces
      .filter((p) => p.ipv6)
      .flatMap((p) => [
        'interface ' + p.name,
        ' ipv6 enable',
        ...(p.dhcp6
          ? [
              ` ${p.dhcp6.enabled ? '' : 'no '}ipv6 dhcp client ${p.dhcp6.requestAddress ? (p.dhcp6.requestPrefix ? 'both' : 'address') : 'prefix'}${p.dhcp6.delegatePort ? ' delegate ' + d.interfaces.find((v) => v.id === p.dhcp6!.delegatePort)!.name : ''}${p.dhcp6.rapidCommit ? ' rapid-commit' : ''}`,
            ]
          : []),
        ...(p.ipv6!.auto ? [' ipv6 address autoconfig'] : []),
        ...p
          .ipv6!.addresses.filter((a) => a.origin === 'static')
          .map((a) => ` ipv6 address ${a.ip}/${a.prefix}`),
        ...(p.ipv6!.ra?.prefixes.map(
          (a) =>
            ` ipv6 nd prefix ${a.network}/${a.prefix} valid ${a.validMs / 1000} preferred ${a.preferredMs / 1000}`
        ) ?? []),
        ...(['aclIn', 'aclOut'] as const).flatMap(
          (key) =>
            p.ipv6![key]?.map(
              (r) =>
                ` ipv6 traffic-filter ${key === 'aclIn' ? 'in' : 'out'} ${r.action} ${r.kind} ${r.source}/${r.sourcePrefix} ${r.destination}/${r.destinationPrefix}`
            ) ?? []
        ),
        'exit',
      ]),
    ...(d.routes6 ?? []).map(
      (r) =>
        `ipv6 route${r.vrf ? ' vrf ' + r.vrf : ''} ${r.network}/${r.prefix} ${d.interfaces.find((p) => p.id === r.port)!.name} ${r.nextHop} metric ${r.metric}`
    ),
  ];
}
