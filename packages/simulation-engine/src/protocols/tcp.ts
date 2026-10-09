import { canListenBgp } from './bgp';
import type { SimulationEngine } from '../core/engine';
import type { Action, Device } from '../model';
import { portNumberSchema } from '../schemas';
import { resolveRoute } from './ipv4';
import { interfaceUp, requireVrf } from './layer3';
import {
  TCP,
  tcpAdd,
  tcpBytes,
  tcpDistance,
  tcpFinished,
  tcpLength,
  tcpTextSchema,
  tcpOptionBytes,
  type TcpConnection,
  type TcpPacket,
  transportAddressSchema,
} from './tcp-model';
import { normalize6, linkLocal6, unicast6 } from './ipv6-address';
import { resolveRoute6, source6, usable6 } from './ipv6-routing';
import {
  acknowledgeTcp,
  armTcpRetry,
  sendTcpReset,
  sendTcpSegment,
  takeTcpText,
  tcpState,
  touchTcp,
  transmitTcp,
  makeTcpPacket,
} from './tcp-wire';
import { queueTcpText, receiveTcpApplication } from './tcp-services';
import { reduceTcpWindow, tcpFinAcknowledged, tcpFlow, tcpInReceiveWindow } from './tcp-flow';
import { initializeTcpExtensions, negotiateTcpExtensions, receiveTcpExtensions } from './tcp-extensions';

