import { z } from 'zod';
import type { SimulationEngine } from '../core/engine';
import type { Device, Snapshot, TcpConnection } from '../model';
import { databaseConfigSchema, databaseNameSchema, databaseValueSchema } from './database-model';
import { configureTcpService } from './tcp-services';
import { httpMessage, respondHttp } from './applications-http';
import { openTcp } from './tcp';
import { tcpBytes } from './tcp-model';

export function configureDatabase(e: SimulationEngine, d: Device, input: unknown) {
  const c = databaseConfigSchema.parse(input);
  if (
    d.tcpServices?.some(
      (s) => s.port === c.port && s.enabled && !(s.kind === 'database' && s.port === d.database?.port)
    )
  )
    throw new Error('Porta ocupada por outro serviço TCP.');
  configureTcpService(e, d, { enabled: c.enabled, port: c.port, kind: 'database' });
  if (d.database && d.database.port !== c.port)
    d.tcpServices = d.tcpServices?.filter((s) => s.port !== d.database!.port);
  d.database = {
    ...c,
    tables: d.database?.tables ?? [],
    queries: d.database?.queries ?? 0,
    rejected: d.database?.rejected ?? 0,
  };
}
type Value = z.infer<typeof databaseValueSchema>;
function name(text: string) {
  return databaseNameSchema.parse(text.trim().toLowerCase());
}
function values(text: string): Value[] {
  const result: Value[] = [];
  let rest = text.trim();
  while (rest) {
    const match = /^(?:'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)|(true|false|null))\s*(,|$)/i.exec(rest);
    if (!match) throw new Error('Valores SQL: texto entre aspas simples, número, booleano ou NULL.');
    result.push(
      databaseValueSchema.parse(
        match[1] !== undefined
          ? match[1].replace(/''/g, "'")
          : match[2] !== undefined
            ? Number(match[2])
            : match[3].toLowerCase() === 'null'
              ? null
              : match[3].toLowerCase() === 'true'
      )
    );
    rest = rest.slice(match[0].length).trim();
    if (match[4] && !rest) throw new Error('Valor ausente.');
  }
  return result;
}
// Gramática limitada, sem eval, sockets ou acesso a um SGBD real.
export function executeDatabase(d: Device, input: string) {
  const db = d.database;
  if (!db?.enabled) throw new Error('Banco de dados indisponível.');
  const sql = z.string().min(1).max(2048).parse(input).trim().replace(/;$/, '');
  let m = /^CREATE TABLE ([a-z][\w]*)\s*\(([^)]+)\)$/i.exec(sql);
  if (m) {
    const table = name(m[1]),
      columns = m[2].split(',').map(name);
    if (
      db.tables.length >= 16 ||
      db.tables.some((t) => t.name === table) ||
      columns.length > 16 ||
      new Set(columns).size !== columns.length
    )
      throw new Error('Tabela duplicada ou limite de tabelas/colunas.');
    db.tables.push({ name: table, columns, rows: [] });
    return { affected: 0, columns, rows: [] };
  }
  m = /^INSERT INTO ([a-z][\w]*)\s*\(([^)]+)\)\s*VALUES\s*\((.*)\)$/i.exec(sql);
  if (m) {
    const table = db.tables.find((t) => t.name === name(m![1]));
    if (!table) throw new Error('Tabela inexistente.');
    const columns = m[2].split(',').map(name),
      vals = values(m[3]);
    if (
      table.rows.length >= 256 ||
      columns.length !== vals.length ||
      new Set(columns).size !== columns.length ||
      columns.some((c) => !table.columns.includes(c))
    )
      throw new Error('Colunas/valores inválidos ou tabela cheia.');
    const row = Object.fromEntries(table.columns.map((c) => [c, null])) as Record<string, Value>;
    columns.forEach((c, i) => {
      row[c] = vals[i];
    });
    table.rows.push(row);
    return { affected: 1, columns: [], rows: [] };
  }
  const selection =
    /^SELECT (\*|[a-z][\w]*(?:\s*,\s*[a-z][\w]*)*) FROM ([a-z][\w]*)(?: WHERE ([a-z][\w]*)\s*=\s*(.+?))?(?: LIMIT (\d+))?$/i.exec(
      sql
    );
  const update =
    /^UPDATE ([a-z][\w]*) SET ([a-z][\w]*)\s*=\s*(.+?)(?: WHERE ([a-z][\w]*)\s*=\s*(.+))?$/i.exec(sql);
  const deletion = /^DELETE FROM ([a-z][\w]*)(?: WHERE ([a-z][\w]*)\s*=\s*(.+))?$/i.exec(sql);
  const tableName = selection?.[2] ?? update?.[1] ?? deletion?.[1];
  if (!tableName)
    throw new Error('Use CREATE TABLE, INSERT, SELECT, UPDATE ou DELETE na gramática documentada.');
  const table = db.tables.find((t) => t.name === name(tableName));
  if (!table) throw new Error('Tabela inexistente.');
  const where = selection?.[3] ?? update?.[4] ?? deletion?.[2],
    raw = selection?.[4] ?? update?.[5] ?? deletion?.[3];
  const predicate = where ? name(where) : undefined;
  const value = raw !== undefined ? values(raw) : [];
  if (predicate && (!table.columns.includes(predicate) || value.length !== 1))
    throw new Error('WHERE inválido.');
  const matches = (r: Record<string, Value>) => !predicate || r[predicate] === value[0];
  if (selection) {
    const columns = selection[1] === '*' ? table.columns : selection[1].split(',').map(name),
      limit = Number(selection[5] ?? 100);
    if (columns.some((c) => !table.columns.includes(c)) || limit < 1 || limit > 100)
      throw new Error('SELECT: coluna inexistente ou LIMIT fora de 1..100.');
    const rows = table.rows
      .filter(matches)
      .slice(0, limit)
      .map((r) => Object.fromEntries(columns.map((c) => [c, r[c]])));
    const output = { affected: 0, columns, rows };
    if (tcpBytes(JSON.stringify(output)) > 10000)
      throw new Error('Resposta excede 10000 bytes; selecione menos colunas/linhas.');
    return output;
  }
  const rows = table.rows.filter(matches);
  if (update) {
    const column = name(update[2]),
      vals = values(update[3]);
    if (!table.columns.includes(column) || vals.length !== 1) throw new Error('SET inválido.');
    rows.forEach((r) => {
      r[column] = vals[0];
    });
  } else table.rows = table.rows.filter((r) => !matches(r));
  return { affected: rows.length, columns: [], rows: [] };
}
export function receiveDatabase(e: SimulationEngine, d: Device, c: TcpConnection) {
  if (c.role !== 'server' || c.httpHandled) return;
  try {
    const request = httpMessage(c.received);
    if (!request) return;
    c.httpHandled = true;
    if (
      request.line !== 'POST /query HTTP/1.1' ||
      !/^Content-Type: application\/json\s*$/im.test(request.header)
    ) {
      respondHttp(e, d, c, '400 Bad Request', 'Use POST /query com application/json.');
      return;
    }
    const auth = [...request.header.matchAll(/^Authorization: Bearer ([^\r\n]+)\s*$/gim)];
    if (auth.length !== 1 || auth[0][1] !== d.database?.key) {
      if (d.database) d.database.rejected++;
      respondHttp(e, d, c, '401 Unauthorized', 'Chave de acesso inválida.');
      return;
    }
    const { query } = z
      .object({ query: z.string().min(1).max(2048) })
      .strict()
      .parse(JSON.parse(request.body));
    const output = executeDatabase(d, query);
    d.database!.queries++;
    respondHttp(e, d, c, '200 OK', JSON.stringify(output), 'application/json');
  } catch (error) {
    c.httpHandled = true;
    if (d.database) d.database.rejected++;
    respondHttp(
      e,
      d,
      c,
      '400 Bad Request',
      JSON.stringify({ error: error instanceof Error ? error.message : 'Consulta inválida.' }),
      'application/json'
    );
  }
}
export function queryDatabase(
  e: SimulationEngine,
  d: Device,
  target: string,
  query: string,
  key: string,
  port = 8080
) {
  z.string()
    .min(8)
    .max(128)
    .regex(/^[^\r\n]+$/)
    .parse(key);
  z.string().min(1).max(2048).parse(query);
  const body = JSON.stringify({ query });
  return openTcp(
    e,
    d,
    target,
    port,
    `POST /query HTTP/1.1\r\nHost: ${target}\r\nContent-Type: application/json\r\nAuthorization: Bearer ${key}\r\nContent-Length: ${tcpBytes(body)}\r\nConnection: close\r\n\r\n${body}`,
    true
  );
}
export function validateDatabase(s: Snapshot) {
  for (const d of s.devices) {
    const db = d.database;
    if (!db) continue;
    if (
      !d.tcpServices?.some((t) => t.kind === 'database' && t.port === db.port && t.enabled === db.enabled) ||
      new Set(db.tables.map((t) => t.name)).size !== db.tables.length
    )
      throw new Error('Banco: listener ou tabela duplicada.');
    for (const t of db.tables)
      if (
        new Set(t.columns).size !== t.columns.length ||
        t.rows.some(
          (r) =>
            Object.keys(r).length !== t.columns.length || Object.keys(r).some((k) => !t.columns.includes(k))
        )
      )
        throw new Error('Banco: colunas/linhas inválidas.');
  }
}
