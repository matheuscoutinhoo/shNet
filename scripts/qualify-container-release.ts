import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { randomBytes, createHash } from 'node:crypto';
import { createPostgres } from '../apps/api/src/db';
import { backupDatabase, restoreDatabase } from './backup';
import { ScenarioRunner } from '../packages/simulation-engine/src';
import WebSocket from 'ws';
const source = process.env.TEST_DATABASE_URL;
if (!process.env.CI || !source || !process.env.POSTGRES_SERVICE_CONTAINER)
  throw new Error('Qualificação de containers exige CI e PostgreSQL descartável do job.');
const url = new URL(source);
if (!['shlab_test', 'netlab_test'].includes(url.pathname.slice(1)))
  throw new Error('Use exclusivamente o banco de teste do job.');
const out = 'artifacts/container-qualification';
await mkdir(out, { recursive: true });
const admin = createPostgres(source),
  name = 'shlab_release_' + Date.now(),
  restored = name + '_restore';
const address = (db: string) => {
  const u = new URL(source);
  u.pathname = '/' + db;
  return u.toString();
};
const docker = (args: string[]) =>
  execFileSync('docker', args, { stdio: 'pipe', timeout: 180000, env: process.env }).toString().trim();
const assert = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message);
};
const evidence: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  scope:
    'Containers Linux reais, PostgreSQL isolado da CI, TLS com CA confiável explícita, rollback de imagem e restore em banco separado.',
};
let certificate: Buffer;
const http = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const r = request(
        'https://localhost:3444' + path,
        {
          method,
          ca: certificate,
          headers: {
            ...headers,
            ...(payload
              ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (b) => chunks.push(b));
          res.on('end', () =>
            resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() })
          );
        }
      );
      r.setTimeout(15000, () => r.destroy(new Error('Timeout HTTPS.')));
      r.on('error', reject);
      r.end(payload);
    }
  );
