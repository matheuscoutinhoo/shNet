import type { SimulationEngine } from '../core/engine';
import type { Device } from '../model';
import { ALL_MODES, type CommandRegistry } from './registry';

interface Block {
  line: string;
  children: string[];
}
/** Splits a configuration into top-level commands and their indented sub-commands. */
function blocks(config: string) {
  const result: Block[] = [];
  for (const raw of config.split('\n')) {
    const line = raw.trimEnd();
    if (
      !line.trim() ||
      /^!/.test(line.trim()) ||
      /^(?:Building configuration|Current configuration)/.test(line)
    )
      continue;
    if (/^\s/.test(line) && result.length) result.at(-1)!.children.push(line.trim());
    else if (line !== 'end' && line !== 'exit') result.push({ line, children: [] });
  }
  return result;
}
/**
 * Contextual diff in the format of IOS "show archive config differences":
 * "+" lines exist only in the second configuration and "-" lines only in the first.
 * Parents of changed sub-commands are printed without a sign.
 */
export function contextualDiff(before: string, after: string) {
  const a = blocks(before),
    b = blocks(after);
  const index = (list: Block[]) => {
    const map = new Map<string, Block>();
    for (const block of list) {
      const old = map.get(block.line);
      if (old) old.children.push(...block.children);
      else map.set(block.line, { line: block.line, children: [...block.children] });
    }
    return map;
  };
  const left = index(a),
    right = index(b);
  const out: string[] = [];
  const removed: string[] = [];
  for (const [line, block] of left)
    if (!right.has(line)) removed.push('-' + line, ...block.children.map((c) => ' -' + c));
  for (const [line, block] of right) {
    const old = left.get(line);
    if (!old) {
      out.push('+' + line, ...block.children.map((c) => ' +' + c));
      continue;
    }
    const was = new Set(old.children),
      now = new Set(block.children);
    const changes = [
      ...block.children.filter((c) => !was.has(c)).map((c) => ' +' + c),
      ...old.children.filter((c) => !now.has(c)).map((c) => ' -' + c),
    ];
    if (changes.length) out.push(line, ...changes);
  }
  return [...out, ...removed];
}
export function runningConfig(e: SimulationEngine, d: Device, r: CommandRegistry) {
  return r.execute('show running-config', e, d, { mode: 'privileged' });
}
/** Running vs startup (or an archived copy) for one device, for the CLI and the inspector. */
export function deviceConfigDiff(e: SimulationEngine, d: Device, r: CommandRegistry, against?: string) {
  const running = runningConfig(e, d, r);
  let base: string | undefined;
  if (!against || /^nvram:startup-config$/i.test(against)) base = d.startupConfig?.commands.join('\n');
  else {
    const copy = d.iosSystem?.archive?.copies.find((c) => c.name === against);
    if (!copy) throw new Error('Error opening ' + against + ' (No such file or directory)');
    base = copy.configuration;
  }
  return { running, base, changes: contextualDiff(base ?? '', running), saved: base !== undefined };
}
export function formatConfigDiff(changes: string[]) {
  return '!Contextual Config Diffs:\n' + (changes.length ? changes.join('\n') : '!No changes were found');
}
export function registerConfigDiff(r: CommandRegistry) {
  r.register({
    pattern: /^show archive config differences(?: (\S+))?(?: (\S+))?$/i,
    syntax: [
      'show archive config differences',
      'show archive config differences <archive-file>',
      'show archive config differences <file-1> <file-2>',
    ],
    modes: ALL_MODES,
    run: (m, e, d) => {
      const read = (name: string) => {
        if (/^(?:system:)?running-config$/i.test(name)) return runningConfig(e, d, r);
        return deviceConfigDiff(e, d, r, name).base ?? '';
      };
      if (m[2]) return formatConfigDiff(contextualDiff(read(m[1]), read(m[2])));
      const diff = deviceConfigDiff(e, d, r, m[1]);
      if (!diff.saved) throw new Error('Error opening nvram:startup-config (No such file or directory)');
      return formatConfigDiff(diff.changes);
    },
  });
}
