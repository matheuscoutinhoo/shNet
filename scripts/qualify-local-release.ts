import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import argon2 from 'argon2';
import staticFiles from '@fastify/static';
import { createPostgres, migrate } from '../apps/api/src/db';
import { buildApp } from '../apps/api/src/app';
import { runtimeConfig } from '../apps/api/src/config';
import {
  ENGINE_CONTRACT_VERSION,
  ScenarioRunner,
  canonicalScenarioJson,
} from '../packages/simulation-engine/src';

const out = resolve(process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/remediation-2026-10-13'),
  local = resolve('.data/local-qualification');
await mkdir(out, { recursive: true });
await mkdir(local, { recursive: true });
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((e) => !['node_modules', 'dist'].includes(e.name))
      .map((e) => (e.isDirectory() ? files(resolve(directory, e.name)) : [resolve(directory, e.name)]))
  );
  return nested.flat().sort();
}
const sources = [
  ...(await files(resolve('packages/simulation-engine/src'))),
  ...(await files(resolve('apps/api/src'))),
  ...(await files(resolve('apps/api/migrations'))),
  ...(await files(resolve('apps/web/src'))),
  resolve('package-lock.json'),
].sort();
const sourceEntries = await Promise.all(
  sources.map(async (p) => ({
    path: relative(process.cwd(), p).replaceAll('\\', '/'),
    sha256: sha(await readFile(p)),
  }))
);
const assets = await files(resolve('apps/web/dist'));
const assetEntries = await Promise.all(
  assets.map(async (p) => ({
    path: relative(resolve('apps/web/dist'), p).replaceAll('\\', '/'),
    sha256: sha(await readFile(p)),
  }))
);
if (!assetEntries.some((a) => a.path === 'index.html'))
  throw new Error('Execute npm run build antes da qualificação.');
const manifest = {
  baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  engineContract: ENGINE_CONTRACT_VERSION,
  schemaVersion: 1,
  sourceHash: sha(canonicalScenarioJson(sourceEntries)),
  assetHash: sha(canonicalScenarioJson(assetEntries)),
  sourceEntries,
  assetEntries,
};
await writeFile(out + '/release-manifest.json', JSON.stringify(manifest, null, 2));

const c = JSON.parse((await readFile('.data/test-postgres/connection.json', 'utf8')).replace(/^\uFEFF/, ''));
if (!['shlab_test', 'netlab_test'].includes(c.database) || c.port !== 55438)
  throw new Error('Use o cluster isolado criado por scripts/local-postgres.ps1.');
const database = 'shlab_qualification_' + Date.now();
if (!/^shlab_qualification_\d+$/.test(database)) throw new Error('Nome de banco inválido.');
const connection = `postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@127.0.0.1:${c.port}/`;
const admin = createPostgres(connection + 'postgres?sslmode=disable');
await admin.query('CREATE DATABASE ' + database);
const db = createPostgres(connection + database + '?sslmode=disable'),
  origin = 'https://local.shlab.test';
