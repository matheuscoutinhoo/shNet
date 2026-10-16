import { z } from 'zod';
import { canonicalScenarioJson } from '../canonical-json';
import {
  applyQuorumData,
  emptyQuorumData,
  quorumCommandSchema,
  quorumDataSchema,
  quorumDataBytes,
  quorumDataHash,
  quorumHex,
  quorumUnhex,
  quorumId,
  QUORUM_DATA_BYTES,
  QUORUM_CHUNK_BYTES,
  type QuorumData,
} from './quorum-data';

// A deterministic, message-driven Raft core. The caller owns transport and
// persistence: persist the returned state BEFORE delivering any returned message.
// No peer's power, links or storage are inspected by this state machine.
const id = quorumId;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const commandSchema = quorumCommandSchema;
const entrySchema = z.object({ term: integer, command: commandSchema }).strict();
const envelope = { cluster: id, from: id, to: id, term: integer };
const transfer = {
  index: integer.min(1),
  lastTerm: integer.min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  total: integer.min(1).max(QUORUM_DATA_BYTES),
};
const hex = z
  .string()
  .regex(/^[a-f0-9]*$/)
  .refine((value) => value.length % 2 === 0);
const checkpointSchema = z
  .object({ index: integer.min(1), term: integer.min(1), data: quorumDataSchema, hash: transfer.hash })
  .strict();
export const quorumMessageSchema = z.discriminatedUnion('kind', [
  z.object({ ...envelope, kind: z.literal('vote'), lastIndex: integer, lastTerm: integer }).strict(),
  z.object({ ...envelope, kind: z.literal('voted'), granted: z.boolean() }).strict(),
  z
    .object({
      ...envelope,
      kind: z.literal('append'),
      previous: integer,
      previousTerm: integer,
      entries: z.array(entrySchema).max(16),
      commit: integer,
    })
    .strict(),
  z.object({ ...envelope, kind: z.literal('appended'), success: z.boolean(), matched: integer }).strict(),
  z
    .object({
      ...envelope,
      ...transfer,
      kind: z.literal('snapshot'),
      offset: integer,
      dataHex: hex.max(QUORUM_CHUNK_BYTES * 2),
      done: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal('snapshotted'),
      index: integer.min(1),
      hash: transfer.hash,
      offset: integer.max(QUORUM_DATA_BYTES),
      installed: z.boolean(),
    })
    .strict(),
]);
export const quorumStateSchema = z
  .object({
    cluster: id,
    self: id,
    members: z.array(id).min(3).max(5),
    term: integer,
    votedFor: id.optional(),
    role: z.enum(['follower', 'candidate', 'leader']),
    log: z.array(entrySchema).max(256),
    snapshot: checkpointSchema.optional(),
    sending: z.record(id, z.object({ ...transfer, offset: integer }).strict()).default({}),
    receiving: z
      .object({ ...transfer, from: id, term: integer, dataHex: hex.max(QUORUM_DATA_BYTES * 2) })
      .strict()
      .optional(),
    commit: integer,
    votes: z.array(id).max(5),
    next: z.record(z.string(), integer),
    match: z.record(z.string(), integer),
    now: integer,
    electionAt: integer,
    heartbeatAt: integer,
    electionMs: z.number().int().min(300).max(10000),
    heartbeatMs: z.number().int().min(10).max(1000),
    seed: integer,
  })
  .strict();
export type QuorumState = z.infer<typeof quorumStateSchema>;
export type QuorumMessage = z.infer<typeof quorumMessageSchema>;
export type QuorumCommand = z.infer<typeof commandSchema>;
export type QuorumResult = { state: QuorumState; messages: QuorumMessage[] };
const majority = (s: QuorumState) => Math.floor(s.members.length / 2) + 1;
export const quorumBase = (s: QuorumState) => s.snapshot?.index ?? 0;
export const quorumLastIndex = (s: QuorumState) => quorumBase(s) + s.log.length;
export const quorumEntryAt = (s: QuorumState, index: number) =>
  index > quorumBase(s) ? s.log[index - quorumBase(s) - 1] : undefined;
const termAt = (s: QuorumState, index: number) =>
  index === quorumBase(s) ? (s.snapshot?.term ?? 0) : quorumEntryAt(s, index)?.term;

