import type { Snapshot } from '../model';
import { TCP, tcpAdd, tcpBytes, tcpDistance, tcpFinished, tcpLength, tcpOptionBytes } from './tcp-model';

export function validateTcp(snapshot: Snapshot) {
  for (const device of snapshot.devices) {
    const services = device.tcpServices ?? [],
      connections = device.tcpConnections ?? [];
    if (
      (device.type === 'pc' && services.some((service) => service.kind !== 'echo')) ||
      (connections.length &&
        device.type === 'switch' &&
        !device.interfaces.some((p) => p.mode === 'routed' && (!!p.ip || !!p.ipv6)))
    )
      throw new Error('Stack TCP incompatível com equipamento.');
    if (new Set(services.map((service) => service.port)).size !== services.length)
      throw new Error('Porta de serviço TCP duplicada.');
    if (new Set(connections.map((connection) => connection.id)).size !== connections.length)
      throw new Error('ID TCP duplicado.');
    const tuples = new Set<string>();
    for (const connection of connections) {
      if (
        ['bgp', 'mqtt', 'netconf', 'restconf', 'aaa'].includes(connection.service) !== !!connection.stream ||
        (connection.service === 'bgp') !== !!connection.bgpOpen ||
        (connection.service === 'bgp' &&
          (connection.role === 'client' ? connection.remotePort : connection.localPort) !== 179)
      )
        throw new Error('Fluxo BGP exige TCP/179 e estado da aplicação.');
      if (
        connection.service === 'dns' &&
        (connection.role === 'client' ? connection.remotePort : connection.localPort) !== 53
      )
        throw new Error('Conexão DNS exige TCP/53.');
      const tuple = JSON.stringify([
        connection.vrf,
        connection.scope,
        connection.localIp,
        connection.localPort,
        connection.remoteIp,
        connection.remotePort,
      ]);
      if (!tcpFinished(connection)) {
        if (tuples.has(tuple)) throw new Error('Conexão TCP duplicada.');
        tuples.add(tuple);
      }
      if (
        connection.startedAt > connection.updatedAt ||
        connection.updatedAt > snapshot.clock ||
        connection.bytesReceived !== tcpBytes(connection.received) ||
        connection.bytesSent + tcpBytes(connection.sendBuffer) > TCP.buffer
      )
        throw new Error('Contadores ou relógio TCP inválidos.');
      const timers = snapshot.queue.filter(
        ({ action }) =>
          action.kind === 'tcp-timer' && action.device === device.id && action.connection === connection.id
      );
      const expire = timers.filter(({ action }) => action.kind === 'tcp-timer' && action.timer === 'expire');
      const retry = timers.filter(({ action }) => action.kind === 'tcp-timer' && action.timer === 'retry');
      const exactTimer = (entries: typeof timers, at: number | undefined) =>
        at !== undefined &&
        entries.length === 1 &&
        entries[0].at === at &&
        entries[0].action.kind === 'tcp-timer' &&
        entries[0].action.at === at &&
        at >= snapshot.clock;
      if (tcpFinished(connection)) {
        if (
          timers.length ||
          connection.pending ||
          connection.expiresAt !== undefined ||
          connection.sendBuffer
        )
          throw new Error('Conexão TCP finalizada com trabalho pendente.');
      } else if (!exactTimer(expire, connection.expiresAt))
        throw new Error('Conexão TCP sem timer de expiração válido.');
      const pending = connection.pending;
      const flow = connection.flow,
        flight = [...(pending ? [pending] : []), ...(flow?.flight ?? [])];
      const extensions = connection.extensions;
      if (
        extensions &&
        ((extensions.sack && !extensions.local.sack) ||
          (extensions.ecn && !extensions.local.ecn) ||
          (extensions.timestamps && !extensions.local.timestamps) ||
          (extensions.timestampRecent === undefined) !== (extensions.timestampAt === undefined) ||
          (extensions.timestamps && extensions.timestampRecent === undefined) ||
          (!extensions.timestamps && extensions.timestampRecent !== undefined) ||
          (extensions.timestampAt !== undefined && extensions.timestampAt > snapshot.clock) ||
          (!extensions.ecn && (extensions.ecnEcho || extensions.cwr || extensions.ecnUntil !== undefined)) ||
          (connection.localIp.includes(':') && extensions.pathMtu !== undefined && extensions.pathMtu < 1280))
      )
        throw new Error('Negociação ou relógio das extensões TCP inválidos.');
      if (
        flight.some(
          (item) =>
            item.sacked &&
            (!extensions?.sack ||
              !item.packet.data ||
              item.packet.flags.some((flag) => ['SYN', 'FIN', 'RST'].includes(flag)))
        )
      )
        throw new Error('Scoreboard SACK incompatível com a negociação TCP.');
      if (flow) {
        if (
          (flow.srtt === undefined) !== (flow.rttvar === undefined) ||
          (!pending && flow.flight.length) ||
          connection.bytesReceived + flow.receiveQueue.reduce((n, p) => n + tcpBytes(p.data), 0) > TCP.buffer
        )
          throw new Error('Janela/estimativa RTT TCP inválida.');
        const ranges = flow.receiveQueue
          .map((p) => ({
            start: tcpDistance(connection.receiveNext, p.sequence),
            length: tcpLength(p),
            packet: p,
          }))
          .sort((a, b) => a.start - b.start);
        if (
          ranges.some(
            (r, i) =>
              !r.length ||
              r.start === 0 ||
              r.start + r.length > TCP.buffer ||
              (i > 0 && ranges[i - 1].start + ranges[i - 1].length > r.start) ||
              r.packet.src !== connection.remoteIp ||
              r.packet.dst !== connection.localIp ||
              r.packet.sourcePort !== connection.remotePort ||
              r.packet.destinationPort !== connection.localPort
          )
        )
          throw new Error('Fila TCP fora de ordem inconsistente.');
        if (tcpFinished(connection) && (flow.flight.length || flow.receiveQueue.length))
          throw new Error('Conexão TCP finalizada com fila pendente.');
      }
      if (pending) {
        if (!exactTimer(retry, pending.deadline)) throw new Error('TCP sem timer de retransmissão válido.');
        let next = connection.sendUna;
        for (const segment of flight) {
          const packet = segment.packet;
          if (
            !tcpLength(packet) ||
            packet.src !== connection.localIp ||
            packet.dst !== connection.remoteIp ||
            packet.sourcePort !== connection.localPort ||
            packet.destinationPort !== connection.remotePort ||
            packet.sequence !== next ||
            packet.traceId !== connection.id ||
            tcpBytes(packet.data) > (connection.extensions?.local.mss ?? TCP.mss) ||
            packet.bytes > TCP.maxMss + (packet.family ? 60 : 40) + tcpOptionBytes(packet.options) ||
            (segment.sentAt !== undefined && segment.sentAt > snapshot.clock)
          )
            throw new Error('Segmento TCP pendente inconsistente.');
          next = tcpAdd(packet.sequence, tcpLength(packet));
        }
        if (next !== connection.sendNext) throw new Error('Janela de envio TCP inconsistente.');
      } else if (retry.length || connection.sendUna !== connection.sendNext)
        throw new Error('TCP sem segmento para retransmitir.');
      if (['SYN-SENT', 'SYN-RECEIVED'].includes(connection.state) && !pending?.packet.flags.includes('SYN'))
        throw new Error('Handshake TCP sem SYN pendente.');
      if (
        ['FIN-WAIT-1', 'CLOSING', 'LAST-ACK'].includes(connection.state) &&
        !pending?.packet.flags.includes('FIN')
      )
        throw new Error('Encerramento TCP sem FIN pendente.');
      if (
        ['CLOSE-WAIT', 'CLOSING', 'LAST-ACK', 'TIME-WAIT'].includes(connection.state) &&
        !connection.peerClosed
      )
        throw new Error('Estado TCP exige FIN recebido.');
      if (connection.state === 'TIME-WAIT' && pending)
        throw new Error('TIME-WAIT TCP com retransmissão pendente.');
    }
  }
  for (const { action } of snapshot.queue) {
    if (
      action.kind === 'tcp-timer' &&
      !snapshot.devices
        .find((device) => device.id === action.device)
        ?.tcpConnections?.some((connection) => connection.id === action.connection)
    )
      throw new Error('Timer TCP sem conexão.');
  }
}
