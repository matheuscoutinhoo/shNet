import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  configurationDiff,
  quorumCommittedView,
  validateSnapshot,
} from '../packages/simulation-engine/src';
import { cloneTopology } from '../apps/web/src/workspace/cloneTopology';
import { duplicateDevice } from '../apps/web/src/workspace/duplicateDevice';

function fixture() {
  const e = new SimulationEngine(),
    members = [e.addDevice('server'), e.addDevice('server'), e.addDevice('server')];
  for (let a = 0; a < members.length; a++)
    for (let b = a + 1; b < members.length; b++)
      e.connect(
        { device: members[a].id, port: e.installNic(members[a].id).id },
        { device: members[b].id, port: e.installNic(members[b].id).id },
        'copper',
        { latency: 5 }
      );
  e.configureQuorumLab(members.map((d) => d.id));
  return { e, members };
}
const leader = (e: SimulationEngine, except?: string) =>
  e.state.devices.find((d) => d.power && d.id !== except && d.quorum?.node.role === 'leader')!;

describe('quorum on physical simulated links', () => {
  it('elects and replicates using cable deliveries; physical partition does not confirm an isolated write', () => {
    const { e } = fixture();
    e.advanceTo(2000);
    const old = leader(e),
      before = e.snapshot();
    const committed = e.proposeQuorumLab(old.id, { kind: 'put', key: 'dns', value: 'one' });
    expect(old.quorum!.node.commit).toBeLessThan(committed.index);
    e.advanceTo(2200);
    expect(old.quorum!.node.commit).toBe(committed.index);
    expect(configurationDiff(before, e.snapshot())).toEqual([]);
    for (const link of e.state.links.filter((l) => l.a.device === old.id || l.b.device === old.id))
      link.up = false;
    const pending = e.proposeQuorumLab(old.id, { kind: 'put', key: 'dns', value: 'orphan' });
    e.advanceTo(4500);
    expect(old.quorum!.node.commit).toBeLessThan(pending.index);
    const replacement = leader(e, old.id);
    expect(replacement).toBeDefined();
    e.proposeQuorumLab(replacement.id, { kind: 'put', key: 'dns', value: 'two' });
    e.advanceTo(4700);
    for (const link of e.state.links) link.up = true;
    e.advanceTo(6500);
    for (const d of e.state.devices) expect(quorumCommittedView(d.quorum!.node).dns).toBe('two');
    validateSnapshot(e.snapshot());
  });
  it('survives power loss, deterministic restore with in-flight traffic, and delayed old messages', () => {
    const { e } = fixture();
    e.advanceTo(2000);
    const old = leader(e);
    e.proposeQuorumLab(old.id, { kind: 'put', key: 'record', value: 'durable' });
    e.advanceTo(2016);
    const restored = new SimulationEngine(e.snapshot());
    for (const engine of [e, restored]) {
      engine.setDevicePower(old.id, false);
      engine.advanceTo(4500);
      expect(leader(engine, old.id)).toBeDefined();
      engine.setDevicePower(old.id, true);
      engine.advanceTo(6500);
      for (const d of engine.state.devices)
        expect(quorumCommittedView(d.quorum!.node).record).toBe('durable');
      validateSnapshot(engine.snapshot());
    }
    expect(restored.snapshot()).toEqual(e.snapshot());
  });
  it('models complete loss and latency without looking up a global majority', () => {
    const { e } = fixture();
    e.state.links.forEach((l) => (l.loss = 1));
    e.advanceTo(3000);
    expect(leader(e)).toBeUndefined();
    e.state.links.forEach((l) => {
      l.loss = 0;
      l.latency = 30;
    });
    e.advanceTo(6000);
    const active = leader(e);
    expect(active).toBeDefined();
    e.proposeQuorumLab(active.id, { kind: 'put', key: 'x', value: 'value' });
    e.advanceTo(6030);
    expect(quorumCommittedView(active.quorum!.node).x).toBeUndefined();
    e.advanceTo(6200);
    expect(quorumCommittedView(active.quorum!.node).x).toBe('value');
  });
  it('cleans deliveries on link deletion, and tears down the fixed group before member deletion', () => {
    const { e } = fixture();
    e.advanceTo(2000);
    const active = leader(e);
    e.proposeQuorumLab(active.id, { kind: 'put', key: 'x', value: 'v' });
    e.removeLink(e.state.links[0].id);
    validateSnapshot(e.snapshot());
    e.removeDevice(active.id);
    validateSnapshot(e.snapshot());
    expect(e.state.devices.every((d) => !d.quorum)).toBe(true);
    expect(
      e.state.queue.some((q) => q.action.kind === 'quorum-tick' || q.action.kind === 'quorum-deliver')
    ).toBe(false);
  });
  it('refuses forged commits, missing timers and concurrent reuse of a dedicated NIC', () => {
    const { e, members } = fixture();
    e.advanceTo(2000);
    const bad = e.snapshot();
    bad.devices[0].quorum!.node.commit = 257;
    expect(() => validateSnapshot(bad)).toThrow();
    const noTimer = e.snapshot();
    noTimer.queue = noTimer.queue.filter((q) => q.action.kind !== 'quorum-tick');
    expect(() => validateSnapshot(noTimer)).toThrow('timer');
    const wrongType = e.snapshot();
    wrongType.devices[0].type = 'pc';
    expect(() => validateSnapshot(wrongType)).toThrow('quorum');
    const delayed = e.snapshot();
    delayed.queue.find((q) => q.action.kind === 'quorum-tick')!.at += 5000;
    expect(() => validateSnapshot(delayed)).toThrow('intervalo');
    expect(() =>
      e.configureBond(
        members[0].id,
        1,
        Object.values(members[0].quorum!.ports),
        Object.values(members[0].quorum!.ports)[0]
      )
    ).toThrow();
  });
  it('clones a complete group with fresh identity/data; isolated duplication does not join it', () => {
    const { e, members } = fixture();
    e.advanceTo(2000);
    const active = leader(e);
    e.proposeQuorumLab(active.id, { kind: 'put', key: 'x', value: 'original' });
    e.advanceTo(2200);
    const cloned = cloneTopology(
      e.snapshot(),
      members.map((d) => d.id)
    ).snapshot;
    const copies = cloned.devices.filter((d) => !members.some((m) => m.id === d.id));
    expect(copies).toHaveLength(3);
    expect(
      copies.every(
        (d) =>
          d.quorum && d.quorum.node.cluster !== active.quorum!.node.cluster && d.quorum.node.log.length === 0
      )
    ).toBe(true);
    validateSnapshot(cloned);
    expect(duplicateDevice(e, active).device.quorum).toBeUndefined();
  });
});