export function quorumDataAt(s: QuorumState, index = s.commit): QuorumData {
  if (index < quorumBase(s) || index > quorumLastIndex(s))
    throw new Error('Quorum index outside retained history');
  let data = structuredClone(s.snapshot?.data ?? emptyQuorumData());
  for (const entry of s.log.slice(0, index - quorumBase(s))) data = applyQuorumData(data, entry.command).data;
  return data;
}
export function compactQuorum(input: QuorumState, through = input.commit): QuorumState {
  const s = validateQuorumState(input),
    base = quorumBase(s);
  if (!Number.isSafeInteger(through) || through <= base || through > s.commit)
    throw new Error('Compact only a new committed prefix');
  const data = quorumDataAt(s, through);
  if (quorumDataBytes(data).length > QUORUM_DATA_BYTES)
    throw new Error('Quorum checkpoint exceeds 512 KiB; confirmed data preserved');
  const term = termAt(s, through)!;
  s.snapshot = { index: through, term, data, hash: quorumDataHash(data) };
  s.log = s.log.slice(through - base);
  s.sending = {};
  if (s.receiving && s.receiving.index <= through) delete s.receiving;
  return validateQuorumState(s);
}
function compactIfNeeded(s: QuorumState) {
  if (s.log.length < 192 || s.commit - quorumBase(s) <= 64) return s;
  const through = s.commit - 64;
  // Legacy un-compacted saves may contain a dataset above the new checkpoint
  // budget. Never change their confirmed state merely to make a snapshot fit.
  if (quorumDataBytes(quorumDataAt(s, through)).length > QUORUM_DATA_BYTES) return s;
  return compactQuorum(s, through);
}

export function validateQuorumState(input: unknown): QuorumState {
  const s = quorumStateSchema.parse(input);
  const base = quorumBase(s),
    last = quorumLastIndex(s);
  if (
    ![3, 5].includes(s.members.length) ||
    new Set(s.members).size !== s.members.length ||
    !s.members.includes(s.self) ||
    s.commit < base ||
    s.commit > last ||
    !Number.isSafeInteger(last + 1) ||
    (s.snapshot &&
      (s.snapshot.term > s.term ||
        quorumDataBytes(s.snapshot.data).length > QUORUM_DATA_BYTES ||
        quorumDataHash(s.snapshot.data) !== s.snapshot.hash)) ||
    (s.votedFor && !s.members.includes(s.votedFor)) ||
    new Set(s.votes).size !== s.votes.length ||
    s.votes.some((v) => !s.members.includes(v)) ||
    s.heartbeatMs * 3 >= s.electionMs ||
    s.electionAt < s.now ||
    s.log.some(
      (entry, i) =>
        entry.term === 0 ||
        entry.term > s.term ||
        entry.term < (i ? s.log[i - 1].term : (s.snapshot?.term ?? 0))
    )
  )
    throw new Error('Invalid quorum state');
  for (const [peer, index] of Object.entries(s.next))
    if (!s.members.includes(peer) || peer === s.self || index < 1 || index > last + 1)
      throw new Error('Invalid quorum next index');
  for (const [peer, index] of Object.entries(s.match))
    if (!s.members.includes(peer) || peer === s.self || index > last || index >= (s.next[peer] ?? 0))
      throw new Error('Invalid quorum match index');
  for (const [peer, t] of Object.entries(s.sending))
    if (
      s.role !== 'leader' ||
      !s.members.includes(peer) ||
      peer === s.self ||
      t.index !== base ||
      t.lastTerm !== s.snapshot?.term ||
      t.hash !== s.snapshot?.hash ||
      t.offset > t.total ||
      t.total !== quorumDataBytes(s.snapshot.data).length
    )
      throw new Error('Invalid outgoing quorum checkpoint');
  const r = s.receiving;
  if (
    r &&
    (!s.members.includes(r.from) ||
      r.from === s.self ||
      r.term !== s.term ||
      r.lastTerm > r.term ||
      r.dataHex.length / 2 > r.total)
  )
    throw new Error('Invalid incoming quorum checkpoint');
  if (
    s.role === 'leader' &&
    (s.votedFor !== s.self ||
      !s.votes.includes(s.self) ||
      s.votes.length < majority(s) ||
      s.members.some(
        (peer) => peer !== s.self && (s.next[peer] === undefined || s.match[peer] === undefined)
      ))
  )
    throw new Error('Invalid quorum leader');
  if (s.role === 'candidate' && (s.votedFor !== s.self || !s.votes.includes(s.self)))
    throw new Error('Invalid quorum candidate');
  return s;
}

