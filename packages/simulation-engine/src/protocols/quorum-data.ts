import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { canonicalScenarioJson } from '../canonical-json';
import { databaseTablesSchema } from './database-model';
import { executeSql } from './database-sql';

export const QUORUM_DATA_BYTES = 512 * 1024;
export const QUORUM_CHUNK_BYTES = 4096;
export const quorumId = z
  .string()
  .regex(/^[a-zA-Z0-9_.:-]{1,64}$/)
  .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value));
export const quorumCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('barrier') }).strict(),
  z.object({ kind: z.literal('put'), key: quorumId, value: z.string().max(4096) }).strict(),
  z.object({ kind: z.literal('delete'), key: quorumId }).strict(),
  z.object({ kind: z.literal('database'), query: z.string().min(1).max(2048) }).strict(),
]);
export type QuorumCommand = z.infer<typeof quorumCommandSchema>;
export const quorumDataSchema = z
  .object({
    values: z.record(quorumId, z.string().max(4096)),
    tables: databaseTablesSchema.refine(
      (tables) =>
        new Set(tables.map((t) => t.name)).size === tables.length &&
        tables.every(
          (t) =>
            new Set(t.columns).size === t.columns.length &&
            t.rows.every(
              (r) =>
                Object.keys(r).length === t.columns.length &&
                Object.keys(r).every((k) => t.columns.includes(k))
            )
        )
    ),
    sql: z.boolean(),
  })
  .strict()
  .refine((data) => data.sql || data.tables.length === 0);
export type QuorumData = z.infer<typeof quorumDataSchema>;
export const emptyQuorumData = (): QuorumData => ({ values: {}, tables: [], sql: false });
export const quorumDataBytes = (data: QuorumData) => new TextEncoder().encode(canonicalScenarioJson(data));
export const quorumDataHash = (data: QuorumData) => bytesToHex(sha256(quorumDataBytes(data)));
export const quorumHex = bytesToHex;
export const quorumUnhex = hexToBytes;
export function applyQuorumData(data: QuorumData, command: QuorumCommand) {
  if (command.kind === 'barrier') return { data };
  const next = {
    ...data,
    values: command.kind === 'put' || command.kind === 'delete' ? { ...data.values } : data.values,
    tables:
      command.kind === 'database' && !/^\s*SELECT\b/i.test(command.query)
        ? structuredClone(data.tables)
        : data.tables,
  };
  if (command.kind === 'put') next.values[command.key] = command.value;
  else if (command.kind === 'delete') delete next.values[command.key];
  else if (command.kind === 'database') {
    next.sql = true;
    try {
      return { data: next, output: executeSql(next, command.query) };
    } catch (error) {
      return { data: next, error: error instanceof Error ? error.message : 'Consulta inválida.' };
    }
  }
  return { data: next };
}
