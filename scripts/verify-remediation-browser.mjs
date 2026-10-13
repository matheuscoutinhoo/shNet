import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import console from 'node:console';
import process from 'node:process';

const out = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/remediation-2026-10-13';
await mkdir(out + '/screenshots', { recursive: true });
const reference = await chromium.connectOverCDP('http://127.0.0.1:9223');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({
  storageState: await reference.contexts()[0].storageState(),
  viewport: { width: 1600, height: 1100 },
});
const page = await context.newPage(),
  errors = [],
  projects = [];
page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
const result = { contrast: [], durableRetry: {}, errors };
async function create(template, topology) {
  await page.goto('http://127.0.0.1:5173');
  const name = 'Regressão local ' + template + ' ' + Date.now();
  const project = await page.evaluate(
    async ({ name, template, topology }) => {
      const me = await (await globalThis.fetch('/api/auth/me')).json();
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken };
      const response = await globalThis.fetch('/api/projects', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, template }),
      });
      let p = await response.json();
      if (!response.ok) throw new Error(p.message);
      if (topology) {
        const save = await globalThis.fetch('/api/projects/' + p.id, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ name, revision: p.revision, topology }),
        });
        p = await save.json();
        if (!save.ok) throw new Error(p.message);
      }
      return p;
    },
    { name, template, topology }
  );
  projects.push(project.id);
  await page.reload();
  await page.getByRole('heading', { name, exact: true }).click();
  await expect(page.locator('.react-flow__node-device')).toHaveCount(project.topology.devices.length);
  return { project, name };
}
async function tools() {
  await page.getByRole('button', { name: 'Opções do laboratório' }).click();
  await page.getByRole('button', { name: 'Validar rede e cenários' }).click();
  await page.getByRole('button', { name: 'Cenários e SLA' }).click();
}
async function pendingCount(project) {
  return page.evaluate(
    (project) =>
      new Promise((resolve, reject) => {
        const open = globalThis.indexedDB.open('shlab-pending-scenario-results', 1);
        open.onsuccess = () => {
          const db = open.result,
            request = db.transaction('results', 'readonly').objectStore('results').getAll();
          request.onsuccess = () => {
            resolve(request.result.filter((r) => r.project === project).length);
            db.close();
          };
          request.onerror = () => {
            reject(request.error);
            db.close();
          };
        };
        open.onerror = () => reject(open.error);
      }),
    project
  );
}
try {
  const topology = JSON.parse(await readFile(out + '/enterprise-datacenter.shlab.json', 'utf8'));
  await create('empty', topology);
  for (const background of ['light', 'gray', 'dark']) {
    await page.getByRole('button', { name: 'Opções do laboratório' }).click();
    await page.getByLabel('Fundo do canvas').selectOption(background);
    await page.getByRole('button', { name: 'Opções do laboratório' }).click();
    for (const mode of ['overview', 'detail', 'selected', 'mobile']) {
      if (mode === 'overview') {
        await page.setViewportSize({ width: 1600, height: 1100 });
        await page.locator('.react-flow__controls-fitview').click();
      } else if (mode === 'detail') {
        for (let i = 0; i < 5; i++) await page.locator('.react-flow__controls-zoomin').click();
      } else if (mode === 'selected') {
        await page.locator('.react-flow__controls-fitview').click();
        await page.waitForTimeout(400);
        const node = page.locator('.react-flow__node-device').filter({ hasText: 'CORE-A' }).first();
        await node.click({ modifiers: ['Control'] });
      } else {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('.react-flow__controls-fitview').click();
      }
      await page.waitForTimeout(400);
      const axe = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
      result.contrast.push({
        background,
        mode,
        violations: axe.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => ({ target: n.target, failureSummary: n.failureSummary })),
        })),
      });
    }
  }
  await page.screenshot({ path: out + '/screenshots/contrast-mobile.png' });
  await page.setViewportSize({ width: 1600, height: 1100 });
  const { project, name } = await create('lan');
  const hosts = project.topology.devices.filter((d) => d.interfaces.some((p) => p.ip));
  const scenario = {
    name: 'Retry durável após indisponibilidade',
    durationMs: 1000,
    intervalMs: 1000,
    deadlineMs: 500,
    flows: [
      {
        name: 'Ping LAN',
        source: hosts[0].id,
        target: hosts[1].interfaces.find((p) => p.ip).ip,
        protocol: 'icmp',
        expect: 'allow',
      },
    ],
    faults: [],
  };
  await tools();
  await page.getByLabel('Definição do cenário').fill(JSON.stringify(scenario));
  await page.getByText('Editar por formulário', { exact: true }).click();
  await expect(page.getByLabel('Origem', { exact: false })).toHaveValue(hosts[0].hostname);
  await page.getByLabel('Origem', { exact: false }).selectOption(hosts[0].hostname);
  await page.getByLabel('Duração (ms)', { exact: false }).fill('2000');
  const edited = JSON.parse(await page.getByLabel('Definição do cenário').inputValue());
  expect(edited.durationMs).toBe(2000);
  expect(edited.flows[0].source).toBe(hosts[0].hostname);
  result.form = { hostnameMapped: true, durationMs: edited.durationMs };
  let rejected = 0;
  const route = '**/api/projects/' + project.id + '/scenario-runs/*';
  await page.route(route, async (r) => {
    if (r.request().method() === 'PUT' && rejected++ === 0) {
      await r.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Falha sintética local de persistência' }),
      });
    } else await r.continue();
  });
  await page.getByRole('button', { name: 'Executar cenário', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Resultado calculado, mas não salvo', {
    timeout: 30000,
  });
  await expect.poll(() => pendingCount(project.id)).toBe(1);
  result.durableRetry.failureRetained = true;
  await page.reload();
  await page.getByRole('heading', { name, exact: true }).click();
  await tools();
  const summary = page
    .getByRole('dialog')
    .locator('summary')
    .filter({ hasText: /Retry durável.*Resultado não salvo/ });
  await expect(summary).toBeVisible({ timeout: 15000 });
  await summary.click();
  result.durableRetry.reloadRecovered = true;
  await page.unroute(route);
  await page.getByRole('button', { name: 'Tentar salvar resultado', exact: true }).click();
  await expect(
    page
      .getByRole('dialog')
      .locator('summary')
      .filter({ hasText: /Retry durável.*Salvo/ })
  ).toBeVisible();
  await expect.poll(() => pendingCount(project.id)).toBe(0);
  await page.getByRole('button', { name: 'Verificar no servidor', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reexecução no servidor' })).toContainText(
    'resultado confirmado',
    { timeout: 30000 }
  );
  result.durableRetry.retrySaved = true;
  result.durableRetry.localCopyRemoved = true;
  result.durableRetry.authoritativeReplay = 'matched';
  await page.screenshot({ path: out + '/screenshots/durable-retry.png' });
  // Keep both failure causes visible when neither API nor IndexedDB is available.
  await page.evaluate(() => {
    const open = globalThis.indexedDB.open.bind(globalThis.indexedDB);
    globalThis.indexedDB.open = (name, ...args) => {
      if (name === 'shlab-pending-scenario-results')
        throw new globalThis.DOMException('Quota sintética local', 'QuotaExceededError');
      return open(name, ...args);
    };
  });
  await page.route(route, async (r) => {
    if (r.request().method() === 'PUT')
      await r.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Falha sintética local de persistência' }),
      });
    else await r.continue();
  });
  await page
    .getByLabel('Definição do cenário')
    .fill(JSON.stringify({ ...scenario, name: 'Armazenamento local indisponível' }));
  await page.getByRole('button', { name: 'Executar cenário', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Armazenamento local indisponível: Quota sintética local. Exporte o ensaio antes de fechar.',
    { timeout: 30000 }
  );
  result.durableRetry.doubleFailureExplained = true;
  expect(result.contrast.flatMap((c) => c.violations)).toEqual([]);
  expect(errors).toEqual([]);
} finally {
  for (const id of projects)
    await page
      .evaluate(async (id) => {
        const me = await (await globalThis.fetch('/api/auth/me')).json();
        const response = await globalThis.fetch('/api/projects/' + id, {
          method: 'DELETE',
          headers: { 'X-CSRF-Token': me.csrfToken },
        });
        if (!response.ok) throw new Error('Cleanup: ' + response.status);
      }, id)
      .catch((e) => errors.push(e.message));
  await writeFile(out + '/browser-regression.json', JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      contrastCases: result.contrast.length,
      violations: result.contrast.flatMap((c) => c.violations).length,
      durableRetry: result.durableRetry,
      errors,
    })
  );
  await browser.close();
  await reference.close();
}
