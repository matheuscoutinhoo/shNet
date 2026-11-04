import type { Device, Snapshot } from '../model';

type Logs = Pick<Snapshot, 'events' | 'diagnostics' | 'capture'>;
type Rest = Omit<Snapshot, 'devices' | 'queue' | 'events' | 'diagnostics' | 'capture'>;

/**
 * Compact rollback point for a local edit: one JSON string per device plus a clone of the
 * remaining state. Comparing device strings afterwards identifies what the edit changed, and
 * unchanged strings are shared with the previous mark so undo history stays small.
 */
export interface StateMark {
  ids: string[];
  devices: string[];
  // Entry identities detect scheduling changes; the JSON copy restores them (frames may be
  // rewritten in place after delivery, e.g. by DSCP marking).
  queue: Snapshot['queue'];
  queueJson: string;
  links: string;
  rest: Rest;
  logs: Logs;
  bytes: number;
}

function copyLogs(s: Snapshot): Logs {
  return {
    events: [...s.events],
    ...(s.diagnostics ? { diagnostics: [...s.diagnostics] } : {}),
    ...(s.capture ? { capture: { ...s.capture, frames: [...s.capture.frames] } } : {}),
  };
}

export function markState(s: Snapshot, previous?: StateMark): StateMark {
  const {
    devices,
    queue: _queue,
    events: _events,
    diagnostics: _diagnostics,
    capture: _capture,
    ...rest
  } = s;
  const strings = devices.map((d, i) => {
    const json = JSON.stringify(d);
    const shared = previous?.ids[i] === d.id ? previous.devices[i] : undefined;
    return shared === json ? shared : json;
  });
  const links = JSON.stringify(s.links),
    queueJson = JSON.stringify(s.queue);
  return {
    ids: devices.map((d) => d.id),
    devices: strings,
    queue: [...s.queue],
    queueJson,
    links,
    rest: structuredClone(rest),
    logs: copyLogs(s),
    // Memory budget estimate for undo history; logs are shared between marks.
    bytes: strings.reduce((n, json) => n + json.length, 0) + links.length + queueJson.length,
  };
}

/** A full snapshot equal to the marked state. */
export function materializeMark(mark: StateMark): Snapshot {
  return {
    ...structuredClone(mark.rest),
    devices: mark.devices.map((json) => JSON.parse(json) as Device),
    queue: JSON.parse(mark.queueJson) as Snapshot['queue'],
    events: [...mark.logs.events],
    ...(mark.logs.diagnostics ? { diagnostics: [...mark.logs.diagnostics] } : {}),
    ...(mark.logs.capture
      ? { capture: { ...mark.logs.capture, frames: [...mark.logs.capture.frames] } }
      : {}),
  } as Snapshot;
}

/**
 * Devices whose state or scheduled timers changed since the mark, plus queue entries added since.
 * Undefined means the change is structural (devices added, removed or reordered, or cabling
 * changed) and needs full validation.
 */
export function changedSince(
  mark: StateMark,
  s: Snapshot
): { devices: Set<string>; queue: Snapshot['queue'] } | undefined {
  if (s.devices.length !== mark.ids.length || s.devices.some((d, i) => d.id !== mark.ids[i])) return;
  if (JSON.stringify(s.links) !== mark.links) return;
  const changed = new Set<string>();
  s.devices.forEach((d, i) => {
    if (JSON.stringify(d) !== mark.devices[i]) changed.add(d.id);
  });
  const before = new Set(mark.queue),
    after = new Set(s.queue),
    added: Snapshot['queue'] = [];
  const owner = (item: Snapshot['queue'][number]) =>
    'device' in item.action ? (item.action.device as string) : undefined;
  for (const item of mark.queue) if (!after.has(item) && owner(item)) changed.add(owner(item)!);
  for (const item of s.queue)
    if (!before.has(item)) {
      added.push(item);
      if (owner(item)) changed.add(owner(item)!);
    }
  return { devices: changed, queue: added };
}