function addConnection(
  engine: SimulationEngine,
  device: Device,
  tuple: Pick<TcpConnection, 'localIp' | 'remoteIp' | 'localPort' | 'remotePort' | 'vrf' | 'scope'>,
  role: TcpConnection['role'],
  service: TcpConnection['service']
): TcpConnection {
  device.tcpConnections ??= [];
  if (device.tcpConnections.length >= TCP.connections) {
    const old = device.tcpConnections.findIndex(
      (entry) =>
        tcpFinished(entry) &&
        entry.id !== device.iot?.connection &&
        !device.broker?.clients.some((client) => client.connection === entry.id) &&
        !device.proxy?.requests.some(
          (request) =>
            request.state === 'pending' && (request.front === entry.id || request.upstream === entry.id)
        ) &&
        !device.dnsQueries?.some((query) => query.status === 'pending' && query.tcpConnection === entry.id)
    );
    if (old < 0) throw new Error('Limite de conexões TCP simultâneas.');
    device.tcpConnections.splice(old, 1);
  }
  const id = engine.id('tcp');
  const initialSequence = (engine.state.sequence * 64000) >>> 0;
  const connection: TcpConnection = {
    id,
    ...tuple,
    role,
    service,
    ...(['mqtt', 'netconf', 'restconf', 'aaa'].includes(service)
      ? { stream: { readBytes: 0, writtenBytes: 0 } }
      : {}),
    ...(service === 'bgp'
      ? { stream: { readBytes: 0, writtenBytes: 0 }, bgpOpen: { sent: false, received: false } }
      : {}),
    state: role === 'client' ? 'SYN-SENT' : 'SYN-RECEIVED',
    initialSequence,
    sendUna: initialSequence,
    sendNext: initialSequence,
    receiveNext: 0,
    peerWindow: TCP.buffer,
    sendBuffer: '',
    received: '',
    closeRequested: false,
    peerClosed: false,
    httpHandled: false,
    bytesSent: 0,
    bytesReceived: 0,
    retransmissions: 0,
    startedAt: engine.state.clock,
    updatedAt: engine.state.clock,
  };
  initializeTcpExtensions(engine, device, connection);
  device.tcpConnections.push(connection);
  touchTcp(engine, device, connection);
  return connection;
}
export function openTcp(
  engine: SimulationEngine,
  device: Device,
  target: string,
  port: number,
  data = '',
  autoClose = false,
  onCreated?: (connection: TcpConnection) => void,
  vrf?: string,
  scope?: string
) {
  transportAddressSchema.parse(target);
  const ipv6 = target.includes(':');
  if (ipv6) target = normalize6(target);
  portNumberSchema.parse(port);
  tcpTextSchema.parse(data);
  requireVrf(device, vrf);
  if (
    (device.type === 'switch' &&
      !device.interfaces.some((p) => p.mode === 'routed' && (ipv6 ? usable6(p).length > 0 : !!p.ip))) ||
    !device.power
  )
    throw new Error('TCP exige stack IP ligada.');
  if (ipv6 && linkLocal6(target) && !scope) throw new Error('TCP IPv6 link-local exige interface de saída.');
  const local = device.interfaces.find(
    (entry) =>
      interfaceUp(device, entry) &&
      entry.vrf === vrf &&
      (!scope || entry.id === scope) &&
      (ipv6 ? usable6(entry).some((a) => a.ip === target) : entry.ip === target)
  );
  const route6 = ipv6 ? resolveRoute6(device, target, engine.state.clock, vrf, scope) : undefined;
  const source = ipv6
    ? local
      ? target
      : route6 && source6(route6.port, target)
    : (local?.ip ?? resolveRoute(device, target, vrf)?.port.ip);
  if (!source) throw new Error('Configure IP e uma rota para o destino TCP.');
  if (ipv6 ? !unicast6(target) : target === '0.0.0.0' || Number(target.split('.')[0]) >= 224)
    throw new Error('TCP exige destino unicast.');
  let localPort = 49152;
  while (
    device.tcpConnections?.some(
      (connection) =>
        connection.vrf === vrf &&
        ((connection.localIp === source && connection.localPort === localPort) ||
          (connection.remoteIp === source && connection.remotePort === localPort))
    ) ||
    device.tcpServices?.some((service) => service.port === localPort) ||
    device.dnsQueries?.some((query) => query.status === 'pending' && query.sourcePort === localPort)
  )
    localPort++;
  portNumberSchema.parse(localPort);
  const connection = addConnection(
    engine,
    device,
    {
      localIp: source,
      remoteIp: target,
      localPort,
      remotePort: port,
      ...(vrf ? { vrf } : {}),
      ...(ipv6 && linkLocal6(target) ? { scope } : {}),
    },
    'client',
    'manual'
  );
  queueTcpText(connection, data);
  if (connection.extensions?.local.pmtud) {
    const mtu = ipv6 ? route6?.port.mtu : resolveRoute(device, target, vrf)?.port.mtu;
    if (mtu) {
      connection.extensions.pathMtu = mtu;
      tcpFlow(connection).mss = Math.min(
        tcpFlow(connection).mss,
        mtu - (ipv6 ? 60 : 40) - (connection.extensions.local.timestamps ? 12 : 0)
      );
    }
  }
  connection.closeRequested = autoClose;
  onCreated?.(connection);
  engine.emit(
    'TCP_STATE_CHANGED',
    device.id,
    `${connection.id}: abertura ativa SYN-SENT para ${target}:${port}.`
  );
  sendTcpSegment(engine, device, connection, ['SYN']);
  return connection.id;
}
function getConnection(device: Device, id: string) {
  const connection = device.tcpConnections?.find((entry) => entry.id === id);
  if (!connection) throw new Error('Conexão TCP não encontrada.');
  return connection;
}
export function flushTcp(engine: SimulationEngine, device: Device, connection: TcpConnection) {
  if (!['ESTABLISHED', 'CLOSE-WAIT'].includes(connection.state)) return;
  const f = tcpFlow(connection);
  while (connection.sendBuffer && f.flight.length < 63) {
    const available =
      Math.floor(Math.min(f.cwnd, connection.peerWindow)) -
      tcpDistance(connection.sendUna, connection.sendNext);
    const mtuLimit =
      connection.extensions?.pathMtu === undefined
        ? f.mss
        : connection.extensions.pathMtu -
          (connection.localIp.includes(':') ? 60 : 40) -
          tcpOptionBytes(makeTcpPacket(connection, ['ACK'], '', engine.state.clock).options);
    const data = takeTcpText(connection.sendBuffer, Math.min(f.mss, available, mtuLimit));
    if (!data) break;
    connection.sendBuffer = connection.sendBuffer.slice(data.length);
    sendTcpSegment(engine, device, connection, ['ACK', 'PSH'], data);
  }
  if (
    !connection.sendBuffer &&
    !connection.pending &&
    connection.closeRequested &&
    ['ESTABLISHED', 'CLOSE-WAIT'].includes(connection.state)
  ) {
    tcpState(engine, device, connection, connection.peerClosed ? 'LAST-ACK' : 'FIN-WAIT-1');
    sendTcpSegment(engine, device, connection, ['FIN', 'ACK']);
  }
}
export function writeTcp(engine: SimulationEngine, device: Device, id: string, data: string) {
  const connection = getConnection(device, id);
  if (!['ESTABLISHED', 'CLOSE-WAIT'].includes(connection.state) || connection.closeRequested)
    throw new Error('Conexão TCP indisponível para envio.');
  queueTcpText(connection, data);
  flushTcp(engine, device, connection);
}
export function closeTcp(engine: SimulationEngine, device: Device, id: string, reset = false) {
  const connection = getConnection(device, id);
  if (tcpFinished(connection) || connection.state === 'TIME-WAIT') return;
  if (reset) {
    // Cancel pending data before sending the reset, including loopback delivery.
    tcpState(engine, device, connection, 'RESET');
    sendTcpSegment(engine, device, connection, ['RST', 'ACK']);
    engine.emit('TCP_RESET', device.id, `${id}: encerramento por reset local.`);
  } else {
    connection.closeRequested = true;
    flushTcp(engine, device, connection);
  }
}
export function receiveTcp(
  engine: SimulationEngine,
  device: Device,
  packet: TcpPacket,
  vrf?: string,
  scope?: string
) {
  engine.emit(
    'TCP_RECEIVED',
    device.id,
    `${packet.flags.join(',')} TCP/${packet.destinationPort}; seq=${packet.sequence} ack=${packet.acknowledgment}.`
  );
  let connection = device.tcpConnections?.find(
    (entry) =>
      !tcpFinished(entry) &&
      entry.vrf === vrf &&
      entry.scope === scope &&
      entry.localIp === packet.dst &&
      entry.remoteIp === packet.src &&
      entry.localPort === packet.destinationPort &&
      entry.remotePort === packet.sourcePort
  );
  const syn = packet.flags.includes('SYN'),
    ack = packet.flags.includes('ACK');
  if (!connection) {
    const service =
      !packet.family && !vrf && packet.destinationPort === 179 && canListenBgp(device, packet.src)
        ? { kind: 'bgp' as const, body: '' }
        : !vrf && packet.destinationPort === 53 && device.dnsServer?.enabled
          ? { kind: 'dns' as const, body: '' }
          : !vrf &&
              device.remoteManagement?.enabled &&
              ((device.remoteManagement.netconf && packet.destinationPort === 830) ||
                (device.remoteManagement.restconf && packet.destinationPort === 443))
            ? {
                kind: packet.destinationPort === 830 ? ('netconf' as const) : ('restconf' as const),
                body: '',
              }
            : !vrf && packet.destinationPort === 49 && device.aaaServer?.enabled && device.aaaServer.tacacs
              ? { kind: 'aaa' as const, body: '' }
              : device.tcpServices?.find((entry) => entry.enabled && entry.port === packet.destinationPort);
    if (!service || !syn || ack) {
      sendTcpReset(engine, device, packet, vrf, scope);
      return;
    }
    if ((device.tcpConnections?.filter((entry) => !tcpFinished(entry)).length ?? 0) >= TCP.connections) {
      engine.drop(device, 'Backlog TCP cheio; SYN descartado.');
      return;
    }
    connection = addConnection(
      engine,
      device,
      {
        localIp: packet.dst,
        remoteIp: packet.src,
        localPort: packet.destinationPort,
        remotePort: packet.sourcePort,
        ...(vrf ? { vrf } : {}),
        ...(scope ? { scope } : {}),
      },
      'server',
      service.kind
    );
    connection.receiveNext = tcpAdd(packet.sequence, 1);
    negotiateTcpExtensions(connection, packet, engine.state.clock);
    connection.peerWindow = packet.window;
    if (service.kind === 'http') connection.responseBody = service.body;
    sendTcpSegment(engine, device, connection, ['SYN', 'ACK']);
    return;
  }
  const c = connection;
  if (packet.flags.includes('RST')) {
    const valid =
      c.state === 'SYN-SENT'
        ? ack && packet.acknowledgment === c.sendNext
        : packet.sequence === c.receiveNext;
    if (valid) {
      tcpState(engine, device, c, 'RESET');
      engine.emit('TCP_RESET', device.id, `${c.id}: reset recebido; porta fechada ou conexão abortada.`);
    } else engine.drop(device, 'RST TCP fora da sequência esperada.');
    return;
  }
  if (c.state === 'SYN-SENT') {
    if (!syn || !ack || packet.acknowledgment !== c.sendNext) {
      engine.drop(device, 'SYN-ACK TCP inválido.');
      return;
    }
    negotiateTcpExtensions(c, packet, engine.state.clock);
    acknowledgeTcp(engine, device, c);
    c.receiveNext = tcpAdd(packet.sequence, 1);
    c.peerWindow = packet.window;
    tcpState(engine, device, c, 'ESTABLISHED');
    sendTcpSegment(engine, device, c, ['ACK']);
    flushTcp(engine, device, c);
    return;
  }
  if (c.state === 'SYN-RECEIVED' && syn && !ack && tcpAdd(packet.sequence, 1) === c.receiveNext) {
    if (c.pending) transmitTcp(engine, device, c.pending.packet, c.vrf, c.scope);
    return;
  }
  // A lost third handshake ACK makes the peer retransmit SYN-ACK.
  if (syn) {
    if (
      ack &&
      c.role === 'client' &&
      tcpAdd(packet.sequence, 1) === c.receiveNext &&
      packet.acknowledgment === tcpAdd(c.initialSequence, 1)
    )
      sendTcpSegment(engine, device, c, ['ACK']);
    else engine.drop(device, 'SYN inesperado em conexão TCP existente.');
    return;
  }
  if (!ack) {
    engine.drop(device, 'Segmento TCP sincronizado sem ACK.');
    return;
  }
  if (c.state === 'TIME-WAIT') {
    if (packet.flags.includes('FIN') && tcpAdd(packet.sequence, tcpLength(packet)) === c.receiveNext) {
      sendTcpSegment(engine, device, c, ['ACK']);
      touchTcp(engine, device, c);
    }
    return;
  }
  const f = tcpFlow(c),
    length = tcpLength(packet),
    old = tcpDistance(packet.sequence, c.receiveNext);
  if (
    !tcpInReceiveWindow(c, packet.sequence, tcpBytes(packet.data)) &&
    !(length && old < 0x80000000 && old <= length)
  ) {
    if (length) sendTcpSegment(engine, device, c, ['ACK']);
    return;
  }
  const acknowledgmentAhead = tcpDistance(c.sendUna, packet.acknowledgment);
  const outstanding = tcpDistance(c.sendUna, c.sendNext);
  if (acknowledgmentAhead > outstanding && acknowledgmentAhead < 0x80000000) {
    engine.drop(device, 'ACK TCP confirma bytes ainda não enviados.');
    return;
  }
  if (c.state === 'SYN-RECEIVED' && packet.acknowledgment !== c.sendNext) {
    engine.drop(device, 'ACK final do handshake TCP inválido.');
    return;
  }
  if (!receiveTcpExtensions(engine, device, c, packet)) {
    if (length) sendTcpSegment(engine, device, c, ['ACK']);
    return;
  }
  const wasFin = tcpFinAcknowledged(c, packet.acknowledgment),
    previousWindow = c.peerWindow,
    acknowledged = acknowledgeTcp(engine, device, c, packet.acknowledgment);
  if (acknowledged) {
    if (c.state === 'SYN-RECEIVED') tcpState(engine, device, c, 'ESTABLISHED');
    else if (wasFin) {
      if (c.state === 'LAST-ACK') {
        tcpState(engine, device, c, 'CLOSED');
        return;
      }
      tcpState(engine, device, c, c.peerClosed ? 'TIME-WAIT' : 'FIN-WAIT-2');
    }
    // NewReno repairs another gap when a partial ACK has not left fast recovery.
    if (f.recovery !== undefined && c.pending) retransmitTcp(engine, device, c, false);
  } else if (
    c.pending &&
    packet.acknowledgment === c.sendUna &&
    !length &&
    packet.window === previousWindow &&
    c.pending.packet.data
  ) {
    f.duplicateAcks++;
    if (f.duplicateAcks === 3 && f.recovery === undefined) {
      reduceTcpWindow(c, false);
      retransmitTcp(engine, device, c, false);
    } else if (f.recovery !== undefined) f.cwnd = Math.min(TCP.buffer, f.cwnd + f.mss);
  }
  c.peerWindow = packet.window;
  touchTcp(engine, device, c);
  if (packet.sequence !== c.receiveNext) {
    if (tcpDistance(c.receiveNext, packet.sequence) < 0x80000000) {
      const start = tcpDistance(c.receiveNext, packet.sequence);
      if (
        length &&
        f.receiveQueue.length < 64 &&
        !f.receiveQueue.some((p) => {
          const other = tcpDistance(c.receiveNext, p.sequence);
          return start < other + tcpLength(p) && other < start + length;
        })
      ) {
        f.receiveQueue.push(structuredClone(packet));
        if (c.extensions) c.extensions.lastOutOfOrder = packet.sequence;
      }
    } else if (old < length) {
      const prefix = takeTcpText(packet.data, old);
      if (tcpBytes(prefix) === old) {
        packet = {
          ...packet,
          sequence: c.receiveNext,
          data: packet.data.slice(prefix.length),
          bytes: packet.bytes - old,
        };
      }
    }
    if (packet.sequence !== c.receiveNext) {
      if (length) sendTcpSegment(engine, device, c, ['ACK']);
      flushTcp(engine, device, c);
      return;
    }
  }
  acceptTcpPayload(engine, device, c, packet);
  while (!tcpFinished(c)) {
    const at = f.receiveQueue.findIndex((p) => p.sequence === c.receiveNext);
    if (at < 0) break;
    const [next] = f.receiveQueue.splice(at, 1);
    acceptTcpPayload(engine, device, c, next);
  }
  if (length && !tcpFinished(c)) sendTcpSegment(engine, device, c, ['ACK']);
  flushTcp(engine, device, c);
}
function acceptTcpPayload(engine: SimulationEngine, device: Device, c: TcpConnection, packet: TcpPacket) {
  if (packet.data) {
    if (c.peerClosed || c.bytesReceived + tcpBytes(packet.data) > TCP.buffer) {
      engine.drop(device, 'Dados TCP após FIN ou janela de recepção esgotada.');
      sendTcpSegment(engine, device, c, ['ACK']);
      return;
    }
    c.received += packet.data;
    c.bytesReceived += tcpBytes(packet.data);
    c.receiveNext = tcpAdd(c.receiveNext, tcpBytes(packet.data));
    receiveTcpApplication(engine, device, c, packet.data);
    if (tcpFinished(c)) return;
  }
  if (packet.flags.includes('FIN')) {
    c.receiveNext = tcpAdd(c.receiveNext, 1);
    c.peerClosed = true;
    if (c.state === 'FIN-WAIT-2') tcpState(engine, device, c, 'TIME-WAIT');
    else if (c.state === 'FIN-WAIT-1') tcpState(engine, device, c, 'CLOSING');
    else if (c.state === 'ESTABLISHED') tcpState(engine, device, c, 'CLOSE-WAIT');
    if (c.role === 'server' && !device.proxy?.requests.some((r) => r.front === c.id && r.state === 'pending'))
      c.closeRequested = true;
  }
}
function retransmitTcp(engine: SimulationEngine, device: Device, c: TcpConnection, timeout: boolean) {
  const pending = [c.pending, ...tcpFlow(c).flight].find((p) => p && !p.sacked);
  if (!pending) return;
  pending.retransmitted = true;
  if (c.extensions?.timestamps && pending.packet.options?.timestamp) {
    pending.packet.options.timestamp.value = Math.floor(engine.state.clock) >>> 0;
    pending.packet.options.timestamp.echo = c.extensions.timestampRecent ?? 0;
    pending.sentAt = engine.state.clock;
  }
  if (pending.packet.ecn !== undefined) pending.packet.ecn = 0;
  c.retransmissions++;
  engine.emit(
    'TCP_RETRANSMIT',
    device.id,
    `${c.id}: seq=${pending.packet.sequence}; ${timeout ? 'RTO=' + tcpFlow(c).rto + ' ms' : 'fast retransmit/recuperação de perda'}.`
  );
  armTcpRetry(engine, device, c);
  transmitTcp(engine, device, pending.packet, c.vrf, c.scope);
}
export function handleTcpTimer(engine: SimulationEngine, action: Extract<Action, { kind: 'tcp-timer' }>) {
  const device = engine.device(action.device);
  const connection = device.tcpConnections?.find((entry) => entry.id === action.connection);
  if (!connection || tcpFinished(connection)) return;
  if (action.timer === 'expire') {
    if (connection.expiresAt !== action.at) return;
    const state = connection.state === 'TIME-WAIT' ? 'CLOSED' : 'TIMED-OUT';
    tcpState(engine, device, connection, state);
    if (state === 'TIMED-OUT')
      engine.emit('TCP_TIMEOUT', device.id, `${connection.id}: limite de inatividade de 120 s.`);
  } else if (connection.pending?.deadline === action.at) {
    const pending = connection.pending;
    if (pending.retries >= TCP.retries) {
      tcpState(engine, device, connection, 'TIMED-OUT');
      engine.emit(
        'TCP_TIMEOUT',
        device.id,
        `${connection.id}: esgotadas ${TCP.retries} retransmissões. Consulte descartes, ACL e rotas.`
      );
      return;
    }
    pending.retries++;
    for (const segment of [pending, ...tcpFlow(connection).flight]) delete segment.sacked;
    reduceTcpWindow(connection, true);
    retransmitTcp(engine, device, connection, true);
  }
}
