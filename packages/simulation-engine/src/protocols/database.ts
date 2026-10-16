import { z } from 'zod';
import type { SimulationEngine } from '../core/engine';
import type { Device, Snapshot, TcpConnection } from '../model';
import { databaseConfigSchema } from './database-model';
import { executeSql } from './database-sql';
import { submitDatabaseHa } from './database-ha';
import { configureTcpService } from './tcp-services';
import { httpMessage, respondHttp } from './applications-http';
import { openTcp } from './tcp';
import { tcpBytes } from './tcp-model';

export function configureDatabase(e: SimulationEngine, d: Device, input: unknown) {
  const c = databaseConfigSchema.parse(input);
  if (d.databaseHa && (c.key !== d.database?.key || c.port !== d.database?.port))
    throw new Error('Banco replicado: porta e chave permanecem fixas até remover o grupo.');
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
  e.refreshVrrp();
}
export function executeDatabase(d: Device, input: string) {
  if (!d.database?.enabled) throw new Error('Banco de dados indisponível.');
  if (d.databaseHa) throw new Error('Banco replicado exige consulta pela rede e confirmação da maioria.');
  return executeSql(d.database, input);
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
    if (d.databaseHa) {
      submitDatabaseHa(e, d, c, query);
      return;
    }
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
