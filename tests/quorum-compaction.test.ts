import { describe, expect, it } from 'vitest';
import { Cluster } from './fixtures/quorum';
import {
  compactQuorum,
  proposeQuorum,
  quorumBase,
  quorumLastIndex,
  quorumDataAt,
  quorumCommittedView,
  receiveQuorum,
  tickQuorum,
  validateQuorumState,
  type QuorumMessage,
} from '../packages/simulation-engine/src/protocols/quorum';
import { quorumDataHash } from '../packages/simulation-engine/src/protocols/quorum-data';

function setup(count = 220) {
  const c = new Cluster();
  c.advance(1500);
  const leader = c.leader().self,
    lag = Object.keys(c.nodes).find((id) => id !== leader)!;
  c.stopped.add(lag);
  for (let i = 0; i < count; i++) {
    c.put(leader, 'key' + (i % 20), '☃🚀ç'.repeat(80) + i);
    c.deliver();
  }
  return { c, leader, lag };
}
function one(c: Cluster, change: (message: QuorumMessage) => QuorumMessage = (m) => m) {
  const original = c.messages.shift()!;
  if (
    !c.stopped.has(original.from) &&
    !c.stopped.has(original.to) &&
    !c.blocked.has(original.from + ':' + original.to)
  )
    c.accept(receiveQuorum(c.nodes[original.to], change(original), c.now));
  return original;
}
function startTransfer(c: Cluster, leader: string, lag: string) {
  c.stopped.delete(lag);
  c.now += 100;
  c.accept(tickQuorum(c.nodes[leader], c.now));
}

