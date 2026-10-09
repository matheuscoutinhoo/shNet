import { TCP, tcpAdd, tcpDistance, type TcpConnection } from './tcp-model';

export function tcpFlow(c: TcpConnection) {
  return (c.flow ??= {
    mss: TCP.mss,
    cwnd: 2 * TCP.mss,
    ssthresh: TCP.buffer,
    duplicateAcks: 0,
    rto: TCP.initialRto,
    flight: [],
    receiveQueue: [],
  });
}
export function sampleTcpRtt(c: TcpConnection, sample: number) {
  const f = tcpFlow(c);
  if (f.srtt === undefined) {
    f.srtt = sample;
    f.rttvar = sample / 2;
  } else {
    f.rttvar = 0.75 * (f.rttvar ?? 0) + 0.25 * Math.abs(f.srtt - sample);
    f.srtt = 0.875 * f.srtt + 0.125 * sample;
  }
  f.rto = Math.min(60000, Math.max(1000, Math.ceil(f.srtt + Math.max(1, 4 * f.rttvar!))));
}
export function growTcpWindow(c: TcpConnection, acknowledged: number) {
  const f = tcpFlow(c);
  f.duplicateAcks = 0;
  if (f.recovery !== undefined) {
    f.cwnd = f.ssthresh;
    if (tcpDistance(f.recovery, c.sendUna) < 0x80000000) delete f.recovery;
    return;
  }
  f.cwnd = Math.min(
    TCP.buffer,
    f.cwnd + (f.cwnd < f.ssthresh ? Math.min(acknowledged, f.mss) : (f.mss * acknowledged) / f.cwnd)
  );
}
export function reduceTcpWindow(c: TcpConnection, timeout: boolean) {
  const f = tcpFlow(c),
    inFlight = tcpDistance(c.sendUna, c.sendNext);
  f.ssthresh = Math.min(TCP.buffer, Math.max(2 * f.mss, Math.floor(inFlight / 2)));
  f.cwnd = timeout ? f.mss : Math.min(TCP.buffer, f.ssthresh + 3 * f.mss);
  f.duplicateAcks = 0;
  if (timeout) {
    delete f.recovery;
    f.rto = Math.min(60000, f.rto * 2);
  } else f.recovery = c.sendNext;
}
export function tcpReceiveWindow(c: TcpConnection) {
  // Out-of-order bytes occupy space inside the advertised range; they must not
  // move its right edge backwards and turn loss reports into window updates.
  return Math.max(0, TCP.buffer - c.bytesReceived);
}
export function tcpInReceiveWindow(c: TcpConnection, sequence: number, length = 0) {
  const ahead = tcpDistance(c.receiveNext, sequence),
    available = tcpReceiveWindow(c);
  return ahead < 0x80000000 && (length ? ahead + length <= available : ahead < Math.max(1, available));
}
export const tcpFinAcknowledged = (c: TcpConnection, ack: number) =>
  !!c.pending?.packet.flags.includes('FIN') && ack === tcpAdd(c.pending.packet.sequence, 1);
