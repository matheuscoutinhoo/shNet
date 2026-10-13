import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import console from 'node:console';

const out = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/ha-remediation-2026-10-13';
await mkdir(out + '/screenshots', { recursive: true });
const reference = await chromium.connectOverCDP('http://127.0.0.1:9223');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({
  storageState: await reference.contexts()[0].storageState(),
  viewport: { width: 1600, height: 1100 },
});
const page = await context.newPage(),
  errors = [],
  canvasWarnings = [],
  results = [],
  projects = [];
page.on('pageerror', (e) => errors.push(e.stack ?? e.message));
page.on('console', (message) => {
  if (
    message.type() === 'warning' &&
    message.text().includes('[React Flow]') &&
    !canvasWarnings.includes(message.text())
  )
    canvasWarnings.push(message.text());
});
async function inspectFirewall(device) {
  await page.getByLabel('Localizar equipamento').fill(device.hostname);
  await page.getByLabel('Localizar equipamento').press('Enter');
  await page.getByLabel('Localizar equipamento').press('Escape');
  await page.locator('.react-flow__node-device[data-id="' + device.id + '"]').click();
}
async function verifyZoom(devices, links) {
  for (let i = 0; i < 20 && (await page.locator('.overview-device').count()); i++) {
    await page.locator('.react-flow__controls-zoomin').click();
    await page.waitForTimeout(80);
  }
  await expect(page.locator('.overview-device')).toHaveCount(0);
  await expect(page.locator('.react-flow__edge')).toHaveCount(links);
  for (let i = 0; i < 20 && !(await page.locator('.overview-device').count()); i++) {
    await page.locator('.react-flow__controls-zoomout').click();
    await page.waitForTimeout(80);
  }
  await expect(page.locator('.overview-device')).toHaveCount(devices);
  await expect(page.locator('.react-flow__edge')).toHaveCount(links);
}
await expect
  .poll(
    async () => {
      try {
        return (await context.request.get('http://127.0.0.1:5173/api/ready')).status();
      } catch {
        return 0;
      }
    },
    { timeout: 60000, intervals: [500, 1000, 2000] }
  )
  .toBe(200);
try {
  for (const template of ['enterprise-datacenter', 'factory']) {
    await page.goto('http://127.0.0.1:5173');
    const project = await page.evaluate(async (template) => {
      const me = await (await globalThis.fetch('/api/auth/me')).json();
      const response = await globalThis.fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken },
        body: JSON.stringify({ name: 'QA HA ' + template + ' ' + Date.now(), template }),
      });
      const p = await response.json();
      if (!response.ok) throw new Error(p.message);
      return p;
    }, template);
    projects.push(project.id);
    await page.reload();
    await page.getByRole('heading', { name: project.name, exact: true }).click();
    await expect(page.locator('.react-flow__edge')).toHaveCount(project.topology.links.length);
    await verifyZoom(project.topology.devices.length, project.topology.links.length);
    const fw = project.topology.devices.find((d) => d.hostname === 'FW-A');
    await inspectFirewall(fw);
    await page.getByRole('button', { name: 'Políticas', exact: true }).click();
    const panel = page.locator('.state-sync-panel');
    await expect(panel).toContainText('Enlace disponível');
    await expect(panel.getByLabel('Peer HA')).toHaveValue(fw.stateSync.peer);
    await panel.getByRole('button', { name: 'Desativar par HA' }).click();
    await expect(panel).toContainText('Desativada');
    await panel.getByLabel('Peer HA').selectOption(fw.stateSync.peer);
    await panel.getByLabel('Porta dedicada local', { exact: true }).selectOption('p2');
    await panel.getByLabel('Porta dedicada do peer', { exact: true }).selectOption('p2');
    await panel
      .getByLabel('Mapeamento de interfaces (ID local ID remoto)', { exact: true })
      .fill(fw.stateSync.portMap.map((p) => p.local + ' ' + p.remote).join('\n'));
    await panel.getByRole('button', { name: 'Aplicar par HA' }).click();
    await expect(panel).toContainText('Enlace disponível');
    await panel.getByRole('heading', { name: 'Sincronização HA de firewall/NAT' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: out + '/screenshots/' + template + '-ha-desktop.png' });
    const desktop = await new AxeBuilder({ page }).analyze();
    await page.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect(page.locator('.project-title')).toContainText('Salvo');
    const saved = await page.evaluate(
      async (id) => (await globalThis.fetch('/api/projects/' + id)).json(),
      project.id
    );
    const a = saved.topology.devices.find((d) => d.hostname === 'FW-A'),
      b = saved.topology.devices.find((d) => d.hostname === 'FW-B');
    expect(a.stateSync.peer).toBe(b.id);
    expect(b.stateSync.peer).toBe(a.id);
    expect(a.stateSync.portMap).toEqual(fw.stateSync.portMap);
    await page.reload();
    await page.getByRole('heading', { name: project.name, exact: true }).click();
    await inspectFirewall(fw);
    await page.getByRole('button', { name: 'Políticas', exact: true }).click();
    await expect(page.locator('.state-sync-panel')).toContainText('Enlace disponível');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.react-flow__edge')).toHaveCount(project.topology.links.length);
    await page
      .locator('.state-sync-panel')
      .getByRole('heading', { name: 'Sincronização HA de firewall/NAT' })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: out + '/screenshots/' + template + '-ha-mobile.png' });
    const mobile = await new AxeBuilder({ page }).analyze();
    const overflow = await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth
    );
    expect(overflow).toBe(false);
    results.push({
      template,
      devices: saved.topology.devices.length,
      links: saved.topology.links.length,
      configureDisableReconfigure: true,
      zoomOverviewDetailEdges: true,
      savedReopened: true,
      desktopViolations: desktop.violations,
      mobileViolations: mobile.violations,
      overflow,
    });
    await page.setViewportSize({ width: 1600, height: 1100 });
  }
  expect(errors).toEqual([]);
  expect(canvasWarnings).toEqual([]);
  expect(results.flatMap((r) => [...r.desktopViolations, ...r.mobileViolations])).toEqual([]);
  await writeFile(
    out + '/state-sync-ui-results.json',
    JSON.stringify({ results, errors, canvasWarnings, passed: true }, null, 2)
  );
  console.log(
    JSON.stringify({
      templates: results.map((r) => r.template),
      errors: errors.length,
      accessibilityViolations: 0,
      savedReopened: true,
    })
  );
} catch (error) {
  await page.screenshot({ path: out + '/screenshots/state-sync-failure.png' });
  console.log(JSON.stringify({ errors, page: (await page.locator('body').innerText()).slice(-3500) }));
  throw error;
} finally {
  for (const id of projects)
    await page
      .evaluate(async (id) => {
        const me = await (await globalThis.fetch('/api/auth/me')).json();
        await globalThis.fetch('/api/projects/' + id, {
          method: 'DELETE',
          headers: { 'X-CSRF-Token': me.csrfToken },
        });
      }, id)
      .catch(() => {});
  await browser.close();
  await reference.close();
}
