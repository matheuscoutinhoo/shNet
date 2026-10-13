import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import console from 'node:console';
import process from 'node:process';
const out = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/enterprise-datacenter-audit';
await mkdir(out + '/screenshots', { recursive: true });
const topology = JSON.parse(await readFile(out + '/enterprise-datacenter.shlab.json', 'utf8'));
const reference = await chromium.connectOverCDP('http://127.0.0.1:9223');
const state = await reference.contexts()[0].storageState();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ storageState: state, viewport: { width: 1600, height: 1100 } });
const page = await context.newPage();
const errors = [],
  failures = [];
page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
page.on('response', (response) => {
  if (response.status() >= 400 && response.url().includes('/api/projects'))
    failures.push({ status: response.status(), path: new globalThis.URL(response.url()).pathname });
});
await page.goto('http://127.0.0.1:5173');
const name = 'Enterprise + datacenter — auditoria ' + Date.now();
const created = await page.evaluate(
  async ({ name, topology }) => {
    const me = await (await globalThis.fetch('/api/auth/me')).json();
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken };
    const response = await globalThis.fetch('/api/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, template: 'empty', background: 'dark' }),
    });
    const project = await response.json();
    if (!response.ok) throw new Error(project.message);
    const saved = await globalThis.fetch('/api/projects/' + project.id, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ name, revision: project.revision, topology }),
    });
    const result = await saved.json();
    if (!saved.ok) throw new Error(result.message);
    return { id: result.id, revision: result.revision };
  },
  { name, topology }
);
await page.reload();
await page.getByRole('heading', { name, exact: true }).click();
await expect(page.locator('.react-flow__node-device')).toHaveCount(topology.devices.length);
if (await page.getByRole('button', { name: 'Pausar simulação' }).count())
  await page.getByRole('button', { name: 'Pausar simulação' }).click();
await page.getByLabel('Modo de simulação').selectOption('realtime');
await page.getByLabel('Velocidade', { exact: true }).selectOption('5');
await expect(page.getByRole('button', { name: 'Pausar simulação' })).toBeVisible();
const clock = async () =>
  Number((await page.locator('.timeline-clock strong').innerText()).replace(' ms', ''));
const startClock = await clock(),
  startTime = performance.now();
await page.waitForTimeout(11000);
await page.getByRole('button', { name: 'Pausar simulação' }).click();
const realtime = { elapsedMs: performance.now() - startTime, advancedMs: (await clock()) - startClock };
realtime.ratio = realtime.advancedMs / (realtime.elapsedMs * 5);
await page.screenshot({ path: out + '/screenshots/desktop.png' });
const desktopAxe = await new AxeBuilder({ page }).analyze();
await page.getByRole('button', { name: 'Opções do laboratório' }).click();
await page.getByRole('button', { name: 'Validar rede e cenários' }).click();
let preflightText;
try {
  preflightText = await page.getByRole('dialog').innerText();
} catch (error) {
  console.log(
    JSON.stringify({ errors, failures, page: (await page.locator('body').innerText()).slice(0, 3000) })
  );
  await page.screenshot({ path: out + '/screenshots/failure.png' });
  await browser.close();
  throw error;
}
await page.screenshot({ path: out + '/screenshots/preflight.png' });
await page.getByRole('button', { name: 'Cenários e SLA' }).click();
const nativePresets = await page
  .getByLabel('Carregar cenário')
  .getByRole('option')
  .filter({ hasText: /^Modelo:/ })
  .count();
