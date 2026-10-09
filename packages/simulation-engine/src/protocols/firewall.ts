import { sipRelated } from './nat-sip';
import { inspectApplication, validateRules } from './inspection';
import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkInterface, Packet } from '../model';
import { firewallSchema, type FirewallSession } from './firewall-model';
import { tcpAdd } from './tcp-model';
import { trackTcpPacket } from './firewall-tcp';
import { isIcmpError } from './icmp';
import { firewallRule, firewallZone, relatedSession, sessionDirection } from './firewall-policy';
export { validateFirewall } from './firewall-validation';
import { validateFirewallConfig } from './firewall-validation';

// Snapshots saved before protocol selection retain their TCP-only policy.
export function firewallProtocols(config: Device['firewall']): ('TCP' | 'UDP' | 'ICMP')[] {
  return config?.protocols ?? ['TCP'];
}
export function configureFirewall(engine: SimulationEngine, device: Device, input: unknown) {
  const config = firewallSchema.parse(input);
  config.protocols ??= ['TCP', 'UDP', 'ICMP'];
  config.sessions = [];
  if (config.application) {
    config.application.flows = [];
    validateRules(config.application);
  }
  config.dropped = 0;
  validateFirewallConfig({ ...device, firewall: config });
  device.firewall = config;
  engine.state.queue = engine.state.queue.filter(
    ({ action }) =>
      (action.kind !== 'firewall-expire' && action.kind !== 'inspection-expire') ||
      action.device !== device.id
  );
  engine.emit(
    'CONFIG_CHANGED',
    device.id,
    'Firewall de trânsito ' + (config.enabled ? 'ativado' : 'desativado') + '; sessões reiniciadas.'
  );
}
function removeSession(engine: SimulationEngine, device: Device, session: FirewallSession) {
  device.firewall!.sessions = device.firewall!.sessions.filter((entry) => entry.id !== session.id);
  engine.state.queue = engine.state.queue.filter(
    ({ action }) =>
      action.kind !== 'firewall-expire' || action.device !== device.id || action.session !== session.id
  );
}
function touchSession(engine: SimulationEngine, device: Device, session: FirewallSession) {
  engine.state.queue = engine.state.queue.filter(
    ({ action }) =>
      action.kind !== 'firewall-expire' || action.device !== device.id || action.session !== session.id
  );
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
  session.expiresAt = engine.state.clock + lifetime;
  engine.schedule(lifetime, {
    kind: 'firewall-expire',
    device: device.id,
    session: session.id,
    at: session.expiresAt,
  });
}
export function expireFirewall(engine: SimulationEngine, device: Device, id: string, at: number) {
  const session = device.firewall?.sessions.find((entry) => entry.id === id && entry.expiresAt === at);
  if (!session) return;
  removeSession(engine, device, session);
  engine.emit('FIREWALL_EXPIRED', device.id, 'Sessão ' + id + ' expirada no relógio virtual.');
}
export function permitFirewall(
  engine: SimulationEngine,
  device: Device,
  input: NetworkInterface,
  output: NetworkInterface,
  packet: Packet
) {
  const config = device.firewall;
  if (!config?.enabled || packet.protocol === 'OSPF' || packet.protocol === 'VRRP') return true;
  const zoned = !!config.zonePolicy;
  const trackedProtocol = isIcmpError(packet) ? (packet.error?.quote.protocol ?? 'ICMP') : packet.protocol;
  if (!zoned && !firewallProtocols(config).includes(trackedProtocol))
    return inspectApplication(engine, device, input, output, packet);
  const trustedIn = config.trustedPorts.includes(input.id),
    trustedOut = config.trustedPorts.includes(output.id);
  const deny = (reason: string) => {
    config.dropped++;
    const message =
      'Firewall ' +
      packet.protocol +
      ' em ' +
      input.name +
      ': ' +
      reason +
      '; ' +
      packet.src +
      ' → ' +
      packet.dst +
      '.';
    engine.emit('FIREWALL_DENY', device.id, message, { port: input.id });
    engine.drop(device, message, input.id);
    return false;
  };
  const from = firewallZone(device, input.id),
    to = firewallZone(device, output.id);
  const rule = zoned
    ? firewallRule(
        device,
        input.id,
        output.id,
        packet.protocol,
        packet.protocol === 'ICMP' ? undefined : packet.destinationPort
      )
    : undefined;
  if (zoned && (!from || !to)) return deny('interface sem zona; descarte padrão');
  if (rule?.action === 'deny') return deny('regra ' + rule.sequence + ' ' + from + ' → ' + to);
  if (rule?.action === 'permit' || (zoned && from === to && !rule) || (!zoned && trustedIn && trustedOut)) {
    engine.emit(
      'FIREWALL_PERMIT',
      device.id,
      rule
        ? 'Regra ' + rule.sequence + ': permit sem rastreamento.'
        : 'Trânsito dentro da mesma zona confiável.',
      { port: input.id }
    );
    return inspectApplication(engine, device, input, output, packet);
  }
  if (sipRelated(device, input, output, packet, engine.state.clock)) {
    engine.emit('FIREWALL_PERMIT', device.id, 'RTP RELATED ao diálogo SIP autorizado.');
    return inspectApplication(engine, device, input, output, packet);
  }
  if (isIcmpError(packet)) {
    const related = relatedSession(device, input.id, output.id, packet, engine.state.clock);
    if (!related) return deny('erro ICMP sem sessão e citação correspondentes');
    engine.emit(
      'FIREWALL_PERMIT',
      device.id,
      'ICMP RELATED à sessão ' + related.id + '; timers preservados.',
      { port: input.id }
    );
    return true;
  }
  if (!zoned && !trustedIn && !trustedOut) return deny('trânsito entre interfaces não confiáveis');
  const existing = config.sessions.find(
    (entry) => sessionDirection(entry, input.id, output.id, packet) !== undefined
  );
  // Validate a copy: rejected ACK/flags must never change the tracked state.
  let session = existing && structuredClone(existing);
  let outbound = existing ? sessionDirection(existing, input.id, output.id, packet)! : zoned || trustedIn;
  if (session && session.expiresAt <= engine.state.clock) {
    removeSession(engine, device, session);
    session = undefined;
    outbound = zoned || trustedIn;
  }
  if (!session && (zoned ? rule?.action !== 'inspect' : !outbound))
    return deny(
      zoned
        ? 'nenhuma regra inspect; descarte padrão entre zonas'
        : 'retorno sem sessão iniciada na rede confiável'
    );
  if (!session && config.sessions.length >= 1024) return deny('limite de sessões atingido');
  const tuple = {
    inside: outbound ? input.id : output.id,
    outside: outbound ? output.id : input.id,
    clientIp: outbound ? packet.src : packet.dst,
    serverIp: outbound ? packet.dst : packet.src,
  };
  if (packet.protocol === 'TCP') {
    if (!session) {
      if (!packet.flags.includes('SYN') || packet.flags.some((flag) => !['SYN', 'ECE', 'CWR'].includes(flag)))
        return deny('conexão não solicitada; falta SYN do iniciador');
      session = {
        id: engine.id('firewall'),
        ...tuple,
        protocol: 'TCP',
        clientPort: packet.sourcePort,
        serverPort: packet.destinationPort,
        clientInitial: packet.sequence,
        clientNext: tcpAdd(packet.sequence, 1),
        state: 'SYN-SENT',
        clientFin: false,
        serverFin: false,
        expiresAt: 0,
      };
    } else if (session.protocol === 'TCP') {
      if (packet.flags.includes('RST')) {
        const valid =
          session.state === 'SYN-SENT' && !outbound
            ? packet.flags.includes('ACK') && packet.acknowledgment === session.clientNext
            : packet.sequence === (outbound ? session.clientNext : session.serverNext);
        if (!valid) return deny('RST fora da sequência rastreada');
        removeSession(engine, device, session);
        engine.emit('FIREWALL_PERMIT', device.id, 'RST encerrou sessão ' + session.id + '.', {
          port: input.id,
        });
        return true;
      }
      if (!trackTcpPacket(session, packet, outbound))
        return deny('flags, sequência ou ACK incompatíveis com a sessão');
    }
  } else if (packet.protocol === 'UDP') {
    session ??= {
      id: engine.id('firewall'),
      ...tuple,
      protocol: 'UDP',
      clientPort: packet.sourcePort,
      serverPort: packet.destinationPort,
      state: 'UNREPLIED',
      expiresAt: 0,
    };
    if (!outbound && session.protocol === 'UDP') session.state = 'REPLIED';
  } else {
    if (packet.kind !== (outbound ? 'echo-request' : 'echo-reply'))
      return deny('apenas Echo Request de saída e Echo Reply correlacionado são rastreados');
    session ??= {
      id: engine.id('firewall'),
      ...tuple,
      protocol: 'ICMP',
      probeId: packet.probeId,
      state: 'UNREPLIED',
      expiresAt: 0,
    };
    if (!outbound && session.protocol === 'ICMP') session.state = 'REPLIED';
  }
  if (!inspectApplication(engine, device, input, output, packet)) return false;
  const index = config.sessions.findIndex((entry) => entry.id === session.id);
  if (index >= 0) config.sessions[index] = session;
  else config.sessions.push(session);
  touchSession(engine, device, session);
  engine.emit(
    'FIREWALL_PERMIT',
    device.id,
    session.protocol +
      ' ' +
      session.id +
      ' ' +
      session.state +
      ': ' +
      (outbound ? 'saída' : 'retorno') +
      ' autorizado.',
    { port: input.id }
  );
  return true;
}
