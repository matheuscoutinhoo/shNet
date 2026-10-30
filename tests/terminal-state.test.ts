import { describe, expect, it } from 'vitest';
import { SimulationEngine } from '@shlab/engine';
import {
  TERMINAL_OUTPUT_LIMIT,
  appendTerminalOutput,
  deviceTerminalState,
  terminalInputErase,
} from '../apps/web/src/workspace/terminalState';

describe('terminal por dispositivo na sessão do laboratório', () => {
  it('retém saída ANSI, edição, histórico e contexto CLI ao voltar ao dispositivo', () => {
    const engine = new SimulationEngine();
    const device = engine.addDevice('switch');
    const terminal = deviceTerminalState(engine, device.id);
    terminal.cli.execute('enable');
    terminal.cli.execute('configure terminal');
    appendTerminalOutput(terminal, '\x1b[36mConsole\x1b[0m\r\n');
    terminal.line = 'host';
    terminal.prompt = terminal.cli.prompt;
    terminal.initialized = true;
    terminal.historyIndex = 1;
    terminal.seen.add('completed-query');

    const reopened = deviceTerminalState(engine, device.id);
    expect(reopened.output).toBe('\x1b[36mConsole\x1b[0m\r\n');
    expect(reopened.line).toBe('host');
    expect(reopened.prompt).toBe(device.hostname + '(config)#');
    expect(reopened.initialized).toBe(true);
    expect(reopened.historyIndex).toBe(1);
    expect(reopened.seen.has('completed-query')).toBe(true);
    expect(reopened.cli.history).toEqual(['enable', 'configure terminal']);
    expect(reopened.cli.execute('hostname PERSISTED')).toBe('');
    expect(device.hostname).toBe('PERSISTED');
    expect(reopened.cli.prompt).toBe('PERSISTED(config)#');
  });

  it('não mistura dois dispositivos nem dois laboratórios com o mesmo ID', () => {
    const firstLab = new SimulationEngine();
    const first = firstLab.addDevice('pc');
    const second = firstLab.addDevice('router');
    const firstTerminal = deviceTerminalState(firstLab, first.id);
    appendTerminalOutput(firstTerminal, 'Primeiro console\r\n');
    firstTerminal.cli.execute('enable');
    const secondTerminal = deviceTerminalState(firstLab, second.id);
    appendTerminalOutput(secondTerminal, 'Segundo console\r\n');
    expect(deviceTerminalState(firstLab, first.id).output).toBe('Primeiro console\r\n');
    expect(secondTerminal.cli.context.mode).toBe('user');
    expect(secondTerminal.cli.history).toEqual([]);

    const reopenedLab = new SimulationEngine(firstLab.snapshot());
    const reopened = deviceTerminalState(reopenedLab, first.id);
    expect(reopened.output).toBe('');
    expect(reopened.cli.context.mode).toBe('user');
    expect(reopened.cli.history).toEqual([]);
    expect(firstLab.snapshot()).not.toHaveProperty('terminal');
  });

  it('limita saída antiga sem cortar linhas ANSI e preserva a saída e a edição recentes', () => {
    const engine = new SimulationEngine();
    const device = engine.addDevice('pc');
    const terminal = deviceTerminalState(engine, device.id);
    appendTerminalOutput(terminal, 'Linha antiga\r\n');
    const row = '\x1b[36m' + 'a'.repeat(1000) + '\x1b[0m\r\n';
    for (let index = 0; index < 300; index++) appendTerminalOutput(terminal, row);
    const last = 'Resposta atual\r\n';
    terminal.line = 'show';
    appendTerminalOutput(terminal, last);
    expect(terminal.output.length).toBeLessThanOrEqual(TERMINAL_OUTPUT_LIMIT);
    expect(terminal.output).not.toContain('Linha antiga');
    expect(terminal.output.startsWith('\x1b[36m')).toBe(true);
    expect(terminal.output.endsWith(last)).toBe(true);
    expect(terminal.line).toBe('show');
  });

  it('descarta sessões de dispositivos excluídos ao abrir outro console', () => {
    const engine = new SimulationEngine();
    const first = engine.addDevice('pc');
    const second = engine.addDevice('pc');
    const firstTerminal = deviceTerminalState(engine, first.id);
    appendTerminalOutput(firstTerminal, 'Dispositivo excluído\r\n');
    const before = engine.snapshot();
    engine.state.devices = engine.state.devices.filter((device) => device.id !== first.id);
    deviceTerminalState(engine, second.id);
    engine.state = before;
    expect(deviceTerminalState(engine, first.id).output).toBe('');
  });

  it('reconhece o início lógico após reflow para apagar todas as linhas de um draft longo', () => {
    const buffer = {
      baseY: 20,
      cursorY: 5,
      getLine: (index: number) => ({ isWrapped: index >= 23 && index <= 25 }),
    };
    expect(terminalInputErase(buffer)).toBe('\x1b[3A\r\x1b[J');
    // Narrowing the terminal reflows the same draft into more physical rows.
    buffer.getLine = (index: number) => ({ isWrapped: index >= 21 && index <= 25 });
    expect(terminalInputErase(buffer)).toBe('\x1b[5A\r\x1b[J');
    buffer.getLine = () => ({ isWrapped: false });
    expect(terminalInputErase(buffer)).toBe('\r\x1b[J');
  });

  it('exige replay quando o draft ocupa linhas anteriores ao viewport', () => {
    const buffer = {
      baseY: 20,
      cursorY: 2,
      getLine: (index: number) => ({ isWrapped: index >= 18 && index <= 22 }),
    };
    expect(terminalInputErase(buffer)).toBeNull();
  });

  it('preserva a saída recente mesmo quando uma única linha ultrapassa o limite', () => {
    const engine = new SimulationEngine();
    const terminal = deviceTerminalState(engine, engine.addDevice('pc').id);
    appendTerminalOutput(terminal, 'x'.repeat(TERMINAL_OUTPUT_LIMIT + 100) + '\r\n');
    expect(terminal.output.length).toBe(TERMINAL_OUTPUT_LIMIT);
    expect(terminal.output.endsWith('\r\n')).toBe(true);
    expect(terminal.output.length).toBeGreaterThan(0);
  });
});
