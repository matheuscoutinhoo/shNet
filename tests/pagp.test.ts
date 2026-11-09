import { describe, expect, it } from 'vitest';
import { SimulationEngine, TerminalSession, validateSnapshot } from '../packages/simulation-engine/src';
import { decodeEthernet, encodeEthernet } from '../packages/simulation-engine/src/wire/ethernet-codec';

/** Two switches joined by Gi0/1-2 with channel-group 1 on both, in the given modes. */
function pair(modeA: string, modeB: string) {
  const e = new SimulationEngine(),
    a = e.addDevice('switch'),
    b = e.addDevice('switch');
  for (const i of [0, 1]) e.connect({ device: a.id, port: 'p' + i }, { device: b.id, port: 'p' + i });
  const [ta, tb] = [a, b].map((d, i) => {
    const t = new TerminalSession(e, d.id);
    for (const line of [
      'enable',
      'configure terminal',
      'hostname SW' + (i + 1),
      'interface range Gi0/1 - 2',
      'channel-group 1 mode ' + (i ? modeB : modeA),
      'end',
    ])
      expect(t.execute(line), line).not.toMatch(/^%/m);
    return t;
  });
  e.advanceTo(5000);
  return { e, a, b, ta, tb };
}

describe('PAgP EtherChannel', () => {
  it('bundles desirable with auto and desirable, never auto with auto', () => {
    for (const [x, y, bundled] of [
      ['desirable', 'auto', true],
      ['desirable', 'desirable', true],
      ['auto', 'auto', false],
    ] as const) {
      const { e, a, b, ta } = pair(x, y);
      const agg = (d: typeof a) => d.interfaces.find((p) => p.aggregate)!.aggregate!;
      expect(agg(a).selected.length, `${x}/${y}`).toBe(bundled ? 2 : 0);
      expect(agg(b).selected.length, `${x}/${y}`).toBe(bundled ? 2 : 0);
      const summary = ta.execute('show etherchannel summary');
      expect(summary).toMatch(
        bundled
          ? /^1\s+Po1\(SU\)\s+PAgP\s+Gi0\/1\(P\)\s+Gi0\/2\(P\)$/m
          : /^1\s+Po1\(SD\)\s+PAgP\s+Gi0\/1\(I\)\s+Gi0\/2\(I\)$/m
      );
      if (bundled) {
        const neighbors = ta.execute('show pagp neighbor');
        expect(neighbors).toContain('Channel group 1 neighbors');
        expect(neighbors).toMatch(/^Gi0\/1 +SW2 +[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4} +Gi0\/1 +\d+s S/m);
        expect(ta.execute('show running-config')).toContain(' channel-group 1 mode ' + x);
      }
      validateSnapshot(e.snapshot());
    }
  });

  it('does not negotiate PAgP with LACP and rejects mixing protocols in one group', () => {
    const { e, a, ta } = pair('desirable', 'active');
    expect(a.interfaces.find((p) => p.aggregate)!.aggregate!.selected).toEqual([]);
    expect(e.state.events.some((v) => /LACP PDU on .*the group runs PAgP/.test(v.reason))).toBe(true);
    ta.execute('configure terminal');
    ta.execute('interface Gi0/3');
    expect(ta.execute('channel-group 1 mode active')).toBe(
      '% Command rejected (Po1, Gi0/3): Invalid etherchnl mode'
    );
  });

  it('encodes PAgP as an LLC/SNAP frame to 01:00:0c:cc:cc:cc', () => {
    const { e } = pair('desirable', 'auto');
    const frame = e.state.events.map((v) => v.frame).find((f) => f?.lacp?.pagp)!;
    expect(frame.dst).toBe('01:00:0c:cc:cc:cc');
    const decoded = decodeEthernet(encodeEthernet(frame));
    expect(decoded.etherType).toBe(50);
    expect(decoded.pagp?.device).toBe(frame.lacp!.actor.system);
    expect(decoded.pagp?.autoMode).toBe(!frame.lacp!.active);
  });
});
