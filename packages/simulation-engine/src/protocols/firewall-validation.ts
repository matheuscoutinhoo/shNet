import type { Device, Snapshot } from '../model';
import { firewallRule, firewallZone } from './firewall-policy';
import { isUnicast } from './dhcp-config';

export function validateFirewallConfig(device: Device) {
  const config = device.firewall;
  if (!config) return;
  if (device.type !== 'router') throw new Error('Firewall de trânsito exige roteador.');
  if (
    new Set(config.trustedPorts).size !== config.trustedPorts.length ||
    config.trustedPorts.some(
      (id) => !device.interfaces.some((port) => port.id === id && port.mode === 'routed')
    )
  )
    throw new Error('Interface confiável de firewall inválida.');
  if (config.enabled && !config.zonePolicy && !config.trustedPorts.length)
    throw new Error('Escolha ao menos uma interface confiável.');
  if (config.protocols && new Set(config.protocols).size !== config.protocols.length)
    throw new Error('Protocolos de firewall duplicados.');
  if (config.zonePolicy) {
    const { zones, rules } = config.zonePolicy;
    const ports = zones.flatMap((zone) => zone.ports);
    if (
      new Set(zones.map((zone) => zone.name)).size !== zones.length ||
      new Set(ports).size !== ports.length ||
      ports.some((id) => !device.interfaces.some((port) => port.id === id && port.mode === 'routed'))
    )
      throw new Error('Zona duplicada ou interface de zona inválida.');
    if (
      new Set(rules.map((rule) => rule.sequence)).size !== rules.length ||
      rules.some(
        (rule) =>
          !zones.some((zone) => zone.name === rule.from) ||
          !zones.some((zone) => zone.name === rule.to) ||
          (rule.destinationPort !== undefined && rule.protocol !== 'TCP' && rule.protocol !== 'UDP')
      )
    )
      throw new Error('Regra de zona inválida: sequência, zonas ou porta de destino.');
  }
}
export function validateFirewall(snapshot: Snapshot) {
  for (const device of snapshot.devices) {
    validateFirewallConfig(device);
    const config = device.firewall;
    if (!config) continue;
    const tuples = new Set<string>(),
      ids = new Set<string>();
    for (const session of config.sessions) {
      const key = JSON.stringify([
        session.protocol,
        session.inside,
        session.outside,
        session.clientIp,
        session.serverIp,
        ...(session.protocol === 'ICMP' ? [session.probeId] : [session.clientPort, session.serverPort]),
      ]);
      const badTcp =
        session.protocol === 'TCP' &&
        ((session.state !== 'SYN-SENT' &&
          (session.serverNext === undefined || session.serverInitial === undefined)) ||
          (session.state === 'CLOSING' && !session.clientFin && !session.serverFin));
      const lifetime =
        session.protocol === 'ICMP'
          ? 60000
          : session.protocol === 'UDP'
            ? 120000
            : session.state === 'ESTABLISHED'
              ? 300000
              : session.state === 'CLOSING'
                ? 120000
                : 60000;
      const policyAllows = config.zonePolicy
        ? firewallZone(device, session.inside) !== undefined &&
          firewallZone(device, session.outside) !== undefined &&
          firewallRule(
            device,
            session.inside,
            session.outside,
            session.protocol,
            session.protocol === 'ICMP' ? undefined : session.serverPort
          )?.action === 'inspect'
        : (config.protocols ?? ['TCP']).includes(session.protocol) &&
          config.trustedPorts.includes(session.inside) &&
          !config.trustedPorts.includes(session.outside);
      if (
        !config.enabled ||
        !policyAllows ||
        !isUnicast(session.clientIp) ||
        !isUnicast(session.serverIp) ||
        tuples.has(key) ||
        ids.has(session.id) ||
        !device.interfaces.some((port) => port.id === session.outside && port.mode === 'routed') ||
        session.expiresAt < snapshot.clock ||
        session.expiresAt > snapshot.clock + lifetime ||
        badTcp
      )
        throw new Error('Sessão de firewall inválida.');
      ids.add(session.id);
      tuples.add(key);
      const timers = snapshot.queue.filter(
        ({ action }) =>
          action.kind === 'firewall-expire' && action.device === device.id && action.session === session.id
      );
      if (
        timers.length !== 1 ||
        timers[0].at !== session.expiresAt ||
        timers[0].action.kind !== 'firewall-expire' ||
        timers[0].action.at !== session.expiresAt
      )
        throw new Error('Sessão de firewall sem timer válido.');
    }
  }
  for (const { action } of snapshot.queue)
    if (
      action.kind === 'firewall-expire' &&
      !snapshot.devices
        .find((device) => device.id === action.device)
        ?.firewall?.sessions.some((session) => session.id === action.session)
    )
      throw new Error('Timer de firewall sem sessão.');
}
