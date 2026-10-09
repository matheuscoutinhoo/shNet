import type { Action, Snapshot } from '../model';
import { LIMITS } from '../model';
export function enqueue(state: Snapshot, delay: number, action: Action) {
  if (state.queue.length >= LIMITS.queue)
    throw new Error(
      'Limite de eventos pendentes atingido. Interrompa o tráfego e revise loops na topologia.'
    );
  const item = { at: state.clock + Math.max(0.001, delay), order: ++state.sequence, action };
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
export function random(state: Snapshot) {
  let x = state.seed;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.seed = x >>> 0 || 1;
  return state.seed / 4294967296;
}