const config = runtimeConfig({
  NODE_ENV: 'production',
  DATABASE_MODE: 'server',
  DATABASE_URL: connection + database,
  APP_ORIGIN: origin,
  HOST: '127.0.0.1',
});
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
try {
  await migrate(db);
  app = await buildApp({
    db,
    origin,
    production: true,
    mailer: async () => {},
    metricsToken: randomBytes(32).toString('hex'),
  });
  await app.register(staticFiles, { root: resolve('apps/web/dist') });
  const password = randomBytes(24).toString('base64url'),
    email = 'qualification@example.test';
  await db.query('INSERT INTO users(id,name,email,password_hash,verified) VALUES($1,$2,$3,$4,true)', [
    randomUUID(),
    'Local qualification',
    email,
    await argon2.hash(password),
  ]);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { email, password },
  });
  if (login.statusCode !== 200 || !String(login.headers['set-cookie']).includes('Secure'))
    throw new Error('Login/cookie de produção inválido.');
  const headers = {
    origin,
    cookie: login.cookies[0].name + '=' + login.cookies[0].value,
    'x-csrf-token': login.json().csrfToken,
  };
  const project = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers,
    payload: { name: 'Qualificação local', template: 'lan' },
  });
  if (project.statusCode !== 201) throw new Error('Projeto: ' + project.statusCode);
  const p = project.json(),
    hosts = p.topology.devices.filter((d: { interfaces: { ip?: string }[] }) =>
      d.interfaces.some((p) => p.ip)
    );
  const scenario = {
    name: 'Smoke local',
    durationMs: 1000,
    intervalMs: 1000,
    deadlineMs: 500,
    flows: [
      {
        name: 'Ping',
        source: hosts[0].id,
        target: hosts[1].interfaces[0].ip,
        protocol: 'icmp',
        expect: 'allow',
      },
    ],
    faults: [],
  };
  const endpoint = '/api/projects/' + p.id + '/scenario-runs';
  const started = await app.inject({
    method: 'POST',
    url: endpoint,
    headers,
    payload: { revision: p.revision, kind: 'scenario', scenario },
  });
  if (started.statusCode !== 201) throw new Error('Ensaio: ' + started.statusCode);
  const run = started.json(),
    runner = new ScenarioRunner(run.topology, run.scenario);
  while (!runner.step(100));
  const complete = await app.inject({
    method: 'PUT',
    url: endpoint + '/' + run.id,
    headers,
    payload: { report: runner.report() },
  });
  const verification = await app.inject({
    method: 'POST',
    url: endpoint + '/' + run.id + '/verify',
    headers,
  });
  if (complete.statusCode !== 200 || verification.json().verification?.replay?.status !== 'matched')
    throw new Error('Persistência/replay não passou.');
  const root = await app.inject('/'),
    ready = await app.inject('/api/ready');
  if (
    root.statusCode !== 200 ||
    ready.statusCode !== 200 ||
    !root.headers['strict-transport-security'] ||
    !root.headers['content-security-policy']
  )
    throw new Error('Static/readiness/security headers inválidos.');
  for (const asset of assetEntries) {
    const response = await app.inject('/' + asset.path);
    if (response.statusCode !== 200 || sha(response.rawPayload) !== asset.sha256)
      throw new Error('Asset divergente: ' + asset.path);
  }
  // Local artifact rollback drill: corrupt a copied active index, detect it,
  // and restore its exact fingerprint. The source build is never changed.
  const active = resolve(local, 'active-index.html'),
    backup = resolve(local, 'previous-index.html');
  await copyFile(resolve('apps/web/dist/index.html'), backup);
  await copyFile(backup, active);
  const before = sha(await readFile(active));
  await writeFile(active, '<html>release inválida</html>');
  if (sha(await readFile(active)) === before) throw new Error('Controle negativo de rollback não falhou.');
  await copyFile(backup, active);
  if (sha(await readFile(active)) !== before) throw new Error('Rollback local não restaurou o artefato.');
  const migrations = await db.query<{ version: number }>(
    'SELECT version FROM schema_migrations ORDER BY version'
  );
  const result = {
    environment: 'isolated-native-postgresql-local',
    productionConfig: {
      production: config.production,
      embedded: config.embedded,
      httpsOrigin: config.origin,
    },
    tlsHandshake:
      'not-executed: production TLS termination requires qualification in the deployment environment',
    migrations: migrations.map((m) => m.version),
    checks: {
      login: true,
      secureCookie: true,
      csp: true,
      hsts: true,
      readiness: true,
      staticAssets: assetEntries.length,
      immutableScenario: true,
      authoritativeReplay: 'matched',
      localArtifactRollback: true,
    },
    sourceHash: manifest.sourceHash,
    assetHash: manifest.assetHash,
    backupRestoreEvidence: 'tests/production.test.ts via npm run test:postgres',
    remoteDeployment: 'not-requested: local-only qualification',
  };
  await writeFile(out + '/local-release-qualification.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await app?.close();
  await db.close();
  // Name is generated above and cannot target an existing user/production DB.
  await admin.query('DROP DATABASE ' + database);
  await admin.close();
}
