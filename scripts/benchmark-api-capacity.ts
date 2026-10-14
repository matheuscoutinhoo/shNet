import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fork, type ChildProcess } from 'node:child_process';
import { buildApp } from '../apps/api/src/app';
import { createEmbedded, createPostgres, migrate, type Database } from '../apps/api/src/db';
import { csrf, digest, COOKIE } from '../apps/api/src/security';
import { capacityTopology } from './capacity-topology';
import { ENGINE_CONTRACT_VERSION } from '../packages/simulation-engine/src/version';
import { engineSourceHash } from './engine-build';
const output = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/capacity-and-services-2026-10-14';
const users = Number(process.env.SHLAB_CAPACITY_USERS ?? 20),
  size = Number(process.env.SHLAB_CAPACITY_DEVICES ?? 500);
if (!Number.isInteger(users) || users < 2 || users > 40) throw new Error('Use 2..40 usuários isolados.');
let db: Database | undefined, admin: Database | undefined, database: string | undefined;
let databaseCreated = false;
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
let client: ChildProcess | undefined;
let deadline: NodeJS.Timeout | undefined;
const prefix = 'shlab_capacity_' + randomUUID().replaceAll('-', '');
try {
  let connection: URL | undefined;
  if (process.env.TEST_DATABASE_URL) connection = new URL(process.env.TEST_DATABASE_URL);
  else {
    try {
      const c = JSON.parse(
        (await readFile('.data/test-postgres/connection.json', 'utf8')).replace(/^\uFEFF/, '')
      );
      if (c.port !== 55438 || !['shlab_test', 'netlab_test'].includes(c.database))
        throw new Error('Cluster local não autorizado.');
      connection = new URL(
        `postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@127.0.0.1:${c.port}/${c.database}`
      );
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  if (connection) {
    if (
      !['localhost', '127.0.0.1'].includes(connection.hostname) ||
      !['/shlab_test', '/netlab_test'].includes(connection.pathname)
    )
      throw new Error('Use apenas PostgreSQL de testes em loopback.');
    const administrative = new URL(connection);
    administrative.pathname = '/postgres';
    admin = createPostgres(administrative.href);
    database = prefix;
    await admin.query('CREATE DATABASE ' + database);
    databaseCreated = true;
    connection.pathname = '/' + database;
    db = createPostgres(connection.href);
  } else db = await createEmbedded();
  await migrate(db);
  const origin = 'http://capacity.example.test';
  for (let i = 0; i < 2; i++)
    apps.push(
      await buildApp({
        db,
        origin,
        mailer: async () => {},
        rateLimit: 10000,
        logger: process.env.SHLAB_CAPACITY_DEBUG === '1',
      })
    );
  const bases = await Promise.all(apps.map((app) => app.listen({ host: '127.0.0.1', port: 0 })));
  interface Actor {
    base: string;
    notificationBase: string;
    headers: Record<string, string>;
    project: string;
    revision: number;
    notifications: number;
    unexpectedNotifications: number;
  }
  const actors: Actor[] = [];
  for (let i = 0; i < users; i++) {
    const id = randomUUID(),
      raw = randomBytes(32).toString('base64url');
    await db.query('INSERT INTO users(id,name,email,password_hash,verified) VALUES($1,$2,$3,$4,true)', [
      id,
      'Capacity fixture',
      prefix + i + '@example.invalid',
      'no-password-login',
    ]);
    await db.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [digest(raw), id]
    );
    const headers = {
      origin,
      cookie: `${COOKIE}=${raw}`,
      'x-csrf-token': csrf(raw),
      'content-type': 'application/json',
    };
    const actor = {
      base: bases[i % 2],
      notificationBase: bases[(i + 1) % 2],
      headers,
      project: '',
      revision: 1,
      notifications: 0,
      unexpectedNotifications: 0,
    };
    const response = await fetch(actor.base + '/api/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Capacity ' + i, template: 'empty' }),
    });
    if (response.status !== 201) throw new Error('Fixture de projeto não foi criada.');
    actor.project = ((await response.json()) as { id: string }).id;

    actors.push(actor);
  }
  const topology = capacityTopology(size).snapshot;
  const loop = monitorEventLoopDelay({ resolution: 10 });
  const rounds: { wallMs: number; heapBeforeMiB: number; heapAfterMiB: number; rssMiB: number }[] = [];
  let before = 0;
  client = fork(new URL('./benchmark-api-clients.mjs', import.meta.url), {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'advanced',
    windowsHide: true,
  });
  const routes = await new Promise<Record<string, unknown>>((resolve, reject) => {
    let completed = false;
    deadline = setTimeout(() => reject(new Error('Carga concorrente excedeu dez minutos.')), 600000);
    client!.on(
      'message',
      (message: {
        kind: string;
        round: number;
        wallMs: number;
        message?: string;
        routes: Record<string, unknown>;
      }) => {
        if (message.kind === 'round-start') {
          global.gc?.();
          before = process.memoryUsage().heapUsed;
          loop.enable();
          client!.send({ kind: 'go' });
        } else if (message.kind === 'round-end') {
          global.gc?.();
          rounds.push({
            wallMs: message.wallMs,
            heapBeforeMiB: before / 1048576,
            heapAfterMiB: process.memoryUsage().heapUsed / 1048576,
            rssMiB: process.memoryUsage().rss / 1048576,
          });
        } else if (message.kind === 'complete') {
          completed = true;
          clearTimeout(deadline);
          resolve(message.routes);
        } else if (message.kind === 'error') reject(new Error(message.message));
      }
    );
    client!.once('error', reject);
    client!.once('exit', (code) => {
      if (!completed) reject(new Error(`Gerador de carga terminou antes da evidência (${code}).`));
    });
    client!.send({ actors, topology });
  });
  loop.disable();
  const result = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    engineContract: ENGINE_CONTRACT_VERSION,
    engineSourceHash: engineSourceHash(),
    database: admin ? 'PostgreSQL isolado criado e removido pelo ensaio' : 'Embedded isolado',
    users,
    devicesPerProject: size,
    apiInstances: apps.length,
    transport: 'HTTP/WS real em loopback; sessões sintéticas provisionadas no banco isolado',
    rounds,
    routes,
    eventLoop: { p95Ms: loop.percentile(95) / 1e6, maxMs: loop.max / 1e6 },
    ownerIsolation: true,
    staleRevisionRejected: true,
    privateNotifications: true,
    passed: true,
    limits:
      'Gerador de carga em processo separado; heap e event loop da API, RSS inclui seus Workers de validação. Mede saves/listagem/reabertura e WS concorrentes; não mede login sob ataque, SLA Railway, replay paralelo ou Workers de 20 navegadores.',
  };
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/api-capacity-${users}-${size}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (cause) {
  await mkdir(output, { recursive: true });
  await writeFile(
    `${output}/api-capacity-${users}-${size}.json`,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        users,
        devicesPerProject: size,
        engineContract: ENGINE_CONTRACT_VERSION,
        engineSourceHash: engineSourceHash(),
        passed: false,
        error: cause instanceof Error ? cause.message : 'Carga concorrente falhou.',
      },
      null,
      2
    )
  );
  throw cause;
} finally {
  clearTimeout(deadline);
  client?.kill();
  for (const app of apps) await app.close();
  await db?.close();
  if (admin) {
    try {
      if (databaseCreated && database) await admin.query('DROP DATABASE ' + database);
    } finally {
      await admin.close();
    }
  }
}
