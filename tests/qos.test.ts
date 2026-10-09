import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  validateSnapshot,
  TerminalSession,
  type Frame,
} from '../packages/simulation-engine/src';
function setup(scheduler = 'priority', queueLimit = 64) {
  const e = new SimulationEngine(),
    a = e.addDevice('pc'),
    b = e.addDevice('server');
  Object.assign(a.interfaces[0], { ip: '10.0.0.1', prefix: 24 });
  Object.assign(b.interfaces[0], { ip: '10.0.0.2', prefix: 24 });
  const link = e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' }, 'copper', {
    latency: 1,
  });
  e.configureQos(a.id, 'p0', {
    enabled: true,
    rateMbps: 1,
    queueLimit,
    scheduler,
    classes: [
      { name: 'HIGH', protocol: 'icmp', priority: 7, weight: 2, mark: 46 },
      { name: 'LOW', protocol: 'tcp', priority: 1, weight: 1 },
    ],
  });
  const frame = (kind: 'icmp' | 'tcp', tag: number): Frame => ({
    src: a.interfaces[0].mac,
    dst: b.interfaces[0].mac,
    etherType: 'IPv4',
    hops: 32,
    packet:
      kind === 'icmp'
        ? {
            protocol: 'ICMP',
            kind: 'echo-request',
            src: '10.0.0.1',
            dst: '10.0.0.2',
            ttl: 64,
            probeId: 'manual-' + tag,
            bytes: 100,
          }
        : {
            protocol: 'TCP',
            src: '10.0.0.1',
            dst: '10.0.0.2',
            ttl: 64,
            sourcePort: 40000 + tag,
            destinationPort: 80,
            sequence: tag,
            acknowledgment: 0,
            window: 4096,
            flags: ['SYN'],
            data: '',
            bytes: 40,
          },
  });
  return { e, a, b, link, frame };
}
describe('QoS transmite por filas e orçamento de capacidade', () => {
  it('prioridade supera ordem de chegada, marca DSCP e produz espera por shaping', () => {
    const { e, a, frame } = setup();
    e.sendFrame(a.id, 'p0', frame('tcp', 1));
    e.sendFrame(a.id, 'p0', frame('icmp', 2));
    e.sendFrame(a.id, 'p0', frame('icmp', 3));
    expect(a.interfaces[0].qos?.queues).toHaveLength(3);
    e.advanceTo(10);
    const events = e.state.events.filter(
      (v) => v.type === 'FRAME_SENT' && v.device === a.id && v.frame?.packet
    );
    expect(events.map((v) => v.frame!.packet!.protocol)).toEqual(['ICMP', 'ICMP', 'TCP']);
    expect(events[0].frame?.packet?.dscp).toBe(46);
    expect(events[1].time - events[0].time).toBeCloseTo(0.944);
    expect(a.interfaces[0].qos?.stats.find((s) => s.name === 'HIGH')?.dequeued).toBe(2);
    validateSnapshot(e.snapshot());
  });
  it('WRR atende duas prioridades altas e uma baixa sem inanição', () => {
    const { e, a, frame } = setup('wrr');
    for (let n = 0; n < 3; n++) {
      e.sendFrame(a.id, 'p0', frame('icmp', n));
      e.sendFrame(a.id, 'p0', frame('tcp', n));
    }
    e.advanceTo(10);
    expect(
      e.state.events
        .filter((v) => v.type === 'FRAME_SENT' && v.device === a.id && v.frame?.packet)
        .map((v) => v.frame!.packet!.protocol)
    ).toEqual(['ICMP', 'ICMP', 'TCP', 'ICMP', 'TCP', 'TCP']);
  });
  it('tail drop e policer descartam frames e reposição de tokens permite novo envio', () => {
    const { e, a, frame } = setup('priority', 2);
    for (let n = 0; n < 4; n++) e.sendFrame(a.id, 'p0', frame('icmp', n));
    expect(a.interfaces[0].qos?.stats[0].dropped).toBe(2);
    e.advanceTo(10);
    e.configureQos(a.id, 'p0', {
      enabled: true,
      rateMbps: 1,
      queueLimit: 8,
      scheduler: 'priority',
      classes: [{ name: 'POLICE', protocol: 'any', priority: 1, weight: 1, policeMbps: 0.001, burst: 118 }],
    });
    e.sendFrame(a.id, 'p0', frame('icmp', 5));
    e.sendFrame(a.id, 'p0', frame('icmp', 6));
    expect(a.interfaces[0].qos?.stats[0].dropped).toBe(1);
    e.advanceTo(1010);
    e.sendFrame(a.id, 'p0', frame('icmp', 7));
    e.advanceTo(1020);
    expect(a.interfaces[0].qos?.stats[0].dequeued).toBe(2);
    validateSnapshot(e.snapshot());
  });
  it('restaura filas e temporização, rejeita frame/timer adulterado e remove cabo sem órfãos', () => {
    const { e, a, frame, link } = setup();
    e.sendFrame(a.id, 'p0', frame('icmp', 1));
    e.sendFrame(a.id, 'p0', frame('tcp', 2));
    const pending = e.snapshot(),
      restored = new SimulationEngine(pending);
    e.advanceTo(10);
    restored.advanceTo(10);
    expect(restored.snapshot()).toEqual(e.snapshot());
    const bad = structuredClone(pending);
    bad.queue = bad.queue.filter((q) => q.action.kind !== 'qos-tick');
    expect(() => validateSnapshot(bad)).toThrow(/Timer QoS/);
    e.sendFrame(a.id, 'p0', frame('icmp', 3));
    e.removeLink(link.id);
    e.advanceTo(20);
    validateSnapshot(e.snapshot());
  });
  it('CLI modifica a fila e reverte taxa impossível', () => {
    const { e, a } = setup();
    const cli = new TerminalSession(e, a.id);
    cli.execute('enable');
    cli.execute('configure terminal');
    cli.execute('interface Eth0');
    expect(
      cli.execute(
        'qos configure ' +
          JSON.stringify({ enabled: true, rateMbps: 2, queueLimit: 8, scheduler: 'wrr', classes: [] })
      )
    ).not.toMatch(/^%/);
    expect(cli.execute('show qos')).toContain('2 Mbps wrr');
    const before = e.snapshot();
    expect(
      cli.execute(
        'qos configure ' +
          JSON.stringify({ enabled: true, rateMbps: 2000, queueLimit: 8, scheduler: 'wrr', classes: [] })
      )
    ).toMatch(/^%/);
    expect(e.snapshot()).toEqual(before);
  });
});
