import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  backupDatabase,
  backupKey,
  decryptBackup,
  postgresEnvironment,
  restoreDatabase,
} from '../scripts/backup';
import { createEmbedded, createPostgres, migrate, type Database } from '../apps/api/src/db';
import { buildApp } from '../apps/api/src/app';
import { makeTemplate } from '../packages/simulation-engine/src';
import type { FastifyInstance } from 'fastify';
import { publishBackupStatus } from '../scripts/backup-status';

it('lê backups anteriores à marca shLab mantendo a autenticação do conteúdo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shlab-legacy-')),
    archive = join(directory, 'legacy.shnet-backup'),
    plaintext = join(directory, 'restored'),
    key = randomBytes(32),
    header = Buffer.concat([Buffer.from('SHNETBK1'), randomBytes(12)]),
    data = Buffer.from('Backup anterior à mudança de marca.'),
    cipher = createCipheriv('aes-256-gcm', key, header.subarray(8));
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
    throw new Error('Temporary directory outside expected root');
  cipher.setAAD(header);
  const encrypted = Buffer.concat([header, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  try {
    await writeFile(archive, encrypted);
    await decryptBackup(archive, plaintext, key);
    expect(await readFile(plaintext)).toEqual(data);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('Operação e privacidade das métricas', () => {
  let db: Database,
    app: FastifyInstance,
    statusDirectory: string,
    failed = false,
    reportConnection: ((ok: boolean) => void) | undefined;
  beforeAll(async () => {
    db = await createEmbedded();
    await migrate(db);
    statusDirectory = await mkdtemp(join(tmpdir(), 'shlab-metrics-'));
    if (!resolve(statusDirectory).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Invalid temporary directory');
    await publishBackupStatus(join(statusDirectory, 'status.json'), {
      version: 1,
      completedAt: new Date().toISOString(),
      bytes: 120,
      sha256: 'a'.repeat(64),
    });
    const wrapped = {
      ...db,
      query: async <T>(sql: string, params?: unknown[]) => {
        if (failed && sql === 'SELECT 1') throw new Error('Database inaccessible');
        return db.query<T>(sql, params);
      },
      subscribe: async (_channel: string, _callback: (p: string) => void, status?: (ok: boolean) => void) => {
        reportConnection = status;
        status?.(true);
        return async () => {};
      },
    };
    app = await buildApp({
      db: wrapped,
      origin: 'https://lab.example.test',
      mailer: async () => {},
      metricsToken: 'm'.repeat(40),
      backupFile: join(statusDirectory, 'status.json'),
    });
    // The subscription callback can signal a disconnected database independently of SQL.
    app.get('/api/metric-fixture/:id', async () => ({ ok: true }));
    await app.ready();
  }, 20000);
  afterAll(async () => {
    await app?.close();
    await db?.close();
    if (statusDirectory) await rm(statusDirectory, { recursive: true, force: true });
  });
  it('mantém liveness e readiness separados; protege métricas e remove identificadores dos labels', async () => {
    expect((await app.inject('/api/live')).statusCode).toBe(200);
    expect((await app.inject('/api/ready')).statusCode).toBe(200);
    expect((await app.inject('/api/metrics')).statusCode).toBe(401);
    await app.inject('/api/metric-fixture/private-owner-id?token=private-secret');
    const metrics = await app.inject({
      url: '/api/metrics',
      headers: { authorization: 'Bearer ' + 'm'.repeat(40) },
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('shlab_ready 1');
    expect(metrics.body).toContain('route="/api/metric-fixture/:id"');
    expect(metrics.body).toContain('shlab_http_duration_seconds_bucket');
    expect(metrics.body).toMatch(/shlab_backup_last_success_timestamp_seconds [1-9]/);
    expect(metrics.body).not.toMatch(/private-owner|private-secret|Bearer/);
    await writeFile(join(statusDirectory, 'status.json'), '{"version":1,"completedAt":"invalid"}');
    expect(
      (await app.inject({ url: '/api/metrics', headers: { authorization: 'Bearer ' + 'm'.repeat(40) } })).body
    ).toContain('shlab_backup_last_success_timestamp_seconds 0');
    failed = true;
    expect((await app.inject('/api/ready')).statusCode).toBe(503);
    expect((await app.inject('/api/live')).statusCode).toBe(200);
    failed = false;
    reportConnection?.(false);
    expect((await app.inject('/api/ready')).statusCode).toBe(503);
    reportConnection?.(true);
    expect((await app.inject('/api/ready')).statusCode).toBe(200);
  });
  it('rejeita chaves inválidas e URLs PostgreSQL ambíguas', () => {
    expect(backupKey(randomBytes(32).toString('base64'))).toHaveLength(32);
    expect(() => backupKey('short')).toThrow('32 bytes');
    expect(() => postgresEnvironment('postgresql://user@host/db?options=-c')).toThrow('sslmode');
    expect(() => postgresEnvironment('https://user@host/db')).toThrow('URL');
  });
  it('publica somente metadados de sucesso com substituição atômica para leitura pela API', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shlab-status-'));
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Invalid temporary directory');
    const file = join(directory, 'report', 'status.json'),
      report = { version: 1, completedAt: new Date().toISOString(), bytes: 120, sha256: 'a'.repeat(64) };
    try {
      await publishBackupStatus(file, report);
      await publishBackupStatus(file, { ...report, bytes: 150 });
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...report, bytes: 150 });
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o644);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('Backup/restauração em PostgreSQL servidor', () => {
  it('restaura dados, histórico e aprendizagem; recusa destino ocupado e ciphertext adulterado', async () => {
    const sourceUrl = process.env.TEST_DATABASE_URL!;
    if (!new URL(sourceUrl).pathname.includes('test')) throw new Error('Use um banco de testes isolado.');
    const source = createPostgres(sourceUrl),
      targetUrl = new URL(sourceUrl),
      name = 'shlab_' + randomBytes(6).toString('hex') + '_restore_test';
    targetUrl.pathname = '/' + name;
    const directory = await mkdtemp(join(tmpdir(), 'shlab-backup-')),
      archive = join(directory, 'test.shlab-backup'),
      key = randomBytes(32),
      user = randomUUID(),
      project = randomUUID();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Temporary directory outside expected root');
    let restored: Database | undefined,
      created = false;
    try {
      await migrate(source);
      await source.query(`CREATE DATABASE ${name}`);
      created = true;
      await source.query('INSERT INTO users(id,email,name,password_hash,verified) VALUES($1,$2,$3,$4,true)', [
        user,
        user + '@example.test',
        'Backup de aprendizagem',
        'test-hash',
      ]);
      await source.query('INSERT INTO projects(id,user_id,name,topology) VALUES($1,$2,$3,$4)', [
        project,
        user,
        'Restauração de rede',
        JSON.stringify(makeTemplate('lan')),
      ]);
      await source.query(
        "INSERT INTO project_activity(user_id,project_id,action,name,revision) VALUES($1,$2,'created',$3,1)",
        [user, project, 'Restauração de rede']
      );
      await source.query(
        "INSERT INTO learning_progress(project_id,goal,revision,result,best_score,completed) VALUES($1,'challenge',1,$2,90,true)",
        [project, JSON.stringify({ score: 90 })]
      );
      const report = await backupDatabase(sourceUrl, archive, key);
      expect(report.bytes).toBeGreaterThan(36);
      expect(report.sha256).toMatch(/^[a-f0-9]{64}$/);
      const ciphertext = await readFile(archive);
      expect(ciphertext.includes(Buffer.from('Restauração de rede'))).toBe(false);
      const tampered = Buffer.from(ciphertext);
      tampered[25] ^= 1;
      const bad = join(directory, 'bad.shlab-backup'),
        plain = join(directory, 'plain');
      await writeFile(bad, tampered);
      await expect(decryptBackup(bad, plain, key)).rejects.toThrow();
      await expect(stat(plain)).rejects.toThrow();
      await expect(restoreDatabase(sourceUrl, targetUrl.href, name, bad, key)).rejects.toThrow();
      restored = createPostgres(targetUrl.href);
      expect(
        await restored.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public'")
      ).toEqual([]);
      await expect(
        restoreDatabase(sourceUrl, sourceUrl, new URL(sourceUrl).pathname.slice(1), archive, key)
      ).rejects.toThrow('distinto');
      await expect(restoreDatabase(sourceUrl, targetUrl.href, 'wrong', archive, key)).rejects.toThrow(
        'RESTORE_CONFIRM'
      );
      await restoreDatabase(sourceUrl, targetUrl.href, name, archive, key);
      expect(await restored.query('SELECT name,topology FROM projects WHERE id=$1', [project])).toEqual([
        { name: 'Restauração de rede', topology: makeTemplate('lan') },
      ]);
      expect(await restored.query('SELECT * FROM project_activity WHERE user_id=$1', [user])).toHaveLength(1);
      expect(
        await restored.query('SELECT best_score,completed FROM learning_progress WHERE project_id=$1', [
          project,
        ])
      ).toEqual([{ best_score: 90, completed: true }]);
      expect(await restored.query('SELECT version FROM schema_migrations ORDER BY version')).toEqual(
        await source.query('SELECT version FROM schema_migrations ORDER BY version')
      );
      await expect(restoreDatabase(sourceUrl, targetUrl.href, name, archive, key)).rejects.toThrow('vazio');
      await expect(backupDatabase(sourceUrl, archive, key)).rejects.toThrow();
      expect((await readFile(archive)).equals(ciphertext)).toBe(true);
    } finally {
      await restored?.close();
      await source.query('DELETE FROM users WHERE id=$1', [user]);
      if (created) await source.query(`DROP DATABASE ${name}`);
      await source.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
