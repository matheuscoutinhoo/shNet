import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  validateSnapshot,
  exportPcap,
  decodePcap,
} from '../packages/simulation-engine/src';
import { encodeEthernet, decodeEthernet } from '../packages/simulation-engine/src/wire/ethernet-codec';

function configure(cli: TerminalSession, commands: string[]) {
  for (const command of commands) expect(cli.execute(command), command).not.toMatch(/^%/);
}
function network() {
  const e = new SimulationEngine(),
    a = e.addProfile('switch-l2'),
    b = e.addProfile('switch-l2'),
    c = e.addProfile('switch-l2');
  e.state.capture = { frames: [], dropped: 0, includeControl: true, startedAt: 0, bytes: 0 };
  a.hostname = 'ACCESS';
  b.hostname = 'DIST';
  c.hostname = 'CORE';
  const ab = e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
  e.connect({ device: b.id, port: 'p1' }, { device: c.id, port: 'p0' });
  const terminals = [a, b, c].map((d) => new TerminalSession(e, d.id));
  for (const cli of terminals) configure(cli, ['en', 'conf t', 'cdp run', 'lldp run', 'end']);
  return { e, a, b, c, ab, terminals };
}
describe('CDP and LLDP advertisements', () => {
  it('learns only from received one-hop frames and expires neighbors after loss', () => {
    const {
      e,
      a,
      b,
      ab,
      terminals: [cli],
    } = network();
    e.advanceTo(100);
    expect(a.discovery!.neighbors).toHaveLength(2);
    expect(a.discovery!.neighbors.every((n) => n.deviceId === 'DIST' && n.port === 'p0')).toBe(true);
    expect(cli.execute('show cdp neighbors detail')).toContain('Device ID: DIST');
    expect(cli.execute('show lldp neighbors')).not.toContain('CORE');
    expect(b.discovery!.neighbors).toHaveLength(4);
    ab.loss = 1;
    e.advanceTo(121000);
    expect(a.discovery!.neighbors.map((n) => n.protocol)).toEqual(['CDP']);
    e.advanceTo(181000);
    expect(a.discovery!.neighbors).toEqual([]);
    expect(cli.execute('show cdp neighbors')).toContain('No CDP neighbors');
    validateSnapshot(e.snapshot());
  });
  it('honors per-port receive/transmit and LLDP shutdown advertisements', () => {
    const {
      e,
      a,
      b,
      terminals: [acli, bcli],
    } = network();
    configure(acli, ['conf t', 'interface Gi0/1', 'no lldp receive', 'end']);
    e.advanceTo(100);
    expect(a.discovery!.neighbors.map((n) => n.protocol)).toEqual(['CDP']);
    expect(b.discovery!.neighbors.some((n) => n.deviceId === 'ACCESS' && n.protocol === 'LLDP')).toBe(true);
    configure(acli, ['conf t', 'no lldp run', 'end']);
    e.advanceTo(200);
    expect(b.discovery!.neighbors.some((n) => n.deviceId === 'ACCESS' && n.protocol === 'LLDP')).toBe(false);
    configure(bcli, ['conf t', 'interface Gi0/1', 'no cdp enable', 'end']);
    e.advanceTo(181000);
    expect(a.discovery!.neighbors).toEqual([]);
    validateSnapshot(e.snapshot());
  });
  it('persists configuration and timers without retaining neighbor caches through reload', () => {
    const {
      e,
      a,
      terminals: [cli],
    } = network();
    e.advanceTo(100);
    configure(cli, [
      'conf t',
      'cdp timer 10',
      'cdp holdtime 30',
      'interface Gi0/2',
      'no lldp transmit',
      'end',
      'write memory',
    ]);
    const restored = new SimulationEngine(e.snapshot()),
      rcli = new TerminalSession(restored, a.id);
    configure(rcli, ['en', 'reload', '']);
    expect(restored.device(a.id).discovery!.neighbors).toEqual([]);
    expect(restored.device(a.id).discovery!.cdpTimer).toBe(10);
    expect(restored.device(a.id).interfaces[1].lldpTransmit).toBe(false);
    restored.advanceTo(200);
    validateSnapshot(restored.snapshot());
    const invalid = restored.snapshot();
    invalid.queue = invalid.queue.filter((q) => q.action.kind !== 'discovery-tick');
    expect(() => validateSnapshot(invalid)).toThrow(/Discovery timer/);
  });
  it('exports CDP LLC/SNAP and LLDP TLVs as binary Ethernet and rejects corrupt packets', () => {
    const { e } = network();
    e.advanceTo(100);
    const frames = e.state.events
      .filter((event) => event.type === 'FRAME_SENT' && event.frame?.discovery)
      .map((event) => event.frame!);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      const bytes = encodeEthernet(frame),
        decoded = decodeEthernet(bytes);
      expect(decoded.discovery).toMatchObject({
        protocol: frame.discovery!.protocol,
        ttl: frame.discovery!.ttl,
        deviceId: frame.discovery!.deviceId,
        portId: frame.discovery!.portId,
      });
      if (frame.etherType === 'CDP') {
        bytes[24] ^= 1;
        expect(() => decodeEthernet(bytes)).toThrow();
      } else {
        bytes[14] = 0;
        expect(() => decodeEthernet(bytes)).toThrow();
      }
    }
    const exported = exportPcap(e.snapshot());
    const decoded = decodePcap(exported.bytes);
    expect(decoded.some((record) => record.frame.discovery?.protocol === 'LLDP')).toBe(true);
    expect(decoded.some((record) => record.frame.discovery?.protocol === 'CDP')).toBe(true);
    const discoveryEvents = new Set(
      e.state.events.filter((event) => event.frame?.discovery).map((event) => event.id)
    );
    expect(exported.excluded.filter((x) => discoveryEvents.has(x.event))).toEqual([]);
  });
});
