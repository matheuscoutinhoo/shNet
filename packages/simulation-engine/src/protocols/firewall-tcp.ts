import type { TcpFirewallSession } from './firewall-model';
import { tcpAdd, tcpDistance, tcpLength, type TcpPacket } from './tcp-model';

export function trackTcpPacket(session: TcpFirewallSession, packet: TcpPacket, outbound: boolean) {
  const syn = packet.flags.includes('SYN'),
    ack = packet.flags.includes('ACK');
  if (session.state === 'SYN-SENT' || session.state === 'SYN-RECEIVED') {
    if (outbound && syn && !ack) return packet.sequence === session.clientInitial;
    if (
      !outbound &&
      syn &&
      ack &&
      packet.acknowledgment === session.clientNext &&
      (session.serverInitial === undefined || session.serverInitial === packet.sequence)
    ) {
      session.serverInitial = packet.sequence;
      session.serverNext = tcpAdd(packet.sequence, 1);
      session.state = 'SYN-RECEIVED';
      return true;
    }
    if (
      !outbound ||
      syn ||
      !ack ||
      session.serverNext === undefined ||
      packet.sequence !== session.clientNext ||
      packet.acknowledgment !== session.serverNext
    )
      return false;
    session.state = 'ESTABLISHED';
  }
  if (syn)
    return (
      !outbound &&
      ack &&
      packet.sequence === session.serverInitial &&
      packet.acknowledgment === tcpAdd(session.clientInitial, 1)
    );
  if (!ack || session.serverNext === undefined) return false;
  const next = outbound ? session.clientNext : session.serverNext;
  const peerNext = outbound ? session.serverNext : session.clientNext;
  // Track a high-water mark: a shorter segment may arrive before an earlier
  // segment when the transport uses a sliding window and links reorder traffic.
  const length = tcpLength(packet),
    end = tcpAdd(packet.sequence, length);
  const duplicate =
    packet.sequence !== next && tcpDistance(end, next) < 65536 && tcpDistance(packet.sequence, next) < 65536;
  const ahead = tcpDistance(next, packet.sequence);
  if (packet.sequence !== next && !duplicate && ahead >= 65536) return false;
  if (tcpDistance(packet.acknowledgment, peerNext) >= 65536) return false;
  if (duplicate) return true;
  if ((outbound ? session.clientFin : session.serverFin) && length) return false;
  if (tcpDistance(next, end) < 0x80000000) {
    if (outbound) session.clientNext = end;
    else session.serverNext = end;
  }
  if (packet.flags.includes('FIN')) {
    if (outbound) session.clientFin = true;
    else session.serverFin = true;
    session.state = 'CLOSING';
  }
  return true;
}
