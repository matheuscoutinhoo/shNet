import type { SimulationEngine } from '../core/engine';
import { retainArpResolutions } from './arp';
import type { Device } from '../model';
import {
  TCP,
  tcpAdd,
  tcpBytes,
  tcpLength,
  tcpDistance,
  tcpFinished,
  type TcpConnection,
  type TcpPacket,
} from './tcp-model';
import { growTcpWindow, sampleTcpRtt, tcpFlow, tcpReceiveWindow } from './tcp-flow';
import { extendTcpPacket } from './tcp-extensions';

export function clearTcpTimer(
  engine: SimulationEngine,
  device: Device,
  connection: TcpConnection,
  timer?: 'retry' | 'expire'
) {
  engine.state.queue = engine.state.queue.filter(
    ({ action }) =>
      action.kind !== 'tcp-timer' ||
      action.device !== device.id ||
      action.connection !== connection.id ||
      (timer !== undefined && action.timer !== timer)
  );
}
export function touchTcp(engine: SimulationEngine, device: Device, connection: TcpConnection) {
  clearTcpTimer(engine, device, connection, 'expire');
  connection.updatedAt = engine.state.clock;
  if (tcpFinished(connection)) {
    delete connection.expiresAt;
    return;
  }
  connection.expiresAt =
    engine.state.clock + (connection.state === 'TIME-WAIT' ? TCP.timeWaitMs : TCP.idleMs);
  engine.schedule(connection.expiresAt - engine.state.clock, {
    kind: 'tcp-timer',
    device: device.id,
    connection: connection.id,
    timer: 'expire',
    at: connection.expiresAt,
  });
}
export function tcpState(
  engine: SimulationEngine,
  device: Device,
  connection: TcpConnection,
  state: TcpConnection['state']
) {
  const before = connection.state;
  connection.state = state;
  if (tcpFinished(connection) || state === 'TIME-WAIT') {
    clearTcpTimer(engine, device, connection);
    delete connection.pending;
    if (connection.flow) {
      connection.flow.flight = [];
      connection.flow.receiveQueue = [];
      delete connection.flow.recovery;
    }
    connection.sendUna = connection.sendNext;
    connection.sendBuffer = '';
    // Unsent ARP buffers must not revive an aborted connection.
    device.pending = device.pending.filter(
      ({ packet }) => packet.protocol !== 'TCP' || packet.traceId !== connection.id
    );
    retainArpResolutions(engine, device);
  }
  touchTcp(engine, device, connection);
  engine.emit('TCP_STATE_CHANGED', device.id, `${connection.id}: ${before} → ${state}.`);
}
export function makeTcpPacket(
  connection: TcpConnection,
  flags: TcpPacket['flags'],
  data = '',
  now = connection.updatedAt
): TcpPacket {
  return extendTcpPacket(
    connection,
    {
      src: connection.localIp,
      dst: connection.remoteIp,
      ...(connection.localIp.includes(':') ? { family: 6 as const } : {}),
      protocol: 'TCP',
      ttl: 64,
      sourcePort: connection.localPort,
      destinationPort: connection.remotePort,
      sequence: connection.sendNext,
      acknowledgment: flags.includes('ACK') ? connection.receiveNext : 0,
      flags: [...flags],
      window: tcpReceiveWindow(connection),
      data,
      bytes: (connection.localIp.includes(':') ? 60 : 40) + tcpBytes(data),
      traceId: connection.id,
    },
    now
  );
}
export function transmitTcp(
  engine: SimulationEngine,
  device: Device,
  packet: TcpPacket,
  vrf?: string,
  scope?: string
) {
  engine.emit(
    'TCP_SENT',
    device.id,
    `${packet.flags.join(',')} ${packet.src}:${packet.sourcePort} → ${packet.dst}:${packet.destinationPort}; seq=${packet.sequence} ack=${packet.acknowledgment} bytes=${tcpBytes(packet.data)}.`
  );
  if (packet.family === 6)
    engine.sendIp6(
      device.id,
      {
        src: packet.src,
        dst: packet.dst,
        protocol: 'TCP',
        kind: 'tcp',
        hopLimit: packet.ttl,
        bytes: packet.bytes,
        segment: packet,
      },
      undefined,
      vrf,
      scope
    );
  else engine.sendIp(device.id, packet, undefined, vrf);
}
export function armTcpRetry(engine: SimulationEngine, device: Device, connection: TcpConnection) {
  clearTcpTimer(engine, device, connection, 'retry');
  const pending = connection.pending!;
  pending.deadline = engine.state.clock + tcpFlow(connection).rto;
  engine.schedule(pending.deadline - engine.state.clock, {
    kind: 'tcp-timer',
    device: device.id,
    connection: connection.id,
    timer: 'retry',
    at: pending.deadline,
  });
}
export function sendTcpSegment(
  engine: SimulationEngine,
  device: Device,
  connection: TcpConnection,
  flags: TcpPacket['flags'],
  data = ''
) {
  const packet = makeTcpPacket(connection, flags, data, engine.state.clock);
  const length = tcpLength(packet);
  if (length) {
    const pending = { packet, retries: 0, deadline: 0, sentAt: engine.state.clock, retransmitted: false };
    if (connection.pending) tcpFlow(connection).flight.push(pending);
    else connection.pending = pending;
    connection.sendNext = tcpAdd(connection.sendNext, length);
    connection.bytesSent += tcpBytes(data);
    if (connection.pending === pending) armTcpRetry(engine, device, connection);
  }
  transmitTcp(engine, device, packet, connection.vrf, connection.scope);
}
export function acknowledgeTcp(
  engine: SimulationEngine,
  device: Device,
  connection: TcpConnection,
  acknowledgment = connection.sendNext
) {
  const acknowledged = tcpDistance(connection.sendUna, acknowledgment);
  if (!acknowledged || acknowledged > tcpDistance(connection.sendUna, connection.sendNext)) return 0;
  const f = tcpFlow(connection),
    flight = [...(connection.pending ? [connection.pending] : []), ...f.flight],
    remaining: typeof flight = [];
  let rtt: number | undefined;
  // Karn's rule: a cumulative ACK spanning a retransmitted segment is ambiguous.
  const ambiguous = flight.some(
    (p) => p.retransmitted && tcpDistance(connection.sendUna, p.packet.sequence) < acknowledged
  );
  if (flight.some((p) => p.retransmitted && p.packet.flags.includes('SYN'))) f.rto = Math.max(3000, f.rto);
  for (const pending of flight) {
    const start = tcpDistance(connection.sendUna, pending.packet.sequence),
      end = start + tcpLength(pending.packet);
    if (end <= acknowledged) {
      if (!ambiguous && pending.sentAt !== undefined) rtt ??= engine.state.clock - pending.sentAt;
      continue;
    }
    if (start < acknowledged) {
      const prefix = takeTcpText(pending.packet.data, acknowledged - start);
      if (tcpBytes(prefix) !== acknowledged - start || pending.packet.flags.includes('SYN')) return 0;
      pending.packet = {
        ...pending.packet,
        sequence: acknowledgment,
        data: pending.packet.data.slice(prefix.length),
        bytes: pending.packet.bytes - tcpBytes(prefix),
      };
    }
    remaining.push(pending);
  }
  clearTcpTimer(engine, device, connection, 'retry');
  connection.sendUna = acknowledgment;
  connection.pending = remaining.shift();
  if (!connection.pending) delete connection.pending;
  f.flight = remaining;
  if (rtt !== undefined) sampleTcpRtt(connection, rtt);
  growTcpWindow(connection, acknowledged);
  if (connection.pending) armTcpRetry(engine, device, connection);
  if (connection.stream && !connection.pending) {
    connection.stream.writtenBytes += connection.bytesSent;
    connection.bytesSent = 0;
  }
  return acknowledged;
}
export function sendTcpReset(
  engine: SimulationEngine,
  device: Device,
  incoming: TcpPacket,
  vrf?: string,
  scope?: string
) {
  if (incoming.flags.includes('RST')) return;
  const acknowledged = incoming.flags.includes('ACK');
  transmitTcp(
    engine,
    device,
    {
      src: incoming.dst,
      dst: incoming.src,
      ...(incoming.family ? { family: incoming.family } : {}),
      protocol: 'TCP',
      ttl: 64,
      sourcePort: incoming.destinationPort,
      destinationPort: incoming.sourcePort,
      sequence: acknowledged ? incoming.acknowledgment : 0,
      acknowledgment: acknowledged ? 0 : tcpAdd(incoming.sequence, tcpLength(incoming)),
      flags: acknowledged ? ['RST'] : ['RST', 'ACK'],
      window: 0,
      data: '',
      bytes: incoming.family ? 60 : 40,
    },
    vrf,
    scope
  );
}

// Whole Unicode characters keep this text-only stream serializable without corrupting UTF-8.
export function takeTcpText(data: string, limit: number) {
  let text = '',
    bytes = 0;
  for (const character of data) {
    const length = tcpBytes(character);
    if (bytes + length > limit) break;
    text += character;
    bytes += length;
  }
  return text;
}
