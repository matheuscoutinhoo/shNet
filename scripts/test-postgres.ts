import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const credentials = JSON.parse(
  (await readFile('.data/test-postgres/connection.json', 'utf8')).replace(/^\uFEFF/, '')
);
const env = {
  ...process.env,
  TEST_DATABASE_URL: `postgresql://${credentials.user}:${encodeURIComponent(credentials.password)}@127.0.0.1:${credentials.port}/${credentials.database}?sslmode=disable`,
  PG_DUMP_PATH: resolve('.data/tools/pgsql/bin/pg_dump.exe'),
  PG_RESTORE_PATH: resolve('.data/tools/pgsql/bin/pg_restore.exe'),
};
const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...process.argv.slice(2)], {
  env,
  windowsHide: true,
  stdio: 'inherit',
});
child.on('exit', (code) => (process.exitCode = code ?? 1));
child.on('error', () => (process.exitCode = 1));