function resetElection(s: QuorumState) {
  // Seeded jitter survives snapshot/replay and avoids permanent election ties.
  s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0;
  s.electionAt = s.now + s.electionMs + (s.seed % s.electionMs);
}
export function createQuorumNode(config: {
  cluster: string;
  self: string;
  members: string[];
  seed: number;
  electionMs?: number;
  heartbeatMs?: number;
}): QuorumState {
  const s: QuorumState = {
    ...config,
    members: [...config.members],
    term: 0,
    role: 'follower',
    log: [],
    commit: 0,
    votes: [],
    next: {},
    match: {},
    sending: {},
    now: 0,
    electionAt: 0,
    heartbeatAt: 0,
    electionMs: config.electionMs ?? 500,
    heartbeatMs: config.heartbeatMs ?? 100,
  };
  validateQuorumState(s);
  resetElection(s);
  return s;
}
function follower(s: QuorumState, term: number) {
  if (term > s.term) {
    delete s.votedFor;
    delete s.receiving;
  }
  s.term = term;
  s.role = 'follower';
  s.votes = [];
  s.next = {};
  s.match = {};
  s.sending = {};
}
function append(s: QuorumState, to: string): QuorumMessage {
  if (s.snapshot && s.next[to] <= quorumBase(s)) {
    const cp = s.snapshot,
      bytes = quorumDataBytes(cp.data);
    const t = (s.sending[to] ??= {
      index: cp.index,
      lastTerm: cp.term,
      hash: cp.hash,
      total: bytes.length,
      offset: 0,
    });
    const chunk = bytes.slice(t.offset, t.offset + QUORUM_CHUNK_BYTES);
    return {
      cluster: s.cluster,
      from: s.self,
      to,
      term: s.term,
      kind: 'snapshot',
      ...t,
      dataHex: quorumHex(chunk),
      done: t.offset + chunk.length === t.total,
    };
  }
  const previous = s.next[to] - 1;
  return {
    cluster: s.cluster,
    from: s.self,
    to,
    term: s.term,
    kind: 'append',
    previous,
    previousTerm: termAt(s, previous)!,
    entries: structuredClone(s.log.slice(previous - quorumBase(s), previous - quorumBase(s) + 16)),
    commit: s.commit,
  };
}
function broadcast(s: QuorumState) {
  s.heartbeatAt = s.now + s.heartbeatMs;
  return s.members.filter((p) => p !== s.self).map((p) => append(s, p));
}
function elect(s: QuorumState): QuorumMessage[] {
  // A partial image belongs to the old leader's term, never to this election.
  delete s.receiving;
  s.role = 'candidate';
  s.term++;
  s.votedFor = s.self;
  s.votes = [s.self];
  resetElection(s);
  return s.members
    .filter((p) => p !== s.self)
    .map((to) => ({
      cluster: s.cluster,
      from: s.self,
      to,
      term: s.term,
      kind: 'vote',
      lastIndex: quorumLastIndex(s),
      lastTerm: termAt(s, quorumLastIndex(s))!,
    }));
}
function advance(s: QuorumState, now: number) {
  if (!Number.isSafeInteger(now) || now < s.now) throw new Error('Quorum clock cannot go backwards');
  s.now = now;
}
export function tickQuorum(input: QuorumState, now: number): QuorumResult {
  let s = validateQuorumState(input);
  advance(s, now);
  s = compactIfNeeded(s);
  const messages =
    s.role === 'leader' ? (now >= s.heartbeatAt ? broadcast(s) : []) : now >= s.electionAt ? elect(s) : [];
  // Leader electionAt is not a lease: an isolated old leader can remain leader
  // locally, but cannot confirm writes or read barriers without fresh log ACKs.
  if (s.electionAt < now) s.electionAt = now;
  return { state: validateQuorumState(s), messages };
}
export function proposeQuorum(input: QuorumState, command: QuorumCommand): QuorumResult & { index: number } {
  let s = validateQuorumState(input);
  if (s.role !== 'leader') throw new Error('Quorum node is not leader');
  if (s.log.length >= 256) s = compactIfNeeded(s);
  if (s.log.length >= 256)
    throw new Error(
      'Quorum log capacity reached (256 retained entries); no committed prefix available for compaction'
    );
  if (quorumLastIndex(s) - s.commit >= 128)
    throw new Error('Quorum capacity: 128 unconfirmed entries; await majority before proposing more');
  const parsed = commandSchema.parse(command);
  if (parsed.kind === 'put' || (parsed.kind === 'database' && !/^\s*(SELECT|DELETE)\b/i.test(parsed.query))) {
    const before = quorumDataAt(s, quorumLastIndex(s)),
      after = applyQuorumData(before, parsed).data;
    const size = quorumDataBytes(after).length;
    if (size > QUORUM_DATA_BYTES && size > quorumDataBytes(before).length)
      throw new Error('Quorum materialized data capacity exceeded (512 KiB); operation not proposed');
  }
  s.log.push({ term: s.term, command: parsed });
  return { state: s, messages: broadcast(s), index: quorumLastIndex(s) };
}