describe('Quorum checkpoint compaction and installation', () => {
  it('discards a partial transfer on local election and rejects chunks from the old term', () => {
    const { c, leader, lag } = setup();
    startTransfer(c, leader, lag);
    let chunk: QuorumMessage | undefined;
    for (let n = 0; !c.nodes[lag].receiving && n < 3000 && c.messages.length; n++) {
      const message = one(c);
      if (message.kind === 'snapshot' && message.to === lag) chunk = message;
    }
    expect(c.nodes[lag].receiving).toBeDefined();
    const before = quorumCommittedView(c.nodes[lag]),
      next = tickQuorum(c.nodes[lag], c.nodes[lag].electionAt);
    expect(next.state.role).toBe('candidate');
    expect(next.state.receiving).toBeUndefined();
    expect(quorumCommittedView(next.state)).toEqual(before);
    const stale = receiveQuorum(next.state, chunk, next.state.now);
    expect(stale.state.role).toBe('candidate');
    expect(stale.state.receiving).toBeUndefined();
    expect(stale.messages).toContainEqual(
      expect.objectContaining({ kind: 'snapshotted', term: next.state.term, offset: 0, installed: false })
    );
    validateQuorumState(stale.state);
  });

  it('catches up when a follower manually compacts beyond the last acknowledged index', () => {
    const c = new Cluster();
    c.advance(1500);
    const leader = c.leader().self,
      peer = Object.keys(c.nodes).find((id) => id !== leader)!;
    c.put(leader, 'value', 'before');
    c.deliver();
    c.blocked.add(peer + ':' + leader);
    c.put(leader, 'value', 'after');
    c.deliver();
    c.nodes[peer] = compactQuorum(c.nodes[peer]);
    expect(quorumBase(c.nodes[peer])).toBeGreaterThan(c.nodes[leader].match[peer]);
    c.blocked.clear();
    c.advance(400);
    c.put(leader, 'value', 'continued');
    c.deliver();
    expect(quorumCommittedView(c.nodes[peer]).value).toBe('continued');
  });

  it('converges across repeated elections, mixed checkpoint positions, duplication and lost messages', () => {
    for (let seed = 1; seed <= 3; seed++) {
      const c = new Cluster();
      c.advance(1500);
      for (let round = 0; round < 4; round++) {
        const old = c.leader().self;
        for (let i = 0; i < 80; i++) {
          c.put(old, 'counter', seed + ':' + round + ':' + i);
          c.deliver(round % 2 === 0, true);
        }
        c.partition(old);
        c.put(old, 'counter', 'orphan');
        c.deliver();
        c.advance(1600, true, true);
        const next = c.leader(old).self;
        for (let i = 0; i < 20; i++) {
          c.put(next, 'counter', seed + ':' + round + ':majority-' + i);
          c.deliver(true, true);
        }
        c.nodes[next] = compactQuorum(c.nodes[next]);
        c.blocked.clear();
        c.messages = c.messages.filter((_, i) => i % 3 !== 0);
        c.advance(1200, true, true);
        const expected = seed + ':' + round + ':majority-19';
        for (const a of Object.values(c.nodes)) {
          expect(quorumCommittedView(a).counter).toBe(expected);
          validateQuorumState(a);
          for (const b of Object.values(c.nodes)) {
            const common = Math.min(a.commit, b.commit);
            if (common >= Math.max(quorumBase(a), quorumBase(b)))
              expect(quorumDataAt(a, common)).toEqual(quorumDataAt(b, common));
          }
        }
      }
    }
  });

  it('compacts only confirmed prefixes, preserves an unconfirmed suffix and never mutates caller state', () => {
    const { c, leader } = setup(100);
    c.partition(leader);
    c.put(leader, 'orphan', 'not committed');
    const before = structuredClone(c.nodes[leader]),
      compacted = compactQuorum(before);
    expect(c.nodes[leader]).toEqual(before);
    expect(compacted.snapshot!.index).toBe(before.commit);
    expect(compacted.log).toEqual(before.log.slice(before.commit));
    expect(quorumLastIndex(compacted)).toBe(quorumLastIndex(before));
    expect(quorumCommittedView(compacted)).toEqual(quorumCommittedView(before));
    expect(quorumCommittedView(compacted).orphan).toBeUndefined();
    expect(() => compactQuorum(before, quorumLastIndex(before))).toThrow('committed');
    expect(() => compactQuorum(compacted, quorumBase(compacted))).toThrow('committed');
  });

  it('installs UTF-8 state atomically, rejects corrupted chunks, tolerates duplicates and retries', () => {
    const { c, leader, lag } = setup();
    const old = structuredClone(c.nodes[lag]);
    startTransfer(c, leader, lag);
    let corrupted = false,
      duplicated = false,
      partial = 0;
    for (let n = 0; c.messages.length && n < 3000; n++) {
      const m = c.messages[0];
      one(c, (msg) => {
        if (msg.kind === 'snapshot' && msg.to === lag && msg.done && !corrupted) {
          corrupted = true;
          return { ...msg, dataHex: '00' + msg.dataHex.slice(2) };
        }
        return msg;
      });
      if (m.kind === 'snapshot' && m.to === lag && !m.done) {
        partial++;
        expect(c.nodes[lag].snapshot).toBeUndefined();
        expect(c.nodes[lag].commit).toBe(old.commit);
        expect(quorumCommittedView(c.nodes[lag])).toEqual(quorumCommittedView(old));
        if (!duplicated) {
          duplicated = true;
          c.accept(receiveQuorum(c.nodes[lag], m, c.now));
        }
      }
    }
    expect(corrupted).toBe(true);
    expect(partial).toBeGreaterThan(1);
    expect(c.nodes[lag].receiving).toBeUndefined();
    expect(c.nodes[lag].snapshot).toBeUndefined();
    c.advance(1000, true, true);
    expect(quorumCommittedView(c.nodes[lag])).toEqual(quorumCommittedView(c.nodes[leader]));
    expect(c.nodes[lag].snapshot!.index).toBeGreaterThan(0);
    expect(c.nodes[lag].sending).toEqual({});
  });

  it('keeps a matching retained suffix and ignores an obsolete checkpoint after later commits', () => {
    const { c, leader, lag } = setup(100);
    const source = c.nodes[leader],
      follower = c.nodes[lag];
    follower.log = structuredClone(source.log);
    follower.commit = 1;
    c.nodes[leader] = compactQuorum(source, 70);
    c.nodes[leader].next[lag] = 1;
    c.nodes[leader].match[lag] = 0;
    startTransfer(c, leader, lag);
    let installed = false,
      oldChunk: QuorumMessage | undefined;
    for (let n = 0; c.messages.length && n < 3000; n++) {
      const m = one(c);
      if (m.kind === 'snapshot' && m.to === lag) oldChunk ??= m;
      if (c.nodes[lag].snapshot) {
        installed = true;
        expect(c.nodes[lag].commit).toBe(70);
        expect(c.nodes[lag].log).toEqual(source.log.slice(70));
        break;
      }
    }
    expect(installed).toBe(true);
    c.deliver();
    expect(c.nodes[lag].commit).toBe(source.commit);
    const before = quorumDataAt(c.nodes[lag]);
    c.accept(receiveQuorum(c.nodes[lag], oldChunk, c.now));
    expect(quorumDataAt(c.nodes[lag])).toEqual(before);
    expect(c.nodes[lag].commit).toBe(source.commit);
  });

  it('restores both ends of an interrupted transfer and queued messages deterministically', () => {
    const { c, leader, lag } = setup();
    startTransfer(c, leader, lag);
    for (let n = 0; !c.nodes[lag].receiving && n < 3000 && c.messages.length; n++) one(c);
    expect(c.nodes[lag].receiving).toBeDefined();
    const copy = new Cluster();
    copy.nodes = JSON.parse(JSON.stringify(c.nodes));
    copy.messages = JSON.parse(JSON.stringify(c.messages));
    copy.now = c.now;
    for (const cluster of [c, copy]) {
      cluster.deliver(true, true);
      cluster.advance(1000);
    }
    expect(copy.nodes).toEqual(c.nodes);
    expect(copy.messages).toEqual(c.messages);
    expect(quorumCommittedView(c.nodes[lag])).toEqual(quorumCommittedView(c.nodes[leader]));
  });

  it('reconciles a formerly isolated leader after the majority advances beyond its retained history', () => {
    const c = new Cluster();
    c.advance(1500);
    const old = c.leader().self;
    for (let i = 0; i < 220; i++) {
      c.put(old, 'value', String(i));
      c.deliver();
    }
    c.partition(old);
    c.put(old, 'value', 'unconfirmed old leader');
    c.deliver();
    const barrier = proposeQuorum(c.nodes[old], { kind: 'barrier' });
    c.accept(barrier);
    c.deliver();
    c.advance(2000);
    const replacement = c.leader(old).self;
    for (let i = 0; i < 300; i++) {
      c.put(replacement, 'value', 'majority-' + i);
      c.deliver();
    }
    expect(c.nodes[old].commit).toBeLessThan(barrier.index);
    c.blocked.clear();
    c.advance(2000, true, true);
    for (const node of Object.values(c.nodes)) {
      expect(quorumCommittedView(node).value).toBe('majority-299');
      validateQuorumState(node);
    }
    expect(c.nodes[old].role).toBe('follower');
  });

  it('enforces data and digest limits without silently dropping existing confirmed values', () => {
    const c = new Cluster();
    c.advance(1500);
    const leader = c.leader().self;
    let blocked = false;
    for (let i = 0; i < 150; i++) {
      const before = quorumCommittedView(c.nodes[leader]);
      try {
        c.put(leader, 'large' + i, 'x'.repeat(4096));
        c.deliver();
      } catch (error) {
        expect(String(error)).toContain('512 KiB');
        expect(quorumCommittedView(c.nodes[leader])).toEqual(before);
        blocked = true;
        break;
      }
    }
    expect(blocked).toBe(true);
    const compacted = compactQuorum(c.nodes[leader]);
    expect(() =>
      validateQuorumState({ ...compacted, snapshot: { ...compacted.snapshot!, hash: '0'.repeat(64) } })
    ).toThrow();
    const bad = structuredClone(compacted);
    bad.snapshot!.data.sql = false;
    bad.snapshot!.data.tables = [{ name: 'forged', columns: ['id'], rows: [] }];
    bad.snapshot!.hash = quorumDataHash(bad.snapshot!.data);
    expect(() => validateQuorumState(bad)).toThrow();
    const legacy = JSON.parse(JSON.stringify(c.nodes[leader]));
    delete legacy.sending;
    expect(validateQuorumState(legacy).sending).toEqual({});
  });
});
