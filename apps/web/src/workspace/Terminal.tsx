import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  formatDnsQuery,
  formatTcpConnection,
  formatSnmpQuery,
  tcpFinished,
  deviceCommandHelp,
  terminalIdentity,
} from '@shlab/engine';
import type { LabController } from './useLab';
import {
  appendTerminalOutput,
  deviceTerminalState,
  terminalInputErase,
  type DeviceTerminalState,
} from './terminalState';
import '@xterm/xterm/css/xterm.css';
import { coloredTerminalCommand, coloredTerminalInput, coloredTerminalOutput } from './terminalColors';
import { getLocale, tr } from '../i18n';
/** Output in the interface language; IOS error lines keep their "% " prefix. */
function localized(text: string) {
  if (getLocale() !== 'en') return text;
  return text
    .split('\n')
    .map((line) => {
      const error = /^(\s*%\s?)(.+)$/.exec(line);
      return error ? error[1] + tr(error[2]) : tr(line);
    })
    .join('\n');
}
export function Terminal({
  lab,
  deviceId,
  compact = false,
}: {
  lab: LabController;
  deviceId: string;
  /** Terminal only, without heading, guide and shortcuts (terminal dock). */
  compact?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null),
    stateRef = useRef<DeviceTerminalState | null>(null),
    labRef = useRef(lab),
    resultRef = useRef<((text: string) => void) | null>(null);
  labRef.current = lab;
  useEffect(() => {
    const state = deviceTerminalState(labRef.current.engine, deviceId);
    const cli = state.cli;
    let cursor = Math.min(state.cursor ?? state.line.length, state.line.length);
    stateRef.current = state;
    const term = new XTerm({
      fontFamily:
        getComputedStyle(document.documentElement).getPropertyValue('--font-data').trim() ||
        'Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.4,
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorBlink: true,
      convertEol: true,
      scrollback: 600,
      theme: {
        background: '#0b202b',
        foreground: '#deedf1',
        cursor: '#59e7cd',
        selectionBackground: '#24555b',
        cyan: '#92ece0',
        blue: '#78cebc',
        brightBlue: '#adf1dc',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current!);
    fit.fit();
    type RenderOperation =
      { kind: 'write'; text: string } | { kind: 'redraw'; text: string; replay: string; tail: number };
    const pending: RenderOperation[] = [];
    let writing = false,
      disposed = false;
    const drain = () => {
      if (disposed || writing) return;
      const operation = pending.shift();
      if (!operation) return;
      let text = operation.text;
      if (operation.kind === 'redraw') {
        const erase = terminalInputErase(term.buffer.active);
        if (erase === null) {
          term.reset();
          text = operation.replay;
        } else text = erase + text;
      } else {
        // Combine input bursts without letting a redraw overtake earlier data.
        while (pending[0]?.kind === 'write') text += pending.shift()!.text;
      }
      writing = true;
      term.write(text, () => {
        const finish = () => {
          writing = false;
          drain();
        };
        if (operation.kind === 'redraw' && operation.tail > 0) {
          const column = term.buffer.active.cursorX,
            up = Math.max(0, Math.ceil((operation.tail - column) / term.cols)),
            target = (((column - operation.tail) % term.cols) + term.cols) % term.cols;
          term.write((up ? '\x1b[' + up + 'A' : '') + '\r' + (target ? '\x1b[' + target + 'C' : ''), finish);
        } else finish();
      });
    };
    const write = (text: string) => {
      pending.push({ kind: 'write', text });
      drain();
    };
    const redraw = (before = '') => {
      const input = coloredTerminalInput(state.prompt, cli.secretInput ? '' : state.line);
      pending.push({
        kind: 'redraw',
        text: before + input,
        replay: state.output + input,
        tail: cli.secretInput ? 0 : state.line.length - cursor,
      });
      drain();
    };
    const result = (text: string) => {
      const output = coloredTerminalOutput(localized(text)) + '\r\n';
      appendTerminalOutput(state, output);
      state.prompt = cli.prompt;
      redraw(output);
    };
    resultRef.current = result;
    if (!state.initialized) {
      appendTerminalOutput(
        state,
        '\x1b[36m' +
          cli.identity.family +
          ' · ' +
          cli.identity.name +
          ' · ' +
          tr('Terminal simulado') +
          '\x1b[0m\r\n' +
          tr('Digite help para ver os comandos disponíveis.') +
          '\r\n\r\n'
      );
      state.initialized = true;
    }
    // Completed output has no transient input-editing controls. XTerm can reflow
    // it at the current width and render the current hostname/draft exactly once.
    state.prompt = cli.prompt;
    write(state.output + coloredTerminalInput(state.prompt, cli.secretInput ? '' : state.line));
    const replaceLine = (text: string, position = text.length) => {
      state.line = text;
      cursor = Math.max(0, Math.min(position, text.length));
      state.cursor = cursor;
      state.prompt = cli.prompt;
      redraw();
    };
    if (cursor < state.line.length) redraw();
    /** Runs one line already shown after the prompt; returns whether it changed the lab. */
    const submit = (input: string, undoStep: boolean) => {
      appendTerminalOutput(state, coloredTerminalInput(state.prompt, cli.displayInput(input)) + '\r\n');
      // Password and reload-dialog answers have no command mark, so they use a full checkpoint.
      const dialog = cli.secretInput || !!cli.context.confirm;
      const output = labRef.current.change(() => cli.execute(input), dialog, true, true);
      const changed = !!cli.lastMark;
      if (undoStep && cli.lastMark) labRef.current.remember(cli.lastMark);
      const shown = output && localized(output);
      if (shown) appendTerminalOutput(state, coloredTerminalOutput(shown) + '\r\n');
      if (output?.startsWith('DNS [')) {
        const query = labRef.current.engine.device(deviceId).dnsQueries?.at(-1);
        if (query && query.status !== 'pending' && output.includes(query.id)) state.seen.add(query.id);
      }
      state.historyIndex = cli.history.length;
      state.prompt = cli.prompt;
      write(
        '\r\n' + (shown ? coloredTerminalOutput(shown) + '\r\n' : '') + coloredTerminalInput(state.prompt)
      );
      return changed;
    };
    // Pasted configuration runs in short slices so the page keeps painting, and counts as one undo step.
    const batch: string[] = [];
    let running = false;
    const runBatch = () => {
      if (running) return;
      running = true;
      let undoStep = true;
      const slice = () => {
        if (disposed) return;
        const started = performance.now();
        while (batch.length && performance.now() - started < 30) {
          const line = batch.shift()!;
          write(coloredTerminalCommand(cli.displayInput(line)));
          if (submit(line, undoStep)) undoStep = false;
        }
        if (batch.length) {
          setTimeout(slice, 0);
          return;
        }
        running = false;
        if (state.line) replaceLine(state.line);
      };
      slice();
    };
    const sub = term.onData((data) => {
      if (data === '\x1b[A') {
        if (cli.secretInput) return;
        state.historyIndex = Math.max(0, state.historyIndex - 1);
        replaceLine(cli.history[state.historyIndex] ?? '');
        return;
      }
      if (data === '\x1b[B') {
        if (cli.secretInput) return;
        state.historyIndex = Math.min(cli.history.length, state.historyIndex + 1);
        replaceLine(cli.history[state.historyIndex] ?? '');
        return;
      }
      if (data === '\t') {
        const completed = cli.complete(state.line.slice(0, cursor));
        replaceLine(completed + state.line.slice(cursor), completed.length);
        return;
      }
      if (data === '?' && !cli.secretInput) {
        write('\r\n' + localized(cli.help(state.line)) + '\r\n' + coloredTerminalInput(cli.prompt, state.line));
        return;
      }
      if (data === '\x1a') {
        cli.cancel();
        cli.end();
        replaceLine('');
        return;
      }
      if (data === '\x1b[D' || data === '\x02') {
        replaceLine(state.line, cursor - 1);
        return;
      }
      if (data === '\x1b[C' || data === '\x06') {
        replaceLine(state.line, cursor + 1);
        return;
      }
      if (['\x1b[H', '\x1b[1~', '\x1bOH', '\x01'].includes(data)) {
        replaceLine(state.line, 0);
        return;
      }
      if (['\x1b[F', '\x1b[4~', '\x1bOF', '\x05'].includes(data)) {
        replaceLine(state.line);
        return;
      }
      if (data === '\x1b[3~' || data === '\x04') {
        replaceLine(state.line.slice(0, cursor) + state.line.slice(cursor + 1), cursor);
        return;
      }
      if (data === '\x15') {
        replaceLine(state.line.slice(cursor), 0);
        return;
      }
      if (data === '\x0b') {
        replaceLine(state.line.slice(0, cursor));
        return;
      }
      if (data === '\x17') {
        const left = state.line.slice(0, cursor).replace(/\s*\S+\s*$/, '');
        replaceLine(left + state.line.slice(cursor), left.length);
        return;
      }
      if (data.startsWith('\x1b')) return;
      // A pasted block arrives as one chunk with line breaks; a typed Enter arrives alone.
      const pasted = /[\r\n]/.test(data) && data.length > 1;
      if (pasted && !batch.length && !running && state.line) {
        // The typed prefix is replayed together with the pasted lines.
        const prefix = state.line;
        replaceLine('');
        state.line = prefix;
        cursor = prefix.length;
        state.cursor = cursor;
      }
      let previous = '';
      for (const ch of data) {
        if (ch === '\n' && previous === '\r') {
          previous = ch;
          continue;
        }
        previous = ch;
        if (ch === '\r' || ch === '\n') {
          const input = state.line;
          if (pasted || running || batch.length) {
            batch.push(input);
            state.line = '';
            cursor = 0;
            state.cursor = 0;
            continue;
          }
          if (cursor !== input.length) replaceLine(input);
          state.line = '';
          cursor = 0;
          state.cursor = 0;
          submit(input, true);
        } else if (ch === '\x7f') {
          if (state.line) {
            if (cursor > 0)
              replaceLine(state.line.slice(0, cursor - 1) + state.line.slice(cursor), cursor - 1);
          }
        } else if (ch === '\x03') {
          batch.length = 0;
          if (cursor !== state.line.length) replaceLine(state.line);
          appendTerminalOutput(
            state,
            coloredTerminalInput(state.prompt, cli.displayInput(state.line)) + '^C\r\n'
          );
          cli.cancel();
          state.line = '';
          cursor = 0;
          state.cursor = 0;
          state.prompt = cli.prompt;
          write('^C\r\n' + coloredTerminalInput(state.prompt));
        } else if (ch >= ' ' && ch <= '~' && state.line.length < 512) {
          const atEnd = cursor === state.line.length;
          state.line = state.line.slice(0, cursor) + ch + state.line.slice(cursor);
          cursor++;
          state.cursor = cursor;
          if (pasted || running) continue;
          if (!atEnd) redraw();
          else if (!cli.secretInput) write(coloredTerminalCommand(ch));
        }
      }
      if (batch.length) runBatch();
    });
    // A popped-out terminal lives in another window; observe it with that window's observer.
    const observer = new (ref.current!.ownerDocument.defaultView ?? window).ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* Host can be hidden during teardown. */
      }
    });
    observer.observe(ref.current!);
    term.focus();
    return () => {
      if (cli.secretInput) state.line = '';
      disposed = true;
      pending.length = 0;
      sub.dispose();
      observer.disconnect();
      term.dispose();
      stateRef.current = null;
      resultRef.current = null;
    };
  }, [deviceId, lab.engine]);
  useEffect(() => {
    const state = stateRef.current,
      result = resultRef.current;
    if (!state || !result) return;
    for (const connection of lab.engine.device(deviceId).tcpConnections ?? []) {
      if (
        connection.role !== 'client' ||
        (!tcpFinished(connection) && connection.state !== 'TIME-WAIT') ||
        state.seen.has(connection.id)
      )
        continue;
      state.seen.add(connection.id);
      result(formatTcpConnection(connection));
    }
    for (const query of lab.engine.device(deviceId).dnsQueries ?? []) {
      if (query.status === 'pending' || state.seen.has(query.id)) continue;
      state.seen.add(query.id);
      result(formatDnsQuery(query));
    }
    for (const query of lab.engine.device(deviceId).snmpQueries ?? []) {
      if (query.status === 'pending' || state.seen.has(query.id)) continue;
      state.seen.add(query.id);
      result(formatSnmpQuery(query));
    }
    for (const p of lab.engine.state.probes.filter(
      (p) => p.device === deviceId && p.status !== 'pending' && !state.seen.has(p.id)
    )) {
      state.seen.add(p.id);
      result(
        p.status === 'success'
          ? 'Reply from ' + p.responder + ': time=' + p.rtt?.toFixed(2) + 'ms TTL probe=' + p.ttl
          : 'Probe TTL ' + p.ttl + ': ' + p.status + (p.responder ? ' from ' + p.responder : '')
      );
    }
  }, [lab.tick, lab.engine, deviceId]);
  const device = lab.engine.device(deviceId),
    identity = terminalIdentity(device);
  if (compact)
    return (
      <div className="terminal-shell compact">
        <div className="terminal-frame">
          <div className="terminal-host" ref={ref} aria-label={'Terminal de ' + identity.name} />
        </div>
      </div>
    );
  return (
    <div className="terminal-shell">
      <div className="terminal-heading">
        <strong title={device.hostname}>{device.hostname}</strong>
        <span>{identity.family}</span>
      </div>
      <details className="terminal-guide">
        <summary>Comandos de {identity.name}</summary>
        <p>
          Este terminal é simulado. Os comandos consultam ou alteram apenas este equipamento no laboratório.
        </p>
        {(!identity.host || identity.family === 'ServiceShell') && (
          <p>
            Para configurar: digite <code>enable</code>, depois <code>configure terminal</code>. Use{' '}
            <code>interface NOME</code> antes dos comandos de porta e <code>end</code> para sair.
          </p>
        )}
        <dl>
          {deviceCommandHelp(device, stateRef.current?.cli.context ?? { mode: 'user' }).map((entry) => (
            <div key={entry.command}>
              <dt>
                <code>{entry.command}</code>
              </dt>
              <dd>
                {entry.description}
                <br />
                <span>
                  Exemplo: <code>{entry.example}</code>
                </span>
              </dd>
            </div>
          ))}
        </dl>
      </details>
      <div className="terminal-frame">
        <div className="terminal-host" ref={ref} aria-label={'Terminal de ' + identity.name} />
      </div>
      <div className="terminal-shortcuts">
        <span>
          <kbd>help</kbd> Comandos
        </span>
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> Histórico
        </span>
        <span>
          <kbd>Ctrl</kbd> + <kbd>C</kbd> Limpar linha
        </span>
      </div>
    </div>
  );
}
