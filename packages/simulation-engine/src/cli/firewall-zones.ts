import type { Device } from '../model';
import { firewallProtocols } from '../protocols/firewall';
import { ALL_MODES, CONFIG_MODES, type CommandRegistry } from './registry';

export function firewallZoneConfig(device: Device) {
  const policy = device.firewall?.zonePolicy;
  if (!policy) return [];
  return [
    'firewall mode zones',
    ...policy.zones.map(
      (zone) =>
        'firewall zone ' +
        zone.name +
        (zone.ports.length
          ? ' ' + zone.ports.map((id) => device.interfaces.find((port) => port.id === id)!.name).join(' ')
          : '')
    ),
    ...policy.rules
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .map(
        (rule) =>
          'firewall rule ' +
          rule.sequence +
          ' ' +
          rule.from +
          ' ' +
          rule.to +
          ' ' +
          rule.action +
          ' ' +
          rule.protocol.toLowerCase() +
          (rule.destinationPort === undefined ? '' : ' eq ' + rule.destinationPort)
      ),
  ];
}
export function registerFirewallZoneCommands(registry: CommandRegistry) {
  const base = (device: Device) => ({
    ...device.firewall,
    enabled: device.firewall?.enabled ?? false,
    trustedPorts: device.firewall?.trustedPorts ?? [],
    protocols: device.firewall ? firewallProtocols(device.firewall) : ['TCP', 'UDP', 'ICMP'],
  });
  registry.register({
    pattern: /^firewall mode (trusted|zones)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const config = base(device);
      if (match[1].toLowerCase() === 'trusted') delete config.zonePolicy;
      else config.zonePolicy ??= { zones: [], rules: [] };
      engine.configureFirewall(device.id, config);
    },
  });
  registry.register({
    pattern: /^(no )?firewall zone ([\w-]+)(?: (.+))?$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      if (!device.firewall?.zonePolicy) throw new Error('Selecione firewall mode zones primeiro.');
      const policy = structuredClone(device.firewall.zonePolicy);
      policy.zones = policy.zones.filter((zone) => zone.name !== match[2]);
      if (match[1])
        policy.rules = policy.rules.filter((rule) => rule.from !== match[2] && rule.to !== match[2]);
      else
        policy.zones.push({
          name: match[2],
          ports: (match[3]?.split(/\s+/) ?? []).map((name) => {
            const port = device.interfaces.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
            if (!port) throw new Error('Interface de zona inexistente.');
            return port.id;
          }),
        });
      engine.configureFirewall(device.id, { ...base(device), zonePolicy: policy });
    },
  });
  registry.register({
    pattern: /^firewall rule (\d+) ([\w-]+) ([\w-]+) (inspect|permit|deny) (ip|tcp|udp|icmp)(?: eq (\d+))?$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      if (!device.firewall?.zonePolicy) throw new Error('Selecione firewall mode zones primeiro.');
      const policy = structuredClone(device.firewall.zonePolicy);
      const sequence = Number(match[1]);
      policy.rules = policy.rules.filter((rule) => rule.sequence !== sequence);
      engine.configureFirewall(device.id, {
        ...base(device),
        zonePolicy: {
          ...policy,
          rules: [
            ...policy.rules,
            {
              sequence,
              from: match[2],
              to: match[3],
              action: match[4].toLowerCase(),
              protocol: match[5].toLowerCase() === 'ip' ? 'ip' : match[5].toUpperCase(),
              ...(match[6] ? { destinationPort: Number(match[6]) } : {}),
            },
          ],
        },
      });
    },
  });
  registry.register({
    pattern: /^no firewall rule (\d+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      if (!device.firewall?.zonePolicy) throw new Error('Selecione firewall mode zones primeiro.');
      engine.configureFirewall(device.id, {
        ...base(device),
        zonePolicy: {
          ...device.firewall.zonePolicy,
          rules: device.firewall.zonePolicy.rules.filter((rule) => rule.sequence !== Number(match[1])),
        },
      });
    },
  });
  registry.register({
    pattern: /^show firewall zones$/i,
    modes: ALL_MODES,
    run: (_match, _engine, device) =>
      firewallZoneConfig(device).join('\n') || 'Modo de interfaces confiáveis; sem zonas explícitas.',
  });
}