const wait = async (fn: () => Promise<void>) => {
  let last: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      await fn();
      return;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw last;
};
function start(image: string, db: string) {
  process.env.DATABASE_URL = address(db);
  docker([
    'run',
    '-d',
    '--name',
    'shlab-release',
    '--network',
    'host',
    '--env',
    'DATABASE_URL',
    '--env',
    'APP_ORIGIN=https://localhost:3444',
    '--env',
    'PORT=3003',
    '--env',
    'MAIL_PROVIDER=none',
    image,
  ]);
}
try {
  await admin.query('CREATE DATABASE ' + name);
  await admin.query('CREATE DATABASE ' + restored);
  process.env.DATABASE_URL = address(name);
  docker([
    'run',
    '--rm',
    '--network',
    'host',
    '--env',
    'DATABASE_URL',
    'shlab:ci',
    'node',
    '--import',
    'tsx',
    'apps/api/src/migrate.ts',
  ]);
  start('shlab:ci', name);
  docker([
    'run',
    '-d',
    '--name',
    'shlab-release-tls',
    '--network',
    'host',
    '-v',
    process.cwd() + '/deploy/Caddyfile.qualification:/etc/caddy/Caddyfile:ro',
    'caddy:2',
  ]);
  await wait(async () => {
    docker(['cp', 'shlab-release-tls:/data/caddy/pki/authorities/local/root.crt', out + '/root.crt']);
    certificate = await readFile(out + '/root.crt');
    assert((await http('/api/health')).status === 200, 'Readiness indisponível.');
  });
  const email = 'release-' + Date.now() + '@example.test',
    password = 'Qa1!' + randomBytes(24).toString('base64url'),
    origin = 'https://localhost:3444';
  assert(
    (
      await http(
        '/api/auth/register',
        'POST',
        { name: 'Isolated release QA', email, password },
        { Origin: origin }
      )
    ).status === 202,
    'Cadastro isolado falhou.'
  );
  const login = await http('/api/auth/login', 'POST', { email, password }, { Origin: origin });
  assert(login.status === 200, 'Login isolado falhou.');
  const cookie = login.headers['set-cookie']![0];
  assert(
    /Secure/.test(cookie) && /HttpOnly/.test(cookie) && /SameSite=Strict/i.test(cookie),
    'Cookie de produção inválido.'
  );
  const headers = {
    Origin: origin,
    Cookie: cookie.split(';')[0],
    'X-CSRF-Token': JSON.parse(login.body).csrfToken,
  };
  const created = await http(
    '/api/projects',
    'POST',
    { name: 'Docker rollback QA', template: 'lan' },
    headers
  );
  assert(created.status === 201, 'Criação de projeto falhou.');
  const project = JSON.parse(created.body),
    hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
  const hosts = project.topology.devices.filter((d: { interfaces: { ip?: string }[] }) =>
    d.interfaces.some((p) => p.ip)
  );
  const scenario = {
    name: 'Container release ICMP',
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
  const endpoint = '/api/projects/' + project.id + '/scenario-runs';
  const begun = await http(
    endpoint,
    'POST',
    { revision: project.revision, kind: 'scenario', scenario },
    headers
  );
  assert(begun.status === 201, 'Ensaio isolado não iniciou.');
  const run = JSON.parse(begun.body),
    runner = new ScenarioRunner(run.topology, run.scenario);
  while (!runner.step(100));
  const report = runner.report();
  assert(report.passed && report.flows.every((flow) => flow.received > 0), 'Fluxo ICMP isolado falhou.');
  evidence.scenario = { passed: report.passed, flows: report.flows };
  const completed = await http(endpoint + '/' + run.id, 'PUT', { report }, headers);
  assert(
    completed.status === 200,
    'Relatório isolado não foi salvo: HTTP ' + completed.status + ' ' + completed.body
  );
  const verified = await http(endpoint + '/' + run.id + '/verify', 'POST', {}, headers);
  assert(
    verified.status === 200 && JSON.parse(verified.body).verification.replay.status === 'matched',
    'Replay autoritativo divergente.'
  );
  const savedReport = JSON.parse(completed.body).report;
  const otherEmail = 'other-' + Date.now() + '@example.test';
  await http(
    '/api/auth/register',
    'POST',
    { name: 'Other isolated owner', email: otherEmail, password },
    { Origin: origin }
  );
  const otherLogin = await http(
    '/api/auth/login',
    'POST',
    { email: otherEmail, password },
    { Origin: origin }
  );
  assert(otherLogin.status === 200, 'Segundo login isolado falhou.');
  const otherHeaders = { Cookie: otherLogin.headers['set-cookie']![0].split(';')[0] };
  assert(
    (await http('/api/projects/' + project.id, 'GET', undefined, otherHeaders)).status === 404,
    'Ownership não isolou projeto.'
  );
  assert(
    (await http(endpoint + '/' + run.id, 'GET', undefined, otherHeaders)).status === 404,
    'Ownership não isolou relatório.'
  );
  const current = JSON.parse((await http('/api/build')).body);
  evidence.currentBuild = current;
  evidence.tls = {
    hsts: (await http('/api/health')).headers['strict-transport-security'],
    cookieSecure: true,
  };
  evidence.ownershipIsolated = true;
  const socket = new WebSocket('wss://localhost:3444/api/events', {
    ca: certificate!,
    headers: { Origin: origin, Cookie: headers.Cookie },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout WSS.')), 15000);
      socket.once('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once('error', (e) => {
        clearTimeout(timeout);
        reject(e);
      });
    });
    const notice = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Notificação PostgreSQL/WSS ausente.')), 15000);
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString());
        if (
          event.type === 'project.updated' &&
          event.id === project.id &&
          event.revision === project.revision + 1
        ) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    assert(
      (
        await http(
          '/api/projects/' + project.id,
          'PUT',
          { revision: project.revision, name: 'WSS and rollback QA', topology: project.topology },
          headers
        )
      ).status === 200,
      'Save por HTTPS falhou.'
    );
    await notice;
    evidence.websocket = { tls: true, privatePostgresNotification: true };
  } finally {
    socket.terminate();
  }
  const key = randomBytes(32),
    archive = out + '/database.shlab.enc';
  await backupDatabase(address(name), archive, key);
  await restoreDatabase(address(name), address(restored), restored, archive, key);
  docker(['stop', '--time', '15', 'shlab-release']);
  docker(['rm', 'shlab-release']);
  start('shlab:rollback', name);
  await wait(async () => assert((await http('/api/health')).status === 200, 'Imagem anterior não iniciou.'));
  const previous = JSON.parse((await http('/api/build')).body);
  assert(previous.engineBuild !== current.engineBuild, 'Rollback exige duas imagens de fontes diferentes.');
  const afterRollback = await http('/api/projects/' + project.id, 'GET', undefined, headers);
  assert(
    afterRollback.status === 200 && hash(JSON.parse(afterRollback.body).topology) === hash(project.topology),
    'Rollback perdeu projeto/sessão.'
  );
  evidence.imageRollback = { previousBuild: previous, projectPreserved: true };
  docker(['stop', '--time', '15', 'shlab-release']);
  docker(['rm', 'shlab-release']);
  start('shlab:ci', restored);
  await wait(async () => assert((await http('/api/health')).status === 200, 'Restore não iniciou.'));
  const afterRestore = await http('/api/projects/' + project.id, 'GET', undefined, headers);
  assert(
    afterRestore.status === 200 && hash(JSON.parse(afterRestore.body).topology) === hash(project.topology),
    'Restore perdeu projeto/sessão.'
  );
  const restoredRun = await http(endpoint + '/' + run.id, 'GET', undefined, headers);
  assert(
    restoredRun.status === 200 && hash(JSON.parse(restoredRun.body).report) === hash(savedReport),
    'Restore perdeu relatório imutável.'
  );
  const db = createPostgres(address(restored));
  try {
    const migrations = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM schema_migrations'
    );
    evidence.databaseRestore = {
      migrations: Number(migrations[0].count),
      projectPreserved: true,
      sessionPreserved: true,
      reportPreserved: true,
    };
  } finally {
    await db.close();
  }
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await writeFile(out + '/qualification.json', JSON.stringify(evidence, null, 2));
  for (const container of ['shlab-release', 'shlab-release-tls'])
    try {
      docker(['rm', '-f', container]);
    } catch {
      /* only this workflow's named containers */
    }
  for (const db of [name, restored]) await admin.query('DROP DATABASE IF EXISTS ' + db + ' WITH (FORCE)');
  await admin.close();
}
