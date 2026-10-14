import { chromium, expect } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import argon2 from 'argon2';
import staticFiles from '@fastify/static';
import { createEmbedded, migrate } from '../apps/api/src/db';
import { buildApp } from '../apps/api/src/app';
const out = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/application-stability-2026-10-13';
const origin = 'http://127.0.0.1:5209',
  db = await createEmbedded();
await migrate(db);
const app = await buildApp({ db, origin, production: false, mailer: async () => {} });
await app.register(staticFiles, { root: resolve('apps/web/dist'), preCompressed: true });
await app.listen({ host: '127.0.0.1', port: 5209 });
const browser = await chromium.launch({
    channel: process.platform === 'win32' ? 'msedge' : undefined,
    headless: true,
  }),
  context = await browser.newContext({ viewport: { width: 1500, height: 1000 } }),
  page = await context.newPage(),
  errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
const result: Record<string, unknown> = { errors };
try {
  const email = 'built-application@example.invalid',
    password = randomBytes(24).toString('base64url');
  await db.query('INSERT INTO users(id,name,email,password_hash,verified) VALUES($1,$2,$3,$4,true)', [
    randomUUID(),
    'QA build local',
    email,
    await argon2.hash(password),
  ]);
  const login = await context.request.post(origin + '/api/auth/login', {
    headers: { Origin: origin },
    data: { email, password },
  });
  expect(login.status()).toBe(200);
  const headers = { Origin: origin, 'X-CSRF-Token': (await login.json()).csrfToken };
  const created = await context.request.post(origin + '/api/projects', {
    headers,
    data: { name: 'Build e autosave contínuo', template: 'lan' },
  });
  expect(created.status()).toBe(201);
  const project = await created.json();
  const started = performance.now();
  await page.goto(origin);
  await page.getByRole('heading', { name: project.name, exact: true }).click();
  await expect(page.locator('.react-flow__node-device')).toHaveCount(3);
  result.openMs = performance.now() - started;
  // Reject a deferred resource and prove the workspace remains available.
  await page.route('**/assets/Inspector-*.js', (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'Controlled missing panel' })
  );
  await page.locator('.network-device').first().dblclick();
  await expect(page.getByRole('heading', { name: 'Painel indisponível' })).toBeVisible();
  await page.getByRole('button', { name: 'Fechar painel' }).click();
  await expect(page.getByLabel('Nome do laboratório', { exact: true })).toBeVisible();
  await page.unroute('**/assets/Inspector-*.js');
  result.failedDeferredPanelPreservesWorkspace = true;
  // React reports the controlled rejected import to pageerror once.
  const controlledErrors = errors.splice(0);
  expect(controlledErrors.every((e) => /import|fetch|module/i.test(e))).toBe(true);
  result.controlledPanelErrors = controlledErrors;
  await page.getByLabel('Modo de simulação', { exact: true }).selectOption('realtime');
  await expect
    .poll(
      async () => (await (await context.request.get(origin + '/api/projects/' + project.id)).json()).revision,
      { timeout: 15000 }
    )
    .toBeGreaterThan(1);
  const live = await (await context.request.get(origin + '/api/projects/' + project.id)).json();
  expect(live.topology.clock).toBeGreaterThan(0);
  const savedResponse = page.waitForResponse(
    (r) => r.url().endsWith('/api/projects/' + project.id) && r.request().method() === 'PUT' && r.ok()
  );
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await savedResponse;
  await page.getByRole('button', { name: 'Pausar simulação', exact: true }).click();
  result.continuousAutosave = {
    revision: live.revision,
    clock: live.topology.clock,
    manualSaveResolved: true,
  };
  await page.getByRole('button', { name: 'Opções do laboratório' }).click();
  await page.getByRole('button', { name: 'Validar rede e cenários' }).click();
  await page.getByRole('button', { name: 'Cenários e SLA' }).click();
  const host = project.topology.devices.find((d: { interfaces: { ip?: string }[] }) =>
    d.interfaces.some((p) => p.ip === '192.168.10.10')
  );
  const scenario = {
    name: 'Identidade do Worker publicado',
    durationMs: 1000,
    intervalMs: 1000,
    deadlineMs: 500,
    flows: [{ name: 'Ping', source: host.id, target: '192.168.10.20', protocol: 'icmp', expect: 'allow' }],
    faults: [],
  };
  await page.getByLabel('Definição do cenário', { exact: true }).fill(JSON.stringify(scenario));
  await page.getByRole('button', { name: 'Executar cenário', exact: true }).click();
  await expect(page.getByText(/Identidade do Worker publicado · revisão.*Salvo/)).toBeVisible({
    timeout: 30000,
  });
  const run = (
    await (await context.request.get(origin + '/api/projects/' + project.id + '/scenario-runs')).json()
  )[0];
  const build = await (await context.request.get(origin + '/api/build')).json();
  expect(run.report.engineBuild).toBe(build.engineBuild);
  expect(run.build_identity.client).toBe(build.engineBuild);
  expect(run.build_identity.server).toBe(build.engineBuild);
  expect(run.report.engineArtifact).toBe(build.workerArtifact);
  expect(run.build_identity.clientArtifact).toBe(build.workerArtifact);
  await page.getByText(/Identidade do Worker publicado · revisão/).click();
  await page.getByRole('button', { name: 'Verificar no servidor', exact: true }).click();
  await expect(page.getByText(/Reexecução no servidor: resultado confirmado/)).toBeVisible({
    timeout: 30000,
  });
  const html = await readFile('apps/web/dist/index.html', 'utf8'),
    entry = html.match(/<script\b(?=[^>]*type="module")[^>]*src="([^"]+\.js)"/)![1],
    entryBytes = (await readFile(resolve('apps/web/dist', entry.slice(1)))).length;
  result.build = {
    ...build,
    clientWorkerHash: run.report.engineBuild,
    workerArtifactHash: run.report.engineArtifact,
    entryBytes,
    entry,
    replay: 'matched',
    schemaVersion: 11,
  };
  await page.getByRole('button', { name: 'Fechar', exact: true }).click();
  await page.route('**/api/projects/' + project.id, (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Falha controlada' }),
        })
      : route.continue()
  );
  await page.evaluate(
    "Object.defineProperty(indexedDB, 'open', { configurable: true, value: function () { throw new DOMException('Quota controlada', 'QuotaExceededError'); } });"
  );
  await page.getByLabel('Nome do laboratório', { exact: true }).fill('Trabalho com quota indisponível');
  await expect(page.getByText(/Recuperação local indisponível:.*Quota controlada/)).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByText('Falha controlada', { exact: true })).toBeVisible();
  result.doubleFailureVisible = true;
  await page.unroute('**/api/projects/' + project.id);
  await page.route('**/api/projects/' + project.id, (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Entre para continuar' }),
        })
      : route.continue()
  );
  await page.getByLabel('Nome do laboratório', { exact: true }).fill('Trabalho preservado após expiração');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(
    page.getByText(
      'Sessão expirada e recuperação local indisponível. Exporte o trabalho antes de entrar novamente.',
      { exact: true }
    )
  ).toBeVisible();
  await expect(page.getByLabel('Nome do laboratório', { exact: true })).toHaveValue(
    'Trabalho preservado após expiração'
  );
  await expect(page.locator('.react-flow__node-device')).toHaveCount(3);
  result.expiredSessionWithUnavailableStoragePreservesWorkspace = true;
  expect(errors).toHaveLength(0);
  result.passed = true;
} finally {
  await mkdir(out, { recursive: true });
  await writeFile(out + '/built-application-ui.json', JSON.stringify(result, null, 2));
  await browser.close();
  await app.close();
  await db.close();
}
process.stdout.write(JSON.stringify(result) + '\n');
