import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  TerminalSession,
  formatDnsQuery,
  formatTcpConnection,
  formatSnmpQuery,
  tcpFinished,
} from '@shlab/engine';
import type { LabController } from './useLab';
import '@xterm/xterm/css/xterm.css';
export function Terminal({ lab, deviceId }: { lab: LabController; deviceId: string }) {
  const ref = useRef<HTMLDivElement>(null),
    terminal = useRef<XTerm | null>(null),
    session = useRef<TerminalSession | null>(null),
    line = useRef(''),
    labRef = useRef(lab),
    seen = useRef(new Set<string>());
  labRef.current = lab;
  useEffect(() => {
    const cli = new TerminalSession(labRef.current.engine, deviceId);
    session.current = cli;
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
    terminal.current = term;
    term.writeln('\x1b[36mNetOS 1.0 · Terminal de simulação\x1b[0m');
    term.writeln('Digite help para ver os comandos disponíveis.\n');
    term.write(cli.prompt + ' ');
    let historyIndex = 0;
    const replaceLine = (text: string) => {
      term.write('\r\x1b[2K' + cli.prompt + ' ' + text);
      line.current = text;
    };
    const sub = term.onData((data) => {
      if (data === '\x1b[A') {
        historyIndex = Math.max(0, historyIndex - 1);
        replaceLine(cli.history[historyIndex] ?? '');
        return;
      }
      if (data === '\x1b[B') {
        historyIndex = Math.min(cli.history.length, historyIndex + 1);
        replaceLine(cli.history[historyIndex] ?? '');
        return;
      }
      if (data.startsWith('\x1b')) return;
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          term.writeln('');
          const input = line.current;
          line.current = '';
          const result = labRef.current.change(
            () => cli.execute(input),
            !/^(show|help|\?|ping|traceroute|nslookup|tcp|http)/i.test(input)
          );
          if (result) term.writeln(result);
          if (result?.startsWith('DNS [')) {
            const query = labRef.current.engine.device(deviceId).dnsQueries?.at(-1);
            if (query && query.status !== 'pending' && result.includes(query.id)) seen.current.add(query.id);
          }
          historyIndex = cli.history.length;
          term.write(cli.prompt + ' ');
        } else if (ch === '\x7f') {
          if (line.current) {
            line.current = line.current.slice(0, -1);
            term.write('\b \b');
          }
        } else if (ch === '\x03') {
          term.writeln('^C');
          line.current = '';
          term.write(cli.prompt + ' ');
        } else if (ch >= ' ' && ch <= '~' && line.current.length < 512) {
          line.current += ch;
          term.write(ch);
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
      sub.dispose();
      observer.disconnect();
      term.dispose();
      terminal.current = null;
      line.current = '';
    };
  }, [deviceId]);
  useEffect(() => {
    const term = terminal.current,
      cli = session.current;
    if (!term || !cli) return;
    for (const connection of lab.engine.device(deviceId).tcpConnections ?? []) {
      if (
        connection.role !== 'client' ||
        (!tcpFinished(connection) && connection.state !== 'TIME-WAIT') ||
        seen.current.has(connection.id)
      )
        continue;
      seen.current.add(connection.id);
      term.write('\r\x1b[2K');
      term.writeln(formatTcpConnection(connection));
      term.write(cli.prompt + ' ' + line.current);
    }
    for (const query of lab.engine.device(deviceId).dnsQueries ?? []) {
      if (query.status === 'pending' || seen.current.has(query.id)) continue;
      seen.current.add(query.id);
      term.write('\r\x1b[2K');
      term.writeln(formatDnsQuery(query));
      term.write(cli.prompt + ' ' + line.current);
    }
    for (const query of lab.engine.device(deviceId).snmpQueries ?? []) {
      if (query.status === 'pending' || seen.current.has(query.id)) continue;
      seen.current.add(query.id);
      term.write('\r\x1b[2K');
      term.writeln(formatSnmpQuery(query));
      term.write(cli.prompt + ' ' + line.current);
    }
    for (const p of lab.engine.state.probes.filter(
      (p) => p.device === deviceId && p.status !== 'pending' && !seen.current.has(p.id)
    )) {
      seen.current.add(p.id);
      term.write('\r\x1b[2K');
      term.writeln(
        p.status === 'success'
          ? 'Reply from ' + p.responder + ': time=' + p.rtt?.toFixed(2) + 'ms TTL probe=' + p.ttl
          : 'Probe TTL ' + p.ttl + ': ' + p.status + (p.responder ? ' from ' + p.responder : '')
      );
      term.write(cli.prompt + ' ' + line.current);
    }
  }, [lab.tick, lab.engine, deviceId]);
  return <div className="terminal-host" ref={ref} aria-label="Terminal NetOS" />;
}
