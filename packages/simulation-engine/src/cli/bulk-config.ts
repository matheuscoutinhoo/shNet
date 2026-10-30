import type { SimulationEngine } from '../core/engine';
import { changedSince } from '../core/state-mark';
import { validateSnapshot } from '../core/validation';
import { refreshInterfacePat } from '../protocols/nat';
import { siteOf } from '../topology-sites';
import { makeRegistry } from './commands';
import { deviceConfigDiff } from './config-diff';
import type { Context } from './registry';
import { cliErrorText, TerminalSession } from './terminal';

export interface BulkResult {
  device: string;
  hostname: string;
  status: 'applied' | 'failed';
  lines: number;
  error?: { number: number; line: string; message: string };
}
export const BULK_LIMITS = { devices: 500, lines: 400 } as const;
const FORBIDDEN = /^(?:do\s+)?(?:reload|erase|delete|format|write erase|configure replace)(?:\s|$)/i;

/** Header row must contain "hostname"; columns may be separated by comma, semicolon or tab. */
export function parseVariableTable(text: string) {
  const rows = text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row && !row.startsWith('#'));
  const table = new Map<string, Record<string, string>>();
  if (!rows.length) return table;
  const separator = rows[0].includes('\t') ? '\t' : rows[0].includes(';') ? ';' : ',';
  const header = rows[0].split(separator).map((cell) => cell.trim().toLowerCase());
  const key = header.indexOf('hostname');
  if (key < 0) throw new Error('A tabela de variáveis precisa de uma coluna "hostname".');
  for (const [index, row] of rows.slice(1).entries()) {
    const cells = row.split(separator).map((cell) => cell.trim());
    if (cells.length !== header.length)
      throw new Error(
        'Linha ' +
          (index + 2) +
          ' da tabela tem ' +
          cells.length +
          ' colunas; esperado ' +
          header.length +
          '.'
      );
    table.set(cells[key].toLowerCase(), Object.fromEntries(header.map((name, i) => [name, cells[i]])));
  }
  return table;
}
/** Running-config vs startup-config changes for one device (inspector view). */
export function configChanges(engine: SimulationEngine, id: string) {
  return deviceConfigDiff(engine, engine.device(id), makeRegistry());
}
/** Replaces {{name}} placeholders; every placeholder must have a value. */
export function renderTemplate(template: string, vars: Record<string, string>) {
  const missing = new Set<string>();
  const text = template.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_match, name: string) => {
    const value = vars[name.toLowerCase()];
    if (value === undefined) missing.add(name);
    return value ?? '';
  });
  if (missing.size)
    throw new Error('Variável sem valor: ' + [...missing].map((name) => '{{' + name + '}}').join(', '));
  return text;
}
function commandLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ number: index + 1, line: line.trim() }))
    .filter(({ line }) => line && !line.startsWith('!'));
}
/**
 * Applies one configuration template to many devices from global configuration mode.
 * Each device is atomic: if any line or the resulting state is invalid, that device is
 * restored and the first failing line is reported. Other devices are unaffected.
 * Built-in variables: {{hostname}}, {{site}}, {{index}} (1-based in the given order).
 */
export function applyBulkConfig(
  engine: SimulationEngine,
  deviceIds: string[],
  template: string,
  table = new Map<string, Record<string, string>>()
): BulkResult[] {
  if (!deviceIds.length) throw new Error('Selecione pelo menos um equipamento.');
  if (deviceIds.length > BULK_LIMITS.devices)
    throw new Error('Configuração em massa aceita até ' + BULK_LIMITS.devices + ' equipamentos por vez.');
  if (commandLines(template).length > BULK_LIMITS.lines)
    throw new Error('O modelo aceita até ' + BULK_LIMITS.lines + ' linhas de comando.');
  const registry = makeRegistry();
  return deviceIds.map((id, index) => {
    const d = engine.device(id),
      hostname = d.hostname;
    const fail = (error: BulkResult['error'], lines = 0): BulkResult => ({
      device: id,
      hostname,
      status: 'failed',
      lines,
      error,
    });
    let lines: { number: number; line: string }[];
    try {
      lines = commandLines(
        renderTemplate(template, {
          site: siteOf(hostname) ?? '',
          ...table.get(hostname.toLowerCase()),
          hostname,
          index: String(index + 1),
        })
      );
    } catch (error) {
      return fail({ number: 0, line: '', message: cliErrorText(error) });
    }
    const forbidden = lines.find(({ line }) => FORBIDDEN.test(line));
    if (forbidden)
      return fail({ ...forbidden, message: 'Comando não permitido em configuração em massa.' }, lines.length);
    if (!['router', 'switch'].includes(d.type))
      return fail(
        { number: 0, line: '', message: 'Equipamento sem modo de configuração IOS.' },
        lines.length
      );
    const mark = engine.mark();
    try {
      const context: Context = { mode: 'config' };
      for (const { line } of lines)
        registry.execute(
          registry.normalize(line, engine.device(id), context),
          engine,
          engine.device(id),
          context
        );
      refreshInterfacePat(engine, engine.device(id));
      engine.refreshSpanningTree();
      engine.refreshBgp();
      const changed = changedSince(mark, engine.state);
      validateSnapshot(engine.state, changed ? { changed } : { trustedLogs: true });
      engine.emit('CONFIG_CHANGED', id, 'Configuração em massa aplicada: ' + lines.length + ' linhas.');
      return { device: id, hostname, status: 'applied', lines: lines.length };
    } catch (error) {
      engine.restore(mark);
      // Replay line by line, with the terminal's own checks, only to name the failing line.
      const session = new TerminalSession(engine, id);
      session.context = { mode: 'config' };
      let failure: BulkResult['error'];
      for (const entry of lines) {
        const output = session.execute(entry.line);
        if (output.startsWith('% ')) {
          failure = { ...entry, message: output.slice(2) };
          break;
        }
      }
      engine.restore(mark);
      return fail(failure ?? { number: 0, line: '', message: cliErrorText(error) }, lines.length);
    }
  });
}
