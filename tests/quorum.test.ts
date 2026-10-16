import { describe, expect, it } from 'vitest';
import {
  proposeQuorum,
  quorumCommittedView,
  receiveQuorum,
  tickQuorum,
  validateQuorumState,
  quorumLastIndex,
  type QuorumMessage,
} from '../packages/simulation-engine/src/protocols/quorum';

import { Cluster } from './fixtures/quorum';

describe('quorum message-driven replication foundation (R08)', () => {
  it('keeps committed prefixes identical under seeded partitions, loss, duplication and reordering', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const c = new Cluster();
      let rng = seed;
      const random = () => {
        rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
        return rng / 0x100000000;
      };
      let transit: { at: number; message: QuorumMessage }[] = [];
      for (let step = 0; step < 500; step++) {
        c.now += 20;
        if (step % 100 === 0) {
          c.blocked.clear();
          if (step < 400) c.partition(['a', 'b', 'c'][Math.floor(random() * 3)]);
        }
        for (const n of Object.values(c.nodes)) c.accept(tickQuorum(n, c.now));
        if (random() < 0.12) {
          const active = Object.values(c.nodes).filter((n) => n.role === 'leader' && n.log.length < 200);
          if (active.length)
            c.put(active[Math.floor(random() * active.length)].self, 'counter', `${seed}:${step}`);
        }
        const enqueue = () => {
          for (const message of c.messages.splice(0)) {
            if (random() < 0.2) continue;
            transit.push({ at: c.now + 1 + Math.floor(random() * 180), message });
            if (random() < 0.2) transit.push({ at: c.now + 200, message: structuredClone(message) });
          }
        };
        enqueue();
        const ready = transit.filter((item) => item.at <= c.now).reverse();
        transit = transit.filter((item) => item.at > c.now);
        for (const { message } of ready)
          if (!c.blocked.has(`${message.from}:${message.to}`))
            c.accept(receiveQuorum(c.nodes[message.to], message, c.now));
        enqueue();
        for (const a of Object.values(c.nodes))
          for (const b of Object.values(c.nodes)) {
            const common = Math.min(a.commit, b.commit);
            expect(a.log.slice(0, common)).toEqual(b.log.slice(0, common));
          }
      }
      c.blocked.clear();
      c.advance(30000);
      const expected = quorumCommittedView(c.leader());
      for (const n of Object.values(c.nodes)) expect(quorumCommittedView(n)).toEqual(expected);
    }
  });
  it('elects by real votes, confirms data only after a majority, and isolates caller-owned objects', () => {
    const c = new Cluster();
    c.advance(1500);
    const leader = c.leader(),
      before = structuredClone(leader);
    const index = c.put(leader.self, 'dns', '192.0.2.1');
    expect(leader).toEqual(before);
    expect(c.nodes[leader.self].commit).toBeLessThan(index);
    expect(quorumCommittedView(c.nodes[leader.self]).dns).toBeUndefined();
    c.deliver();
    for (const node of Object.values(c.nodes)) {
      expect(node.commit).toBe(index);
      expect(quorumCommittedView(node).dns).toBe('192.0.2.1');
    }
  });
  it('never confirms isolated leader writes; majority replaces its uncommitted suffix on return', () => {
    const c = new Cluster();
    c.advance(1500);
    const old = c.leader().self;
    c.put(old, 'db', 'confirmed');
    c.deliver();
    c.partition(old);
    const orphan = c.put(old, 'db', 'must-not-commit');
    c.deliver();
    c.advance(2000);
    expect(c.nodes[old].commit).toBeLessThan(orphan);
    expect(quorumCommittedView(c.nodes[old]).db).toBe('confirmed');
    const replacement = c.leader(old).self;
    c.put(replacement, 'db', 'majority');
    c.deliver();
    c.blocked.clear();
    c.advance(1500);
    for (const node of Object.values(c.nodes)) {
      expect(quorumCommittedView(node).db).toBe('majority');
      expect(node.log).toEqual(c.nodes[replacement].log);
    }
    expect(c.nodes[old].role).toBe('follower');
  });
  it('with five full replicas, two failures retain writes; three prevent confirmation', () => {
    const c = new Cluster(['a', 'b', 'c', 'd', 'e']);
    c.advance(1500);
    const leader = c.leader().self,
      others = Object.keys(c.nodes).filter((p) => p !== leader);
    others.slice(0, 2).forEach((p) => c.stopped.add(p));
    const committed = c.put(leader, 'lease', 'one');
    c.deliver();
    expect(c.nodes[leader].commit).toBe(committed);
    c.stopped.add(others[2]);
    const pending = c.put(leader, 'lease', 'two');
    c.deliver();
    c.advance(500);
    expect(c.nodes[leader].commit).toBeLessThan(pending);
    expect(quorumCommittedView(c.nodes[leader]).lease).toBe('one');
  });
  it('does not count duplicate votes/ACKs as distinct replicas', () => {
    const c = new Cluster(['a', 'b', 'c', 'd', 'e']);
    c.stopped = new Set(['c', 'd', 'e']);
    c.advance(2000, false, true);
    expect(Object.values(c.nodes).some((n) => n.role === 'leader')).toBe(false);
    c.stopped.clear();
    c.advance(2000, false, true);
    const leader = c.leader().self;
    for (const p of Object.keys(c.nodes)
      .filter((p) => p !== leader)
      .slice(0, 3))
      c.stopped.add(p);
    const index = c.put(leader, 'value', 'pending');
    c.deliver(false, true);
    expect(c.nodes[leader].commit).toBeLessThan(index);
  });
  it('preserves durable votes on restart and rejects less up-to-date candidates', () => {
    const c = new Cluster();
    c.advance(1500);
    const leader = c.leader(),
      peer = Object.values(c.nodes).find((n) => n.self !== leader.self)!;
    const vote: QuorumMessage = {
      cluster: 'lab',
      from: leader.self,
      to: peer.self,
      term: peer.term + 1,
      kind: 'vote',
      lastIndex: 0,
      lastTerm: 0,
    };
    const rejected = receiveQuorum(peer, vote, c.now);
    expect(rejected.messages[0]).toMatchObject({ kind: 'voted', granted: false });
    const candidate = { ...vote, lastIndex: peer.log.length, lastTerm: peer.log.at(-1)!.term };
    const granted = receiveQuorum(rejected.state, candidate, c.now);
    expect(granted.messages[0]).toMatchObject({ granted: true });
    const restarted = validateQuorumState(JSON.parse(JSON.stringify(granted.state)));
    const other = Object.keys(c.nodes).find((p) => p !== peer.self && p !== leader.self)!;
    expect(receiveQuorum(restarted, { ...candidate, from: other }, c.now).messages[0]).toMatchObject({
      granted: false,
    });
  });
  it('recovers deterministically from JSON including in-flight messages', () => {
    const c = new Cluster();
    c.advance(1500);
    c.put(c.leader().self, 'session', 'saved');
    const copy = new Cluster();
    copy.nodes = JSON.parse(JSON.stringify(c.nodes));
    copy.messages = JSON.parse(JSON.stringify(c.messages));
    copy.now = c.now;
    c.advance(2000);
    copy.advance(2000);
    expect(copy.nodes).toEqual(c.nodes);
    expect(copy.messages).toEqual(c.messages);
  });
  it('tolerates reordered duplicate messages, transient total loss and lagging replicas beyond one batch', () => {
    const c = new Cluster();
    c.advance(1500);
    const leader = c.leader().self,
      lag = Object.keys(c.nodes).find((p) => p !== leader)!;
    c.stopped.add(lag);
    for (let i = 0; i < 40; i++) {
      c.put(leader, 'counter', String(i));
      c.deliver(true, true);
    }
    c.stopped.clear();
    c.advance(1500, true, true);
    for (const node of Object.values(c.nodes)) expect(quorumCommittedView(node).counter).toBe('39');
    c.messages = [];
    c.advance(100);
    for (const node of Object.values(c.nodes)) validateQuorumState(node);
  });
  it('ignores foreign clusters/identities even with a higher term and rejects clock rollback', () => {
    const c = new Cluster();
    c.advance(1500);
    const before = c.nodes.a;
    const message = {
      cluster: 'other',
      from: 'b',
      to: 'a',
      term: 999,
      kind: 'vote',
      lastIndex: 100,
      lastTerm: 99,
    };
    expect(receiveQuorum(before, message, c.now).state).toEqual(before);
    expect(receiveQuorum(before, { ...message, cluster: 'lab', from: 'unknown' }, c.now).state).toEqual(
      before
    );
    expect(() => tickQuorum(before, c.now - 1)).toThrow('clock');
    expect(() => receiveQuorum(before, message, NaN)).toThrow('clock');
  });
  it('compacts confirmed history, keeps absolute indices and bounds the unconfirmed suffix', () => {
    const c = new Cluster();
    c.advance(1500);
    const leader = c.leader().self;
    for (let i = 0; i < 600; i++) {
      c.put(leader, 'key', String(i));
      c.deliver();
    }
    expect(c.nodes[leader].snapshot!.index).toBeGreaterThan(256);
    expect(quorumLastIndex(c.nodes[leader])).toBe(601);
    c.partition(leader);
    let blocked = false;
    for (let i = 0; i < 300; i++) {
      try {
        c.put(leader, 'key', 'unconfirmed');
        c.deliver();
      } catch (error) {
        expect(String(error)).toContain('capacity');
        blocked = true;
        break;
      }
    }
    expect(blocked).toBe(true);
    expect(quorumLastIndex(c.nodes[leader]) - c.nodes[leader].commit).toBe(128);
    expect(c.nodes[leader].log.length).toBeLessThanOrEqual(256);
    expect(quorumCommittedView(c.nodes[leader]).key).toBe('599');
    expect(() =>
      validateQuorumState({ ...c.nodes[leader], commit: quorumLastIndex(c.nodes[leader]) + 1 })
    ).toThrow();
    expect(() => validateQuorumState({ ...c.nodes[leader], members: ['a', 'a', 'c'] })).toThrow();
    expect(() => validateQuorumState({ ...c.nodes[leader], votes: ['outsider'] })).toThrow();
    expect(() => proposeQuorum(c.nodes[leader], { kind: 'put', key: 'bad key', value: '' })).toThrow();
  });
  it('uses a fresh barrier for a read and never treats an old committed view as authority', () => {
    const c = new Cluster();
    c.advance(1500);
    const leader = c.leader().self;
    c.put(leader, 'syslog', 'entry');
    c.deliver();
    c.partition(leader);
    const barrier = proposeQuorum(c.nodes[leader], { kind: 'barrier' });
    c.accept(barrier);
    c.deliver();
    expect(c.nodes[leader].commit).toBeLessThan(barrier.index);
    expect(quorumCommittedView(c.nodes[leader]).syslog).toBe('entry');
    c.advance(2000);
    expect(() =>
      proposeQuorum(
        Object.values(c.nodes).find((n) => n.role !== 'leader')!,
        { kind: 'barrier' }
      )
    ).toThrow('not leader');
  });
});
