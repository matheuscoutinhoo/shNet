import type { Action, Snapshot } from '../model';
import { LIMITS } from '../model';
export function enqueue(state: Snapshot, delay: number, action: Action) {
  enqueueAt(state, state.clock + Math.max(0.001, delay), action);
}
/** Preserve an absolute protocol deadline without subtracting and adding the current clock. */
export function enqueueAt(state: Snapshot, at: number, action: Action) {
  if (state.queue.length >= LIMITS.queue)
    throw new Error(
      'Limite de eventos pendentes atingido. Interrompa o tráfego e revise loops na topologia.'
    );
  const item = { at: Math.max(state.clock + 0.001, at), order: ++state.sequence, action };
  let lo = 0,
    hi = state.queue.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const q = state.queue[mid];
    if (q.at < item.at || (q.at === item.at && q.order < item.order)) lo = mid + 1;
    else hi = mid;
  }
  state.queue.splice(lo, 0, item);
}
/** Removes the queued action at `at` matching `match`; false when there is none at that time. */
export function removeQueued(state: Snapshot, at: number, match: (action: Action) => boolean) {
  const queue = state.queue;
  let lo = 0,
    hi = queue.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (queue[mid].at < at) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < queue.length && queue[i].at === at; i++)
    if (match(queue[i].action)) {
      queue.splice(i, 1);
      return true;
    }
  return false;
}
export function random(state: Snapshot) {
  let x = state.seed;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.seed = x >>> 0 || 1;
  return state.seed / 4294967296;
}
