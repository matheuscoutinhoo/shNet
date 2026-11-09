import { ALL_MODES, CONFIG_MODES, CommandRegistry, currentPort } from './registry';
import { showAccessLists, showNatTranslations } from './ios-show';
import { ipv4Schema, type Device, type NatConfig, type NetworkInterface } from '../model';
import type { SimulationEngine } from '../core/engine';
import { ipNumber, ipString, mask, parsePrefix, sameSubnet } from '../protocols/ipv4';
import { syncNat } from '../protocols/state-sync';
import { registerNativeAclCommands, aclEntryText, aclRunningLines } from './acl';
import { showIpv6AccessLists } from './acl6';
import { interfaceName, longInterfaceName } from './operational';

export function policyNetwork(value: string) {
  if (value.toLowerCase() === 'any') return { network: '0.0.0.0', prefix: 0 };
  const [network, prefix = '32'] = value.split('/');
  return { network, prefix: parsePrefix(prefix) };
}
function currentNat(device: Device): NatConfig {
  return device.nat ?? { enabled: true, statics: [], pools: [], bindings: [] };
}
function outside(device: Device, address: string) {
  const port = device.interfaces.find(
    (entry) =>
      entry.natRole === 'outside' &&
      entry.ip &&
      entry.prefix !== undefined &&
      sameSubnet(entry.ip, address, entry.prefix)
  );
  if (!port) throw new Error('Configure uma interface ip nat outside na subnet global.');
  return port.id;
}
export function registerPolicyCommands(registry: CommandRegistry) {
  registerNativeAclCommands(registry);
  registerIosNatCommands(registry);
  registry.register({
    pattern: /^(no )?ip nat inside source list ([\w-]+) interface (\S+) overload$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const p = d.interfaces.find((p) => p.name.toLowerCase() === interfaceName(m[3]).toLowerCase());
      if (!p || p.mode !== 'routed') throw new Error('Invalid PAT interface.');
      const value = currentNat(d),
        old = value.interfaceRules?.find((r) => r.acl === m[2] && r.outside === p.id);
      value.interfaceRules = (value.interfaceRules ?? []).filter((r) => r.acl !== m[2] || r.outside !== p.id);
      let n = 1;
      while (
        value.interfaceRules.some((r) => r.name === 'PAT-' + n) ||
        value.pools.some((r) => r.name === 'PAT-' + n)
      )
        n++;
      if (!m[1]) value.interfaceRules.push({ name: old?.name ?? 'PAT-' + n, acl: m[2], outside: p.id });
      e.configureNat(d.id, value);
    },
  });
  registry.register({
    pattern: /^(no )?ip nat alg sip$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      e.configureNat(d.id, { ...currentNat(d), algSip: !m[1] });
    },
  });
  registry.register({
    pattern: /^show ip nat alg$/i,
    modes: ALL_MODES,
    run: (_m, _e, d) => JSON.stringify(d.nat?.sipBindings ?? [], null, 2),
  });
  registry.register({
    pattern: /^(no )?ip nat hairpin$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      e.configureNat(d.id, { ...currentNat(d), hairpin: !m[1] });
    },
  });
  registry.register({
    pattern: /^show ip nat hairpin$/i,
    modes: ALL_MODES,
    run: (_m, _e, d) => JSON.stringify(d.nat?.hairpins ?? [], null, 2),
  });

  registry.register({
    pattern:
      /^access-list ([\w-]+) (\d+) (permit|deny) (ip|icmp|udp|tcp|ospf|vrrp) ([\w./]+) ([\w./]+)(?: eq (\d+))?$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const existing = device.accessLists?.find((acl) => acl.name === match[1]);
      engine.configureAcl(device.id, {
        name: match[1],
        rules: [
          ...(existing?.rules.filter((rule) => rule.sequence !== Number(match[2])) ?? []),
          {
            sequence: Number(match[2]),
            action: match[3].toLowerCase(),
            protocol: match[4].toLowerCase(),
            source: policyNetwork(match[5]),
            destination: policyNetwork(match[6]),
            ...(match[7] ? { destinationPort: Number(match[7]) } : {}),
          },
        ],
      });
    },
  });
  registry.register({
    pattern: /^no access-list ([\w-]+)(?: (\d+))?$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      if (!match[2]) engine.removeAcl(device.id, match[1], true);
      else {
        const acl = device.accessLists?.find((entry) => entry.name === match[1]);
        if (!acl) throw new Error('ACL inexistente.');
        engine.configureAcl(device.id, {
          ...acl,
          rules: acl.rules.filter((rule) => rule.sequence !== Number(match[2])),
        });
      }
    },
  });
  registry.register({
    pattern: /^(no )?ip access-group ([\w-]+) (in|out)$/i,
    modes: ['interface'],
    run: (match, engine, device, context) =>
      engine.bindAcl(
        device.id,
        currentPort(device, context).id,
        match[3].toLowerCase() as 'in' | 'out',
        match[1] ? undefined : match[2]
      ),
  });
  registry.register({
    pattern: /^(no )?ip nat (inside|outside)$/i,
    modes: ['interface'],
    run: (match, _engine, device, context) => {
      if (device.type !== 'router') throw new Error('NAT exige roteador.');
      const port = currentPort(device, context);
      if (match[1]) delete port.natRole;
      else port.natRole = match[2].toLowerCase() as 'inside' | 'outside';
    },
  });
  registry.register({
    pattern: /^(no )?ip nat (inside source )?static ([\d.]+) ([\d.]+)$/i,
    syntax: [
      'ip nat inside source static <inside> <global>',
      'no ip nat inside source static <inside> <global>',
    ],
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const nat = currentNat(device);
      const statics = nat.statics.filter((entry) => entry.inside !== match[3]);
      if (!match[1])
        statics.push({
          inside: match[3],
          global: match[4],
          outside: match[2] ? '*' : outside(device, match[4]),
        });
      engine.configureNat(device.id, { ...nat, statics });
    },
  });
  registry.register({
    pattern: /^ip nat pool ([\w-]+) ([\d./]+) ([\d.]+) ([\d.]+)(?: (overload))?$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const nat = currentNat(device);
      engine.configureNat(device.id, {
        ...nat,
        pools: [
          ...nat.pools.filter((pool) => pool.name !== match[1]),
          {
            name: match[1],
            source: policyNetwork(match[2]),
            outside: outside(device, match[3]),
            start: match[3],
            end: match[4],
            overload: !!match[5],
          },
        ],
      });
    },
  });
  registry.register({
    pattern: /^no ip nat pool ([\w-]+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const nat = currentNat(device);
      if (nat.poolRules?.some((rule) => rule.pool === match[1]))
        throw new Error(`Pool ${match[1]} in use, cannot destroy`);
      engine.configureNat(device.id, {
        ...nat,
        pools: nat.pools.filter((pool) => pool.name !== match[1]),
        iosPools: (nat.iosPools ?? []).filter((pool) => pool.name !== match[1]),
      });
    },
  });
  registry.register({
    pattern: /^(no )?service nat$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      engine.configureNat(device.id, { ...currentNat(device), enabled: !match[1] });
    },
  });
  registry.register({
    pattern: /^show (?:ip )?access-lists(?: ([\w-]{1,32}))?$/i,
    syntax: [
      'show access-lists',
      'show access-lists <name>',
      'show ip access-lists',
      'show ip access-lists <name>',
    ],
    modes: ALL_MODES,
    run: (match, _engine, device) =>
      [
        showAccessLists(device, match[1]),
        // "show ip access-lists" is IPv4 only; "show access-lists" also lists IPv6 ACLs.
        /^show access-lists/i.test(match[0]) ? showIpv6AccessLists(device, match[1]) : '',
      ]
        .filter(Boolean)
        .join('\n') || 'Nenhuma ACL',
  });
  registry.register({
    pattern: /^show ip nat translations(?: (verbose))?$/i,
    syntax: ['show ip nat translations', 'show ip nat translations verbose'],
    modes: ALL_MODES,
    run: (_match, _engine, device) => showNatTranslations(device),
  });
  registry.register({
    pattern: /^show ip nat statistics$/i,
    syntax: 'show ip nat statistics',
    modes: ALL_MODES,
    run: (_match, engine, device) => showNatStatistics(engine, device),
  });
  registry.register({
    pattern: /^clear ip nat translation \*$/i,
    syntax: 'clear ip nat translation *',
    modes: ['privileged'],
    run: (_match, engine, device) => {
      if (device.nat) clearNatTranslations(engine, device);
      return '';
    },
  });
}
/** IOS "ip nat pool": "netmask A.B.C.D" or "prefix-length N". */
function poolPrefix(kind: string, value: string) {
  const prefix = kind.toLowerCase() === 'netmask' ? parsePrefix(value) : Number(value);
  if (!Number.isInteger(prefix) || prefix < 8 || prefix > 32)
    throw new Error('Invalid input detected at: ' + value);
  return prefix;
}
export function registerIosNatCommands(registry: CommandRegistry) {
  registry.register({
    pattern: /^ip nat pool ([\w-]{1,32}) ([\d.]+) ([\d.]+) (netmask|prefix-length) ([\d.]+)$/i,
    syntax: [
      'ip nat pool <name> <start> <end> netmask <mask>',
      'ip nat pool <name> <start> <end> prefix-length <length>',
    ],
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      if (d.type !== 'router') throw new Error('NAT exige roteador.');
      const nat = currentNat(d);
      const pool = {
        name: m[1],
        start: ipv4Schema.parse(m[2]),
        end: ipv4Schema.parse(m[3]),
        prefix: poolPrefix(m[4], m[5]),
      };
      e.configureNat(d.id, {
        ...nat,
        iosPools: [...(nat.iosPools ?? []).filter((entry) => entry.name !== pool.name), pool],
      });
    },
  });
  registry.register({
    pattern: /^(no )?ip nat inside source list ([\w-]{1,32}) pool ([\w-]{1,32})( overload)?$/i,
    syntax: ['ip nat inside source list <acl> pool <name> [overload]'],
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const nat = currentNat(d);
      const others = (nat.poolRules ?? []).filter((rule) => rule.acl !== m[2]);
      if (!m[1] && !nat.iosPools?.some((pool) => pool.name === m[3]))
        throw new Error(`Pool ${m[3]} not found`);
      e.configureNat(d.id, {
        ...nat,
        poolRules: m[1] ? others : [...others, { acl: m[2], pool: m[3], overload: !!m[4] }],
      });
    },
  });
  registry.register({
    pattern:
      /^(no )?ip nat inside source static (tcp|udp) ([\d.]+) (\d+) ([\d.]+) (\d+)( extendable)?( no-alias)?$/i,
    syntax: [
      'ip nat inside source static tcp <local> <port> <global> <port> [extendable]',
      'ip nat inside source static udp <local> <port> <global> <port> [extendable]',
    ],
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      if (d.type !== 'router') throw new Error('NAT exige roteador.');
      const nat = currentNat(d);
      const port = (value: string) => {
        const n = Number(value);
        if (n < 1 || n > 65535) throw new Error('Invalid input detected at: ' + value);
        return n;
      };
      const entry = {
        protocol: m[2].toLowerCase() as 'tcp' | 'udp',
        inside: ipv4Schema.parse(m[3]),
        insidePort: port(m[4]),
        global: ipv4Schema.parse(m[5]),
        globalPort: port(m[6]),
        ...(m[7] ? { extendable: true as const } : {}),
      };
      const others = (nat.portStatics ?? []).filter(
        (other) =>
          !(
            other.protocol === entry.protocol &&
            other.inside === entry.inside &&
            other.insidePort === entry.insidePort &&
            other.global === entry.global &&
            other.globalPort === entry.globalPort
          )
      );
      e.configureNat(d.id, { ...nat, portStatics: m[1] ? others : [...others, entry] });
    },
  });
}
/** Removes dynamic translations; static mappings stay (IOS "clear ip nat translation *"). */
export function clearNatTranslations(engine: SimulationEngine, device: Device) {
  const nat = device.nat!;
  for (const binding of nat.bindings) syncNat(engine, device, binding, true);
  nat.bindings = [];
  engine.state.queue = engine.state.queue.filter(
    ({ action }) => action.kind !== 'nat-expire' || action.device !== device.id
  );
  engine.emit('CONFIG_CHANGED', device.id, 'Traduções NAT dinâmicas removidas.');
}
function showNatStatistics(engine: SimulationEngine, device: Device) {
  const nat = device.nat;
  const name = (p: NetworkInterface) => '  ' + longInterfaceName(p.name);
  const bindings = nat?.bindings.filter((b) => b.expiresAt > engine.state.clock) ?? [];
  const statics = (nat?.statics.length ?? 0) + (nat?.portStatics?.length ?? 0);
  const extended = bindings.filter((b) => b.protocol !== 'ip').length + (nat?.portStatics?.length ?? 0);
  const rules = [
    ...(nat?.interfaceRules ?? []).map(
      (rule) =>
        `access-list ${rule.acl} interface ${longInterfaceName(device.interfaces.find((p) => p.id === rule.outside)?.name ?? '')}`
    ),
    ...(nat?.poolRules ?? []).map((rule) => `access-list ${rule.acl} pool ${rule.pool}`),
  ];
  return [
    `Total active translations: ${bindings.length + statics} (${statics} static, ${bindings.length} dynamic; ${extended} extended)`,
    'Outside interfaces:',
    ...device.interfaces.filter((p) => p.natRole === 'outside').map(name),
    'Inside interfaces: ',
    ...device.interfaces.filter((p) => p.natRole === 'inside').map(name),
    'Dynamic mappings:',
    ...(rules.length ? ['-- Inside Source'] : []),
    ...rules.flatMap((rule, index) => {
      const pool = /pool (\S+)$/.exec(rule)?.[1];
      const entry = pool ? nat?.iosPools?.find((p) => p.name === pool) : undefined;
      const refcount = bindings.filter((b) => b.pool === (pool ?? nat?.interfaceRules?.[index]?.name)).length;
      if (!entry) return [`[Id: ${index + 1}] ${rule} refcount ${refcount}`];
      const total = ipNumber(entry.end) - ipNumber(entry.start) + 1,
        allocated = new Set(bindings.filter((b) => b.pool === pool).map((b) => b.global)).size;
      return [
        `[Id: ${index + 1}] ${rule} refcount ${refcount}`,
        ` pool ${entry.name}: netmask ${ipString(mask(entry.prefix))}`,
        `\tstart ${entry.start} end ${entry.end}`,
        `\ttype generic, total addresses ${total}, allocated ${allocated} (${Math.floor((allocated * 100) / total)}%), misses 0`,
      ];
    }),
  ].join('\n');
}

