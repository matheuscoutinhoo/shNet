import { Pool, type PoolClient } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
export interface Database {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  subscribe?(
    channel: string,
    callback: (payload: string) => void,
    status?: (connected: boolean) => void
  ): Promise<() => Promise<void>>;
}
function pgConnection(client: Pool | PoolClient): Database {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return (await client.query(sql, params)).rows as T[];
    },
    async transaction<T>(fn: (db: Database) => Promise<T>) {
      const connection = client instanceof Pool ? await client.connect() : client;
      try {
        await connection.query('BEGIN');
        const result = await fn(pgConnection(connection));
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        if (client instanceof Pool) connection.release();
      }
    },
    async close() {
      if ('end' in client) await client.end();
    },
  };
}
export function createPostgres(url: string): Database {
  const pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000 });
  return {
    ...pgConnection(pool),
    async subscribe(channel, callback, status) {
      if (!/^[a-z_]{1,40}$/.test(channel)) throw new Error('Canal inválido.');
      let client: PoolClient | undefined,
        closed = false,
        retry: NodeJS.Timeout | undefined,
        delay = 1000;
      const reconnect = () => {
        if (closed || retry) return;
        retry = setTimeout(() => {
          retry = undefined;
          void connect().catch(() => {
            delay = Math.min(30000, delay * 2);
            reconnect();
          });
        }, delay);
        retry.unref();
      };
      const connect = async () => {
        const connection = await pool.connect();
        if (closed) {
          connection.release();
          return;
        }
        client = connection;
        connection.on('notification', (event) => {
          if (event.channel === channel && event.payload) callback(event.payload);
        });
        connection.on('error', () => {
          if (client === connection) {
            client = undefined;
            connection.release(true);
            status?.(false);
            reconnect();
          }
        });
        try {
          await connection.query('LISTEN ' + channel);
          delay = 1000;
          status?.(true);
        } catch (error) {
          if (client === connection) {
            client = undefined;
            connection.release(true);
          }
          throw error;
        }
      };
      await connect();
      return async () => {
        closed = true;
        if (retry) clearTimeout(retry);
        const connection = client;
        client = undefined;
        if (connection) {
          try {
            await connection.query('UNLISTEN ' + channel);
          } finally {
            connection.release();
          }
        }
      };
    },
  };
}
export async function createEmbedded(path?: string): Promise<Database> {
  if (path) await mkdir(dirname(path), { recursive: true });
  const pg = new PGlite(path);
  const wrap = (db: Pick<PGlite, 'query' | 'transaction'>): Database => ({
    async query<T>(sql: string, params: unknown[] = []) {
      return (await db.query<T>(sql, params)).rows;
    },
    async transaction<T>(fn: (db: Database) => Promise<T>) {
      return db.transaction((tx) => fn(wrap(tx as unknown as PGlite)));
    },
    async close() {
      await pg.close();
    },
  });
  await pg.waitReady;
  return {
    ...wrap(pg),
    subscribe: async (channel, callback, status) => {
      const close = await pg.listen(channel, callback);
      status?.(true);
      return () => close();
    },
  };
}
export async function migrate(db: Database) {
  const directory = new URL('../migrations/', import.meta.url);
  const migrations = (await readdir(directory))
    .filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
    .map((file) => ({ file, version: Number(file.split('_')[0]) }))
    .sort((left, right) => left.version - right.version);
  if (new Set(migrations.map((entry) => entry.version)).size !== migrations.length)
    throw new Error('Migration duplicada.');
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
  );
  await db.transaction(async (tx) => {
    await tx.query('LOCK TABLE schema_migrations IN EXCLUSIVE MODE');
    const applied = new Set(
      (await tx.query<{ version: number }>('SELECT version FROM schema_migrations')).map(
        (entry) => entry.version
      )
    );
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      const sql = await readFile(new URL(migration.file, directory), 'utf8');
      for (const statement of sql
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean))
        await tx.query(statement);
      await tx.query('INSERT INTO schema_migrations(version) VALUES($1)', [migration.version]);
    }
  });
}
