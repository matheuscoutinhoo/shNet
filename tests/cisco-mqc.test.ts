import { it, expect } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  validateSnapshot,
  type Frame,
} from '../packages/simulation-engine/src';
it('native MQC classifies DSCP, prioritizes voice, shapes and survives startup replay', () => {
  const e = new SimulationEngine(),
    a = e.addProfile('router'),
    b = e.addDevice('server'),
    t = new TerminalSession(e, a.id);
  e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
  const lines = [
    'en',
    'conf t',
    'class-map match-any VOICE',
    'match ip dscp ef cs5',
    'exit',
    'policy-map WAN-QOS',
    'class VOICE',
    'priority percent 30',
    'set dscp af41',
    'exit',
    'class class-default',
    'bandwidth remaining percent 70',
    'queue-limit 16',
    'exit',
    'exit',
    'policy-map WAN-PARENT',
    'class class-default',
    'shape average 1000000',
    'service-policy WAN-QOS',
    'exit',
    'exit',
    'interface Gi0/1',
    'service-policy output WAN-PARENT',
    'end',
  ];
  for (const c of lines) expect(t.execute(c), c).not.toMatch(/^%/);
  const frame = (dscp: number, id: string): Frame => ({
    src: a.interfaces[0].mac,
    dst: b.interfaces[0].mac,
    etherType: 'IPv4',
    hops: 10,
    packet: {
      protocol: 'ICMP',
      kind: 'echo-request',
      src: '192.0.2.1',
      dst: '192.0.2.2',
      ttl: 64,
      dscp,
      probeId: id,
      bytes: 100,
    },
  });
  e.sendFrame(a.id, 'p0', frame(0, 'low-1'));
  e.sendFrame(a.id, 'p0', frame(0, 'low-2'));
  e.sendFrame(a.id, 'p0', frame(46, 'voice'));
  e.advanceTo(10);
  const sent = e.state.events.filter(
    (v) => v.device === a.id && v.type === 'FRAME_SENT' && v.frame?.packet?.protocol === 'ICMP'
  );
  expect(sent[0].frame?.packet?.dscp).toBe(34);
  expect(sent[1].time - sent[0].time).toBeCloseTo(0.944);
  expect(a.interfaces[0].qos?.stats.find((s) => s.name.endsWith('__VOICE'))?.dequeued).toBe(1);
  validateSnapshot(e.snapshot());
  expect(t.execute('write memory')).toContain('[OK]');
  expect(t.execute('reload')).not.toMatch(/^%/);
  expect(t.execute('')).toBe('Reload complete.');
  expect(e.device(a.id).interfaces[0].qos?.scheduler).toBe('llq-cbwfq');
  expect(e.device(a.id).mqc?.attachments[0].policy).toBe('WAN-PARENT');
  validateSnapshot(e.snapshot());
});
