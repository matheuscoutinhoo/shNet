import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createPostgres } from '../apps/api/src/db';

const magic = Buffer.from('SHLABBK1');
const legacyMagic = Buffer.from('SHNETBK1');
const maxBytes = 2 * 1024 ** 3;
export function backupKey(value: string | undefined) {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('BACKUP_KEY exige 32 bytes em base64.');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('BACKUP_KEY inválida.');
  return key;
}
export function postgresEnvironment(address: string) {
  const url = new URL(address);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !/^\/[a-zA-Z0-9_-]+$/.test(url.pathname) ||
    url.hash
  )
    throw new Error('URL PostgreSQL inválida.');
  const sslmode = url.searchParams.get('sslmode') ?? 'prefer';
  if (
    !['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(sslmode) ||
    [...url.searchParams.keys()].some((k) => k !== 'sslmode')
  )
    throw new Error('Use apenas sslmode na URL; configure certificados via PGSSLROOTCERT.');
  return {
    ...process.env,
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: url.port || '5432',
    PGDATABASE: url.pathname.slice(1),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: sslmode,
    PGCONNECT_TIMEOUT: '5',
  };
}
async function command(program: string, args: string[], env: NodeJS.ProcessEnv, input?: string) {
  const child = spawn(program, args, {
    env,
    windowsHide: true,
    timeout: 1800000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  const finished = new Promise<void>((ok, fail) => {
    child.on('error', () => fail(new Error('Executável PostgreSQL indisponível.')));
    child.on('exit', (code) =>
      code === 0
        ? ok()
        : fail(new Error('Ferramenta PostgreSQL falhou; confira acesso, versão e permissões.'))
    );
  });
  if (input) await Promise.all([pipeline(createReadStream(input), child.stdin), finished]);
  else {
    child.stdin.end();
    await finished;
  }
}
export async function decryptBackup(archive: string, plaintext: string, key: Buffer) {
  const size = (await stat(archive)).size;
  if (size < 36 || size > maxBytes) throw new Error('Arquivo de backup inválido ou acima de 2 GiB.');
  const file = await open(archive, 'r');
  const header = Buffer.alloc(20),
    tag = Buffer.alloc(16);
  try {
    await file.read(header, 0, 20, 0);
    await file.read(tag, 0, 16, size - 16);
  } finally {
    await file.close();
  }
  if (!header.subarray(0, 8).equals(magic) && !header.subarray(0, 8).equals(legacyMagic))
    throw new Error('Formato de backup desconhecido.');
  const cipher = createDecipheriv('aes-256-gcm', key, header.subarray(8));
  cipher.setAAD(header);
  cipher.setAuthTag(tag);
  const plain = await open(plaintext, 'wx', 0o600);
  try {
    await pipeline(
      createReadStream(archive, { start: 20, end: size - 17 }),
      cipher,
      plain.createWriteStream()
    );
  } catch (error) {
    await rm(plaintext, { force: true });
    throw error;
  }
}
export async function backupDatabase(
  address: string,
  destination: string,
  key: Buffer,
  program = process.env.PG_DUMP_PATH ?? 'pg_dump'
) {
  const env = postgresEnvironment(address),
    target = resolve(destination),
    partial = target + '.partial';
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  // Neither an existing backup nor another process's partial file is replaced.
  const reserved = await open(target, 'wx', 0o600);
  await reserved.close();
  let partialFile;
  try {
    partialFile = await open(partial, 'wx', 0o600);
  } catch (error) {
    await rm(target);
    throw error;
  }
  const header = Buffer.concat([magic, randomBytes(12)]),
    cipher = createCipheriv('aes-256-gcm', key, header.subarray(8));
  cipher.setAAD(header);
  const output = partialFile.createWriteStream();
  output.write(header);
  const child = spawn(program, ['--format=custom', '--no-owner', '--no-privileges'], {
    env,
    windowsHide: true,
    timeout: 1800000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const finished = new Promise<void>((ok, fail) => {
    child.on('error', () => fail(new Error('pg_dump indisponível.')));
    child.on('exit', (code) => (code === 0 ? ok() : fail(new Error('pg_dump falhou.'))));
  });
  let total = 36;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) callback(new Error('Backup excede 2 GiB.'));
      else callback(null, chunk);
    },
  });
  const streaming = pipeline(child.stdout, bounded, cipher, output);
  let completed = false;
  try {
    await Promise.all([streaming, finished]);
    const handle = await open(partial, 'a');
    try {
      await handle.write(cipher.getAuthTag());
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await stat(partial)).size > maxBytes) throw new Error('Backup excede 2 GiB.');
    // The zero-byte reservation is ours; rename is atomic on the same volume.
    await rename(partial, target);
    completed = true;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    const report = {
      version: 1,
      completedAt: new Date().toISOString(),
      bytes: (await stat(target)).size,
      sha256: hash.digest('hex'),
    };
    await writeFile(target + '.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return report;
  } catch (error) {
    child.kill();
    await Promise.allSettled([streaming, finished]);
    await rm(partial, { force: true });
    if (!completed) await rm(target, { force: true });
    throw error;
  }
}
export async function restoreDatabase(
  source: string,
  target: string,
  confirmation: string,
  archive: string,
  key: Buffer,
  program = process.env.PG_RESTORE_PATH ?? 'pg_restore'
) {
  const from = postgresEnvironment(source),
    to = postgresEnvironment(target);
  if (to.PGDATABASE === from.PGDATABASE || confirmation !== to.PGDATABASE)
    throw new Error('Restauração exige banco distinto e RESTORE_CONFIRM_DATABASE idêntico ao destino.');
  const db = createPostgres(target),
    plain = resolve(archive) + '.restore-' + randomBytes(8).toString('hex');
  try {
    const tables = await db.query(
      "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f') LIMIT 1"
    );
    if (tables.length) throw new Error('Destino deve estar vazio; nenhum objeto será apagado.');
    // Authentication completes before pg_restore can receive any plaintext.
    await decryptBackup(archive, plain, key);
    await command(
      program,
      ['--dbname', to.PGDATABASE, '--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error'],
      to,
      plain
    );
  } finally {
    await db.close();
    await rm(plain, { force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2],
    archive = process.argv[3],
    address = process.env.DATABASE_URL,
    key = backupKey(process.env.BACKUP_KEY);
  if (!address || !archive) throw new Error('Use backup.ts backup|restore ARQUIVO e DATABASE_URL.');
  if (mode === 'backup')
    process.stdout.write(JSON.stringify(await backupDatabase(address, archive, key)) + '\n');
  else if (mode === 'restore' && process.env.RESTORE_DATABASE_URL) {
    await restoreDatabase(
      address,
      process.env.RESTORE_DATABASE_URL,
      process.env.RESTORE_CONFIRM_DATABASE ?? '',
      archive,
      key
    );
    process.stdout.write('Restauração concluída em banco separado.\n');
  } else throw new Error('Restauração exige RESTORE_DATABASE_URL e RESTORE_CONFIRM_DATABASE.');
}
