import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { formatDnsQuery, formatTcpConnection, formatSnmpQuery, tcpFinished } from '@shlab/engine';
import type { LabController } from './useLab';
import {
  appendTerminalOutput,
  deviceTerminalState,
  terminalInputErase,
  type DeviceTerminalState,
} from './terminalState';
import '@xterm/xterm/css/xterm.css';
export function Terminal({ lab, deviceId }: { lab: LabController; deviceId: string }) {
  const ref = useRef<HTMLDivElement>(null),
    stateRef = useRef<DeviceTerminalState | null>(null),
    labRef = useRef(lab),
    resultRef = useRef<((text: string) => void) | null>(null);
  labRef.current = lab;
  useEffect(() => {
    const state = deviceTerminalState(labRef.current.engine, deviceId);
    const cli = state.cli;
    stateRef.current = state;
    const term = new XTerm({
      fontFamily: 'Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.5,
      cursorBlink: true,
      convertEol: true,
      scrollback: 600,
      theme: {
        background: '#102333',
        foreground: '#dce8ef',
        cursor: '#5fd4d4',
        selectionBackground: '#34546a',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current!);
    fit.fit();
    type RenderOperation = { kind: 'write'; text: string } | { kind: 'redraw'; text: string; replay: string };
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
        writing = false;
        drain();
      });
    };
    const write = (text: string) => {
      pending.push({ kind: 'write', text });
      drain();
    };
    const redraw = (before = '') => {
      const input = state.prompt + ' ' + state.line;
      pending.push({ kind: 'redraw', text: before + input, replay: state.output + input });
      drain();
    };
    const result = (text: string) => {
      const output = text + '\r\n';
      appendTerminalOutput(state, output);
      state.prompt = cli.prompt;
      redraw(output);
    };
    resultRef.current = result;
    if (!state.initialized) {
      appendTerminalOutput(
        state,
        '\x1b[36mNetOS 1.0 · Terminal de simulação\x1b[0m\r\n' +
          'Digite help para ver os comandos disponíveis.\r\n\r\n'
      );
      state.initialized = true;
    }
    // Completed output has no transient input-editing controls. XTerm can reflow
    // it at the current width and render the current hostname/draft exactly once.
    state.prompt = cli.prompt;
    write(state.output + state.prompt + ' ' + state.line);
    const replaceLine = (text: string) => {
      state.line = text;
      state.prompt = cli.prompt;
      redraw();
    };
    const sub = term.onData((data) => {
      if (data === '\x1b[A') {
        state.historyIndex = Math.max(0, state.historyIndex - 1);
        replaceLine(cli.history[state.historyIndex] ?? '');
        return;
      }
      if (data === '\x1b[B') {
        state.historyIndex = Math.min(cli.history.length, state.historyIndex + 1);
        replaceLine(cli.history[state.historyIndex] ?? '');
        return;
      }
      if (data.startsWith('\x1b')) return;
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          const input = state.line;
          appendTerminalOutput(state, state.prompt + ' ' + input + '\r\n');
          state.line = '';
          const output = labRef.current.change(
            () => cli.execute(input),
            !/^(show|help|\?|ping|traceroute|nslookup|tcp|http)/i.test(input)
          );
          if (output) appendTerminalOutput(state, output + '\r\n');
          if (output?.startsWith('DNS [')) {
            const query = labRef.current.engine.device(deviceId).dnsQueries?.at(-1);
            if (query && query.status !== 'pending' && output.includes(query.id)) state.seen.add(query.id);
          }
          state.historyIndex = cli.history.length;
          state.prompt = cli.prompt;
          write('\r\n' + (output ? output + '\r\n' : '') + state.prompt + ' ');
        } else if (ch === '\x7f') {
          if (state.line) {
            replaceLine(state.line.slice(0, -1));
          }
        } else if (ch === '\x03') {
          appendTerminalOutput(state, state.prompt + ' ' + state.line + '^C\r\n');
          state.line = '';
          state.prompt = cli.prompt;
          write('^C\r\n' + state.prompt + ' ');
        } else if (ch >= ' ' && ch <= '~' && state.line.length < 512) {
          state.line += ch;
          write(ch);
        }
      }
    });
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* Host can be hidden during teardown. */
      }
    });
    observer.observe(ref.current!);
    term.focus();
    return () => {
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
  return <div className="terminal-host" ref={ref} aria-label="Terminal NetOS" />;
}
