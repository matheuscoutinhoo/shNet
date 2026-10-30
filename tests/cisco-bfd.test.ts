import { it, expect } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  validateSnapshot,
  exportPcap,
  decodePcap,
} from '../packages/simulation-engine/src';
import { encodeBfd, decodeBfd } from '../packages/simulation-engine/src/wire/bfd-codec';
it('BFD wire control packets preserve discriminators and microsecond timers', () => {
  const m = { state: 'Up' as const, my: 7, your: 9, desiredTx: 50000, requiredRx: 50000, multiplier: 3 },
    b = encodeBfd(m);
  expect(b).toHaveLength(24);
  expect(decodeBfd(b)).toEqual(m);
  b[3] = 23;
  expect(() => decodeBfd(b)).toThrow();
});
it('native BFD removes an OSPF adjacency before its dead timer and recovers over real packets', () => {
  const e = new SimulationEngine(),
    a = e.addProfile('router'),
    b = e.addProfile('router');
  e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
  e.state.capture = { frames: [], dropped: 0, includeControl: true, startedAt: 0 };
  for (const [i, d] of [a, b].entries()) {
    const t = new TerminalSession(e, d.id);
    for (const c of [
      'en',
      'conf t',
      'interface Gi0/1',
      `ip address 192.0.2.${i + 1} 255.255.255.252`,
      'bfd interval 50 min_rx 50 multiplier 3',
      'ip ospf bfd',
      'ip ospf 1 area 0',
      'ip ospf network point-to-point',
      'end',
    ])
      expect(t.execute(c), c).not.toMatch(/^%/);
  }
  e.advanceTo(15000);
  expect(a.ospf?.neighbors[0].state).toBe('Full');
  expect(a.interfaces[0].bfd?.sessions[0].state).toBe('Up');
  validateSnapshot(e.snapshot());
  const before = e.state.clock;
  while (e.state.queue[0]?.at <= before + 500) {
    e.state.queue = e.state.queue.filter(
      (q) =>
        !(
          q.action.kind === 'deliver' &&
          q.action.from === b.id &&
          q.action.frame.packet?.protocol === 'UDP' &&
          q.action.frame.packet.payload.protocol === 'BFD'
        )
    );
    if (e.state.queue[0]?.at <= before + 500) e.step();
  }
  expect(a.ospf?.neighbors).toHaveLength(0);
  expect(
    e.state.events.some(
      (v) =>
        v.type === 'OSPF_NEIGHBOR_CHANGED' &&
        v.device === a.id &&
        v.reason.includes('BFD Down') &&
        v.time - before <= 200
    )
  ).toBe(true);
  validateSnapshot(e.snapshot());
  e.advanceTo(40000);
  expect(a.interfaces[0].bfd?.sessions[0].state).toBe('Up');
  expect(a.ospf?.neighbors[0].state).toBe('Full');
  const capture = exportPcap(e.snapshot());
  expect(capture.excluded).toEqual([]);
  expect(decodePcap(capture.bytes).some((p) => p.frame.transport?.bfd?.state === 'Up')).toBe(true);
  const t = new TerminalSession(e, a.id);
  for (const c of ['en', 'write memory', 'reload', '']) expect(t.execute(c), c).not.toMatch(/^%/);
  expect(e.device(a.id).interfaces[0].bfd?.sessions).toEqual([]);
  validateSnapshot(e.snapshot());
});
