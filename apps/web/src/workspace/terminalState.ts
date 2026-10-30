import { TerminalSession, type SimulationEngine } from '@shlab/engine';
import type { IBuffer, IBufferLine } from '@xterm/xterm';

export const TERMINAL_OUTPUT_LIMIT = 256 * 1024;

export type DeviceTerminalState = {
  cli: TerminalSession;
  output: string;
  line: string;
  cursor?: number;
  prompt: string;
  initialized: boolean;
  historyIndex: number;
  seen: Set<string>;
};

// The engine belongs to one open lab. No terminal data enters a saved topology,
// and a closed lab can release its sessions along with the engine.
const sessions = new WeakMap<SimulationEngine, Map<string, DeviceTerminalState>>();

export function deviceTerminalState(engine: SimulationEngine, deviceId: string): DeviceTerminalState {
  engine.device(deviceId);
  let devices = sessions.get(engine);
  if (!devices) {
    devices = new Map();
    sessions.set(engine, devices);
  }
  const existingIds = new Set(engine.state.devices.map((device) => device.id));
  for (const id of devices.keys()) if (!existingIds.has(id)) devices.delete(id);
  let state = devices.get(deviceId);
  if (!state) {
    const cli = new TerminalSession(engine, deviceId);
    state = {
      cli,
      output: '',
      line: '',
      prompt: cli.prompt,
      initialized: false,
      historyIndex: 0,
      seen: new Set(),
    };
    devices.set(deviceId, state);
  }
  return state;
}

export function appendTerminalOutput(state: DeviceTerminalState, text: string): void {
  const output = state.output + text;
  if (output.length <= TERMINAL_OUTPUT_LIMIT) {
    state.output = output;
    return;
  }
  // Keep recent output and trim at a completed line rather than inside an ANSI
  // sequence. XTerm applies its normal scrollback limit when replaying it.
  const start = output.length - TERMINAL_OUTPUT_LIMIT;
  const newline = output.indexOf('\n', start);
  state.output = output.slice(newline < 0 || newline === output.length - 1 ? start : newline + 1);
}

/** Erase the current logical input after XTerm has parsed preceding writes. */
export function terminalInputErase(
  buffer: Pick<IBuffer, 'baseY' | 'cursorY'> & {
    getLine(index: number): Pick<IBufferLine, 'isWrapped'> | undefined;
  }
): string | null {
  const cursor = buffer.baseY + buffer.cursorY;
  let first = cursor;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  const rows = cursor - first;
  // Cursor movement cannot reach a prompt that has scrolled out of the visible
  // buffer. In that case replay the logical transcript and draft from scratch.
  if (rows > buffer.cursorY) return null;
  return (rows ? '\x1b[' + rows + 'A' : '') + '\r\x1b[J';
}
