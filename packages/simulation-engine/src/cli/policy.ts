import { ALL_MODES, CONFIG_MODES, CommandRegistry, currentPort } from './registry';
import { type Device, type NatConfig } from '../model';
import { parsePrefix, sameSubnet } from '../protocols/ipv4';

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
      if (!match[2]) engine.removeAcl(device.id, match[1]);
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
    pattern: /^(no )?ip nat static ([\d.]+) ([\d.]+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const nat = currentNat(device);
      const statics = nat.statics.filter((entry) => entry.inside !== match[2]);
      if (!match[1]) statics.push({ inside: match[2], global: match[3], outside: outside(device, match[3]) });
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
      engine.configureNat(device.id, { ...nat, pools: nat.pools.filter((pool) => pool.name !== match[1]) });
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
    pattern: /^show access-lists$/i,
    modes: ALL_MODES,
    run: (_match, _engine, device) =>
      device.accessLists
        ?.map(
          (acl) =>
            acl.name +
            ' (implicit drops: ' +
            acl.implicitDrops +
            ')\n' +
            acl.rules
              .map(
                (rule) =>
                  rule.sequence +
                  ' ' +
                  rule.action +
                  ' ' +
                  rule.protocol +
                  ' ' +
                  rule.source.network +
                  '/' +
                  rule.source.prefix +
                  ' -> ' +
                  rule.destination.network +
                  '/' +
                  rule.destination.prefix +
                  (rule.destinationPort ? ' eq ' + rule.destinationPort : '') +
                  ' hits=' +
                  rule.hits
              )
              .join('\n')
        )
        .join('\n') || 'Nenhuma ACL',
  });
  registry.register({
    pattern: /^show ip nat translations$/i,
    modes: ALL_MODES,
    run: (_match, engine, device) =>
      [
        'INSIDE LOCAL          INSIDE GLOBAL         PROTOCOL / REMAINING',
        ...(device.nat?.statics.map(
          (entry) => entry.inside.padEnd(22) + entry.global.padEnd(22) + 'static'
        ) ?? []),
        ...(device.nat?.bindings.map(
          (entry) =>
            (entry.inside + ':' + (entry.insideToken ?? '*')).padEnd(22) +
            (entry.global + ':' + (entry.globalToken ?? '*')).padEnd(22) +
            entry.protocol +
            ' ' +
            Math.ceil((entry.expiresAt - engine.state.clock) / 1000) +
            's'
        ) ?? []),
      ].join('\n'),
  });
}

export function policyRunningConfig(device: Device) {
  return [
    ...(device.accessLists?.flatMap((acl) =>
      acl.rules.map(
        (rule) =>
          'access-list ' +
          acl.name +
          ' ' +
          rule.sequence +
          ' ' +
          rule.action +
          ' ' +
          rule.protocol +
          ' ' +
          rule.source.network +
          '/' +
          rule.source.prefix +
          ' ' +
          rule.destination.network +
          '/' +
          rule.destination.prefix +
          (rule.destinationPort ? ' eq ' + rule.destinationPort : '')
      )
    ) ?? []),
    ...(device.nat ? [device.nat.enabled ? 'service nat' : 'no service nat'] : []),
    ...(device.nat?.statics.map((entry) => 'ip nat static ' + entry.inside + ' ' + entry.global) ?? []),
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
