import { firewallProtocols } from '../protocols/firewall';
import type { Device, TcpConnection } from '../model';
import { ALL_MODES, CONFIG_MODES, type CommandRegistry } from './registry';
import { firewallZoneConfig, registerFirewallZoneCommands } from './firewall-zones';

// Never allow simulated payloads to become control sequences in xterm.
export const terminalText = (text: string) =>
  [...text]
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return code === 9 || code === 10 || (code >= 32 && (code < 127 || code > 159));
    })
    .join('');
export function formatTcpConnection(connection: TcpConnection) {
  return (
    `TCP [${connection.id}] ${connection.state}\n${connection.localIp}:${connection.localPort} → ${connection.remoteIp}:${connection.remotePort}\n` +
    `TX=${connection.bytesSent} B RX=${connection.bytesReceived} B retransmissões=${connection.retransmissions}\n` +
    (connection.flow
      ? `Em voo=${(connection.sendNext - connection.sendUna) >>> 0} B CWND=${Math.floor(connection.flow.cwnd)} B SSTHRESH=${Math.floor(connection.flow.ssthresh)} B RTO=${connection.flow.rto} ms RTT=${connection.flow.srtt?.toFixed(2) ?? 'sem amostra'} ms\n`
      : '') +
    terminalText(connection.received)
  );
}
export function registerTcpCommands(registry: CommandRegistry) {
  registerFirewallZoneCommands(registry);
  registry.register({
    pattern: /^(no )?service (echo|http)(?: (\d+))?$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const kind = match[2].toLowerCase() as 'echo' | 'http';
      const port = Number(match[3] ?? (kind === 'http' ? 80 : 7));
      const previous = device.tcpServices?.find((service) => service.port === port);
      engine.configureTcpService(device.id, { ...previous, port, kind, enabled: !match[1] });
    },
  });
  registry.register({
    pattern: /^tcp connect ([\da-f:.]+) (\d+)(?: interface (\S+))?$/i,
    modes: ALL_MODES,
    run: (match, engine, device) => {
      const scope = match[3]
        ? device.interfaces.find((p) => p.name.toLowerCase() === match[3].toLowerCase())
        : undefined;
      if (match[3] && !scope) throw new Error('Interface TCP inexistente.');
      return `TCP [${engine.openTcp(
        device.id,
        match[1],
        Number(match[2]),
        '',
        false,
        undefined,
        scope?.id
      )}] enfileirado. Avance a simulação.`;
    },
  });
  registry.register({
    pattern: /^tcp echo ([\da-f:.]+) (\d+) (.+)$/i,
    modes: ALL_MODES,
    run: (match, engine, device) =>
      `TCP [${engine.openTcp(device.id, match[1], Number(match[2]), match[3], true)}] echo enfileirado. Avance a simulação.`,
  });
  registry.register({
    pattern: /^tcp send (tcp-\d+) (.+)$/i,
    modes: ALL_MODES,
    run: (match, engine, device) => engine.writeTcp(device.id, match[1], match[2]),
  });
  registry.register({
    pattern: /^tcp (close|reset) (tcp-\d+)$/i,
    modes: ALL_MODES,
    run: (match, engine, device) => engine.closeTcp(device.id, match[2], match[1].toLowerCase() === 'reset'),
  });
  registry.register({
    pattern: /^http get ([\da-f:.]+)(?: (\d+))?(?: (\/\S*))?(?: host ([a-zA-Z0-9.:-]+))?$/i,
    modes: ALL_MODES,
    run: (match, engine, device) =>
      `TCP [${engine.httpGet(device.id, match[1], Number(match[2] ?? 80), match[3] ?? '/', undefined, match[4])}] HTTP GET enfileirado. Avance a simulação.`,
  });
  registry.register({
    pattern: /^show tcp(?: (tcp-\d+))?$/i,
    modes: ALL_MODES,
    run: (match, _engine, device) =>
      device.tcpConnections
        ?.filter((connection) => !match[1] || connection.id === match[1])
        .map(formatTcpConnection)
        .join('\n\n') || 'Nenhuma conexão TCP.',
  });
  registry.register({
    pattern: /^show services$/i,
    modes: ALL_MODES,
    run: (_match, _engine, device) =>
      device.tcpServices
        ?.map(
          (service) => `${service.kind} TCP/${service.port}: ${service.enabled ? 'LISTEN' : 'desativado'}`
        )
        .join('\n') || 'Nenhum serviço TCP.',
  });
  registry.register({
    pattern: /^firewall trust (.+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const trustedPorts = match[1].split(/\s+/).map((name) => {
        const port = device.interfaces.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
        if (!port) throw new Error('Interface de firewall inexistente.');
        return port.id;
      });
      engine.configureFirewall(device.id, {
        enabled: device.firewall?.enabled ?? false,
        zonePolicy: device.firewall?.zonePolicy,
        application: device.firewall?.application,
        trustedPorts,
        protocols: device.firewall ? firewallProtocols(device.firewall) : ['TCP', 'UDP', 'ICMP'],
      });
    },
  });
  registry.register({
    pattern: /^(no )?service firewall$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) =>
      engine.configureFirewall(device.id, {
        enabled: !match[1],
        zonePolicy: device.firewall?.zonePolicy,
        application: device.firewall?.application,
        trustedPorts: device.firewall?.trustedPorts ?? [],
        protocols: device.firewall ? firewallProtocols(device.firewall) : ['TCP', 'UDP', 'ICMP'],
      }),
  });
  registry.register({
    pattern: /^firewall protocols ((?:(?:tcp|udp|icmp)(?:\s+|$))+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) =>
      engine.configureFirewall(device.id, {
        enabled: device.firewall?.enabled ?? false,
        zonePolicy: device.firewall?.zonePolicy,
        application: device.firewall?.application,
        trustedPorts: device.firewall?.trustedPorts ?? [],
        protocols: match[1].trim().toUpperCase().split(/\s+/),
      }),
  });
  registry.register({
    pattern: /^show firewall$/i,
    modes: ALL_MODES,
    run: (_match, _engine, device) =>
      [
        `Firewall de trânsito: ${device.firewall?.enabled ? 'ativo' : 'desativado'}; descartes=${device.firewall?.dropped ?? 0}`,
        device.firewall?.zonePolicy
          ? 'Rastreamento definido pelas regras de zonas e portas.'
          : 'Protocolos rastreados: ' + firewallProtocols(device.firewall).join(', '),
        'Política: ' +
          (device.firewall?.zonePolicy
            ? 'zonas; descarte padrão entre zonas; ICMP RELATED por citação'
            : 'interfaces confiáveis; ICMP RELATED por citação'),
        ...firewallZoneConfig(device),
        ...(device.firewall?.sessions.map(
          (session) =>
            session.id +
            ' ' +
            session.protocol +
            ' ' +
            session.state +
            ' ' +
            session.clientIp +
            ' → ' +
            session.serverIp +
            (session.protocol === 'ICMP'
              ? ' ID=' + session.probeId
              : ' portas ' + session.clientPort + ' → ' + session.serverPort)
        ) ?? []),
      ].join('\n'),
  });
}
export function tcpRunningConfig(device: Device) {
  return [
    ...(device.tcpServices?.map(
      (service) => `${service.enabled ? '' : 'no '}service ${service.kind} ${service.port}`
    ) ?? []),
    ...(device.firewall
      ? [
          ...(device.firewall.trustedPorts.length
            ? [
                'firewall trust ' +
                  device.firewall.trustedPorts
                    .map((id) => device.interfaces.find((port) => port.id === id)!.name)
                    .join(' '),
              ]
            : []),
          'firewall protocols ' + firewallProtocols(device.firewall).join(' ').toLowerCase(),
          ...firewallZoneConfig(device),
          (device.firewall.enabled ? '' : 'no ') + 'service firewall',
        ]
      : []),
  ];
}
