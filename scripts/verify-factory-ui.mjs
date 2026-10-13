import { chromium, expect } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import console from 'node:console';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
const out = 'artifacts/factory-audit/remediation';
await mkdir(out, { recursive: true });
const reference = await chromium.connectOverCDP('http://127.0.0.1:9223');
const session = await reference.contexts()[0].storageState();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ storageState: session });
const page = await context.newPage();
await page.setViewportSize({ width: 1600, height: 1100 });
await page.goto('http://127.0.0.1:5173');
await page.waitForTimeout(1500);
const errors = [];
const projectName = 'Fábrica corrigida — validação ' + Date.now();
page.on('pageerror', (error) => errors.push(error.message));
await page.getByRole('button', { name: 'Templates', exact: true }).click();
await page.getByRole('button', { name: /Fábrica segmentada e redundância IP/ }).click();
await page.getByLabel('Nome do laboratório').fill(projectName);
await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
await expect(page.locator('.react-flow__node-device')).toHaveCount(43);
await page.getByRole('button', { name: 'Opções do laboratório' }).click();
await page.getByRole('button', { name: 'Validar fábrica e cenários' }).click();
await expect(page.getByRole('dialog')).toContainText('única instância');
await page.screenshot({ path: out + '/preflight.png' });
await page.getByRole('button', { name: 'Cenários e SLA' }).click();
await expect(
  page
    .getByLabel('Carregar cenário')
    .getByRole('option')
    .filter({ hasText: /^Modelo:/ })
).toHaveCount(17);
await page.getByLabel('Definição do cenário').fill(
  JSON.stringify({
    name: 'SCADA-PLC baseline',
    durationMs: 10000,
    intervalMs: 1000,
    deadlineMs: 500,
    flows: [
      {
        name: 'SCADA-PLC',
        source: 'HMI-A',
        target: '10.20.40.10',
        protocol: 'modbus',
        modbus: { transaction: 1, unit: 1, function: 3, address: 0, quantity: 1 },
        expectedRegisters: [725],
        expect: 'allow',
        maxLossPercent: 0,
      },
    ],
    faults: [],
  })
);
await page.getByRole('button', { name: 'Salvar cenário no laboratório', exact: true }).click();
await expect(page.getByLabel('Carregar cenário')).toContainText('Salvo: SCADA-PLC baseline');
await page.getByRole('button', { name: 'Executar cenário', exact: true }).click();
await expect(page.getByRole('cell', { name: 'Aprovado', exact: true })).toBeVisible({ timeout: 30000 });
await expect(
  page
    .getByRole('dialog')
    .locator('summary')
    .filter({ hasText: /SCADA-PLC baseline · revisão \d+ · Salvo/ })
).toBeVisible({ timeout: 15000 });
await page
  .getByLabel('Carregar cenário')
  .selectOption({ label: 'Modelo: MQTT — publicação QoS 1 e assinatura wildcard' });
await page.getByRole('button', { name: 'Executar cenário', exact: true }).click();
await expect(
  page
    .getByRole('dialog')
    .locator('summary')
    .filter({ hasText: /MQTT — publicação QoS 1 e assinatura wildcard · revisão \d+ · Salvo/ })
).toBeVisible({ timeout: 30000 });
await expect(page.getByRole('cell', { name: 'Aprovado', exact: true })).toHaveCount(2);
const scenarioText = await page.getByRole('dialog').innerText();
const scenarioAxe = await new AxeBuilder({ page }).analyze();
await page.screenshot({ path: out + '/scenarios.png' });
await page.getByRole('button', { name: 'PLC / HMI', exact: true }).click();
await page.getByLabel('HMI / origem').selectOption({ label: 'HMI-A' });
await page.getByRole('button', { name: 'Executar transação' }).click();
await expect(page.getByRole('dialog').getByRole('status')).toContainText('Registradores: 725', {
  timeout: 15000,
});
const modbusText = await page.getByRole('dialog').getByRole('status').innerText();
await page.screenshot({ path: out + '/modbus.png' });
await page.getByRole('button', { name: 'Fechar', exact: true }).click();
if (await page.getByRole('button', { name: 'Pausar simulação' }).count())
  await page.getByRole('button', { name: 'Pausar simulação' }).click();