export function receiveQuorum(input: QuorumState, incoming: unknown, now: number): QuorumResult {
  let s = validateQuorumState(input);
  const m = quorumMessageSchema.parse(incoming);
  advance(s, now);
  if (s.electionAt < now) s.electionAt = now;
  const messages: QuorumMessage[] = [];
  // Foreign identities must never affect term, vote or election timers.
  if (m.cluster !== s.cluster || m.to !== s.self || m.from === s.self || !s.members.includes(m.from))
    return { state: s, messages };
  s = compactIfNeeded(s);
  if (m.term > s.term) {
    follower(s, m.term);
    resetElection(s);
  }
  const reply = { cluster: s.cluster, from: s.self, to: m.from, term: s.term };
  if (m.kind === 'vote') {
    const lastTerm = termAt(s, quorumLastIndex(s))!;
    const upToDate = m.lastTerm > lastTerm || (m.lastTerm === lastTerm && m.lastIndex >= quorumLastIndex(s));
    const granted = m.term === s.term && upToDate && (!s.votedFor || s.votedFor === m.from);
    if (granted) {
      s.votedFor = m.from;
      resetElection(s);
    }
    messages.push({ ...reply, kind: 'voted', granted });
  } else if (m.kind === 'voted' && m.term === s.term && s.role === 'candidate' && m.granted) {
    if (!s.votes.includes(m.from)) s.votes.push(m.from);
    if (s.votes.length >= majority(s)) {
      s.role = 'leader';
      for (const peer of s.members.filter((p) => p !== s.self)) {
        s.next[peer] = quorumLastIndex(s) + 1;
        s.match[peer] = 0;
      }
      // A current-term entry is required before older-term entries can commit.
      if (s.log.length < 256) s.log.push({ term: s.term, command: { kind: 'barrier' } });
      messages.push(...broadcast(s));
    }
  } else if (m.kind === 'append') {
    let success = false;
    const validEntries = m.entries.every(
      (entry, i) =>
        entry.term > 0 && entry.term <= m.term && entry.term >= (i ? m.entries[i - 1].term : m.previousTerm)
    );
    if (m.term === s.term && validEntries && m.previous + m.entries.length <= quorumBase(s) + 256) {
      follower(s, m.term);
      resetElection(s);
      if (termAt(s, m.previous) === m.previousTerm) {
        success = true;
        for (const [offset, entry] of m.entries.entries()) {
          const index = m.previous + offset,
            local = index - quorumBase(s);
          const existing = s.log[local];
          if (
            existing &&
            existing.term === entry.term &&
            canonicalScenarioJson(existing) !== canonicalScenarioJson(entry)
          ) {
            success = false;
            break;
          }
          if (existing && existing.term !== entry.term) {
            if (index < s.commit) {
              success = false;
              break;
            }
            s.log.length = local;
          }
          if (!s.log[local]) s.log.push(structuredClone(entry));
        }
        if (success) {
          s.commit = Math.max(s.commit, Math.min(m.commit, m.previous + m.entries.length));
          if (s.receiving && s.receiving.index <= s.commit) delete s.receiving;
        }
      }
    }
    messages.push({
      ...reply,
      kind: 'appended',
      success,
      matched: success
        ? m.previous + m.entries.length
        : Math.max(quorumBase(s), Math.min(m.previous - 1, quorumLastIndex(s))),
    });
  } else if (m.kind === 'appended' && m.term === s.term && s.role === 'leader') {
    if (m.success && m.matched <= quorumLastIndex(s)) {
      s.match[m.from] = Math.max(s.match[m.from], m.matched);
      s.next[m.from] = Math.max(s.next[m.from], m.matched + 1);
      const indexes = [quorumLastIndex(s), ...Object.values(s.match)].sort((a, b) => b - a);
      const candidate = indexes[majority(s) - 1];
      if (candidate > s.commit && termAt(s, candidate) === s.term) {
        s.commit = candidate;
        messages.push(...broadcast(s));
      } else if (s.next[m.from] <= quorumLastIndex(s)) messages.push(append(s, m.from));
    } else if (!m.success) {
      const hint =
        m.matched >= s.next[m.from] && m.matched <= s.commit
          ? m.matched + 1
          : Math.min(s.next[m.from] - 1, m.matched + 1);
      s.next[m.from] = Math.max(s.match[m.from] + 1, hint);
      // Retry on heartbeat, avoiding a zero-time request/rejection storm.
    }
  } else if (m.kind === 'snapshot' && m.term < s.term) {
    messages.push({
      ...reply,
      kind: 'snapshotted',
      index: m.index,
      hash: m.hash,
      offset: 0,
      installed: false,
    });
  } else if (m.kind === 'snapshot' && m.term === s.term) {
    const end = m.offset + m.dataHex.length / 2;
    if (m.lastTerm > m.term || end > m.total || m.done !== (end === m.total) || !m.dataHex.length)
      return { state: s, messages };
    follower(s, m.term);
    resetElection(s);
    const acknowledge = (offset: number, installed = false) =>
      messages.push({
        ...reply,
        kind: 'snapshotted' as const,
        index: m.index,
        hash: m.hash,
        offset,
        installed,
      });
    if (m.index <= s.commit) {
      const known = termAt(s, m.index);
      if (
        (known !== undefined && known !== m.lastTerm) ||
        (s.snapshot?.index === m.index && s.snapshot.hash !== m.hash)
      )
        return { state: s, messages };
      delete s.receiving;
      acknowledge(m.total, true);
    } else {
      const r = s.receiving;
      const same =
        r?.from === m.from &&
        r.term === m.term &&
        r.index === m.index &&
        r.lastTerm === m.lastTerm &&
        r.hash === m.hash &&
        r.total === m.total;
      if (!same) {
        if (m.offset !== 0) {
          acknowledge(0);
          return { state: s, messages };
        }
        s.receiving = {
          from: m.from,
          term: m.term,
          index: m.index,
          lastTerm: m.lastTerm,
          hash: m.hash,
          total: m.total,
          dataHex: '',
        };
      }
      const pending = s.receiving!,
        expected = pending.dataHex.length / 2;
      if (m.offset < expected && pending.dataHex.slice(m.offset * 2, end * 2) === m.dataHex) {
        acknowledge(expected);
      } else if (m.offset !== expected) {
        acknowledge(expected);
      } else {
        pending.dataHex += m.dataHex;
        if (!m.done) acknowledge(end);
        else {
          let data: QuorumData;
          try {
            data = quorumDataSchema.parse(
              JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(quorumUnhex(pending.dataHex)))
            );
            if (quorumDataBytes(data).length !== m.total || quorumDataHash(data) !== m.hash)
              throw new Error('Checkpoint digest mismatch');
          } catch {
            delete s.receiving;
            acknowledge(0);
            return { state: s, messages };
          }
          const suffix = termAt(s, m.index) === m.lastTerm ? s.log.slice(m.index - quorumBase(s)) : [];
          s.snapshot = { index: m.index, term: m.lastTerm, hash: m.hash, data };
          s.log = suffix;
          s.commit = m.index;
          delete s.receiving;
          acknowledge(m.total, true);
        }
      }
    }
  } else if (m.kind === 'snapshotted' && m.term === s.term && s.role === 'leader') {
    const t = s.sending[m.from];
    if (t && t.index === m.index && t.hash === m.hash) {
      if (m.installed && m.offset === t.total) {
        s.match[m.from] = Math.max(s.match[m.from], m.index);
        s.next[m.from] = Math.max(s.next[m.from], m.index + 1);
        delete s.sending[m.from];
        messages.push(append(s, m.from));
      } else if (
        !m.installed &&
        m.offset === Math.min(t.offset + QUORUM_CHUNK_BYTES, t.total) &&
        m.offset < t.total
      ) {
        t.offset = m.offset;
        messages.push(append(s, m.from));
      } else if (!m.installed && m.offset === 0) t.offset = 0;
    }
  }
  return { state: validateQuorumState(s), messages };
}

// A committed view is historical. A service must commit a NEW barrier in its
// current term before treating this view as a linearizable read response.
export function quorumCommittedView(input: QuorumState): Record<string, string> {
  return quorumDataAt(validateQuorumState(input)).values;
}
