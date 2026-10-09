import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  TCP,
  tcpBytes,
  validateSnapshot,
  type TcpPacket,
} from '../packages/simulation-engine/src';

function network(latency = 5) {
  const e = new SimulationEngine(),
    pc = e.addDevice('pc'),
    srv = e.addDevice('server');
  Object.assign(pc.interfaces[0], { ip: '10.0.0.10', prefix: 24 });
  Object.assign(srv.interfaces[0], { ip: '10.0.0.20', prefix: 24 });
  const link = e.connect({ device: pc.id, port: 'p0' }, { device: srv.id, port: 'p0' });
  link.latency = latency;
  e.configureTcpService(srv.id, { enabled: true, kind: 'echo', port: 7 });
  e.openTcp(pc.id, '10.0.0.20', 7);
  e.advanceTo(5000);
  return { e, pc, srv, link, c: pc.tcpConnections![0], s: srv.tcpConnections![0] };
}
function until(e: SimulationEngine, ready: () => boolean) {
  for (let i = 0; i < 1500 && !ready(); i++) {
    expect(e.step()).toBe(true);
    validateSnapshot(e.snapshot());
  }
  expect(ready()).toBe(true);
}
function drop(e: SimulationEngine, from: string, predicate: (p: TcpPacket) => boolean) {
  const at = e.state.queue.findIndex(
    ({ action: a }) =>
      a.kind === 'deliver' &&
      a.from === from &&
      a.frame.packet?.protocol === 'TCP' &&
      predicate(a.frame.packet)
  );
  expect(at).toBeGreaterThanOrEqual(0);
  e.state.queue.splice(at, 1);
}

describe('janela TCP, congestionamento e RTO', () => {
  it('transmite vários segmentos antes do ACK e reconstrói reordenação persistida', () => {
    const { e, pc, c, s } = network(),
      text = 'rede-🌐-'.repeat(270);
    e.writeTcp(pc.id, c.id, text);
    expect(c.flow!.flight.length).toBeGreaterThan(0);
    expect((c.sendNext - c.sendUna) >>> 0).toBeLessThanOrEqual(Math.floor(c.flow!.cwnd));
    // Later data arrives first while the first segment remains in transit.
    const packets = e.state.queue.filter(
      ({ action: a }) =>
        a.kind === 'deliver' &&
        a.from === pc.id &&
        a.frame.packet?.protocol === 'TCP' &&
        !!a.frame.packet.data
    );
    const first = packets.find(
      ({ action: a }) =>
        a.kind === 'deliver' &&
        a.frame.packet?.protocol === 'TCP' &&
        a.frame.packet.sequence === c.pending!.packet.sequence
    )!;
    first.at += 100;
    e.state.queue.sort((a, b) => a.at - b.at || a.order - b.order);
    until(e, () => s.flow!.receiveQueue.length > 0);
    expect(s.received).toBe('');
    const resumed = new SimulationEngine(e.snapshot());
    e.advanceTo(8000);
    resumed.advanceTo(8000);
    expect(e.snapshot()).toEqual(resumed.snapshot());
    expect(c.received).toBe(text);
    expect(s.received).toBe(text);
    expect(c.bytesReceived).toBe(tcpBytes(text));
    expect(c.flow!.cwnd).toBeGreaterThan(2 * TCP.mss);
  });
  it('três ACKs duplicados recuperam uma lacuna antes do RTO sem duplicar dados', () => {
    const { e, pc, c, s } = network();
    e.writeTcp(pc.id, c.id, 'a'.repeat(4500));
    e.advanceTo(6000);
    expect(c.flow!.cwnd).toBeGreaterThan(4 * TCP.mss);
    const start = e.state.clock,
      sequence = c.sendNext,
      text = 'b'.repeat(5000);
    e.writeTcp(pc.id, c.id, text);
    drop(e, pc.id, (p) => p.sequence === sequence && !!p.data);
    until(e, () => c.retransmissions > 0);
    expect(e.state.clock - start).toBeLessThan(1000);
    expect(
      e.state.events.some((v) => v.type === 'TCP_RETRANSMIT' && v.reason.includes('fast retransmit'))
    ).toBe(true);
    expect(c.flow!.ssthresh).toBeLessThan(TCP.buffer);
    const resumed = new SimulationEngine(e.snapshot());
    e.advanceTo(9000);
    resumed.advanceTo(9000);
    expect(resumed.snapshot()).toEqual(e.snapshot());
    expect(s.received).toBe('a'.repeat(4500) + text);
    expect(c.received).toBe(s.received);
    expect(c.flow!.recovery).toBeUndefined();
  });
  it('estima RTT/variância e aplica Karn, backoff e slow start em timeout', () => {
    const { e, pc, c, link } = network(100);
    expect(c.flow!.srtt).toBeGreaterThanOrEqual(200);
    link.latency = 450;
    e.writeTcp(pc.id, c.id, 'amostra');
    e.advanceTo(8000);
    expect(c.flow!.rto).toBeGreaterThan(1000);
    const sample = c.flow!.srtt,
      initialRto = c.flow!.rto,
      start = e.state.clock;
    e.writeTcp(pc.id, c.id, 'perdido');
    drop(e, pc.id, (p) => p.data === 'perdido');
    until(e, () => c.retransmissions > 0);
    expect(e.state.clock - start).toBeCloseTo(initialRto, 3);
    expect(c.flow!.cwnd).toBe(TCP.mss);
    expect(c.flow!.rto).toBe(initialRto * 2);
    e.advanceTo(14000);
    expect(c.received).toBe('amostraperdido');
    expect(c.flow!.srtt).toBe(sample);
    validateSnapshot(e.snapshot());
  });
  it('rejeita snapshots com sobreposição de segmentos em voo e fila além da janela', () => {
    const { e, pc, c } = network();
    e.writeTcp(pc.id, c.id, 'x'.repeat(2000));
    const bad = e.snapshot();
    bad.devices[0].tcpConnections![0].flow!.flight[0].packet.sequence--;
    expect(() => validateSnapshot(bad)).toThrow('pendente inconsistente');
    const invalid = e.snapshot(),
      receiver = invalid.devices[1].tcpConnections![0];
    receiver.flow!.receiveQueue.push({
      ...c.pending!.packet,
      sequence: (receiver.receiveNext + TCP.buffer) >>> 0,
    });
    expect(() => validateSnapshot(invalid)).toThrow('fora de ordem');
  });
});
