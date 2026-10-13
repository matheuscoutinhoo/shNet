import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPostgres } from '../apps/api/src/db';
const credentials = JSON.parse(
  (await readFile('.data/test-postgres/connection.json', 'utf8')).replace(/^\uFEFF/, '')
);
if (!['shlab_test', 'netlab_test'].includes(credentials.database) || credentials.port !== 55438)
  throw new Error('Use o cluster local isolado de scripts/local-postgres.ps1.');
const name = 'shlab_test_validation_' + Date.now() + '_' + randomBytes(4).toString('hex');
if (!/^shlab_test_validation_\d+_[a-f0-9]{8}$/.test(name))
  throw new Error('Nome de banco de teste inválido.');
const root = `postgresql://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${credentials.port}/`;
const admin = createPostgres(root + 'postgres?sslmode=disable');
const env = {
  ...process.env,
  TEST_DATABASE_URL: root + name + '?sslmode=disable',
  PG_DUMP_PATH: resolve('.data/tools/pgsql/bin/pg_dump.exe'),
  PG_RESTORE_PATH: resolve('.data/tools/pgsql/bin/pg_restore.exe'),
};
let created = false;
try {
  await admin.query('CREATE DATABASE ' + name);
  created = true;
  process.exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', ...process.argv.slice(2)],
      {
        env,
        windowsHide: true,
        stdio: 'inherit',
      }
    );
    const interrupt = () => child.kill('SIGINT');
    process.on('SIGINT', interrupt);
    child.on('exit', (code) => {
      process.off('SIGINT', interrupt);
      resolve(code ?? 1);
    });
    child.on('error', (error) => {
      process.off('SIGINT', interrupt);
      reject(error);
    });
  });
} finally {
  // Only the unique database created by this invocation can be removed.
  if (created) await admin.query('DROP DATABASE ' + name);
  await admin.close();
}
