import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  makeTemplate,
  validateSnapshot,
} from '../packages/simulation-engine/src';
import { changedSince, markState, materializeMark } from '../packages/simulation-engine/src/core/state-mark';
import { SnapshotHistory } from '../apps/web/src/workspace/snapshot-history';

function routedLab() {
  const e = new SimulationEngine(makeTemplate('ospf'));
  e.advanceTo(20000, 500000);
  return e;
}

describe('incremental CLI state handling', () => {
  it('a mark restores the exact state and records which devices and timers changed', () => {
    const e = routedLab();
    const before = e.snapshot(),
      mark = markState(e.state);
    expect(materializeMark(mark)).toEqual(before);
    const [a, b] = e.state.devices;
    a.hostname = 'CHANGED';
    e.state.queue = e.state.queue.filter((q) => !('device' in q.action && q.action.device === b.id));
    const changed = changedSince(mark, e.state)!;
    expect([...changed.devices].sort()).toEqual([a.id, b.id].sort());
    expect(changed.queue).toEqual([]);
    e.state.links[0].up = false;
    expect(changedSince(mark, e.state)).toBeUndefined();
  });

  it('validation of a scoped change still rejects a broken changed device', () => {
    const e = routedLab();
    const mark = markState(e.state),
      router = e.state.devices.find((d) => d.ospf)!;
    router.ospf!.routes = [];
    const changed = changedSince(mark, e.state)!;
    expect(changed.devices.has(router.id)).toBe(true);
    expect(() => validateSnapshot(e.state, { changed })).toThrow(/OSPF/);
    expect(() => validateSnapshot(e.state)).toThrow(/OSPF/);
  });

  it('a rejected command restores the device and leaves no undo mark', () => {
    const e = routedLab(),
      router = e.state.devices.find((d) => d.type === 'router')!;
    const t = new TerminalSession(e, router.id);
    t.execute('enable');
    t.execute('configure terminal');
    const before = e.snapshot();
    expect(t.execute('ip route 10.99.0.0 255.255.0.0 10.0.0.300')).toMatch(/^%/);
    expect(t.lastMark).toBeUndefined();
    expect(e.snapshot()).toEqual(before);
    expect(t.execute('hostname R-EDITED')).toBe('');
    expect(t.lastMark).toBeDefined();
    expect(materializeMark(t.lastMark!)).toEqual(before);
    expect(t.execute('do show version')).toContain('R-EDITED');
    expect(t.lastMark).toBeUndefined();
    validateSnapshot(e.snapshot());
  });

  it('undo history keeps terminal marks lazily and materializes them on undo', () => {
    const e = routedLab(),
      history = new SnapshotHistory(),
      before = e.snapshot(),
      mark = markState(e.state);
    let loads = 0;
    history.checkpointLazy(() => {
      loads++;
      return materializeMark(mark);
    }, mark.bytes);
    e.state.devices[0].hostname = 'AFTER';
    expect(loads).toBe(0);
    expect(history.restore('undo', e.snapshot())).toEqual(before);
    expect(loads).toBe(1);
    expect(history.restore('redo', before)?.devices[0].hostname).toBe('AFTER');
  });

  it('consecutive marks share the JSON of unchanged devices', () => {
    const e = routedLab();
    const first = e.mark();
    e.state.devices[0].hostname = 'SHARED-TEST';
    const second = e.mark();
    expect(second.devices[0]).not.toBe(first.devices[0]);
    expect(second.devices.slice(1).every((json, i) => json === first.devices[i + 1])).toBe(true);
  });
});