await page.getByLabel('Modo de simulação').selectOption('realtime');
await page.getByLabel('Velocidade', { exact: true }).selectOption('5');
await expect(page.locator('.simulation-controls')).toContainText('eventos/s', { timeout: 30000 });
const readClock = async () =>
  Number((await page.locator('.timeline-clock strong').innerText()).replace(' ms', ''));
const initialClock = await readClock(),
  started = performance.now();
await page.waitForTimeout(10000);
await page.getByRole('button', { name: 'Pausar simulação' }).click();
const elapsed = performance.now() - started,
  advanced = (await readClock()) - initialClock;
expect(advanced / (elapsed * 5)).toBeGreaterThan(0.8);
expect(advanced / (elapsed * 5)).toBeLessThan(1.1);
await page.getByRole('button', { name: 'Opções do laboratório' }).click();
await page.getByRole('button', { name: 'Exportar captura PCAP' }).click();
await expect(page.getByRole('dialog')).toContainText('armazenamento independente');
const captureText = await page.getByRole('dialog').innerText();
await page.screenshot({ path: out + '/capture.png' });
await page.getByRole('button', { name: 'Fechar', exact: true }).click();
const axe = await new AxeBuilder({ page }).analyze();
await page.getByRole('button', { name: 'Salvar', exact: true }).click();
await expect(page.locator('.project-title')).toContainText('Salvo', { timeout: 10000 });
await page.reload();
await page.getByRole('heading', { name: projectName, exact: true }).click();
await page.getByRole('button', { name: 'Opções do laboratório' }).click();
await page.getByRole('button', { name: 'Validar fábrica e cenários' }).click();
await page.getByRole('button', { name: 'Cenários e SLA' }).click();
await expect(page.getByLabel('Carregar cenário')).toContainText('Salvo: SCADA-PLC baseline');
await expect(page.getByRole('cell', { name: 'Aprovado', exact: true })).toHaveCount(2);
await expect(
  page
    .getByRole('dialog')
    .locator('summary')
    .filter({ hasText: /SCADA-PLC baseline · revisão \d+ · Salvo/ })
).toBeVisible();
await page.getByRole('button', { name: 'Fechar', exact: true }).click();
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(700);
const visibleDevices = await page.locator('.react-flow__node-device').evaluateAll(
  (nodes) =>
    nodes.filter((node) => {
      const r = node.getBoundingClientRect();
      return r.right > 0 && r.left < globalThis.innerWidth && r.bottom > 170 && r.top < 580;
    }).length
);
expect(visibleDevices).toBeGreaterThan(0);
await page.screenshot({ path: out + '/mobile.png' });
const mobile = await page.evaluate(() => ({
  viewport: globalThis.innerWidth,
  bodyWidth: globalThis.document.body.scrollWidth,
}));
expect(mobile.bodyWidth).toBeLessThanOrEqual(mobile.viewport);
await page.getByRole('button', { name: 'Opções do laboratório' }).click();
await page.getByRole('button', { name: 'Validar fábrica e cenários' }).click();
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
expect(mobileReports.scrollWidth).toBeLessThanOrEqual(mobileReports.width + 1);
await page.screenshot({ path: out + '/mobile-reports.png' });
await writeFile(
  out + '/ui-results.json',
  JSON.stringify(
    {
      scenarioText,
      modbusText,
      captureText,
      realtime: { elapsedMs: elapsed, advancedMs: advanced, ratio: advanced / (elapsed * 5) },
      scenarioAccessibility: scenarioAxe.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        count: v.nodes.length,
      })),
      accessibility: axe.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length })),
      mobile: { ...mobile, visibleDevices },
      mobileReports,
      errors,
    },
    null,
    2
  )
);
console.log(
  JSON.stringify({
    realtimeRatio: advanced / (elapsed * 5),
    modbus: modbusText,
    violations: axe.violations.length,
    errors,
    mobile,
  })
);
await browser.close();
process.exit(0);
