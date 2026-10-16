import { z } from 'zod';
import { canonicalScenarioJson } from '../canonical-json';

// A deterministic, message-driven Raft core. The caller owns transport and
// persistence: persist the returned state BEFORE delivering any returned message.
// No peer's power, links or storage are inspected by this state machine.
const id = z
  .string()
  .regex(/^[a-zA-Z0-9_.:-]{1,64}$/)
  .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value));
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const commandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('barrier') }).strict(),
  z.object({ kind: z.literal('put'), key: id, value: z.string().max(4096) }).strict(),
  z.object({ kind: z.literal('delete'), key: id }).strict(),
  z.object({ kind: z.literal('database'), query: z.string().min(1).max(2048) }).strict(),
]);
const entrySchema = z.object({ term: integer, command: commandSchema }).strict();
const envelope = { cluster: id, from: id, to: id, term: integer };
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
const termAt = (s: QuorumState, index: number) => (index === 0 ? 0 : s.log[index - 1]?.term);

export function validateQuorumState(input: unknown): QuorumState {
  const s = quorumStateSchema.parse(input);
  if (
    ![3, 5].includes(s.members.length) ||
    new Set(s.members).size !== s.members.length ||
    !s.members.includes(s.self) ||
    s.commit > s.log.length ||
    (s.votedFor && !s.members.includes(s.votedFor)) ||
    new Set(s.votes).size !== s.votes.length ||
    s.votes.some((v) => !s.members.includes(v)) ||
    s.heartbeatMs * 3 >= s.electionMs ||
    s.electionAt < s.now ||
    s.log.some(
      (entry, i) => entry.term === 0 || entry.term > s.term || (i > 0 && entry.term < s.log[i - 1].term)
    )
  )
    throw new Error('Invalid quorum state');
  for (const [peer, index] of Object.entries(s.next))
    if (!s.members.includes(peer) || peer === s.self || index < 1 || index > s.log.length + 1)
      throw new Error('Invalid quorum next index');
  for (const [peer, index] of Object.entries(s.match))
    if (!s.members.includes(peer) || peer === s.self || index > s.log.length || index >= (s.next[peer] ?? 0))
      throw new Error('Invalid quorum match index');
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
  if (term > s.term) delete s.votedFor;
  s.term = term;
  s.role = 'follower';
  s.votes = [];
  s.next = {};
  s.match = {};
}
function append(s: QuorumState, to: string): QuorumMessage {
  const previous = s.next[to] - 1;
  return {
    cluster: s.cluster,
    from: s.self,
    to,
    term: s.term,
    kind: 'append',
    previous,
    previousTerm: termAt(s, previous)!,
    entries: structuredClone(s.log.slice(previous, previous + 16)),
    commit: s.commit,
  };
}
function broadcast(s: QuorumState) {
  s.heartbeatAt = s.now + s.heartbeatMs;
  return s.members.filter((p) => p !== s.self).map((p) => append(s, p));
}
function elect(s: QuorumState): QuorumMessage[] {
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
      lastIndex: s.log.length,
      lastTerm: termAt(s, s.log.length)!,
    }));
}
function advance(s: QuorumState, now: number) {
  if (!Number.isSafeInteger(now) || now < s.now) throw new Error('Quorum clock cannot go backwards');
  s.now = now;
}
export function tickQuorum(input: QuorumState, now: number): QuorumResult {
  const s = validateQuorumState(input);
  advance(s, now);
  const messages =
    s.role === 'leader' ? (now >= s.heartbeatAt ? broadcast(s) : []) : now >= s.electionAt ? elect(s) : [];
  // Leader electionAt is not a lease: an isolated old leader can remain leader
  // locally, but cannot confirm writes or read barriers without fresh log ACKs.
  if (s.electionAt < now) s.electionAt = now;
  return { state: validateQuorumState(s), messages };
}
export function proposeQuorum(input: QuorumState, command: QuorumCommand): QuorumResult & { index: number } {
  const s = validateQuorumState(input);
  if (s.role !== 'leader') throw new Error('Quorum node is not leader');
  if (s.log.length >= 256) throw new Error('Quorum log capacity reached (256); no compaction implemented');
  s.log.push({ term: s.term, command: commandSchema.parse(command) });
  return { state: s, messages: broadcast(s), index: s.log.length };
}

export function receiveQuorum(input: QuorumState, incoming: unknown, now: number): QuorumResult {
  const s = validateQuorumState(input),
    m = quorumMessageSchema.parse(incoming);
  advance(s, now);
  if (s.electionAt < now) s.electionAt = now;
  const messages: QuorumMessage[] = [];
  // Foreign identities must never affect term, vote or election timers.
  if (m.cluster !== s.cluster || m.to !== s.self || m.from === s.self || !s.members.includes(m.from))
    return { state: s, messages };
  if (m.term > s.term) {
    follower(s, m.term);
    resetElection(s);
  }
  const reply = { cluster: s.cluster, from: s.self, to: m.from, term: s.term };
  if (m.kind === 'vote') {
    const lastTerm = termAt(s, s.log.length)!;
    const upToDate = m.lastTerm > lastTerm || (m.lastTerm === lastTerm && m.lastIndex >= s.log.length);
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
        s.next[peer] = s.log.length + 1;
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
    if (m.term === s.term && validEntries && m.previous + m.entries.length <= 256) {
      follower(s, m.term);
      resetElection(s);
      if (termAt(s, m.previous) === m.previousTerm) {
        success = true;
        for (const [offset, entry] of m.entries.entries()) {
          const index = m.previous + offset;
          const existing = s.log[index];
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
            s.log.length = index;
          }
          if (!s.log[index]) s.log.push(structuredClone(entry));
        }
        if (success) s.commit = Math.max(s.commit, Math.min(m.commit, m.previous + m.entries.length));
      }
    }
    messages.push({
      ...reply,
      kind: 'appended',
      success,
      matched: success ? m.previous + m.entries.length : Math.max(0, Math.min(m.previous - 1, s.log.length)),
    });
  } else if (m.kind === 'appended' && m.term === s.term && s.role === 'leader') {
    if (m.success && m.matched <= s.log.length) {
      s.match[m.from] = Math.max(s.match[m.from], m.matched);
      s.next[m.from] = Math.max(s.next[m.from], m.matched + 1);
      const indexes = [s.log.length, ...Object.values(s.match)].sort((a, b) => b - a);
      const candidate = indexes[majority(s) - 1];
      if (candidate > s.commit && termAt(s, candidate) === s.term) {
        s.commit = candidate;
        messages.push(...broadcast(s));
      } else if (s.next[m.from] <= s.log.length) messages.push(append(s, m.from));
    } else if (!m.success) {
      s.next[m.from] = Math.max(s.match[m.from] + 1, Math.min(s.next[m.from] - 1, m.matched + 1));
      // Retry on heartbeat, avoiding a zero-time request/rejection storm.
    }
  }
  return { state: validateQuorumState(s), messages };
}

// A committed view is historical. A service must commit a NEW barrier in its
// current term before treating this view as a linearizable read response.
export function quorumCommittedView(input: QuorumState): Record<string, string> {
  const s = validateQuorumState(input),
    values: Record<string, string> = Object.create(null);
  for (const { command } of s.log.slice(0, s.commit)) {
    if (command.kind === 'put') values[command.key] = command.value;
    else if (command.kind === 'delete') delete values[command.key];
  }
  return values;
}