export function policyRunningConfig(device: Device) {
  return [
    ...(device.accessLists?.flatMap((acl) =>
      // Numbered ACLs keep their legacy "access-list N ..." form, without sequence numbers.
      /^\d+$/.test(acl.name)
        ? [
            ...acl.rules.flatMap((rule) => [
              ...(rule.remarks ?? []).map((text) => `access-list ${acl.name} remark ${text}`),
              `access-list ${acl.name} ${aclEntryText(rule, acl.kind)}`,
            ]),
            ...(acl.remarks ?? []).map((text) => `access-list ${acl.name} remark ${text}`),
          ]
        : [`ip access-list ${acl.kind ?? 'extended'} ${acl.name}`, ...aclRunningLines(acl), 'exit']
    ) ?? []),
    // NAT runs as soon as it is configured (IOS has no global switch); "no service nat" is the
    // simulator's way to pause it.
    ...(device.nat && !device.nat.enabled ? ['no service nat'] : []),
    ...(device.nat?.iosPools ?? []).map(
      (pool) => `ip nat pool ${pool.name} ${pool.start} ${pool.end} netmask ${ipString(mask(pool.prefix))}`
    ),
    ...(device.nat?.interfaceRules ?? []).map(
      (rule) =>
        `ip nat inside source list ${rule.acl} interface ${device.interfaces.find((p) => p.id === rule.outside)!.name} overload`
    ),
    ...(device.nat?.poolRules ?? []).map(
      (rule) => `ip nat inside source list ${rule.acl} pool ${rule.pool}${rule.overload ? ' overload' : ''}`
    ),
    ...(device.nat?.statics.map(
      (entry) =>
        'ip nat ' +
        (entry.outside === '*' ? 'inside source ' : '') +
        'static ' +
        entry.inside +
        ' ' +
        entry.global
    ) ?? []),
    ...(device.nat?.portStatics ?? []).map(
      (entry) =>
        `ip nat inside source static ${entry.protocol} ${entry.inside} ${entry.insidePort} ${entry.global} ${entry.globalPort}${entry.extendable ? ' extendable' : ''}`
    ),
    ...(device.nat?.hairpin !== undefined ? [(device.nat.hairpin ? '' : 'no ') + 'ip nat hairpin'] : []),
    ...(device.nat?.algSip !== undefined ? [(device.nat.algSip ? '' : 'no ') + 'ip nat alg sip'] : []),
    ...(device.nat?.pools.map(
      (pool) =>
        'ip nat pool ' +
        pool.name +
        ' ' +
        pool.source.network +
        '/' +
        pool.source.prefix +
        ' ' +
        pool.start +
        ' ' +
        pool.end +
        (pool.overload ? ' overload' : '')
    ) ?? []),
  ];
}