const scenario = {
  name: 'Enterprise e DC — ensaio integrado',
  durationMs: 6000,
  intervalMs: 1000,
  deadlineMs: 500,
  warmupMs: Math.max(0, Math.ceil(35000 - (await clock()))),
  flows: [
    {
      name: 'ERP autorizado',
      source: 'USER-PC',
      target: '10.60.40.10',
      protocol: 'http',
      expect: 'allow',
      maxLossPercent: 0,
    },
    {
      name: 'Visitante bloqueado',
      source: 'GUEST-PC',
      target: '10.60.40.10',
      protocol: 'http',
      expect: 'deny',
    },
    {
      name: 'Tenant A para APP-1',
      source: 'TENANT-A-CLIENT',
      target: '10.80.100.11',
      protocol: 'http',
      expect: 'allow',
    },
    {
      name: 'Campus para VIP DC',
      source: 'USER-PC',
      target: '10.80.100.100',
      protocol: 'http',
      expect: 'allow',
    },
    {
      name: 'Wi-Fi empresarial para ERP',
      source: 'WIFI-EMPLOYEE',
      target: '10.60.40.10',
      protocol: 'http',
      expect: 'allow',
    },
  ],
  faults: [],
};
await page.getByLabel('Definição do cenário').fill(JSON.stringify(scenario));
await page.getByRole('button', { name: 'Salvar cenário no laboratório', exact: true }).click();
await page.getByRole('button', { name: 'Executar cenário', exact: true }).click();
await expect(page.getByRole('cell', { name: 'Aprovado', exact: true })).toHaveCount(5, { timeout: 60000 });
await expect(
  page
    .getByRole('dialog')
    .locator('summary')
    .filter({ hasText: /Enterprise e DC — ensaio integrado · revisão \d+ · Salvo/ })
).toBeVisible({ timeout: 15000 });
const scenarioText = await page.getByRole('dialog').innerText();
await page.screenshot({ path: out + '/screenshots/scenario-report.png' });
const reportAxe = await new AxeBuilder({ page }).analyze();
await page.getByRole('button', { name: 'Fechar', exact: true }).click();
await page.getByRole('button', { name: 'Salvar', exact: true }).click();
await expect(page.locator('.project-title')).toContainText('Salvo');
await page.reload();
await page.getByRole('heading', { name, exact: true }).click();
await expect(page.locator('.react-flow__node-device')).toHaveCount(topology.devices.length);
await page.getByRole('button', { name: 'Opções do laboratório' }).click();
await page.getByRole('button', { name: 'Validar rede e cenários' }).click();
await page.getByRole('button', { name: 'Cenários e SLA' }).click();
await expect(page.getByRole('cell', { name: 'Aprovado', exact: true })).toHaveCount(5);
const persisted = true;
await page.getByRole('button', { name: 'Fechar', exact: true }).click();
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(800);
const mobile = await page.evaluate(() => ({
  viewport: globalThis.innerWidth,
  bodyWidth: globalThis.document.body.scrollWidth,
}));
const visibleDevices = await page.locator('.react-flow__node-device').evaluateAll(
  (nodes) =>
    nodes.filter((n) => {
      const r = n.getBoundingClientRect();
      return r.right > 0 && r.left < globalThis.innerWidth && r.bottom > 170 && r.top < 580;
    }).length
);
await page.screenshot({ path: out + '/screenshots/mobile.png' });
await page.getByRole('button', { name: 'Opções do laboratório' }).click();
await page.getByRole('button', { name: 'Validar rede e cenários' }).click();
await page.getByRole('button', { name: 'Cenários e SLA' }).click();
await page
  .getByRole('dialog')
  .locator('summary')
  .filter({ hasText: / · Salvo/ })
  .first()
  .click();
const mobileReports = await page
  .getByRole('dialog')
  .evaluate((e) => ({ width: e.clientWidth, scrollWidth: e.scrollWidth }));
await page.screenshot({ path: out + '/screenshots/mobile-report.png' });
const mobileAxe = await new AxeBuilder({ page }).analyze();
const violation = (value) =>
  value.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
    examples: v.nodes
      .slice(0, 8)
      .map((n) => ({ target: n.target, html: n.html, failureSummary: n.failureSummary })),
  }));
await writeFile(
  out + '/ui-results.json',
  JSON.stringify(
    {
      project: created,
      name,
      devices: topology.devices.length,
      links: topology.links.length,
      realtime,
      nativePresets,
      preflightText,
      scenarioText,
      persisted,
      mobile: { ...mobile, visibleDevices },
      mobileReports,
      accessibility: {
        desktop: violation(desktopAxe),
        report: violation(reportAxe),
        mobile: violation(mobileAxe),
      },
      errors,
      failures,
    },
    null,
    2
  )
);
console.log(
  JSON.stringify({
    devices: topology.devices.length,
    realtimeRatio: realtime.ratio,
    nativePresets,
    persisted,
    mobile,
    mobileReports,
    errors,
    failures,
  })
);
await browser.close();
process.exit(0);
