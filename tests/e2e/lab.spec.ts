import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  decodePcap,
  makeTemplate,
  deviceProfiles,
  SimulationEngine,
  wirelessConfig,
  vxlanConfig,
} from '../../packages/simulation-engine/src';
import { networkConcepts } from '../../apps/web/src/workspace/networkConcepts';
import type { Project, ProjectSummary } from '../../apps/web/src/api';
import { dualAccessFixture } from '../fixtures/dual-access';
const email = 'shlab-e2e-' + Date.now() + '@example.test',
  password = 'My-Network-Lab-123!';
async function inspectDevice(page: Page, hostname: string) {
  // A saved viewport can legitimately leave a device outside the canvas.
  // Navigate using the same public finder as the user, then inspect its header.
  const finder = page.getByRole('textbox', { name: 'Localizar equipamento' });
  await finder.fill(hostname);
  await page.getByRole('button', { name: 'Localizar ' + hostname, exact: true }).click();
  await finder.press('Escape');
  await page.locator('.network-device').getByText(hostname, { exact: true }).click({ timeout: 15000 });
  await expect(page.locator('.inspector-device h2')).toHaveText(hostname);
}
async function waitForLoginRetry(value: string | undefined) {
  const seconds = Number(value);
  expect(Number.isFinite(seconds) && seconds > 0 && seconds <= 60).toBe(true);
  await new Promise((done) => setTimeout(done, seconds * 1000 + 250));
}
async function submitLogin(page: Page) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = page.waitForResponse(
      (response) => response.url().endsWith('/api/auth/login') && response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Entrar no shLab', exact: true }).click();
    const response = await pending;
    if (response.status() !== 429) {
      expect(response.status()).toBe(200);
      return;
    }
    await waitForLoginRetry(response.headers()['retry-after']);
  }
  throw new Error('Login continua limitado após o intervalo informado pelo servidor');
}
async function submitRegistration(page: Page) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = page.waitForResponse(
      (response) => response.url().endsWith('/api/auth/register') && response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Criar conta', exact: true }).click();
    const response = await pending;
    if (response.status() !== 429) {
      expect(response.status()).toBe(202);
      return;
    }
    await waitForLoginRetry(response.headers()['retry-after']);
  }
  throw new Error('Cadastro continua limitado após o intervalo informado pelo servidor');
}
async function verificationLink(address = email) {
  const dir = resolve('.data/mail');
  const files = await readdir(dir);
  for (const file of files) {
    const text = await readFile(resolve(dir, file), 'utf8');
    if (text.includes('To: ' + address) && text.includes('action=verify'))
      return text.match(/http[^\s]+/)![0];
  }
  throw new Error('E-mail de teste não encontrado');
}
async function registerAndLogin(page: Page, address: string) {
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await page.getByLabel('Seu nome').fill('Network Explorer');
  await page.getByLabel('E-mail', { exact: true }).fill(address);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await submitRegistration(page);
  const capabilities = await (await page.request.get('/api/auth/capabilities')).json();
  if (capabilities.emailEnabled) {
    await expect(page.getByRole('status')).toContainText('verificação');
    await page.goto(await verificationLink(address));
    await page.getByRole('button', { name: 'Verificar e-mail', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('E-mail verificado');
  } else {
    await expect(page.getByRole('status')).toContainText('Entre com seu e-mail e senha');
    await expect(page.getByRole('button', { name: 'Esqueceu sua senha?' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reenviar verificação de e-mail' })).toHaveCount(0);
  }
  await page.getByLabel('E-mail', { exact: true }).fill(address);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await submitLogin(page);
  await expect(page.getByRole('heading', { name: 'Meus laboratórios', exact: true })).toBeVisible();
}
test('Aprendizado: finder centraliza equipamento presente e terminais respeitam o perfil', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'finder-terminal-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Novo laboratório', exact: true }).click();
  await page.getByLabel('Nome do laboratório').fill('Finder e comandos específicos');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const e = new SimulationEngine(),
    laptop = e.addProfile('laptop', { x: 5500, y: 1300 }),
    sw = e.addProfile('switch-l2', { x: 100, y: 100 });
  laptop.hostname = 'NOTEBOOK-REMOTO';
  sw.hostname = 'SW-LOCAL';
  await page.locator('input[type=file][accept=".json,.shlab.json,.netlab.json"]').setInputFiles({
    name: 'finder.shlab.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(e.snapshot())),
  });
  await expect(page.locator('.network-device')).toHaveCount(2);
  const finder = page.getByRole('textbox', { name: 'Localizar equipamento' }),
    viewport = page.locator('.react-flow__viewport');
  const before = await viewport.getAttribute('style');
  await finder.fill('NOTEBOOK-REMOTO');
  const target = page
    .locator('.network-device')
    .filter({ has: page.getByText('NOTEBOOK-REMOTO', { exact: true }) });
  await expect(target).toHaveClass(/selected/);
  await expect.poll(() => viewport.getAttribute('style')).not.toBe(before);
  await expect
    .poll(async () => {
      const box = await target.boundingBox(),
        canvas = await page.locator('.react-flow').boundingBox();
      return (
        !!box &&
        !!canvas &&
        box.x >= canvas.x &&
        box.y >= canvas.y &&
        box.x + box.width <= canvas.x + canvas.width &&
        box.y + box.height <= canvas.y + canvas.height
      );
    })
    .toBe(true);
  await expect.poll(async () => (await target.boundingBox())!.width).toBeGreaterThan(180);
  await finder.fill('não-existe');
  await expect(page.locator('.finder-results')).toContainText('Nenhum equipamento');
  const centered = await viewport.getAttribute('style');
  await finder.press('Enter');
  await expect(viewport).toHaveAttribute('style', centered!);
  await finder.fill('NOTEBOOK');
  await page.getByRole('button', { name: 'Localizar NOTEBOOK-REMOTO', exact: true }).click();
  await finder.press('Escape');
  await target.dblclick();
  const inspector = page.locator('.inspector'),
    tabs = inspector.locator('.inspector-tabs');
  await expect(tabs.getByRole('button', { name: 'STP', exact: true })).toHaveCount(0);
  await tabs.getByRole('button', { name: 'Terminal', exact: true }).click();
  await inspector.locator('.terminal-guide summary').click();
  await expect(inspector.locator('.terminal-guide')).toContainText('ipconfig /all');
  await expect(inspector.locator('.terminal-guide')).not.toContainText('show spanning-tree');
  await inspector.locator('.terminal-guide summary').click();
  const command = async (text: string) => {
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  };
  await command('ipconfig /all');
  await expect(inspector.locator('.terminal-heading')).toContainText('HostShell');
  await expect(inspector.locator('.terminal-host')).toContainText('IPv4:');
  await expect(inspector.locator('.terminal-host')).toContainText('NOTEBOOK-REMOTO$');
  await command('vlan 20');
  await expect(inspector.locator('.terminal-host')).toContainText('não se aplica');
  await command(`ip addr add 192.0.2.10/24 dev ${laptop.interfaces[0].name}`);
  await tabs.getByRole('button', { name: 'Portas', exact: true }).click();
  await expect(inspector.locator('.interface-item').first()).toContainText('192.0.2.10');
  await expect(inspector.locator('.section-education')).toContainText('interface é');
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await finder.fill('SW-LOCAL');
  await finder.press('Enter');
  await finder.press('Escape');
  await inspectDevice(page, 'SW-LOCAL');
  await tabs.getByRole('button', { name: 'Terminal', exact: true }).click();
  await inspector.locator('.terminal-guide summary').click();
  await expect(inspector.locator('.terminal-guide')).toContainText('show spanning-tree');
  await expect(inspector.locator('.terminal-guide')).not.toContainText('ipconfig /all');
  await inspector.locator('.terminal-guide summary').click();
  await command('ipconfig');
  await expect(inspector.locator('.terminal-host')).toContainText('não se aplica');
  await page.getByRole('button', { name: 'Inspetor da rede', exact: true }).click();
  const networkDialog = page.getByRole('dialog', { name: 'Inspetor da rede' });
  await expect(networkDialog.locator('.section-education')).toContainText('RX / TX');
  await networkDialog.getByRole('tab', { name: 'Caminho', exact: true }).click();
  await expect(networkDialog.locator('.section-education')).toContainText('não é uma previsão');
  await expect(new AxeBuilder({ page }).include('.modal').analyze()).resolves.toMatchObject({
    violations: [],
  });
  await networkDialog.locator('.modal-head').getByRole('button', { name: 'Fechar', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('finder-terminal.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('Categorias e terminal: capacidades, troca de filtro e texto sem cortes em desktop/mobile', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'terminal-layout-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Novo laboratório', exact: true }).click();
  await page.getByLabel('Nome do laboratório').fill('Categorias e terminal legível');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const e = new SimulationEngine(),
    laptop = e.addProfile('laptop', { x: 100, y: 100 }),
    sw = e.addProfile('switch-l2', { x: 480, y: 100 });
  laptop.hostname = 'NOTEBOOK-CLI';
  sw.hostname = 'SW-CLI';
  await page.locator('input[type=file][accept=".json,.shlab.json,.netlab.json"]').setInputFiles({
    name: 'terminal.shlab.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(e.snapshot())),
  });
  const finder = page.getByRole('textbox', { name: 'Localizar equipamento' }),
    filters = page.locator('.event-filters');
  const select = async (name: string) => {
    await finder.fill(name);
    await finder.press('Enter');
    await expect(page.locator('.timeline-scope')).toContainText(name);
    await finder.press('Escape');
  };
  await select(sw.hostname);
  await expect(filters.getByRole('button', { name: 'STP', exact: true })).toHaveCount(1);
  await expect(filters.getByRole('button', { name: 'OSPF', exact: true })).toHaveCount(0);
  await filters.getByRole('button', { name: 'STP', exact: true }).click();
  await select(laptop.hostname);
  await expect(filters.getByRole('button', { name: 'STP', exact: true })).toHaveCount(0);
  await expect(filters.getByRole('button', { name: 'OSPF', exact: true })).toHaveCount(0);
  await expect(filters.getByRole('button', { name: 'Wi-Fi', exact: true })).toHaveCount(1);
  await expect(filters.getByRole('button', { name: 'Todos', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await page.locator('.network-device').filter({ hasText: laptop.hostname }).click();
  const inspector = page.locator('.inspector'),
    tabs = inspector.locator('.inspector-tabs');
  await tabs.getByRole('button', { name: 'Terminal', exact: true }).click();
  const terminal = inspector.locator('.terminal-host');
  await expect(terminal).toContainText('HostShell');
  const command = async (text: string) => {
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  };
  await command('ipconfig /all');
  await expect(terminal).toContainText('IPv4:');
  const coloredText = (color: string) =>
    terminal.locator('.xterm-rows span').evaluateAll(
      (spans, expected) =>
        spans
          .filter((span) => getComputedStyle(span).color === expected)
          .map((span) => span.textContent)
          .join(''),
      color
    );
  await expect.poll(() => coloredText('rgb(146, 236, 224)')).toContain('02:');
  await expect.poll(() => coloredText('rgb(242, 204, 139)')).toContain('não configurado');
  await command('vlan 20');
  await expect.poll(() => coloredText('rgb(255, 157, 171)')).toContain('não se aplica');
  const geometry = async () => {
    const host = (await terminal.boundingBox())!,
      screen = (await terminal.locator('.xterm-screen').boundingBox())!;
    return (
      screen.x >= host.x - 1 &&
      screen.y >= host.y - 1 &&
      screen.x + screen.width <= host.x + host.width + 1 &&
      screen.y + screen.height <= host.y + host.height + 1
    );
  };
  await expect(inspector.locator('.terminal-body')).toHaveCSS('padding-left', '12px');
  await expect.poll(geometry).toBe(true);
  const draft = 'ping ' + '0123456789'.repeat(9);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(draft);
  const text = () =>
    terminal.locator('.xterm-rows').evaluate((el) =>
      Array.from(el.children)
        .map((row) => row.textContent)
        .join('')
        .replaceAll('\u00a0', ' ')
    );
  await expect.poll(text).toContain(draft);
  await inspector.locator('.terminal-guide summary').click();
  await expect.poll(geometry).toBe(true);
  await inspector.locator('.terminal-guide summary').click();
  await tabs.getByRole('button', { name: 'Portas', exact: true }).click();
  await tabs.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect.poll(text).toContain(draft);
  await expect.poll(() => coloredText('rgb(173, 241, 220)')).toContain('ping');
  const resize = page.getByRole('separator', { name: 'Redimensionar detalhes do equipamento' });
  await resize.focus();
  await page.keyboard.press('End');
  await expect.poll(geometry).toBe(true);
  await expect(new AxeBuilder({ page }).include('.inspector').analyze()).resolves.toMatchObject({
    violations: [],
  });
  await page.screenshot({ path: testInfo.outputPath('terminal-readable-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(geometry).toBe(true);
  await expect.poll(text).toContain(draft);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('terminal-readable-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Fechar inspector', exact: true }).click();
  await expect(filters.getByRole('button', { name: 'OSPF', exact: true })).toHaveCount(1);
  await expect(filters.getByRole('button', { name: 'STP', exact: true })).toHaveCount(1);
  await expect(filters.getByRole('button', { name: 'Sincronização HA', exact: true })).toHaveCount(1);
  await expect(filters.getByRole('button', { name: 'NICs redundantes', exact: true })).toHaveCount(1);
  await expect(filters.getByRole('button', { name: 'PLC / HMI / Processo', exact: true })).toHaveCount(1);
  await expect(filters.getByRole('button')).toHaveCount(25);
  expect(errors).toEqual([]);
});

test('Painel inferior: expansão por mouse, teclado e toque, limites responsivos e rolagem', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'timeline-resize-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Novo laboratório', exact: true }).click();
  await page.getByLabel('Nome do laboratório').fill('Painel redimensionável');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const e = new SimulationEngine(),
    host = e.addProfile('desktop');
  for (let i = 0; i < 60; i++) e.emit('CONFIG_CHANGED', host.id, 'Verificação de rolagem ' + i);
  await page.locator('input[type=file][accept=".json,.shlab.json,.netlab.json"]').setInputFiles({
    name: 'resize.shlab.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(e.snapshot())),
  });
  const panel = page.locator('.timeline'),
    handle = page.getByRole('separator', { name: 'Redimensionar painel de eventos e tráfego' }),
    height = async () => (await panel.boundingBox())!.height;
  const initial = await height();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 150, { steps: 8 });
  await page.mouse.up();
  await expect.poll(height).toBeGreaterThan(initial + 100);
  await expect(panel).not.toHaveClass(/resizing/);
  await handle.focus();
  const expanded = await height();
  await page.keyboard.press('ArrowDown');
  await expect.poll(height).toBeLessThan(expanded - 20);
  await page.keyboard.press('End');
  await expect.poll(height).toBeCloseTo(Number(await handle.getAttribute('aria-valuemax')), 0);
  const canvas = page.locator('.canvas-area');
  expect((await canvas.boundingBox())!.height).toBeGreaterThanOrEqual(159);
  const scrolling = panel.locator('.event-table-wrap');
  expect(await scrolling.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await scrolling.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await scrolling.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const remembered = await height();
  await panel.getByRole('button', { name: /^Tráfego/ }).click();
  await expect.poll(height).toBeCloseTo(remembered, 0);
  await panel.getByRole('button', { name: 'Notas do laboratório', exact: true }).click();
  await panel
    .getByRole('textbox', { name: 'Notas do laboratório' })
    .fill('Notas mantidas durante a expansão');
  await panel.getByRole('button', { name: /^Eventos/ }).click();
  await expect(
    panel.locator('.event-table tbody tr').filter({ hasText: 'Verificação de rolagem' })
  ).toHaveCount(60);
  await expect(new AxeBuilder({ page }).include('.timeline').analyze()).resolves.toMatchObject({
    violations: [],
  });
  await page.screenshot({ path: testInfo.outputPath('timeline-expanded-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await handle.focus();
  await page.keyboard.press('Home');
  const mobileInitial = await height();
  const touchBox = (await handle.boundingBox())!;
  expect(touchBox.height).toBeGreaterThanOrEqual(24);
  const cdp = await page.context().newCDPSession(page);
  const x = touchBox.x + touchBox.width / 2,
    y = touchBox.y + touchBox.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 130 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await expect.poll(height).toBeGreaterThan(mobileInitial + 90);
  await expect(panel).not.toHaveClass(/resizing/);
  const filters = panel.locator('.event-filters');
  expect(await filters.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await filters.getByRole('button', { name: 'Descartes', exact: true }).click();
  await expect(filters.getByRole('button', { name: 'Descartes', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await filters.getByRole('button', { name: 'Todos', exact: true }).click();
  await expect(new AxeBuilder({ page }).include('.timeline').analyze()).resolves.toMatchObject({
    violations: [],
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('timeline-expanded-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(height).toBeLessThanOrEqual(Number(await handle.getAttribute('aria-valuemax')) + 1);
  expect((await panel.boundingBox())!.y).toBeGreaterThanOrEqual(
    (await page.locator('.canvas-and-timeline').boundingBox())!.y
  );
  expect((await panel.boundingBox())!.y + (await height())).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1440, height: 960 });
  await handle.focus();
  await page.keyboard.press('Home');
  await expect.poll(height).toBeCloseTo(Number(await handle.getAttribute('aria-valuemin')), 0);
  await panel.getByRole('button', { name: 'Notas do laboratório', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'Notas do laboratório' })).toHaveValue(
    'Notas mantidas durante a expansão'
  );
  expect(errors).toEqual([]);
});

test('Painel inferior: eventos e tráfego acompanham a seleção e preservam a visão da rede', async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'timeline-selection-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Novo laboratório', exact: true }).click();
  await page.getByLabel('Nome do laboratório').fill('Eventos por equipamento');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const e = new SimulationEngine(),
    a = e.addProfile('desktop', { x: 100, y: 100 }),
    b = e.addProfile('desktop', { x: 480, y: 100 }),
    quiet = e.addFactoryProfile('desktop', { x: 860, y: 100 });
  a.hostname = 'HOST-A';
  b.hostname = 'HOST-B';
  quiet.hostname = 'HOST-SEM-EVENTOS';
  a.interfaces[0].ip = '192.0.2.10';
  a.interfaces[0].prefix = 24;
  b.interfaces[0].ip = '192.0.2.20';
  b.interfaces[0].prefix = 24;
  e.ping(a.id, '192.0.2.100');
  e.ping(b.id, '192.0.2.200');
  const originalEvents = e.state.events.length;
  expect(e.state.events.filter((event) => event.device === a.id).length).toBeGreaterThan(0);
  expect(e.state.events.filter((event) => event.device === b.id).length).toBeGreaterThan(0);
  await page.locator('input[type=file][accept=".json,.shlab.json,.netlab.json"]').setInputFiles({
    name: 'timeline.shlab.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(e.snapshot())),
  });
  const timeline = page.locator('.timeline'),
    rows = timeline.locator('.event-table tbody tr'),
    finder = page.getByRole('textbox', { name: 'Localizar equipamento' });
  await expect(timeline.locator('.timeline-scope')).toContainText('Toda a rede');
  await expect(rows).toHaveCount(originalEvents);
  const select = async (name: string) => {
    await finder.fill(name);
    await finder.press('Enter');
    await expect(timeline.locator('.timeline-scope')).toContainText(name);
    await finder.press('Escape');
  };
  await select(a.hostname);
  await expect(rows).toHaveCount(e.state.events.filter((event) => event.device === a.id).length);
  expect(await rows.locator('td:nth-child(2)').allTextContents()).toEqual(
    Array(await rows.count()).fill(a.hostname)
  );
  await timeline.getByRole('button', { name: 'ARP', exact: true }).click();
  await expect(rows).toHaveCount(
    e.state.events.filter((event) => event.device === a.id && event.type.startsWith('ARP')).length
  );
  await timeline.getByRole('button', { name: 'Tráfego', exact: false }).click();
  await expect(timeline.locator('.traffic-table tbody tr')).toHaveCount(1);
  await expect(timeline.locator('.traffic-table')).toContainText('192.0.2.100');
  await expect(timeline.locator('.traffic-table')).not.toContainText('192.0.2.200');
  await select(b.hostname);
  await expect(timeline.locator('.traffic-table tbody tr')).toHaveCount(1);
  await expect(timeline.locator('.traffic-table')).toContainText('192.0.2.200');
  await expect(timeline.locator('.traffic-table')).not.toContainText('192.0.2.100');
  await timeline.getByRole('button', { name: 'Notas do laboratório', exact: true }).click();
  await timeline
    .getByRole('textbox', { name: 'Notas do laboratório' })
    .fill('Hipótese compartilhada da rede');
  await timeline.getByRole('button', { name: /^Eventos/ }).click();
  await timeline.getByRole('button', { name: 'Todos', exact: true }).click();
  await select(quiet.hostname);
  await expect(rows).toHaveCount(0);
  await expect(timeline).toContainText('Nenhum evento registrado para a seleção');
  await timeline.getByRole('button', { name: /^Tráfego/ }).click();
  await expect(timeline.locator('.traffic-table tbody tr')).toHaveCount(0);
  await expect(timeline).toContainText('Nenhum teste de ping iniciado pela seleção');
  await timeline.getByRole('button', { name: 'Ver toda a rede', exact: true }).click();
  await expect(timeline.locator('.timeline-scope')).toContainText('Toda a rede');
  await expect(timeline.locator('.traffic-table tbody tr')).toHaveCount(2);
  await timeline.getByRole('button', { name: /^Eventos/ }).click();
  await expect(rows).toHaveCount(originalEvents);
  await select(a.hostname);
  await page.locator('.react-flow__pane').click({ position: { x: 30, y: 160 } });
  await expect(timeline.locator('.timeline-scope')).toContainText('Toda a rede');
  await expect(rows).toHaveCount(originalEvents);
  await timeline.getByRole('button', { name: 'Notas do laboratório', exact: true }).click();
  await expect(timeline.getByRole('textbox', { name: 'Notas do laboratório' })).toHaveValue(
    'Hipótese compartilhada da rede'
  );
  expect(errors).toEqual([]);
});

test('Aprendizado: beacon explicado, campos com significado e camadas Wi-Fi corretas', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'event-education-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Novo laboratório', exact: true }).click();
  await page.getByLabel('Nome do laboratório').fill('Anúncio Wi-Fi explicado');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const e = new SimulationEngine(),
    ap = e.addProfile('ap');
  e.configureWireless(ap.id, { ...wirelessConfig(ap), ssid: 'MinhaRede', security: 'open', key: undefined });
  await page.locator('input[type=file][accept=".json,.shlab.json,.netlab.json"]').setInputFiles({
    name: 'wifi.shlab.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(e.snapshot())),
  });
  await advanceSimulation(
    page,
    async () => (await page.locator('.event-table tbody').innerText()).includes('WIFI_SENT'),
    20
  );
  await page.locator('.event-table tbody tr').filter({ hasText: 'WIFI_SENT' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Por que isso aconteceu?' });
  await expect(dialog.locator('.event-explanation')).toContainText('não confirma associação');
  await expect(dialog.locator('.event-explanation')).toContainText('MinhaRede');
  await expect(dialog.locator('.event-technical')).not.toHaveAttribute('open', '');
  await expect(dialog.getByText('EtherType', { exact: true })).toHaveCount(0);
  await dialog.locator('.event-technical > summary').click();
  await expect(dialog.locator('.packet-fields')).toContainText(['Nome da rede (SSID)']);
  await expect(dialog).toContainText('Rede aberta — sem autenticação por chave');
  await expect(dialog.getByText('Nonce', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('Negociação', { exact: true })).toHaveCount(0);
  await expect(dialog.locator('.osi-stack > div')).toHaveCount(2);
  await expect(dialog.locator('.osi-stack')).toContainText('Rádio');
  await expect(dialog).not.toContainText('Ethernet II');
  const wifi = dialog.locator('.packet-wifi');
  const checkWifiSpacing = async () => {
    expect(
      await wifi.evaluate((element) => parseFloat(getComputedStyle(element).paddingLeft))
    ).toBeGreaterThanOrEqual(14);
    expect(
      await wifi.locator('h3').evaluate((element) => parseFloat(getComputedStyle(element).marginBottom))
    ).toBeGreaterThanOrEqual(12);
    expect(
      await wifi
        .locator('dt small')
        .first()
        .evaluate((element) => parseFloat(getComputedStyle(element).lineHeight))
    ).toBeGreaterThanOrEqual(19);
  };
  await checkWifiSpacing();
  await expect(new AxeBuilder({ page }).include('.modal').analyze()).resolves.toMatchObject({
    violations: [],
  });
  await wifi.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('event-education-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await checkWifiSpacing();
  await wifi.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(new AxeBuilder({ page }).include('.modal').analyze()).resolves.toMatchObject({
    violations: [],
  });
  await page.screenshot({ path: testInfo.outputPath('event-education-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('Aparência: plataforma sempre escura, independente do sistema e de preferências antigas', async ({
  page,
}) => {
  const root = page.locator('html');
  const control = page.getByRole('combobox', { name: 'Aparência da plataforma' });
  await page.addInitScript(() => localStorage.setItem('shlab.appearance', 'light'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expect(root).toHaveCSS('color-scheme', 'dark');
  await expect(control).toHaveCount(0);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'dark');
  const other = await page.context().newPage();
  await other.goto('/');
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
  await other.evaluate(() => localStorage.setItem('shlab.appearance', 'system'));
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await other.evaluate(() => localStorage.setItem('shlab.appearance', 'invalid'));
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await other.evaluate(() => localStorage.clear());
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
  await other.close();
  await expect(control).toHaveCount(0);
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'dark');
});

test('Aparência: armazenamento indisponível não interfere no tema escuro', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'shlab.appearance') throw new DOMException('Storage unavailable', 'SecurityError');
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'shlab.appearance') throw new DOMException('Storage unavailable', 'QuotaExceededError');
      set.call(this, key, value);
    };
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('combobox', { name: 'Aparência da plataforma' })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(errors).toEqual([]);
});

test('Aparência: plataforma e canvas independentes, conta, modais e mobile', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('combobox', { name: 'Aparência da plataforma' })).toHaveCount(0);
  const audit = async () => {
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      result.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
      }))
    ).toEqual([]);
  };
  await audit();
  await page.screenshot({ path: testInfo.outputPath('auth.png'), fullPage: true });
  await registerAndLogin(page, 'appearance-' + testInfo.project.name + '-' + Date.now() + '@example.test');
  await expect(page.getByRole('combobox', { name: 'Aparência da plataforma' })).toHaveCount(0);
  await audit();
  await page.screenshot({ path: testInfo.outputPath('dashboard.png'), fullPage: true });
  await page.getByRole('button', { name: 'Conta e segurança' }).click();
  for (const name of ['Perfil', 'Sessões', 'Senha', 'Excluir conta']) {
    await page.getByRole('tab', { name, exact: true }).click();
    await audit();
  }
  await page.getByRole('button', { name: 'Fechar', exact: true }).click();
  await page.getByRole('button', { name: 'Novo laboratório', exact: true }).click();
  await page.getByLabel('Nome do laboratório').fill('Aparência independente');
  await audit();
  await page.screenshot({ path: testInfo.outputPath('modal.png'), fullPage: true });
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await page.getByRole('searchbox', { name: 'Buscar equipamento' }).fill('Mesh AP');
  await page
    .locator('.equipment-card')
    .filter({ has: page.getByText('Mesh AP', { exact: true }) })
    .click();
  const palette = { light: 'rgb(251, 253, 255)', gray: 'rgb(231, 237, 241)', dark: 'rgb(19, 41, 58)' };
  const canvas = page.locator('.canvas-container');
  await expect(canvas).toHaveClass(/theme-dark/);
  for (const [background, color] of Object.entries(palette)) {
    await page.getByRole('button', { name: 'Opções do laboratório' }).click();
    await page.getByLabel('Fundo do canvas', { exact: true }).selectOption(background);
    await page.getByRole('button', { name: 'Opções do laboratório' }).click();
    let cardColor = '';
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(canvas).toHaveCSS('background-color', color);
      await expect(canvas.locator('.react-flow')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const card = canvas.locator('.network-device').first();
      if (!cardColor) cardColor = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
      await expect(card).toHaveCSS('background-color', cardColor);
      await expect(canvas).toHaveClass(new RegExp('theme-' + background));
      await audit();
    }
  }
  await expect(page.getByRole('combobox', { name: 'Aparência da plataforma' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('workspace-dark.png'), fullPage: true });
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await expect(canvas).toHaveCSS('background-color', palette.dark);
  await page.getByRole('button', { name: 'Voltar aos laboratórios' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('.lab-card').filter({ hasText: 'Aparência independente' }).locator('.lab-open').click();
  await expect(canvas).toHaveCSS('background-color', palette.dark);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await audit();
  }
  await page.screenshot({ path: testInfo.outputPath('workspace.png'), fullPage: true });
  expect(errors).toEqual([]);
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test('Canvas: fluxo real e destaques com movimento ' + reducedMotion, async ({ page }, testInfo) => {
    test.setTimeout(120000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion });
    await page.goto('/');
    await registerAndLogin(page, 'motion-' + reducedMotion + '-' + Date.now() + '@example.test');
    await page.getByRole('button', { name: 'Templates', exact: true }).click();
    await page.getByRole('button', { name: /Sua primeira LAN/ }).click();
    const name = 'Fluxo observado ' + reducedMotion;
    await page.getByLabel('Nome do laboratório').fill(name);
    await page.getByRole('dialog').locator('select[name="background"]').selectOption('dark');
    await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
    await expect(page.locator('.network-device')).toHaveCount(3);
    await expect(page.locator('.cable-packet')).toHaveCount(0);
    await expect(page.locator('.network-device[data-activity]:not([data-activity="none"])')).toHaveCount(0);
    const projects: ProjectSummary[] = await (await page.request.get('/api/projects')).json();
    const summary = projects.find((p) => p.name === name);
    expect(summary).toBeDefined();
    const detail = await page.request.get('/api/projects/' + summary!.id);
    expect(detail.status()).toBe(200);
    const project: Project = await detail.json();
    const peer = project.topology.devices.filter((d) => d.type === 'pc').at(-1);
    expect(peer?.interfaces[0].ip).toBeTruthy();
    const destination = peer!.interfaces[0].ip!;
    type Observation = {
      packets: { id: string; direction: string; moving: boolean }[];
      devices: { id: string; activity: string; animation: string }[];
    };
    // Os destaques são transitórios. Registrar suas inserções evita alongar a animação para os testes.
    await page.evaluate(() => {
      const observation: Observation = { packets: [], devices: [] };
      const record = () => {
        for (const packet of document.querySelectorAll('.cable-packet[data-event-id]')) {
          const id = packet.getAttribute('data-event-id')!;
          const direction = packet.getAttribute('data-direction')!;
          if (!observation.packets.some((p) => p.id === id && p.direction === direction))
            observation.packets.push({
              id,
              direction,
              moving: packet.querySelector('animateMotion') !== null,
            });
        }
        for (const device of document.querySelectorAll('.network-device[data-event-id]')) {
          const id = device.getAttribute('data-event-id')!;
          const activity = device.getAttribute('data-activity')!;
          if (activity !== 'none' && !observation.devices.some((d) => d.id === id && d.activity === activity))
            observation.devices.push({
              id,
              activity,
              animation: getComputedStyle(device.querySelector('.node-activity-indicator') ?? device)
                .animationName,
            });
        }
      };
      (window as Window & { __shlabMotionObservation?: Observation }).__shlabMotionObservation = observation;
      new MutationObserver(record).observe(document.querySelector('.canvas-container')!, {
        subtree: true,
        childList: true,
        attributes: true,
      });
    });
    await page.getByRole('button', { name: 'Enviar ping', exact: true }).click();
    await page.getByLabel('Destino IPv4 ou hostname').fill(destination);
    await page.getByRole('button', { name: 'Enfileirar ping' }).click();
    await advanceSimulation(page, async () =>
      (await page.locator('.probe-toast').innerText()).includes('Resposta em')
    );
    const observed = await page.evaluate(
      () => (window as unknown as { __shlabMotionObservation: Observation }).__shlabMotionObservation
    );
    const verifyObservation = async (observation: Observation, assertMotion = true) => {
      expect(observation.packets.length).toBeGreaterThan(0);
      expect(observation.devices.length).toBeGreaterThan(0);
      for (const packet of observation.packets) {
        const matching = page.locator('.event-table tr[data-event-id="' + packet.id + '"]');
        await expect(matching).toContainText('FRAME_SENT');
        expect(['forward', 'reverse']).toContain(packet.direction);
        if (assertMotion || reducedMotion === 'reduce')
          expect(packet.moving).toBe(reducedMotion === 'no-preference');
      }
      const loggedIds = await page
        .locator('.event-table tr[data-event-id]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-event-id')));
      for (const device of observation.devices) {
        expect(loggedIds).toContain(device.id);
        if (reducedMotion === 'reduce') expect(device.animation).toBe('none');
      }
    };
    expect(new Set(observed.packets.map((p) => p.direction))).toEqual(new Set(['forward', 'reverse']));
    await verifyObservation(observed);
    await expect(page.locator('.cable-packet')).toHaveCount(0);
    await expect(page.locator('.network-device[data-activity]:not([data-activity="none"])')).toHaveCount(0);
    await page.evaluate(() => {
      const observation = (window as unknown as { __shlabMotionObservation: Observation })
        .__shlabMotionObservation;
      observation.packets = [];
      observation.devices = [];
    });
    const successes = page.locator('.event-table tr').filter({ hasText: 'PING_SUCCESS' });
    const beforeWorker = await successes.count();
    await page.getByRole('button', { name: 'Enviar ping', exact: true }).click();
    await page.getByLabel('Destino IPv4 ou hostname').fill(destination);
    await page.getByRole('button', { name: 'Enfileirar ping' }).click();
    await page.getByLabel('Velocidade', { exact: true }).selectOption('5');
    await page.getByRole('button', { name: 'Executar simulação' }).click();
    await expect(successes).toHaveCount(beforeWorker + 1);
    await page.screenshot({
      path: testInfo.outputPath('canvas-flow-' + reducedMotion + '.png'),
      fullPage: true,
      animations: 'allow',
    });
    await page.getByRole('button', { name: 'Pausar simulação' }).click();
    await expect(page.locator('.cable-packet[data-motion="active"]')).toHaveCount(0);
    const workerObservation = await page.evaluate(
      () => (window as unknown as { __shlabMotionObservation: Observation }).__shlabMotionObservation
    );
    // Um delta pode reunir ida e volta. A atividade mais recente por enlace é uma amostra fiel, não um replay.
    await verifyObservation(workerObservation, false);
    await page.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect(page.locator('.project-title')).toContainText('Salvo');
    await page.getByRole('button', { name: 'Voltar aos laboratórios' }).click();
    await page.locator('.lab-card').filter({ hasText: name }).locator('.lab-open').click();
    await expect(page.locator('.event-table')).toContainText('FRAME_SENT');
    await expect(page.locator('.cable-packet')).toHaveCount(0);
    await expect(page.locator('.network-device[data-activity]:not([data-activity="none"])')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({
      path: testInfo.outputPath('canvas-motion-' + reducedMotion + '.png'),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
}

test('Workspace: inicialização manual e terminal preservado por dispositivo', async ({ page }, testInfo) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Entrar no shLab', exact: true })).toHaveCSS(
    'background-color',
    'rgb(89, 231, 205)'
  );
  await registerAndLogin(page, 'factory-terminal-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Novo laboratório', exact: true }).click();
  const name = 'Inicialização e terminal';
  await page.getByLabel('Nome do laboratório').fill(name);
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  for (const profile of ['Switch L2', 'Computador']) {
    await page.getByRole('searchbox', { name: 'Buscar equipamento' }).fill(profile);
    await page
      .locator('.equipment-card')
      .filter({ has: page.getByText(profile, { exact: true }) })
      .click();
  }
  await expect(page.locator('.network-device.powered-off')).toHaveCount(2);
  await expect(page.locator('.event-table tbody tr')).toHaveCount(0);
  await expect(page.locator('.cable-packet')).toHaveCount(0);
  await expect(page.locator('.network-device[data-event-id]')).toHaveCount(0);
  const selected = page.locator('.network-device.selected');
  await expect(selected).toHaveCSS('outline-style', 'none');
  await expect(selected).toHaveCSS('border-top-width', '1px');
  const shadows = await selected.evaluate((element) => getComputedStyle(element).boxShadow);
  expect(shadows).not.toMatch(/0px 0px 0px [1-9]/);
  await page.screenshot({ path: testInfo.outputPath('factory-single-border.png'), fullPage: true });
  const save = async () => {
    await page.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect(page.locator('.project-title')).toContainText('Salvo');
    const projects: ProjectSummary[] = await (await page.request.get('/api/projects')).json();
    const summary = projects.find((project) => project.name === name)!;
    const response = await page.request.get('/api/projects/' + summary.id);
    expect(response.status()).toBe(200);
    return (await response.json()) as Project;
  };
  const initial = await save();
  expect(initial.topology.events).toEqual([]);
  expect(initial.topology.queue).toEqual([]);
  for (const device of initial.topology.devices) {
    expect(device.power).toBe(false);
    expect(device.interfaces.every((port) => !port.ip && !port.ipv6 && port.rx === 0 && port.tx === 0)).toBe(
      true
    );
    expect(device.wireless).toBeUndefined();
    expect(device.tcpServices ?? []).toEqual([]);
  }
  const first = initial.topology.devices.find((device) => device.profile === 'switch-l2')!;
  const second = initial.topology.devices.find((device) => device.profile === 'desktop')!;
  const inspector = page.locator('.inspector');
  const open = async (hostname: string, tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await inspectDevice(page, hostname);
    await inspector.locator('.inspector-tabs').getByRole('button', { name: tab, exact: true }).click();
  };
  await open(first.hostname, 'Resumo');
  await page.getByRole('button', { name: 'Ligar equipamento', exact: true }).click();
  await inspector.locator('.inspector-tabs').getByRole('button', { name: 'Terminal', exact: true }).click();
  const command = async (text: string) => {
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  };
  for (const text of ['enable', 'configure terminal', 'hostname SW-A', 'interface Gi0/1', 'description KEEP'])
    await command(text);
  await expect(inspector.locator('.terminal-host')).toContainText('KEEP');
  await page.keyboard.type('description NEXT');
  await inspector.locator('.inspector-tabs').getByRole('button', { name: 'Resumo', exact: true }).click();
  await page.getByLabel('Hostname', { exact: true }).fill('SW-B');
  await page.getByRole('button', { name: 'Aplicar configuração', exact: true }).click();
  await inspector.locator('.inspector-tabs').getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(inspector.locator('.terminal-host')).toContainText('KEEP');
  await expect(inspector.locator('.terminal-host')).toContainText('SW-B(config-if)#');
  await expect(inspector.locator('.terminal-host')).toContainText('NEXT');
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Enter');
  await open(second.hostname, 'Resumo');
  await page.getByRole('button', { name: 'Ligar equipamento', exact: true }).click();
  await inspector.locator('.inspector-tabs').getByRole('button', { name: 'Terminal', exact: true }).click();
  await command('show ip interface brief');
  await expect(inspector.locator('.terminal-host')).not.toContainText('KEEP');
  await expect(inspector.locator('.terminal-host')).not.toContainText('(config-if)#');
  await open('SW-B', 'Terminal');
  await expect(inspector.locator('.terminal-host')).toContainText('KEEP');
  await expect(inspector.locator('.terminal-host')).toContainText('NEXT');
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  const draft = 'description wrap_' + '0123456789'.repeat(8);
  await page.keyboard.type(draft);
  const rows = () =>
    inspector.locator('.xterm-rows').evaluate((element) =>
      Array.from(element.children)
        .map((row) => row.textContent)
        .join('')
        .replaceAll('\u00a0', ' ')
    );
  await expect.poll(rows).toContain(draft);
  await inspector.locator('.inspector-tabs').getByRole('button', { name: 'Resumo', exact: true }).click();
  await page.getByLabel('Hostname', { exact: true }).fill('SW-C');
  await page.getByRole('button', { name: 'Aplicar configuração', exact: true }).click();
  await inspector.locator('.inspector-tabs').getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect.poll(rows).toContain(draft);
  expect((await rows()).match(/0123456789/g)).toHaveLength(8);
  await page.screenshot({ path: testInfo.outputPath('terminal-retained-draft.png'), fullPage: true });
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+c');
  const saved = await save();
  expect(saved.topology.devices.find((device) => device.id === first.id)!.interfaces[0].description).toBe(
    'NEXT'
  );
  expect(
    saved.topology.devices.find((device) => device.id === second.id)!.interfaces[0].description ?? ''
  ).toBe('');
  expect(saved.topology).not.toHaveProperty('terminal');
  expect(errors).toEqual([]);
});

test('Conexões: métricas calculadas, compatibilidade física e obstrução do rádio', async ({ page }) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'physical-controls-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Sua primeira LAN/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Condição física do cabo');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const edge = page.locator('.react-flow__edge .react-flow__edge-interaction').first();
  const openLink = async () => {
    const point = await edge.evaluate((element) => {
      const path = element as SVGPathElement;
      const midpoint = path.getPointAtLength(path.getTotalLength() / 2);
      const position = new DOMPoint(midpoint.x, midpoint.y).matrixTransform(path.getScreenCTM()!);
      return { x: position.x, y: position.y };
    });
    await page.mouse.click(point.x, point.y);
  };
  await openLink();
  let dialog = page.getByRole('dialog', { name: 'Propriedades da conexão' });
  await expect(dialog.locator('input[name="latency"], input[name="jitter"], input[name="loss"]')).toHaveCount(
    0
  );
  await expect(dialog.locator('.link-metrics')).toContainText('Propagação no cabo');
  await dialog.getByLabel('Comprimento do cabo (metros)').fill('101');
  await dialog.getByRole('button', { name: 'Aplicar', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByLabel('Comprimento do cabo (metros)').fill('50');
  await dialog.getByRole('button', { name: 'Aplicar', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await openLink();
  dialog = page.getByRole('dialog', { name: 'Propriedades da conexão' });
  await expect(dialog.getByLabel('Comprimento do cabo (metros)')).toHaveValue('50');
  await expect(dialog.locator('.link-metrics')).toContainText('0.250 µs');
  const audit = await new AxeBuilder({ page }).include('.modal').analyze();
  expect(
    audit.violations.map((entry) => ({ id: entry.id, nodes: entry.nodes.map((node) => node.target) }))
  ).toEqual([]);
  await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();
  await page.getByRole('button', { name: 'Voltar aos laboratórios' }).click();
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Do rádio à resposta HTTP/ }).click();
  const name = 'Obstrução física do rádio';
  await page.getByLabel('Nome do laboratório').fill(name);
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await inspectDevice(page, 'AP-CAMPUS');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Wireless', exact: true }).click();
  const radio = page.locator('.wireless-panel');
  await expect(radio.locator('input[name="noise"], input[name="attenuation"]')).toHaveCount(0);
  const signal = async () => {
    const text = await radio.locator('.wireless-link').first().innerText();
    return Number(text.match(/RSSI (-?[\d.]+) dBm/)![1]);
  };
  const before = await signal();
  await radio.getByLabel('Obstrução do rádio').selectOption('concrete');
  await radio.getByRole('button', { name: 'Aplicar wireless', exact: true }).click();
  await expect.poll(signal).toBeLessThan(before);
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  const projects: ProjectSummary[] = await (await page.request.get('/api/projects')).json();
  const summary = projects.find((project) => project.name === name)!;
  const response = await page.request.get('/api/projects/' + summary.id);
  expect(response.status()).toBe(200);
  const project: Project = await response.json();
  expect(
    project.topology.devices.find((device) => device.hostname === 'AP-CAMPUS')!.wireless!.attenuation
  ).toBe(12);
  await page.reload();
  await page.locator('.lab-card').filter({ hasText: name }).locator('.lab-open').click();
  await inspectDevice(page, 'AP-CAMPUS');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Wireless', exact: true }).click();
  await expect(page.getByLabel('Obstrução do rádio')).toHaveValue('concrete');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('Catálogo completo: todas as abas dos 47 perfis renderizam sem falhas', async ({ page }) => {
  test.setTimeout(360000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'catalog-all-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Novo laboratório', exact: true }).click();
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspector = page.getByRole('complementary', { name: 'Inspeção de equipamento' });
  const audited = new Set<string>();
  for (const profile of deviceProfiles) {
    await page.getByRole('searchbox', { name: 'Buscar equipamento' }).fill(profile.name);
    await page
      .locator('.equipment-card')
      .filter({ has: page.getByText(profile.name, { exact: true }) })
      .click();
    await expect(inspector.locator('h2')).toBeVisible();
    const tabs = inspector.locator('.inspector-tabs button');
    const names = await tabs.allTextContents();
    for (const name of names) {
      await inspector.locator('.inspector-tabs').getByRole('button', { name, exact: true }).click();
      if (name === 'Terminal') await expect(inspector.locator('.xterm')).toBeVisible();
      expect(
        await inspector.evaluate((el) => el.scrollWidth <= el.clientWidth),
        profile.id + ': ' + name
      ).toBe(true);
      if (!audited.has(name) && name !== 'Terminal') {
        audited.add(name);
        const result = await new AxeBuilder({ page }).include('.inspector').analyze();
        expect(
          result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
          profile.id + ': ' + name
        ).toEqual([]);
      }
    }
  }
  expect(errors).toEqual([]);
});

test('Resiliência: falha ao salvar, recuperação, importação inválida e menus durante simulação', async ({
  page,
}) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'resilience-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Sua primeira LAN/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Resiliência de laboratório');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const projects = await (await page.request.get('/api/projects')).json();
  const project = projects.find((p: { name: string }) => p.name === 'Resiliência de laboratório');
  const route = '**/api/projects/' + project.id;
  await page.route(route, (request) =>
    request.request().method() === 'PUT'
      ? request.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Serviço temporariamente indisponível' }),
        })
      : request.continue()
  );
  await page.getByLabel('Nome do laboratório').fill('Resiliência após falha');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Falha ao salvar');
  await expect(page.getByRole('alert')).toContainText('Serviço temporariamente indisponível');
  await expect(page.locator('.network-device')).toHaveCount(3);
  await page.unroute(route);
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const saved = await (await page.request.get('/api/projects/' + project.id)).json();
  expect(saved.name).toBe('Resiliência após falha');
  await page.locator('input[type=file][accept=".json,.shlab.json,.netlab.json"]').setInputFiles({
    name: 'invalid.shlab.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"version":999,"devices":[]}'),
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('.network-device')).toHaveCount(3);
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await page.getByRole('button', { name: 'Fechar erro' }).click();
  const peer = saved.topology.devices.filter((d: { type: string }) => d.type === 'pc').at(-1);
  await page.getByRole('button', { name: 'Enviar ping', exact: true }).click();
  await page.getByLabel('Destino IPv4 ou hostname').fill(peer.interfaces[0].ip);
  await page.getByRole('button', { name: 'Enfileirar ping' }).click();
  await page.getByLabel('Velocidade', { exact: true }).selectOption('5');
  await page.getByRole('button', { name: 'Executar simulação' }).click();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.getByRole('button', { name: 'Opções do laboratório' }).click();
    await expect(page.getByLabel('Fundo do canvas', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Opções do laboratório' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('button', { name: 'Pausar simulação' })).toBeVisible();
  }
  await expect(page.locator('.probe-toast')).toContainText('Resposta em');
  await page.getByRole('button', { name: 'Pausar simulação' }).click();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  expect(errors).toEqual([]);
});

test('Resiliência: sair informa falha de rede e permite encerrar a sessão ao tentar novamente', async ({
  page,
}) => {
  await page.goto('/');
  await registerAndLogin(page, 'logout-retry-' + Date.now() + '@example.test');
  await page.route('**/api/auth/logout', (route) => route.abort('connectionfailed'));
  await page.getByRole('button', { name: 'Sair', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Meus laboratórios', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Não foi possível encerrar a sessão');
  await page.unroute('**/api/auth/logout');
  await page.getByRole('button', { name: 'Sair', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entrar no shLab', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Entrar no shLab', exact: true })).toBeVisible();
});

test('Equipamentos: detalhes responsivos, expansão pela esquerda e opções específicas', async ({ page }) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await registerAndLogin(page, 'integridade-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Novo laboratório', exact: true }).click();
  await page.getByLabel('Nome do laboratório').fill('Integridade de equipamentos');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspector = page.getByRole('complementary', { name: 'Inspeção de equipamento' });
  const tabs = inspector.locator('.inspector-tabs');
  const add = async (name: string) => {
    await page.getByRole('searchbox', { name: 'Buscar equipamento' }).fill(name);
    await page
      .locator('.equipment-card')
      .filter({ has: page.getByText(name, { exact: true }) })
      .click();
    await expect(inspector.locator('h2')).toBeVisible();
  };
  await add('Mesh AP');
  const meshName = (await inspector.locator('h2').textContent())!;
  expect(meshName).toMatch(/^MESH-/);
  for (const name of ['LACP', 'VXLAN / EVPN', 'OSPF', 'Controller WAN', 'Banco de dados', 'Aplicações']) {
    await expect(tabs.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await tabs.getByRole('button', { name: 'CAPWAP / Mesh / EAP', exact: true }).click();
  const features = inspector.getByRole('combobox', { name: 'Recurso de rede' });
  await expect(features.locator('option')).toHaveCount(3);
  await expect(features.locator('option[value="ids"]')).toHaveCount(0);
  await expect(features.locator('option[value="wlc"]')).toHaveCount(0);
  const handle = page.getByRole('separator', { name: 'Redimensionar detalhes do equipamento' });
  const before = (await inspector.boundingBox())!;
  const edge = (await handle.boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 120);
  await page.mouse.down();
  await page.mouse.move(edge.x - 210, edge.y + 120, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await inspector.boundingBox())!.width).toBeGreaterThan(before.width + 180);
  await expect(inspector).not.toHaveClass(/resizing/);
  const expanded = (await inspector.boundingBox())!.width;
  expect(await inspector.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await inspector.boundingBox())!.width).toBeLessThan(expanded);
  await page.screenshot({ path: 'test-results/device-details-expanded.png', fullPage: true });
  await page.setViewportSize({ width: 1000, height: 960 });
  await page.getByRole('button', { name: 'Mostrar catálogo', exact: true }).click();
  await handle.focus();
  await page.keyboard.press('End');
  const withoutCatalog = (await inspector.boundingBox())!.width;
  await page.getByRole('button', { name: 'Mostrar catálogo', exact: true }).click();
  await expect.poll(async () => (await inspector.boundingBox())!.width).toBeLessThan(withoutCatalog - 150);
  await page.setViewportSize({ width: 1440, height: 960 });
  await handle.focus();
  await page.keyboard.press('End');
  await add('Wireless Controller');
  expect((await inspector.boundingBox())!.width).toBeGreaterThan(before.width + 100);
  await expect(inspector.locator('h2')).toHaveText(/^WLC-/);
  await expect(tabs.getByRole('button', { name: 'Wireless', exact: true })).toHaveCount(0);
  await tabs.getByRole('button', { name: 'WLC / CAPWAP', exact: true }).click();
  await expect(inspector.getByRole('combobox', { name: 'Recurso de rede' }).locator('option')).toHaveCount(1);
  await add('Telefone IP');
  await tabs.getByRole('button', { name: 'Aplicações', exact: true }).click();
  await expect(inspector.getByRole('combobox').locator('option')).toHaveCount(1);
  await expect(inspector.getByRole('button', { name: 'Conectar IoT', exact: true })).toHaveCount(0);
  await tabs.getByRole('button', { name: 'Hardware / PoE', exact: true }).click();
  await expect(
    inspector.getByRole('combobox', { name: 'Socket', exact: true }).locator('option')
  ).toHaveCount(1);
  await expect(
    inspector.getByRole('combobox', { name: 'Socket', exact: true }).locator('option[value="serial"]')
  ).toHaveCount(0);
  await add('Rack');
  const rackName = (await inspector.locator('h2').textContent())!;
  await expect(tabs.getByRole('button')).toHaveCount(3);
  await expect(inspector.getByRole('button', { name: 'Desligar equipamento', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await page.getByRole('button', { name: 'Fit View', exact: true }).click();
  await page
    .locator('.network-device')
    .filter({ has: page.getByText(rackName, { exact: true }) })
    .click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Conectar', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Desligar', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await add('Smartphone');
  await expect(tabs.getByRole('button', { name: 'Hardware / PoE', exact: true })).toHaveCount(0);
  await tabs.getByRole('button', { name: 'Portas', exact: true }).click();
  await expect(inspector.locator('.interface-item')).toHaveCount(1);
  await expect(inspector.locator('.interface-item')).toContainText('Wlan0');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await inspector.boundingBox())!.width).toBeLessThanOrEqual(382);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await inspector.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await handle.focus();
  await page.keyboard.press('Home');
  await expect(handle).toHaveAttribute('aria-valuenow', '280');
  await page.keyboard.press('End');
  await expect.poll(async () => (await inspector.boundingBox())!.width).toBeGreaterThan(350);
  await page.screenshot({ path: 'test-results/device-details-mobile.png', fullPage: true });
  await expect(new AxeBuilder({ page }).include('.inspector').analyze()).resolves.toMatchObject({
    violations: [],
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await add('Mesh AP');
  await tabs.getByRole('button', { name: 'Hardware / PoE', exact: true }).click();
  await page.screenshot({ path: 'test-results/device-details-hardware.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('Canvas: categorias recolhíveis, ações com botão direito e dicas por laboratório', async ({ page }) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'canvas-ui-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Novo laboratório', exact: true }).click();
  await page.getByLabel('Nome do laboratório').fill('Canvas ações');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const catalog = page.locator('.equipment-panel');
  const wireless = catalog.getByRole('region', { name: 'Wireless', exact: true });
  await expect(wireless).toHaveCount(1);
  const disclosure = wireless.getByRole('button', { name: /^Wireless \d+$/ });
  expect(
    await disclosure.evaluate((button) => parseFloat(getComputedStyle(button).fontSize))
  ).toBeGreaterThanOrEqual(12);
  const icons = await wireless
    .locator('.equipment-card .device-icon')
    .evaluateAll((elements) => elements.map((element) => element.innerHTML));
  expect(new Set(icons).size).toBe(3);
  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(wireless.locator('.equipment-card').first()).toBeHidden();
  await disclosure.press('Space');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  const search = page.getByRole('searchbox', { name: 'Buscar equipamento' });
  await disclosure.click();
  await search.fill('access point');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(catalog.locator('.equipment-category')).toHaveCount(1);
  await expect(wireless.locator('.equipment-card')).toHaveCount(1);
  await search.fill('seguranca');
  await expect(catalog.locator('.equipment-category')).toHaveCount(1);
  await expect(catalog.getByRole('region', { name: 'Segurança' })).toBeVisible();
  await search.fill('xyz equipamento inexistente');
  await expect(catalog.getByRole('status')).toContainText('Nenhum equipamento');
  await search.clear();
  await expect(catalog.getByRole('region', { name: 'Industrial', exact: true })).toBeVisible();
  await expect(catalog.locator('.equipment-category')).toHaveCount(9);
  await catalog
    .locator('.equipment-card')
    .filter({ has: page.getByText('Computador', { exact: true }) })
    .click();
  await expect(page.locator('.inspector-device h2')).toBeVisible();
  const initialName = (await page.locator('.inspector-device h2').textContent())!;
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  const node = (name: string) =>
    page.locator('.network-device').filter({ has: page.getByText(name, { exact: true }) });
  await node(initialName).click();
  await expect(page.locator('.inspector-device h2')).toHaveText(initialName);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await node(initialName).click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Ações de ' + initialName })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Conectar', exact: true })).toBeDisabled();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Renomear', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  const rename = page.getByRole('dialog', { name: 'Renomear equipamento' });
  await rename.getByLabel('Nome do equipamento').fill('Nome inválido');
  expect(
    await rename
      .getByLabel('Nome do equipamento')
      .evaluate((input: HTMLInputElement) => input.checkValidity())
  ).toBe(false);
  await rename.getByLabel('Nome do equipamento').fill('HOST-TESTE');
  await rename.getByRole('button', { name: 'Salvar nome' }).click();
  await expect(rename).toHaveCount(0);
  await expect(node('HOST-TESTE')).toHaveClass(/powered-off/);
  await node('HOST-TESTE').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Ligar', exact: true }).click();
  await expect(node('HOST-TESTE')).not.toHaveClass(/powered-off/);
  await node('HOST-TESTE').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Desligar', exact: true }).click();
  await expect(node('HOST-TESTE')).toHaveClass(/powered-off/);
  const wrapper = node('HOST-TESTE').locator('..');
  await wrapper.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Ligar', exact: true }).click();
  await expect(node('HOST-TESTE')).not.toHaveClass(/powered-off/);
  await node('HOST-TESTE').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Duplicar', exact: true }).click();
  await expect(node('HOST-TESTE-copy')).toBeVisible();
  await expect(page.locator('.inspector-device h2')).toHaveText('HOST-TESTE-copy');
  await node('HOST-TESTE').click({ button: 'right' });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+c');
  await node('HOST-TESTE-copy').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Duplicar', exact: true }).click();
  await expect(page.locator('.inspector-device h2')).toHaveText('HOST-TESTE-copy-copy');
  await page.keyboard.press('Control+v');
  await expect(page.locator('.network-device')).toHaveCount(4);
  await expect(page.locator('.inspector-device h2')).toHaveText('HOST-TESTE-copy2');
  await expect(node('HOST-TESTE-copy2')).toHaveCount(1);
  await page.getByRole('button', { name: 'Excluir seleção', exact: true }).click();
  await expect(page.locator('.network-device')).toHaveCount(3);
  await node('HOST-TESTE-copy-copy').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Excluir', exact: true }).click();
  await expect(page.locator('.network-device')).toHaveCount(2);
  await node('HOST-TESTE').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Conectar', exact: true }).click();
  const connection = page.getByRole('dialog', { name: 'Conectar interfaces' });
  await expect(connection.getByLabel('Equipamento A')).toContainText('HOST-TESTE');
  expect(
    await connection
      .getByLabel('Equipamento A')
      .evaluate((select: HTMLSelectElement) => select.selectedOptions[0].textContent)
  ).toBe('HOST-TESTE');
  await connection.getByRole('button', { name: /Conectar/ }).click();
  await expect(connection).toHaveCount(0);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await node('HOST-TESTE-copy').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Excluir', exact: true }).click();
  await expect(page.locator('.network-device')).toHaveCount(1);
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  await page.getByRole('button', { name: 'Desfazer', exact: true }).click();
  await expect(page.locator('.network-device')).toHaveCount(2);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await node('HOST-TESTE').click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(wrapper).toBeFocused();
  await node('HOST-TESTE').click();
  await expect(page.locator('.inspector-device h2')).toHaveText('HOST-TESTE');
  await node('HOST-TESTE-copy').click();
  await expect(page.locator('.inspector-device h2')).toHaveText('HOST-TESTE-copy');
  await node('HOST-TESTE').click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Ações de HOST-TESTE', exact: true })).toBeVisible();
  await expect(page.locator('.inspector-device h2')).toHaveText('HOST-TESTE-copy');
  await page.getByRole('menuitem', { name: 'Inspecionar', exact: true }).click();
  await expect(page.locator('.inspector-device h2')).toHaveText('HOST-TESTE');
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await page.screenshot({ path: 'test-results/canvas-catalog-actions.png', fullPage: true });
  await page.getByRole('button', { name: 'Ajuda', exact: true }).click();
  const tips = page.getByRole('dialog', { name: 'Dicas do laboratório' });
  const concepts = tips.getByRole('combobox', { name: 'Conceito de rede', exact: true });
  await expect(concepts.locator('option')).toHaveCount(networkConcepts.length);
  await concepts.selectOption('arp');
  await expect(tips.locator('.concept-content')).toContainText('MAC do gateway');
  await expect(tips.locator('.concept-content ol li')).toHaveCount(2);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'test-results/concepts-free.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Fit View', exact: true }).click();
  await node('HOST-TESTE').click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  const menuBounds = await page.locator('.device-actions-popover').boundingBox();
  expect(menuBounds!.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(390);
  expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(844);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'test-results/device-actions-mobile.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Meus laboratórios', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE Canvas ações/ }).click();
  await expect(node('HOST-TESTE')).toBeVisible();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await page.getByRole('button', { name: 'Voltar aos laboratórios' }).click();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.locator('.lesson-card').filter({ hasText: 'Primeira LAN' }).click();
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await page.getByRole('button', { name: 'Ajuda', exact: true }).click();
  const scoped = page.getByRole('dialog').getByRole('combobox', { name: 'Conceito de rede', exact: true });
  await expect(scoped).toBeVisible();
  expect(
    await scoped
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
  ).toEqual(['physical', 'ethernet', 'ipv4', 'arp', 'icmp']);
  await expect(page.locator('.help-code')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/concepts-guided.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Voltar aos laboratórios' }).click();
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.locator('.lesson-card').filter({ hasText: 'A credencial abre o rádio' }).click();
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await page.getByRole('button', { name: 'Ajuda', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Conceito de rede', exact: true })).toBeVisible();
  expect(
    await page
      .getByRole('combobox', { name: 'Conceito de rede', exact: true })
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
  ).toEqual(['physical', 'ethernet', 'ipv4', 'arp', 'tcp', 'wireless']);
  expect(errors).toEqual([]);
});

test('Dashboard: navegação, filtros, favoritos, histórico e controles em desktop e mobile', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'dashboard-' + Date.now() + '@example.test');
  const navigation = page.getByRole('navigation', { name: 'Navegação principal' });
  await expect(navigation.getByRole('button')).toHaveCount(2);
  await expect(navigation.getByRole('button', { name: 'Favoritos', exact: true })).toHaveCount(0);
  await expect(navigation.getByRole('button', { name: 'Histórico', exact: true })).toHaveCount(0);
  await navigation.getByRole('button', { name: 'Templates', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Buscar templates e trilhas' });
  await search.focus();
  expect(
    await search.evaluate((input) => ({
      border: getComputedStyle(input).borderWidth,
      outline: getComputedStyle(input).outlineStyle,
      shadow: getComputedStyle(input).boxShadow,
    }))
  ).toEqual({ border: '0px', outline: 'none', shadow: 'none' });
  const heights = await page
    .locator('.catalog-card')
    .evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(10);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
  await page.getByRole('combobox', { name: 'Conteúdo', exact: true }).selectOption('lessons');
  await page.getByRole('combobox', { name: 'Tema', exact: true }).selectOption('Roteamento');
  await page.getByRole('combobox', { name: 'Nível da trilha', exact: true }).selectOption('Avançado');
  await expect(page.locator('.template-card')).toHaveCount(0);
  await expect(page.locator('.lesson-card')).toHaveCount(3);
  await page.screenshot({ path: 'test-results/catalog-desktop.png', fullPage: true });
  await page.locator('.lesson-card').filter({ hasText: 'Adjacência e caminho OSPF' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Modo do laboratório')).toHaveValue('guided');
  const action = await dialog.getByRole('button', { name: 'Criar e abrir laboratório' }).boundingBox();
  const bounds = await dialog.boundingBox();
  expect(action).not.toBeNull();
  expect(bounds).not.toBeNull();
  expect(Math.abs(action!.x + action!.width / 2 - bounds!.x - bounds!.width / 2)).toBeLessThan(1);
  await page.screenshot({ path: 'test-results/create-lab-centered.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.lesson-card').filter({ hasText: 'Adjacência e caminho OSPF' })).toBeFocused();
  await search.fill('nenhum-item-com-este-nome');
  await expect(page.getByText('Nenhum template ou trilha corresponde aos filtros.')).toBeVisible();
  await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click();
  await page.getByRole('combobox', { name: 'Conteúdo', exact: true }).selectOption('templates');
  await expect(page.getByLabel('Nível da trilha')).toBeDisabled();
  await page.getByRole('combobox', { name: 'Tema', exact: true }).selectOption('Segurança');
  await search.fill('802.1x');
  await expect(page.locator('.template-card')).toHaveCount(1);
  await expect(page.locator('.template-card')).toContainText('A porta espera autorização');
  await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click();

  const me = await (await page.request.get('/api/auth/me')).json();
  for (const body of [
    { name: 'Árvore LAN', template: 'lan', mode: 'free' },
    { name: 'DNS salvo', template: 'dns', mode: 'free' },
    { name: 'Laboratório guiado', template: 'broken', mode: 'guided', labId: 'routing-repair' },
  ]) {
    const response = await page.request.post('/api/projects', {
      headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': me.csrfToken },
      data: body,
    });
    expect(response.status()).toBe(201);
  }
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Meus laboratórios', exact: true })).toBeVisible();
  await expect(page.locator('.lab-card')).toHaveCount(3);
  await expect(page.locator('.template-card, .lesson-card')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Histórico de atividades' })).toContainText(
    'Criado · Árvore LAN'
  );
  await page.getByRole('button', { name: 'Favoritar Árvore LAN', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Remover dos favoritos Árvore LAN', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Histórico de atividades' })).toContainText(
    'Favoritado · Árvore LAN'
  );
  await page.getByRole('button', { name: 'Favoritos', exact: true }).click();
  await expect(page.locator('.lab-card')).toHaveCount(1);
  const labSearch = page.getByRole('searchbox', { name: 'Buscar laboratórios' });
  await labSearch.fill('arvore');
  await expect(page.locator('.lab-card')).toHaveCount(1);
  await labSearch.focus();
  await page.screenshot({ path: 'test-results/labs-search-focus.png', fullPage: true });
  await page.getByRole('combobox', { name: 'Modo', exact: true }).selectOption('guided');
  await expect(page.getByText('Nenhum laboratório corresponde aos filtros.')).toBeVisible();
  await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click();
  await page.getByRole('combobox', { name: 'Modo', exact: true }).selectOption('guided');
  await expect(page.locator('.lab-card')).toHaveCount(1);
  await expect(page.locator('.lab-card')).toContainText('Laboratório guiado');
  await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click();
  await page.getByRole('combobox', { name: 'Progresso', exact: true }).selectOption('in-progress');
  await expect(page.locator('.lab-card')).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Progresso', exact: true }).selectOption('completed');
  await expect(page.locator('.lab-card')).toHaveCount(0);
  await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click();
  await page.getByRole('combobox', { name: 'Ordenar por', exact: true }).selectOption('name');
  expect(await page.locator('.lab-card h3').allTextContents()).toEqual([
    'Árvore LAN',
    'DNS salvo',
    'Laboratório guiado',
  ]);
  const labHeights = await page
    .locator('.lab-card, .new-lab-card')
    .evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().height));
  expect(Math.max(...labHeights) - Math.min(...labHeights)).toBeLessThan(1);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Remover dos favoritos Árvore LAN', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'test-results/labs-dashboard-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/labs-dashboard-mobile.png', fullPage: true });
  await navigation.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('combobox', { name: 'Conteúdo', exact: true }).selectOption('lessons');
  await page.getByRole('combobox', { name: 'Tema', exact: true }).selectOption('Roteamento');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/catalog-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('VPN e SD-WAN: configuração, controller, failover HTTP, PDU e persistência mobile', async ({ page }) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await registerAndLogin(page, 'sdwan-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /A aplicação escolhe o caminho/ }).click();
  await page.getByLabel('Nome do laboratório').fill('SD-WAN E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (name: string, tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await inspectDevice(page, name);
    await page.locator('.inspector-tabs').getByRole('button', { name: tab, exact: true }).click();
  };
  await inspect('WAN-A', 'VPN / SD-WAN');
  await page.getByLabel('Chave do túnel').fill('Tunnel-Key-123');
  await page.getByRole('button', { name: 'Aplicar túnel' }).click();
  await advanceSimulation(
    page,
    async () =>
      (await page.locator('[data-tunnel-state="up"]').count()) === 2 &&
      (await page
        .locator('.tunnel-panel')
        .innerText()
        .then((v) => v.includes('políticas recebidas'))),
    350
  );
  await page.screenshot({ path: 'test-results/sdwan-desktop.png', fullPage: true });
  await inspect('LAN-A', 'TCP / HTTP');
  await page.getByLabel('Destino TCP IPv4').fill('10.2.0.20');
  await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.tcp-result').innerText()).includes('overlay sdwan'),
    300
  );
  await inspect('WAN-A', 'VPN / SD-WAN');
  await expect(page.locator('[data-selected-path="tun1"]')).toContainText('WEB');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Portas', exact: true }).click();
  await page
    .locator('.interface-item')
    .filter({ has: page.getByText('Gi0/2', { exact: true }) })
    .click();
  await page.getByRole('dialog').getByLabel('Interface habilitada (no shutdown)').uncheck();
  await page.getByRole('button', { name: 'Aplicar à simulação' }).click();
  await inspect('LAN-A', 'TCP / HTTP');
  await page.getByLabel('Destino TCP IPv4').fill('10.2.0.20');
  await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.tcp-result').innerText()).includes('overlay sdwan'),
    300
  );
  await inspect('WAN-A', 'VPN / SD-WAN');
  await advanceSimulation(
    page,
    async () => (await page.locator('[data-selected-path="tun2"]').count()) > 0,
    350
  );
  await page.locator('.event-filters').getByRole('button', { name: 'VPN / SD-WAN', exact: true }).click();
  await page.locator('.event-table-wrap tr').filter({ hasText: 'TUNNEL_SENT' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('Túnel sobre UDP/4500');
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE SD-WAN E2E/ }).click();
  await inspect('WAN-A', 'VPN / SD-WAN');
  await expect(page.locator('[data-selected-path="tun2"]')).toContainText('WEB');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.tunnel-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/sdwan-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
async function inspectDhcp(page: Page, hostname: string) {
  await inspectDevice(page, hostname);
  await page.locator('.inspector-tabs').getByRole('button', { name: 'DHCP', exact: true }).click();
}
for (const scenario of [
  { template: 'O pacote segue os labels', name: 'MPLS', router: 'PE-A', client: 'CE-A', body: 'labels MPLS' },
  {
    template: 'Quem passa primeiro na fila',
    name: 'QoS',
    router: 'QOS-EDGE',
    client: 'QOS-CLIENT',
    body: 'fila QoS',
  },
]) {
  test(
    scenario.name + ': configuração, encaminhamento HTTP, inspeção e save/load mobile',
    async ({ page }) => {
      test.setTimeout(150000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto('/');
      await registerAndLogin(page, scenario.name.toLowerCase() + '-' + Date.now() + '@example.test');
      await page.getByRole('button', { name: 'Templates', exact: true }).click();
      await page.getByRole('button', { name: new RegExp(scenario.template) }).click();
      await page.getByLabel('Nome do laboratório').fill(scenario.name + ' E2E');
      await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
      const inspect = async (name: string, tab: string) => {
        const close = page.getByRole('button', { name: 'Fechar inspector' });
        if (await close.count()) await close.click();
        await inspectDevice(page, name);
        await page.locator('.inspector-tabs').getByRole('button', { name: tab, exact: true }).click();
      };
      await inspect(scenario.router, 'QoS / MPLS');
      if (scenario.name === 'MPLS') {
        await expect(page.getByLabel('FEC e LFIB JSON')).toContainText('100');
        await page.getByRole('button', { name: 'Aplicar MPLS', exact: true }).click();
      } else {
        await page.getByLabel('Porta QoS').selectOption('p1');
        const config = JSON.parse(await page.getByLabel('Configuração QoS JSON').inputValue());
        config.queueLimit = 12;
        await page.getByText('Editor avançado JSON · Configuração QoS JSON', { exact: true }).click();
        await page.getByLabel('Configuração QoS JSON', { exact: true }).fill(JSON.stringify(config, null, 2));
        await page.getByRole('button', { name: 'Aplicar QoS', exact: true }).click();
        await expect(page.locator('[data-qos-depth]')).toContainText('/12');
      }
      await inspect(scenario.client, 'TCP / HTTP');
      await page.getByLabel('Destino TCP IPv4').fill('10.2.0.20');
      await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
      await advanceSimulation(
        page,
        async () => (await page.locator('.tcp-result').innerText()).includes(scenario.body),
        350
      );
      await page.getByRole('button', { name: 'Ver toda a rede', exact: true }).click();
      await page.locator('.event-filters').getByRole('button', { name: 'QoS / MPLS', exact: true }).click();
      await page
        .locator('.event-table-wrap tr')
        .filter({ hasText: scenario.name === 'MPLS' ? 'MPLS_SWAP' : 'QOS_DEQUEUE' })
        .first()
        .click();
      await expect(page.getByRole('dialog')).toContainText(
        scenario.name === 'MPLS' ? 'MPLS — labels' : 'TCP'
      );
      await page
        .getByRole('dialog')
        .locator('.modal-head')
        .getByRole('button', { name: 'Fechar', exact: true })
        .click();
      await inspect(scenario.router, 'QoS / MPLS');
      if (scenario.name === 'QoS') {
        await page.getByLabel('Porta QoS').selectOption('p1');
        await expect(page.locator('.forwarding-panel tr').filter({ hasText: 'WEB' })).not.toContainText(
          '0/0'
        );
      }
      await page.screenshot({
        path: 'test-results/' + scenario.name.toLowerCase() + '-desktop.png',
        fullPage: true,
      });
      await page.getByRole('button', { name: 'Salvar', exact: true }).click();
      await expect(page.locator('.project-title')).toContainText('Salvo');
      await page.reload();
      await page
        .getByRole('button', { name: new RegExp('^LABORATÓRIO LIVRE ' + scenario.name + ' E2E') })
        .click();
      await inspect(scenario.router, 'QoS / MPLS');
      if (scenario.name === 'QoS') await page.getByLabel('Porta QoS').selectOption('p1');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('.forwarding-panel').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: 'test-results/' + scenario.name.toLowerCase() + '-mobile.png',
        fullPage: true,
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    }
  );
}
async function inspectTcp(page: Page, hostname: string) {
  await inspectDevice(page, hostname);
  await page.locator('.inspector-tabs').getByRole('button', { name: 'TCP / HTTP', exact: true }).click();
}
test('AAA: 802.1X, RADIUS, VLAN, TACACS+, HTTP e persistência mobile', async ({ page }) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await registerAndLogin(page, 'aaa-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /A porta espera autorização/ }).click();
  await page.getByLabel('Nome do laboratório').fill('AAA E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (name: string, tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await inspectDevice(page, name);
    await page.locator('.inspector-tabs').getByRole('button', { name: tab, exact: true }).click();
  };
  await inspect('SW-AUTH', '802.1X / AAA');
  await page.getByRole('button', { name: 'Aplicar AAA', exact: true }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('[data-dot1x-state="authorized"]').count()) === 1,
    150
  );
  await expect(page.locator('[data-dot1x-state="authorized"]')).toContainText('/ 20');
  await page.getByLabel('Usuário de rede').fill('admin');
  await page.getByLabel('Senha de rede').fill('rede-admin');
  await page.getByRole('button', { name: 'Autenticar na rede' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.aaa-panel').innerText()).includes('admin / privilégio 15'),
    200
  );
  await page.locator('.inspector-body').evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({ path: 'test-results/aaa-desktop.png', fullPage: true });
  await inspect('PC-8021X', 'TCP / HTTP');
  await page.getByLabel('Destino TCP IPv4').fill('10.20.0.20');
  await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.tcp-result').innerText()).includes('HTTP após autorização'),
    150
  );
  await page.locator('.event-filters').getByRole('button', { name: '802.1X / AAA', exact: true }).click();
  await page.locator('.event-table-wrap tr').filter({ hasText: 'DOT1X_RECEIVED' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('802.1X — EAPOL');
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE AAA E2E/ }).click();
  await inspect('SW-AUTH', '802.1X / AAA');
  await expect(page.locator('[data-dot1x-state="authorized"]')).toContainText('/ 20');
  await expect(page.locator('.aaa-panel')).toContainText('admin / privilégio 15');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/aaa-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('Inspeção de aplicação: Host HTTP bloqueado e permitido, regras e persistência mobile', async ({
  page,
}) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await registerAndLogin(page, 'inspection-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /O firewall lê a aplicação/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Inspection E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (name: string, tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await inspectDevice(page, name);
    await page.locator('.inspector-tabs').getByRole('button', { name: tab, exact: true }).click();
  };
  await inspect('R-EDGE-01', 'Políticas');
  await page.getByRole('button', { name: 'Aplicar inspeção', exact: true }).click();
  await inspect('PC-01', 'TCP / HTTP');
  await page.getByLabel('Host HTTP (opcional)').fill('blocked.lab');
  await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
  await inspect('R-EDGE-01', 'Políticas');
  await advanceSimulation(
    page,
    async () => (await page.locator('[data-inspection-decision="deny"]').count()) === 1,
    200
  );
  await expect(page.locator('[data-inspection-decision="deny"]')).toContainText('blocked.lab');
  await inspect('PC-01', 'TCP / HTTP');
  await page.getByLabel('Host HTTP (opcional)').fill('allowed.lab');
  await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.tcp-result').innerText()).includes('200 OK'),
    200
  );
  await inspect('R-EDGE-01', 'Políticas');
  await page.locator('.inspection-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/inspection-desktop.png', fullPage: true });
  await expect(page.locator('[data-inspection-decision="permit"]')).toContainText('allowed.lab');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE Inspection E2E/ }).click();
  await inspect('R-EDGE-01', 'Políticas');
  await expect(page.locator('[data-inspection-decision="deny"]')).toContainText('blocked.lab');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.inspection-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/inspection-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('VXLAN/EVPN: VNI, BGP MAC/IP, HTTP, encapsulamento e persistência mobile', async ({ page }) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await registerAndLogin(page, 'evpn-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /O BGP anuncia onde está o MAC/ }).click();
  await page.getByLabel('Nome do laboratório').fill('EVPN E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (name: string, tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await inspectDevice(page, name);
    await page.locator('.inspector-tabs').getByRole('button', { name: tab, exact: true }).click();
  };
  await inspect('VTEP-A', 'VXLAN / EVPN');
  await expect(page.getByLabel('Configuração VNI JSON')).toContainText('10010');
  await page.getByRole('button', { name: 'Aplicar VNI' }).click();
  await page.locator('.inspector-tabs').getByRole('button', { name: 'BGP', exact: true }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.bgp-panel tr[data-state="Established"]').count()) === 1,
    350
  );
  await inspect('VM-A', 'TCP / HTTP');
  await page.getByLabel('Destino TCP IPv4').fill('10.50.0.20');
  await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.tcp-result').innerText()).includes('overlay VXLAN'),
    350
  );
  await inspect('VTEP-A', 'VXLAN / EVPN');
  await advanceSimulation(page, async () => (await page.locator('[data-evpn-mac]').count()) > 0, 250);
  await expect(page.locator('[data-evpn-mac]').first()).toContainText('10.50.0.20');
  await page.locator('.inspector-body').evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({ path: 'test-results/evpn-desktop.png', fullPage: true });
  await page.locator('.event-filters').getByRole('button', { name: 'VXLAN / EVPN', exact: true }).click();
  await page.locator('.event-table-wrap tr').filter({ hasText: 'FRAME_SENT' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('VXLAN — UDP/4789');
  await expect(page.getByRole('dialog')).toContainText('10010');
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE EVPN E2E/ }).click();
  await inspect('VTEP-A', 'VXLAN / EVPN');
  await expect(page.locator('[data-evpn-mac]').first()).toContainText('10.50.0.20');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.vxlan-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/evpn-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
test('DHCP relay: pool remoto, reserva, pacotes, ping, release e persistência mobile', async ({ page }) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'relay-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Um servidor, duas redes/ }).click();
  await page.getByLabel('Nome do laboratório').fill('DHCP relay E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await expect(page.locator('.network-device')).toHaveCount(6);
  await inspectDhcp(page, 'DHCP-CENTRAL');
  await page.getByRole('button', { name: 'Editar pool USERS', exact: true }).click();
  await expect(page.getByLabel('Tipo de pool')).toHaveValue('remote');
  const mac = (await page.getByLabel('Reservas por MAC', { exact: true }).inputValue()).split(' ')[0];
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.getByRole('button', { name: 'Excluir pool USERS', exact: true }).click();
  await page.getByRole('button', { name: 'Novo pool', exact: true }).click();
  await page.getByLabel('Nome do pool').fill('CENTRAL');
  await page.getByLabel('Tipo de pool').selectOption('remote');
  await page.getByLabel('IPv4 do relay (giaddr)').fill('192.168.10.1');
  await page.getByLabel('Rede do pool').fill('192.168.10.0');
  await page.getByLabel('Início do intervalo').fill('192.168.10.50');
  await page.getByLabel('Fim do intervalo').fill('192.168.10.70');
  await page.getByLabel('Gateway do pool').fill('192.168.10.1');
  await page.getByLabel('Servidores DNS', { exact: true }).fill('192.168.20.10');
  await page.getByLabel('Reservas por MAC', { exact: true }).fill(mac + ' 192.168.10.65');
  await page.screenshot({ path: 'test-results/relay-pool-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Salvar pool', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await inspectDhcp(page, 'R-EDGE-01');
  await expect(page.getByLabel('Servidores do relay')).toHaveValue('192.168.20.10');
  await page.getByRole('button', { name: 'Aplicar relay', exact: true }).click();
  await page.screenshot({ path: 'test-results/relay-router-desktop.png', fullPage: true });
  await advanceSimulation(
    page,
    async () =>
      (await page.locator('.network-device').filter({ hasText: 'PC-01' }).innerText()).includes(
        '192.168.10.65'
      ) &&
      (await page.locator('.network-device').filter({ hasText: 'PC-02' }).innerText()).includes(
        '192.168.10.50'
      )
  );
  await inspectDhcp(page, 'PC-01');
  await expect(page.locator('.dhcp-client')).toHaveAttribute('data-state', 'bound');
  await expect(page.locator('.dhcp-client')).toContainText('192.168.20.10');
  await inspectDhcp(page, 'R-EDGE-01');
  await page.locator('.event-filters').getByRole('button', { name: 'DHCP', exact: true }).click();
  await page.locator('.event-table tr').filter({ hasText: 'DHCP_RELAY_REPLY' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('Endereço do relay DHCP');
  await expect(page.getByRole('dialog')).toContainText('192.168.10.1');
  await expect(page.getByRole('dialog')).toContainText('Saltos de relay');
  await page.screenshot({ path: 'test-results/relay-packet-desktop.png', fullPage: true });
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await page.getByRole('button', { name: 'Enviar ping', exact: true }).click();
  await page.getByLabel('Destino IPv4 ou hostname').fill('192.168.20.10');
  await page.getByRole('button', { name: 'Enfileirar ping' }).click();
  await advanceSimulation(page, async () =>
    (await page.locator('.probe-toast').innerText()).includes('Resposta em')
  );
  await inspectDhcp(page, 'PC-01');
  await page.getByRole('button', { name: 'Liberar DHCP Eth0', exact: true }).click();
  await page.getByRole('button', { name: 'Renovar DHCP Eth0', exact: true }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.dhcp-client').getAttribute('data-state')) === 'bound'
  );
  await expect(page.locator('.dhcp-client')).toContainText('192.168.10.65/24');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE DHCP relay E2E/ }).click();
  await inspectDhcp(page, 'DHCP-CENTRAL');
  await expect(page.getByRole('table', { name: 'Reservas CENTRAL' })).toContainText('192.168.10.65');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('table', { name: 'Reservas CENTRAL' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/relay-reservations-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await inspectDhcp(page, 'R-EDGE-01');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('Servidores do relay')).toHaveValue('192.168.20.10');
  await page.screenshot({ path: 'test-results/relay-router-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('RIP: configuração, vetores, expiração exibida e persistência mobile', async ({ page }) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'rip-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Rotas por distância/ }).click();
  await page.getByLabel('Nome do laboratório').fill('RIP E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await inspectDevice(page, 'R-01');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'RIP', exact: true }).click();
  await page.getByRole('button', { name: 'Aplicar RIP', exact: true }).click();
  const route = page.locator('.rip-panel tr').filter({ hasText: '192.168.20.0/24' });
  await advanceSimulation(
    page,
    async () => (await route.count()) > 0 && (await route.getAttribute('data-metric')) === '2',
    200
  );
  await expect(route).toContainText('10.0.13.3');
  await page.locator('.event-filters').getByRole('button', { name: 'RIP', exact: true }).click();
  await page.locator('.event-table tr').filter({ hasText: 'RIP_UPDATE' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('RIPv2');
  await expect(page.getByRole('dialog')).toContainText('520');
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await switchTerminal(page, 'R-01', ['enable', 'conf t', 'interface Gi0/2', 'shutdown']);
  await page.locator('.inspector-tabs').getByRole('button', { name: 'RIP', exact: true }).click();
  await advanceSimulation(
    page,
    async () => (await route.count()) > 0 && (await route.getAttribute('data-metric')) === '3',
    250
  );
  await expect(route).toContainText('10.0.12.2');
  await page.getByRole('heading', { name: 'Tabela RIP', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/rip-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE RIP E2E/ }).click();
  await inspectDevice(page, 'R-01');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'RIP', exact: true }).click();
  await expect(route).toHaveAttribute('data-metric', '3');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: 'Tabela RIP', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/rip-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('OSPF: convergência, falha, inspector e persistência', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'ospf-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Rotas que se adaptam/ }).click();
  await page.getByLabel('Nome do laboratório').fill('OSPF E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await inspectDevice(page, 'R-01');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'OSPF', exact: true }).click();
  const route = page.locator('.ospf-panel tr').filter({ hasText: '192.168.20.0/24' });
  await advanceSimulation(
    page,
    async () => (await route.count()) > 0 && (await route.innerText()).includes('21'),
    400
  );
  await expect(route).toContainText('10.0.12.2');
  await page.locator('.event-filters').getByRole('button', { name: 'OSPF', exact: true }).click();
  await page.locator('.event-table tr').filter({ hasText: 'OSPF_SENT' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('89 (OSPF)');
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await switchTerminal(page, 'R-01', ['enable', 'conf t', 'interface Gi0/1', 'shutdown']);
  await page.locator('.inspector-tabs').getByRole('button', { name: 'OSPF', exact: true }).click();
  await advanceSimulation(
    page,
    async () => (await route.count()) > 0 && (await route.innerText()).includes('31'),
    400
  );
  await expect(route).toContainText('10.0.13.3');
  await page.getByRole('heading', { name: 'Vizinhos OSPF' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/ospf-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE OSPF E2E/ }).click();
  await inspectDevice(page, 'R-01');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'OSPF', exact: true }).click();
  await expect(route).toContainText('31');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: 'Vizinhos OSPF' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/ospf-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('gerenciamento: SNMP, syslog, configuração, pacotes e persistência mobile', async ({ page }) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'management-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Rede sob observação/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Gerenciamento E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (hostname: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await inspectDevice(page, hostname);
    await page.locator('.inspector-tabs').getByRole('button', { name: 'Gerenciamento', exact: true }).click();
  };
  const query = async (expected: string) => {
    await page.getByRole('button', { name: 'Consultar SNMP', exact: true }).click();
    await advanceSimulation(
      page,
      async () => (await page.locator('.snmp-result').getAttribute('data-state')) !== 'pending',
      128
    );
    await expect(page.locator('.snmp-result')).toHaveAttribute('data-state', expected);
  };
  await inspect('PC-01');
  await query('success');
  await expect(page.locator('.snmp-result')).toContainText('SERVER-01');
  await page.locator('.event-filters').getByRole('button', { name: 'Gerenciamento', exact: true }).click();
  await page.locator('.event-table-wrap tr').filter({ hasText: 'FRAME_SENT' }).last().click();
  await expect(page.getByRole('dialog')).toContainText('SNMP');
  await expect(page.getByRole('dialog')).toContainText('161');
  await expect(page.getByRole('dialog')).toContainText('requestId');
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.getByLabel('Operação SNMP').selectOption('get-next');
  await query('success');
  await expect(page.locator('.snmp-result')).toContainText('1.3.6.1.2.1.2.1.0');
  await inspect('SERVER-01');
  await page.getByLabel('Community do agente', { exact: true }).fill('read_lab');
  await page.getByRole('button', { name: 'Aplicar agente SNMP' }).click();
  await inspect('PC-01');
  await query('timeout');
  await page.getByLabel('Community da consulta', { exact: true }).fill('read_lab');
  await page.getByLabel('Operação SNMP').selectOption('get');
  await query('success');
  await page.locator('.snmp-result').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/snmp-desktop.png', fullPage: true });
  await page.getByLabel('Mensagem syslog', { exact: true }).fill('Teste de coleta por enlace');
  await page.getByRole('button', { name: 'Enviar mensagem syslog' }).click();
  await inspect('SERVER-01');
  await advanceSimulation(page, async () =>
    (await page.locator('.syslog-records').innerText()).includes('Teste de coleta por enlace')
  );
  await expect(page.locator('.syslog-records')).toContainText('PC-01');
  await expect(page.locator('.syslog-records')).toContainText('190');
  await page.locator('.syslog-records').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/syslog-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE Gerenciamento E2E/ }).click();
  await inspect('SERVER-01');
  await expect(page.getByLabel('Community do agente')).toHaveValue('read_lab');
  await expect(page.locator('.syslog-records')).toContainText('Teste de coleta por enlace');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.syslog-records').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/management-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('zonas: regras por serviço, bloqueio, HTTP, PAT/ICMP citado e persistência desktop/mobile', async ({
  page,
}) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'zones-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Três zonas, caminhos controlados/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Zonas E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async () => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await inspectDevice(page, 'FW-EDGE');
    await page.locator('.inspector-tabs').getByRole('button', { name: 'Políticas', exact: true }).click();
  };
  await inspect();
  const panel = page.locator('.firewall-panel');
  await expect(panel.getByLabel('Modo do firewall')).toHaveValue('zones');
  const rules = await panel.getByLabel('Regras entre zonas').inputValue();
  await panel.getByLabel('Regras entre zonas').fill('5 WAN DMZ deny tcp eq 80\n' + rules);
  await panel.getByRole('button', { name: 'Aplicar firewall' }).click();
  await inspectTcp(page, 'WAN-CLIENT');
  await page.getByLabel('Destino TCP IPv4').fill('192.168.30.10');
  await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.tcp-result').getAttribute('data-state')) === 'TIMED-OUT',
    160
  );
  await inspect();
  await expect(panel).toContainText('Sessões: 0');
  await expect(panel).not.toContainText('Descartes: 0');
  await panel.getByLabel('Regras entre zonas').fill(rules);
  await panel.getByRole('button', { name: 'Aplicar firewall' }).click();
  for (const [origin, target] of [
    ['WAN-CLIENT', '192.168.30.10'],
    ['PC-01', '192.168.20.10'],
  ]) {
    await inspectTcp(page, origin);
    await page.getByLabel('Destino TCP IPv4').fill(target);
    await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
    await advanceSimulation(
      page,
      async () => (await page.locator('.tcp-result').getAttribute('data-state')) === 'TIME-WAIT',
      160
    );
    await expect(page.locator('.tcp-result')).toContainText('HTTP/1.1 200 OK');
  }
  await switchTerminal(page, 'PC-01', ['traceroute 192.168.20.10']);
  await inspect();
  await page.locator('.event-filters').getByRole('button', { name: 'ACL / NAT', exact: true }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.event-table').innerText()).includes('RELATED'),
    160
  );
  await page.locator('.event-filters').getByRole('button', { name: 'ICMP', exact: true }).click();
  await page.locator('.event-table-wrap tr').filter({ hasText: 'FRAME_SENT' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('Pacote que provocou o erro');
  await expect(page.getByRole('dialog')).toContainText('time-exceeded');
  await expect(page.getByRole('dialog')).toContainText('192.168.10.10');
  await page.screenshot({ path: 'test-results/zones-icmp-desktop.png', fullPage: true });
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await inspect();
  await expect(panel.getByRole('table').filter({ hasText: 'Protocolo' }).locator('tbody')).toContainText(
    'WAN → DMZ'
  );
  await expect(panel).toContainText('Descartes: 0');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE Zonas E2E/ }).click();
  await inspect();
  await expect(panel.getByLabel('Regras entre zonas')).toHaveValue(rules);
  await expect(panel.getByRole('table').filter({ hasText: 'Protocolo' }).locator('tbody')).toContainText(
    'WAN → DMZ'
  );
  await page.screenshot({ path: 'test-results/zones-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByLabel('Regras entre zonas').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/zones-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('firewall: UDP, ICMP, bloqueio de entrada e sessões persistidas desktop/mobile', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'firewall-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Entre duas redes/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Firewall E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspectFirewall = async () => {
    await inspectDevice(page, 'R-EDGE-01');
    await page.locator('.inspector-tabs').getByRole('button', { name: 'Políticas', exact: true }).click();
  };
  await inspectFirewall();
  const panel = page.locator('.firewall-panel');
  await panel.getByLabel('Ativar firewall', { exact: true }).check();
  await panel.getByLabel(/Gi0\/1 ·/).check();
  for (const protocol of ['TCP', 'UDP', 'ICMP'])
    await expect(panel.getByLabel(protocol, { exact: true })).toBeChecked();
  await panel.getByRole('button', { name: 'Aplicar firewall' }).click();
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await rstpPing(page, 'Resposta em', '192.168.20.10');
  await switchTerminal(page, 'SERVER-01', [
    'enable',
    'configure terminal',
    'dns record firewall.lab A 203.0.113.20 ttl 0',
  ]);
  await inspectDns(page, 'PC-01');
  await page.getByLabel('Servidor da consulta').fill('192.168.20.10');
  await page.getByLabel('Transporte DNS').selectOption('udp');
  await queryDns(page, 'firewall.lab');
  await expect(page.locator('.dns-query-result')).toContainText('success');
  await inspectFirewall();
  await expect(panel.getByRole('table').filter({ hasText: 'Protocolo' }).locator('tbody')).toContainText(
    'ICMP'
  );
  await expect(panel.getByRole('table').filter({ hasText: 'Protocolo' }).locator('tbody')).toContainText(
    'UDP'
  );
  await expect(panel.getByRole('table').filter({ hasText: 'Protocolo' }).locator('tbody')).toContainText(
    'REPLIED'
  );
  await expect(panel).toContainText('Descartes: 0');
  await panel.getByRole('table').filter({ hasText: 'Protocolo' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/firewall-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await page.getByRole('button', { name: 'Enviar ping', exact: true }).click();
  const serverOption = await page
    .getByLabel('Equipamento de origem')
    .getByRole('option', { name: /SERVER-01/ })
    .getAttribute('value');
  await page.getByLabel('Equipamento de origem').selectOption(serverOption!);
  await page.getByLabel('Destino IPv4 ou hostname').fill('192.168.10.10');
  await page.getByRole('button', { name: 'Enfileirar ping' }).click();
  await advanceSimulation(page, async () =>
    (await page.locator('.probe-toast').innerText()).includes('timeout')
  );
  await inspectFirewall();
  await expect(panel).toContainText('Descartes: 1');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE Firewall E2E/ }).click();
  await inspectFirewall();
  await expect(panel.getByLabel('UDP', { exact: true })).toBeChecked();
  await expect(panel.getByRole('table').filter({ hasText: 'Protocolo' }).locator('tbody')).toContainText(
    'UDP'
  );
  await expect(panel).toContainText('Descartes: 1');
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole('table').filter({ hasText: 'Protocolo' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/firewall-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('TCP: HTTP, echo, firewall, packet inspector e save/reload desktop/mobile', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'tcp-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Da conexão à resposta/ }).click();
  await page.getByLabel('Nome do laboratório').fill('TCP E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await inspectTcp(page, 'SERVER-01');
  await page.getByRole('button', { name: 'Aplicar opções TCP', exact: true }).click();
  await inspectTcp(page, 'PC-01');
  await page.getByRole('button', { name: 'Aplicar opções TCP', exact: true }).click();
  await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.tcp-result').getAttribute('data-state')) === 'TIME-WAIT',
    128
  );
  await expect(page.locator('.tcp-result')).toContainText('HTTP/1.1 200 OK');
  await expect(page.locator('.tcp-result')).toContainText('Olá da rede simulada!');
  await expect(page.locator('.tcp-result')).toContainText('SACK negociado');
  await expect(page.locator('.tcp-result')).toContainText('ECN negociado');
  await expect(page.locator('.tcp-result')).toContainText('Timestamps negociados');
  await page.getByRole('button', { name: 'Opções do laboratório', exact: true }).click();
  await page.getByRole('button', { name: 'Exportar captura PCAP', exact: true }).click();
  const captureDialog = page.getByRole('dialog', { name: 'Captura binária da simulação' });
  await expect(captureDialog).toBeVisible();
  expect((await new AxeBuilder({ page }).include('dialog[open]').analyze()).violations).toEqual([]);
  const downloadPromise = page.waitForEvent('download');
  await captureDialog.getByRole('button', { name: 'Baixar PCAP', exact: true }).click();
  const downloaded = await downloadPromise;
  expect(downloaded.suggestedFilename()).toBe('TCP-E2E.pcap');
  const frames = decodePcap(await readFile((await downloaded.path())!));
  expect(frames.length).toBeGreaterThan(10);
  expect(frames.map((r) => new TextDecoder().decode(r.frame.transport?.payload)).join('')).toContain(
    'HTTP/1.1 200 OK'
  );
  expect(frames.some((r) => r.frame.transport?.options?.some((o) => o.kind === 8))).toBe(true);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'test-results/tcp-http-desktop.png', fullPage: true });
  await page.getByRole('combobox', { name: 'Operação TCP' }).selectOption('echo');
  await page.getByLabel('Mensagem echo').fill('Mensagem TCP com acentuação');
  await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.tcp-result').getAttribute('data-state')) === 'TIME-WAIT',
    128
  );
  await expect(page.locator('.tcp-result')).toContainText('Mensagem TCP com acentuação');
  await inspectDevice(page, 'R-EDGE-01');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Políticas', exact: true }).click();
  await expect(page.locator('.firewall-panel')).toContainText('CLOSING');
  await expect(page.locator('.firewall-panel')).toContainText('Descartes: 0');
  await page.locator('.event-filters').getByRole('button', { name: 'TCP', exact: true }).click();
  const packetRow = page.locator('.event-table-wrap tr').filter({ hasText: 'FRAME_SENT' }).last();
  await packetRow.click();
  await expect(page.getByRole('dialog')).toContainText('Confirmação TCP (ACK)');
  await expect(page.getByRole('dialog')).toContainText('6 (TCP)');
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await inspectTcp(page, 'SERVER-01');
  await page.getByLabel('HTTP TCP/80 · LISTEN').uncheck();
  await inspectTcp(page, 'PC-01');
  await page.getByRole('combobox', { name: 'Operação TCP' }).selectOption('http');
  await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.tcp-result').getAttribute('data-state')) === 'RESET',
    128
  );
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE TCP E2E/ }).click();
  await inspectTcp(page, 'PC-01');
  await expect(page.locator('.tcp-result')).toContainText('RESET');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Iniciar tráfego TCP' })).toBeVisible();
  await page.screenshot({ path: 'test-results/tcp-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
async function inspectDns(page: Page, hostname: string) {
  await inspectDevice(page, hostname);
  await page.locator('.inspector-tabs').getByRole('button', { name: 'DNS', exact: true }).click();
}
async function queryDns(page: Page, name: string, type = 'A') {
  await page.getByLabel('Nome consultado', { exact: true }).fill(name);
  await page.getByRole('combobox', { name: 'Tipo de consulta', exact: true }).selectOption(type);
  await page.getByRole('button', { name: 'Consultar DNS', exact: true }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.dns-query-result').getAttribute('data-state')) !== 'pending'
  );
}
async function advanceSimulation(page: Page, ready: () => Promise<boolean>, maxSteps = 64) {
  for (let step = 0; step < maxSteps; step++) {
    if (await ready()) return;
    await expect(
      page.getByRole('button', { name: 'Próximo evento', exact: true }),
      'A operação ainda exige eventos pendentes'
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Próximo evento', exact: true }).click();
  }
  expect(await ready(), 'A operação deve terminar em até ' + maxSteps + ' eventos da simulação').toBe(true);
}
async function switchTerminal(page: Page, hostname: string, commands: string[]) {
  await inspectDevice(page, hostname);
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.locator('.xterm-helper-textarea').focus();
  for (const command of commands) {
    await page.keyboard.type(command);
    await page.keyboard.press('Enter');
  }
}
async function rstpPing(page: Page, result: string, destination = '192.168.10.20') {
  await page.getByRole('button', { name: 'Enviar ping', exact: true }).click();
  await page.getByLabel('Destino IPv4 ou hostname').fill(destination);
  await page.getByRole('button', { name: 'Enfileirar ping' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.probe-toast').innerText()).includes(result),
    result === 'timeout' ? 256 : 64
  );
  await expect(page.locator('.probe-toast')).toContainText(result);
}
test('Bond: configuração de NICs, failover de acesso, ping e persistência mobile', async ({ page }) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await registerAndLogin(page, 'bond-ui-' + Date.now() + '@example.test');
  const me = await (await page.request.get('/api/auth/me')).json(),
    origin = new URL(page.url()).origin,
    headers = { Origin: origin, 'X-CSRF-Token': me.csrfToken },
    fixture = dualAccessFixture();
  const created = await page.request.post('/api/projects', {
    headers,
    data: { name: 'Bond UI', template: 'empty' },
  });
  expect(created.status()).toBe(201);
  const project = await created.json();
  const seeded = await page.request.put('/api/projects/' + project.id, {
    headers,
    data: { name: 'Bond UI', revision: project.revision, topology: fixture.snapshot },
  });
  expect(seeded.status()).toBe(200);
  await page.reload();
  await page.getByRole('heading', { name: 'Bond UI', exact: true }).click();
  await inspectDevice(page, 'HMI-TESTE');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Redundância NIC', exact: true }).click();
  const panel = page.locator('.bond-panel');
  for (const checkbox of await panel
    .getByRole('group', { name: 'NICs participantes' })
    .getByRole('checkbox')
    .all())
    await checkbox.check();
  await panel.getByLabel('Alvo ARP no domínio local (opcional)').fill('192.0.2.1');
  await panel.getByRole('button', { name: 'Aplicar bond', exact: true }).click();
  await expect(panel.locator('[data-bond="Bond1"]')).toHaveAttribute('data-active', 'p0');
  await panel.getByRole('button', { name: 'Configurar IPv4', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Endereço IPv4', { exact: true })).toHaveValue(
    '192.0.2.10'
  );
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.getByRole('button', { name: 'Fechar inspector', exact: true }).click();
  await switchTerminal(page, 'SW-PRIMARY', ['enable', 'configure terminal', 'interface Gi0/1', 'shutdown']);
  await page.getByRole('button', { name: 'Fechar inspector', exact: true }).click();
  await inspectDevice(page, 'HMI-TESTE');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Redundância NIC', exact: true }).click();
  await expect(panel.locator('[data-bond="Bond1"]')).toHaveAttribute('data-active', fixture.spare);
  await page.getByRole('button', { name: 'Fechar inspector', exact: true }).click();
  await rstpPing(page, 'Resposta em', '192.0.2.1');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('heading', { name: 'Bond UI', exact: true }).click();
  await inspectDevice(page, 'HMI-TESTE');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Redundância NIC', exact: true }).click();
  await expect(panel.locator('[data-bond="Bond1"]')).toHaveAttribute('data-active', fixture.spare);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/bond-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('Serviços HA: configuração do VIP, tracking, presets e persistência mobile', async ({ page }) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await registerAndLogin(page, 'service-ha-ui-' + Date.now() + '@example.test');
  const me = await (await page.request.get('/api/auth/me')).json();
  const created = await page.request.post('/api/projects', {
    headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': me.csrfToken },
    data: { name: 'Serviços HA UI', template: 'service-ha' },
  });
  expect(created.status()).toBe(201);
  await page.reload();
  await page.getByRole('heading', { name: 'Serviços HA UI', exact: true }).click();
  await inspectDevice(page, 'SVC-A');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'VRRP', exact: true }).click();
  const panel = page.locator('.vrrp-panel');
  await panel.getByRole('button', { name: 'Editar VRID 42', exact: true }).click();
  const accept = panel.getByRole('checkbox', { name: 'Accept mode: atender serviços locais no IP virtual' });
  await expect(accept).toBeChecked();
  await accept.uncheck();
  await panel
    .getByRole('textbox', { name: 'Tracking VRRP', exact: true })
    .fill('service dns 80\nservice http:80 80');
  await panel.getByRole('button', { name: 'Aplicar grupo VRRP', exact: true }).click();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('heading', { name: 'Serviços HA UI', exact: true }).click();
  await inspectDevice(page, 'SVC-A');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'VRRP', exact: true }).click();
  await panel.getByRole('button', { name: 'Editar VRID 42', exact: true }).click();
  await expect(accept).not.toBeChecked();
  await expect(panel.getByRole('textbox', { name: 'Tracking VRRP', exact: true })).toHaveValue(
    'service dns 80\nservice http:80 80'
  );
  await accept.check();
  await panel.getByRole('button', { name: 'Aplicar grupo VRRP', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/service-ha-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Fechar inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Opções do laboratório', exact: true }).click();
  await page.getByRole('button', { name: 'Validar rede e cenários', exact: true }).click();
  await page.getByRole('button', { name: 'Cenários e SLA', exact: true }).click();
  await expect(page.getByLabel('Carregar cenário').locator('option')).toHaveCount(7);
  await page.getByLabel('Carregar cenário').selectOption({ label: 'Modelo: Serviços HA — parada de dns' });
  expect(errors).toEqual([]);
});
test('Processo industrial: ciclos PLC/HMI, alarmes, persistência e mobile', async ({ page }) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await registerAndLogin(page, 'process-ui-' + Date.now() + '@example.test');
  const me = await (await page.request.get('/api/auth/me')).json();
  const created = await page.request.post('/api/projects', {
    headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': me.csrfToken },
    data: { name: 'Processo UI', template: 'industrial-process' },
  });
  expect(created.status()).toBe(201);
  await page.reload();
  await page.getByRole('heading', { name: 'Processo UI', exact: true }).click();
  const open = async () => {
    await page.getByRole('button', { name: 'Opções do laboratório', exact: true }).click();
    await page.getByRole('button', { name: 'Validar rede e cenários', exact: true }).click();
    await page.getByRole('button', { name: 'PLC / HMI', exact: true }).click();
  };
  const close = async () =>
    page
      .getByRole('dialog')
      .locator('.modal-head')
      .getByRole('button', { name: 'Fechar', exact: true })
      .click();
  await open();
  const panel = page.locator('.industrial-process-panel');
  await panel.getByRole('combobox', { name: 'Controle do tanque', exact: true }).selectOption('manual');
  await panel.getByLabel('Nível inicial ao aplicar (0–1000)', { exact: true }).fill('950');
  await panel.getByLabel('Vazão de entrada (unidades/s)', { exact: true }).fill('0');
  await panel.getByLabel('Vazão de saída (unidades/s)', { exact: true }).fill('0');
  await panel.getByRole('button', { name: 'Aplicar processo PLC', exact: true }).click();
  await panel.getByLabel('Alarme alto da amostra HMI (opcional)', { exact: true }).fill('900');
  await panel.getByRole('button', { name: 'Aplicar ciclo HMI', exact: true }).click();
  await close();
  await page.getByLabel('Modo de simulação', { exact: true }).selectOption('realtime');
  await expect(page.getByRole('button', { name: 'Pausar simulação', exact: true })).toBeVisible();
  await open();
  await expect(panel.getByRole('status', { name: 'Estado do processo PLC' })).toContainText('Alarme: retido');
  await expect(panel.getByRole('status', { name: 'Estado do ciclo HMI' })).toContainText('Valor: alarme');
  await panel.getByRole('button', { name: 'Reconhecer alarme do processo', exact: true }).click();
  await expect(panel.getByRole('status', { name: 'Estado do processo PLC' })).toContainText(
    'Reconhecido: true'
  );
  await close();
  await page.getByRole('button', { name: 'Pausar simulação', exact: true }).click();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('heading', { name: 'Processo UI', exact: true }).click();
  await open();
  await expect(panel.getByRole('status', { name: 'Estado do processo PLC' })).toContainText(
    'Reconhecido: true'
  );
  await expect(panel.getByRole('status', { name: 'Estado do ciclo HMI' })).toContainText('950');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.getByRole('status', { name: 'Estado do processo PLC' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/process-mobile.png', fullPage: true });
  await panel.getByRole('status', { name: 'Estado do ciclo HMI' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/hmi-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});
async function configureIp(page: Page, hostname: string, ip: string) {
  await inspectDevice(page, hostname);
  const power = page.getByRole('button', { name: 'Ligar equipamento', exact: true });
  if (await power.count()) await power.click();
  await page.getByRole('button', { name: 'Portas', exact: true }).click();
  await page.locator('.interface-item').first().click();
  await page.getByLabel('Endereço IPv4').fill(ip);
  await page.getByRole('button', { name: 'Aplicar à simulação' }).click();
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
}
async function connect(page: Page, a: string, portA: string, b: string, portB: string) {
  await page.getByRole('button', { name: 'Conectar', exact: true }).click();
  await page.getByLabel('Equipamento A').selectOption({ label: a });
  await page.getByLabel('Interface A').selectOption({ label: portA + ' · rj45' });
  await page.getByLabel('Equipamento B').selectOption({ label: b });
  await page.getByLabel('Interface B').selectOption({ label: portB + ' · rj45' });
  await page.getByRole('button', { name: 'Conectar equipamentos' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
test('canvas: grupos, notas, grade e reabertura', async ({ page }) => {
  await page.goto('/');
  await registerAndLogin(page, 'canvas-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Sua primeira LAN/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Canvas E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await inspectDevice(page, 'PC-01');
  await page
    .locator('.network-device')
    .filter({ hasText: 'PC-02' })
    .click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Opções do laboratório' }).click();
  await page.getByRole('button', { name: 'Agrupar seleção', exact: true }).click();
  await expect(page.locator('.canvas-group')).toHaveCount(1);
  await page.getByLabel('Texto da anotação').fill('Estações');
  const bounds = await page.locator('.canvas-group').boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width - 35, bounds!.y + bounds!.height - 25);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width + 35, bounds!.y + bounds!.height + 25, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Opções do laboratório' }).click();
  await page.getByRole('button', { name: 'Desagrupar', exact: true }).click();
  await expect(page.locator('.canvas-group')).toHaveCount(0);
  await expect(page.locator('.network-device')).toHaveCount(3);
  await page.getByRole('button', { name: 'Opções do laboratório' }).click();
  await page.getByLabel('Ajustar à grade').uncheck();
  await page.getByRole('combobox', { name: 'Marcação', exact: true }).selectOption('fine-grid');
  await page.getByRole('button', { name: 'Adicionar nota', exact: true }).click();
  await page.getByLabel('Texto da anotação').fill('LAN de desenvolvimento');
  await page.getByRole('button', { name: 'Cor cyan', exact: true }).click();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.screenshot({ path: 'test-results/canvas-notes-desktop.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE Canvas E2E/ }).click();
  await expect(page.locator('.canvas-note')).toContainText('LAN de desenvolvimento');
  await page.getByRole('button', { name: 'Opções do laboratório' }).click();
  await expect(page.getByLabel('Ajustar à grade')).not.toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Marcação', exact: true })).toHaveValue('fine-grid');
});

test('labs: tarefas, correção, avaliação e progresso persistido', async ({ page }) => {
  await page.goto('/');
  await registerAndLogin(page, 'guided-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.locator('.lesson-card').filter({ hasText: 'Primeira LAN' }).click();
  await expect(page.getByRole('combobox', { name: 'Modo do laboratório', exact: true })).toHaveValue(
    'guided'
  );
  await expect(page.getByRole('combobox', { name: 'Trilha', exact: true })).toHaveValue('lan-foundations');
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.locator('.lesson-card').filter({ hasText: 'Reconecte as sub-redes' }).click();
  await page.getByLabel('Nome do laboratório').fill('Lab guiado E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await page.getByRole('button', { name: 'Tarefas do laboratório', exact: true }).click();
  await expect(page.locator('.lab-task-list li')).toHaveCount(3);
  await page.getByRole('button', { name: 'Validar laboratório', exact: true }).click();
  await expect(page.locator('.lab-evaluation')).toContainText('Em andamento');
  await expect(page.locator('.probe-toast')).toHaveCount(0);
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await switchTerminal(page, 'R-EDGE-01', ['enable', 'configure terminal', 'interface Gi0/2', 'no shutdown']);
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await page.getByRole('button', { name: 'Tarefas do laboratório', exact: true }).click();
  await expect(page.locator('.lab-evaluation')).toContainText('Alterações ainda não avaliadas');
  await page.getByRole('button', { name: 'Validar laboratório', exact: true }).click();
  await expect(page.locator('.lab-evaluation')).toContainText('Laboratório concluído');
  await expect(page.locator('.lab-task-list li.passed')).toHaveCount(3);
  await page.screenshot({ path: 'test-results/lab-evaluation-desktop.png', fullPage: true });
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.getByRole('button', { name: 'Voltar aos laboratórios' }).click();
  await expect(page.getByRole('button', { name: /LABORATÓRIO GUIADO Lab guiado E2E/ })).toContainText(
    '3/3 tarefas'
  );
  await page.reload();
  await page.getByRole('button', { name: /LABORATÓRIO GUIADO Lab guiado E2E/ }).click();
  await page.getByRole('button', { name: 'Tarefas do laboratório', exact: true }).click();
  await expect(page.locator('.lab-evaluation')).toContainText('Laboratório concluído');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/lab-evaluation-mobile.png', fullPage: true });
});

test('políticas: PAT, ACL, bloqueio, recuperação e persistência', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'policy-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Além da rede privada/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Políticas E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await inspectDevice(page, 'R-EDGE-01');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Políticas', exact: true }).click();
  await page.getByRole('button', { name: 'Nova tradução', exact: true }).click();
  await page.getByRole('button', { name: 'Salvar tradução', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('NAT habilitado')).toBeChecked();
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await rstpPing(page, 'Resposta em', '192.168.20.10');
  await page.getByRole('button', { name: 'Inspetor da rede', exact: true }).click();
  await page.getByRole('tab', { name: 'Caminho', exact: true }).click();
  await page.getByRole('button', { name: 'Traçar caminho', exact: true }).click();
  await expect(page.locator('.path-result')).toContainText('success');
  await expect(page.locator('.network-table')).toContainText('192.168.20.100');
  await page.screenshot({ path: 'test-results/network-path-desktop.png', fullPage: true });
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.locator('.event-table').getByRole('row').filter({ hasText: 'FRAME_RECEIVED' }).first().click();
  await page.getByRole('dialog').locator('.event-technical > summary').click();
  await expect(page.locator('.osi-stack')).toBeVisible();
  await expect(page.locator('.osi-stack > div')).toHaveCount(3);
  await expect(page.locator('.osi-stack > div')).toContainText(['IPv4', 'Ethernet', 'Cabo de cobre']);
  await expect(page.getByRole('dialog')).toContainText('ICMP');
  await page.screenshot({ path: 'test-results/osi-packet-desktop.png', fullPage: true });
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await inspectDevice(page, 'R-EDGE-01');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Políticas', exact: true }).click();
  await expect(page.locator('.nat-translations')).toContainText('192.168.20.100');
  await page.getByRole('button', { name: 'Nova regra', exact: true }).click();
  await page.getByRole('combobox', { name: 'Ação', exact: true }).selectOption('deny');
  await page.getByRole('combobox', { name: 'Protocolo', exact: true }).selectOption('icmp');
  await page.getByRole('button', { name: 'Salvar regra', exact: true }).click();
  await page.getByRole('combobox', { name: 'ACL in Gi0/1', exact: true }).selectOption('FILTER');
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await rstpPing(page, 'timeout', '192.168.20.10');
  await page.locator('.event-filters').getByRole('button', { name: 'ACL / NAT', exact: true }).click();
  await expect(page.locator('.event-table')).toContainText('ACL_DENY');
  await inspectDevice(page, 'R-EDGE-01');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Políticas', exact: true }).click();
  await page.getByRole('button', { name: 'Editar regra 10 de FILTER', exact: true }).click();
  await page.getByRole('combobox', { name: 'Ação', exact: true }).selectOption('permit');
  await page.getByRole('button', { name: 'Salvar regra', exact: true }).click();
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await rstpPing(page, 'Resposta em', '192.168.20.10');
  await page.screenshot({ path: 'test-results/policies-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE Políticas E2E/ }).click();
  await inspectDevice(page, 'R-EDGE-01');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Políticas', exact: true }).click();
  await expect(page.getByLabel('ACL in Gi0/1')).toHaveValue('FILTER');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/policies-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('conta: perfil, sessões independentes, revogação e exclusão', async ({ page, browser }) => {
  const address = 'shlab-account-' + Date.now() + '@example.test';
  await page.goto('/');
  await registerAndLogin(page, address);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await other.goto('/');
    await other.getByLabel('E-mail', { exact: true }).fill(address);
    await other.getByLabel('Senha', { exact: true }).fill(password);
    await other.getByRole('button', { name: 'Entrar no shLab' }).click();
    await expect(other.getByRole('heading', { name: 'Meus laboratórios', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Conta e segurança', exact: true }).click();
    await page.getByLabel('Nome de exibição').fill('Network Builder');
    await page.getByRole('button', { name: 'Salvar perfil', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('status')).toContainText('Perfil atualizado');
    await page.getByRole('tab', { name: 'Sessões', exact: true }).click();
    await expect(page.locator('.account-session')).toHaveCount(2);
    await page.screenshot({ path: 'test-results/account-desktop.png', fullPage: true });
    await page.getByRole('button', { name: 'Encerrar outra sessão', exact: true }).click();
    await expect(page.locator('.account-session')).toHaveCount(1);
    await other.reload();
    await expect(other.getByRole('heading', { name: 'Entrar no shLab', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('tab', { name: 'Perfil', exact: true }).click();
    await expect(page.getByLabel('Nome de exibição')).toHaveValue('Network Builder');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/account-mobile.png', fullPage: true });
    await page.getByRole('tab', { name: 'Excluir conta', exact: true }).click();
    await page.getByLabel('Confirme sua senha').fill(password);
    await page.getByLabel('Entendo que esta ação é irreversível').check();
    await page.getByRole('button', { name: 'Excluir minha conta', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Entrar no shLab', exact: true })).toBeVisible();
  } finally {
    await otherContext.close();
  }
});

test('RSTP: redundância, BPDUs, falha, recuperação e persistência mobile', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'shlab-rstp-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Redundância sem loops/ }).click();
  await page.getByLabel('Nome do laboratório').fill('RSTP E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await expect(page.locator('.network-device')).toHaveCount(5);
  await inspectDevice(page, 'SW-03');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'STP', exact: true }).click();
  await expect(page.locator('.stp-ports tr[data-port="p2"]')).toHaveAttribute('data-role', 'alternate');
  await expect(page.locator('.stp-blocked')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/rstp-workspace-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await rstpPing(page, 'Resposta em');
  const viewportZoom = () =>
    page
      .locator('.react-flow__viewport')
      .evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
  const zoomBeforeInspection = await viewportZoom();
  await switchTerminal(page, 'SW-03', ['enable', 'configure terminal', 'interface Gi0/2', 'shutdown']);
  expect(await viewportZoom()).toBeCloseTo(zoomBeforeInspection, 5);
  await page.locator('.inspector-tabs').getByRole('button', { name: 'STP', exact: true }).click();
  await advanceSimulation(
    page,
    async () =>
      (await page.locator('.stp-ports tr[data-port="p2"]').getAttribute('data-state')) === 'forwarding'
  );
  await expect(page.locator('.stp-ports tr[data-port="p2"]')).toHaveAttribute('data-role', 'root');
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await rstpPing(page, 'Resposta em');
  await switchTerminal(page, 'SW-03', ['enable', 'configure terminal', 'interface Gi0/3', 'shutdown']);
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await rstpPing(page, 'timeout');
  await switchTerminal(page, 'SW-03', ['enable', 'configure terminal', 'interface Gi0/3', 'no shutdown']);
  await page.locator('.inspector-tabs').getByRole('button', { name: 'STP', exact: true }).click();
  await advanceSimulation(
    page,
    async () =>
      (await page.locator('.stp-ports tr[data-port="p2"]').getAttribute('data-state')) === 'forwarding'
  );
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await rstpPing(page, 'Resposta em');
  await page.locator('.event-filters').getByRole('button', { name: 'STP', exact: true }).click();
  await page.locator('.event-table').getByRole('row').filter({ hasText: 'BPDU_RECEIVED' }).first().click();
  await page.getByRole('dialog').locator('.event-technical > summary').click();
  await expect(page.getByRole('dialog')).toContainText('RSTP BPDU');
  await expect(page.getByRole('dialog')).toContainText('Proposta / acordo RSTP');
  await page.screenshot({ path: 'test-results/rstp-bpdu-desktop.png', fullPage: true });
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE RSTP E2E/ }).click();
  const finder = page.getByRole('textbox', { name: 'Localizar equipamento' });
  await finder.fill('SW-03');
  await finder.press('Enter');
  await finder.press('Escape');
  await page.locator('.network-device').getByText('SW-03', { exact: true }).click();
  await expect(page.locator('.inspector-device h2')).toHaveText('SW-03');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'STP', exact: true }).click();
  await expect(page.locator('.stp-ports tr[data-port="p2"]')).toHaveAttribute('data-role', 'root');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/rstp-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await page.setViewportSize({ width: 1440, height: 960 });
  await inspectDevice(page, 'SW-03');
  await page.getByRole('button', { name: 'Duplicar', exact: true }).click();
  await expect(page.locator('.network-device')).toHaveCount(6);
  await page.locator('.inspector-tabs').getByRole('button', { name: 'STP', exact: true }).click();
  await expect(page.locator('.stp-summary')).toContainText('Esta bridge é a raiz');
  await page.getByRole('button', { name: 'Excluir seleção', exact: true }).click();
  await expect(page.locator('.network-device')).toHaveCount(5);
  await page.getByRole('button', { name: 'Voltar aos laboratórios' }).click();
  expect(errors).toEqual([]);
});

test('DNS: registros, nslookup, cache, ping por nome, falha e persistência mobile', async ({ page }) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'shlab-dns-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Nomes na rede/ }).click();
  await page.getByLabel('Nome do laboratório').fill('DNS E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await inspectDns(page, 'DNS-01');
  for (const record of [
    { name: 'app.lab', type: 'A', value: '192.168.50.12' },
    { name: 'app.lab', type: 'AAAA', value: '2001:db8::12' },
    { name: 'alias.lab', type: 'CNAME', value: 'app.lab' },
  ]) {
    await page.getByRole('button', { name: 'Novo registro', exact: true }).click();
    await page.getByLabel('Nome DNS', { exact: true }).fill(record.name);
    await page.getByRole('combobox', { name: 'Tipo do registro', exact: true }).selectOption(record.type);
    await page.getByLabel('Valor do registro', { exact: true }).fill(record.value);
    await page.getByLabel('TTL (segundos)', { exact: true }).fill('60');
    await page.getByRole('button', { name: 'Salvar registro', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Editar alias.lab CNAME', exact: true }).click();
  await page.getByLabel('TTL (segundos)', { exact: true }).fill('30');
  await page.screenshot({ path: 'test-results/dns-record-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Salvar registro', exact: true }).click();
  await page.getByRole('button', { name: 'Excluir server.lab AAAA', exact: true }).click();
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await inspectDns(page, 'PC-01');
  await expect(page.getByLabel('Servidores DNS (DHCP)', { exact: true })).toHaveValue('192.168.50.2');
  await queryDns(page, 'alias.lab');
  await expect(page.locator('.dns-query-result')).toHaveAttribute('data-state', 'success');
  await expect(page.locator('.dns-query-result')).toContainText('192.168.50.12');
  await queryDns(page, 'alias.lab');
  await expect(page.locator('.dns-query-result')).toContainText('(cache)');
  await queryDns(page, 'app.lab', 'AAAA');
  await expect(page.locator('.dns-query-result')).toContainText('2001:db8::12');
  await queryDns(page, 'alias.lab', 'CNAME');
  await expect(page.locator('.dns-query-result')).toContainText('IN CNAME app.lab');
  await page.locator('.event-filters').getByRole('button', { name: 'DNS', exact: true }).click();
  await page.locator('.event-table').getByRole('row').filter({ hasText: 'FRAME_RECEIVED' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('17 (UDP)');
  await expect(page.getByRole('dialog')).toContainText('NOERROR');
  await page.screenshot({ path: 'test-results/dns-packet-desktop.png', fullPage: true });
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('nslookup app.lab');
  await page.keyboard.press('Enter');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'DNS', exact: true }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.dns-query-result').getAttribute('data-state')) !== 'pending'
  );
  await expect(page.locator('.dns-query-result')).toContainText('app.lab A');
  await expect(page.locator('.dns-query-result')).toHaveAttribute('data-state', 'success');
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await page.getByRole('button', { name: 'Enviar ping', exact: true }).click();
  await page.getByLabel('Destino IPv4 ou hostname').fill('app.lab');
  await page.getByRole('button', { name: 'Enfileirar ping' }).click();
  await advanceSimulation(page, async () =>
    (await page.locator('.probe-toast').innerText()).includes('Resposta em')
  );
  await expect(page.locator('.probe-toast')).toContainText('Resposta em');
  await inspectDns(page, 'DNS-01');
  await page.getByRole('switch', { name: 'Serviço DNS', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Serviço DNS', exact: true })).toHaveAttribute(
    'aria-checked',
    'false'
  );
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await inspectDns(page, 'PC-01');
  await page.getByRole('button', { name: 'Limpar cache DNS', exact: true }).click();
  await queryDns(page, 'app.lab');
  await expect(page.locator('.dns-query-result')).toHaveAttribute('data-state', 'timeout');
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await inspectDns(page, 'DNS-01');
  await page.getByRole('switch', { name: 'Serviço DNS', exact: true }).click();
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await inspectDns(page, 'PC-01');
  await page.getByRole('combobox', { name: 'Transporte DNS', exact: true }).selectOption('tcp');
  await queryDns(page, 'app.lab');
  await expect(page.locator('.dns-query-result')).toHaveAttribute('data-state', 'success');
  await expect(page.locator('.dns-query-result')).toContainText('Transporte: TCP');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'TCP / HTTP', exact: true }).click();
  await expect(page.locator('.tcp-result')).toContainText(':53');
  await page.screenshot({ path: 'test-results/dns-tcp-desktop.png', fullPage: true });
  await page.locator('.inspector-tabs').getByRole('button', { name: 'DNS', exact: true }).click();
  await page.screenshot({ path: 'test-results/dns-workspace-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE DNS E2E/ }).click();
  await inspectDns(page, 'PC-01');
  await expect(page.locator('.dns-query-result')).toContainText('Transporte: TCP');
  await expect(page.locator('.dns-query-result')).toHaveAttribute('data-state', 'success');
  await expect(page.locator('.dns-cache')).toContainText('app.lab');
  await page.setViewportSize({ width: 390, height: 844 });
  await queryDns(page, 'app.lab');
  await expect(page.locator('.dns-query-result')).toContainText('(cache)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/dns-client-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await page.getByRole('button', { name: 'Voltar aos laboratórios' }).click();
  expect(errors).toEqual([]);
});

test('cadastro → LAN do zero → ping → save/reload → redes roteadas → falha/recuperação', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error('BROWSER ERROR', error.message);
  });
  await mkdir(resolve('test-results'), { recursive: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Entrar no shLab', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/auth-desktop.png', fullPage: true });
  await registerAndLogin(page, email);
  await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Novo laboratório' }).click();
  await page.getByLabel('Nome do laboratório').fill('E2E · LAN construída do zero');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await expect(page.locator('.canvas-empty')).toBeVisible();
  await page.locator('.equipment-card').filter({ hasText: 'Computador' }).click();
  await expect(page.locator('.network-device')).toHaveCount(1);
  await page.locator('.equipment-card').filter({ hasText: 'Computador' }).click();
  await expect(page.locator('.network-device')).toHaveCount(2);
  await page.locator('.equipment-card').filter({ hasText: 'Switch L2' }).click();
  await expect(page.locator('.network-device')).toHaveCount(3);
  const [clientA, clientB, switchName] = await page.locator('.network-device strong').allTextContents();
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await inspectDevice(page, clientA);
  await page
    .locator('.network-device')
    .filter({ hasText: clientB })
    .click({ modifiers: ['Shift'] });
  await expect(page.locator('.network-device.selected')).toHaveCount(2);
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await expect(page.locator('.network-device.selected')).toHaveCount(0);
  await configureIp(page, clientA, '192.168.10.10');
  await configureIp(page, clientB, '192.168.10.20');
  await inspectDevice(page, switchName);
  await page.getByRole('button', { name: 'Ligar equipamento', exact: true }).click();
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await connect(page, clientA, 'Eth0', switchName, 'Gi0/1');
  await connect(page, clientB, 'Eth0', switchName, 'Gi0/2');
  await page.getByRole('button', { name: 'Enviar ping', exact: true }).click();
  await page.getByLabel('Destino IPv4 ou hostname').fill('192.168.10.20');
  await page.getByRole('button', { name: 'Enfileirar ping' }).click();
  await page.getByLabel('Velocidade', { exact: true }).selectOption('5');
  await page.getByRole('button', { name: 'Executar simulação' }).click();
  await expect(page.locator('.probe-toast')).toContainText('Resposta em');
  await expect(page.locator('.event-table')).toContainText('ARP_REQUEST');
  await page.getByRole('button', { name: 'Pausar simulação' }).click();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.screenshot({ path: 'test-results/lan-workspace.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE E2E · LAN construída do zero/ }).click();
  await expect(page.locator('.network-device')).toHaveCount(3);
  await expect(page.locator('.probe-toast')).toContainText('Resposta em');
  await page.getByRole('button', { name: 'Voltar aos laboratórios' }).click();
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Entre duas redes/ }).click();
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await page.getByRole('button', { name: 'Enviar ping', exact: true }).click();
  await page.getByRole('button', { name: 'Enfileirar ping' }).click();
  await page.getByLabel('Velocidade', { exact: true }).selectOption('5');
  await page.getByRole('button', { name: 'Executar simulação' }).click();
  await expect(page.locator('.probe-toast')).toContainText('Resposta em');
  await inspectDevice(page, 'R-EDGE-01');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();

  // Use keyboard input so xterm receives actual terminal data.
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('enable');
  await page.keyboard.press('Enter');
  await page.keyboard.type('configure terminal');
  await page.keyboard.press('Enter');
  await page.keyboard.type('interface Gi0/2');
  await page.keyboard.press('Enter');
  await page.keyboard.type('shutdown');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await page.getByRole('button', { name: 'Enviar ping', exact: true }).click();
  await page.getByRole('button', { name: 'Enfileirar ping' }).click();
  await page.getByRole('button', { name: 'Executar simulação', exact: true }).click();
  await expect(page.locator('.probe-toast')).toContainText('unreachable');
  await inspectDevice(page, 'R-EDGE-01');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  for (const cmd of ['enable', 'configure terminal', 'interface Gi0/2', 'no shutdown']) {
    await page.keyboard.type(cmd);
    await page.keyboard.press('Enter');
  }
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await page.getByRole('button', { name: 'Enviar ping', exact: true }).click();
  await page.getByRole('button', { name: 'Enfileirar ping' }).click();
  await page.getByRole('button', { name: 'Executar simulação', exact: true }).click();
  await expect(page.locator('.probe-toast')).toContainText('Resposta em');
  await page.screenshot({ path: 'test-results/routed-workspace.png', fullPage: true });
  await page.getByRole('button', { name: 'Pausar simulação' }).click();
  await page.getByRole('button', { name: 'Voltar aos laboratórios' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Meus laboratórios', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE Entre duas redes/ }).click();
  await expect(page.locator('.network-device')).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/workspace-mobile.png', fullPage: true });
  await inspectDevice(page, 'R-EDGE-01');
  await page.getByRole('button', { name: 'Portas', exact: true }).click();
  await page.locator('.interface-item').first().click();
  await expect(page.getByLabel('Endereço IPv4')).toHaveValue('192.168.10.1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/inspector-mobile.png', fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: 'Fechar', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await page.getByRole('button', { name: 'Voltar aos laboratórios' }).click();
  expect(errors).toEqual([]);
});

test('DHCP: pool, dois clientes, pacotes, ping, lease e persistência mobile', async ({ page }) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'shlab-dhcp-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Endereços automáticos/ }).click();
  await page.getByLabel('Nome do laboratório').fill('DHCP E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await expect(page.locator('.network-device')).toHaveCount(4);
  await inspectDhcp(page, 'DHCP-01');
  await page.getByRole('button', { name: 'Excluir pool LAN', exact: true }).click();
  await page.getByRole('button', { name: 'Novo pool', exact: true }).click();
  await page.getByLabel('Nome do pool').fill('USERS');
  await page.getByLabel('Início do intervalo').fill('192.168.50.10');
  await page.getByLabel('Fim do intervalo').fill('192.168.50.12');
  await page.getByLabel('Gateway do pool').fill('192.168.50.1');
  await page.getByLabel('Servidores DNS').fill('192.168.50.2');
  await page.getByLabel('Endereços excluídos').fill('192.168.50.11');
  await page.screenshot({ path: 'test-results/dhcp-pool-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Salvar pool', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  for (const hostname of ['PC-01', 'PC-02']) {
    await inspectDevice(page, hostname);
    await page.getByRole('button', { name: 'Portas', exact: true }).click();
    await page.locator('.interface-item').first().click();
    await page.getByLabel('Automático (DHCP)', { exact: true }).check();
    await expect(page.getByLabel('Endereço IPv4')).toBeDisabled();
    await page.getByRole('button', { name: 'Aplicar à simulação' }).click();
    await page.getByRole('button', { name: 'Fechar inspector' }).click();
  }
  await advanceSimulation(
    page,
    async () =>
      (await page.locator('.network-device').filter({ hasText: 'PC-01' }).innerText()).includes(
        '192.168.50.10'
      ) &&
      (await page.locator('.network-device').filter({ hasText: 'PC-02' }).innerText()).includes(
        '192.168.50.12'
      )
  );
  await expect(page.locator('.network-device').filter({ hasText: 'PC-01' })).toContainText('192.168.50.10');
  await expect(page.locator('.network-device').filter({ hasText: 'PC-02' })).toContainText('192.168.50.12');
  await inspectDhcp(page, 'PC-01');
  await expect(page.locator('.dhcp-client')).toHaveAttribute('data-state', 'bound');
  await expect(page.locator('.dhcp-client')).toContainText('192.168.50.1');
  await page.locator('.event-filters').getByRole('button', { name: 'DHCP', exact: true }).click();
  await expect(page.locator('.event-table')).toContainText('DHCP_DISCOVER');
  await expect(page.locator('.event-table')).not.toContainText('DHCP_ACK');
  await page.getByRole('button', { name: 'Fechar inspector', exact: true }).click();
  await inspectDhcp(page, 'DHCP-01');
  await expect(page.locator('.event-table')).toContainText('DHCP_ACK');
  await page.locator('.event-table').getByRole('row').filter({ hasText: 'DHCP_ACK' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('17 (UDP)');
  await expect(page.getByRole('dialog')).toContainText('Servidores DNS informados');
  await page.screenshot({ path: 'test-results/dhcp-packet-desktop.png', fullPage: true });
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await page.getByRole('button', { name: 'Enviar ping', exact: true }).click();
  await page.getByLabel('Destino IPv4 ou hostname').fill('192.168.50.12');
  await page.getByRole('button', { name: 'Enfileirar ping' }).click();
  await advanceSimulation(page, async () =>
    (await page.locator('.probe-toast').innerText()).includes('Resposta em')
  );
  await expect(page.locator('.probe-toast')).toContainText('Resposta em');
  await inspectDhcp(page, 'DHCP-01');
  await expect(page.locator('.dhcp-bindings')).toContainText('192.168.50.10');
  await expect(page.locator('.dhcp-bindings')).toContainText('192.168.50.12');
  await page.screenshot({ path: 'test-results/dhcp-workspace-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await inspectDhcp(page, 'PC-01');
  await page.getByRole('button', { name: 'Liberar DHCP Eth0', exact: true }).click();
  await expect(page.locator('.dhcp-client')).toHaveAttribute('data-state', 'released');
  await page.getByRole('button', { name: 'Renovar DHCP Eth0', exact: true }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.dhcp-client').getAttribute('data-state')) === 'bound'
  );
  await expect(page.locator('.dhcp-client')).toHaveAttribute('data-state', 'bound');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE DHCP E2E/ }).click();
  await inspectDhcp(page, 'PC-01');
  await expect(page.locator('.dhcp-client')).toHaveAttribute('data-state', 'bound');
  await expect(page.locator('.dhcp-client')).toContainText('192.168.50.10/24');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/dhcp-client-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await page.getByRole('button', { name: 'Voltar aos laboratórios' }).click();
  expect(errors).toEqual([]);
});

test('VRRP: edição, eleição, failover, HTTP, anúncios e persistência desktop/mobile', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'vrrp-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Um gateway, dois roteadores/ }).click();
  await page.getByLabel('Nome do laboratório').fill('VRRP E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await expect(page.locator('.network-device')).toHaveCount(6);
  const inspect = async (hostname: string, tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await inspectDevice(page, hostname);
    await page.locator('.inspector-tabs').getByRole('button', { name: tab, exact: true }).click();
  };
  const panel = page.locator('.vrrp-panel');
  await inspect('R-PRIMARY', 'VRRP');
  await expect(panel.locator('tr[data-state="ACTIVE"]')).toHaveCount(2);
  await panel.getByRole('button', { name: 'Editar VRID 10', exact: true }).click();
  await page.getByLabel('Prioridade VRRP').fill('160');
  await page.getByRole('button', { name: 'Aplicar grupo VRRP' }).click();
  await expect(panel).toContainText('Prioridade 160');
  await advanceSimulation(
    page,
    async () => (await panel.locator('tr[data-state="ACTIVE"]').count()) === 2,
    150
  );
  await inspect('R-BACKUP', 'VRRP');
  await advanceSimulation(
    page,
    async () => (await panel.locator('tr[data-state="BACKUP"]').count()) === 2,
    150
  );
  await expect(panel.locator('tr[data-state="BACKUP"]')).toHaveCount(2);
  const http = async () => {
    await inspect('PC-01', 'TCP / HTTP');
    await page.getByLabel('Destino TCP IPv4').fill('192.168.20.10');
    await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
    await advanceSimulation(
      page,
      async () => (await page.locator('.tcp-result').innerText()).includes('HTTP pelo gateway VRRP'),
      160
    );
    await expect(page.locator('.tcp-result')).toContainText('200 OK');
  };
  await http();
  await inspect('R-PRIMARY', 'VRRP');
  await page.getByRole('button', { name: 'Desligar equipamento', exact: true }).click();
  await expect(panel.locator('tr[data-state="INIT"]')).toHaveCount(2);
  await inspect('R-BACKUP', 'VRRP');
  await advanceSimulation(
    page,
    async () => (await panel.locator('tr[data-state="ACTIVE"]').count()) === 2,
    150
  );
  await page.screenshot({ path: 'test-results/vrrp-desktop.png', fullPage: true });
  await http();
  await page.getByRole('button', { name: 'Ver toda a rede', exact: true }).click();
  await page.locator('.event-filters').getByRole('button', { name: 'VRRP', exact: true }).click();
  await page.locator('.event-table-wrap tr').filter({ hasText: 'VRRP_ADVERT_SENT' }).first().click();
  await page.getByRole('dialog').locator('.event-technical > summary').click();
  await expect(page.getByRole('dialog')).toContainText('112 (VRRP)');
  await expect(page.getByRole('dialog')).toContainText('Grupo / endereço virtual VRRP');
  await page.screenshot({ path: 'test-results/vrrp-packet-desktop.png', fullPage: true });
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE VRRP E2E/ }).click();
  await inspect('R-BACKUP', 'VRRP');
  await expect(panel.locator('tr[data-state="ACTIVE"]')).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole('textbox', { name: 'IP virtual', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/vrrp-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('EVPN: supressão ARP configurável, diagnóstico e persistência mobile', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  const engine = new SimulationEngine(makeTemplate('evpn'));
  const a = engine.state.devices.find((d) => d.hostname === 'VTEP-A')!;
  for (const d of engine.state.devices.filter((d) => d.interfaces.some((p) => p.vxlan))) {
    const port = d.interfaces.find((p) => p.vxlan)!;
    engine.configureVxlan(d.id, { ...vxlanConfig(port), peerPolicy: 'evpn', proxyArp: d.id === a.id });
  }
  const pc = engine.state.devices.find((d) => d.hostname === 'VM-A')!;
  engine.advanceTo(4000);
  engine.ping(pc.id, '10.50.0.20');
  engine.advanceTo(6000);
  pc.arpTable = [];
  engine.ping(pc.id, '10.50.0.20');
  engine.advanceTo(7000);
  const event = engine.state.events.findLast((e) => e.type === 'EVPN_ARP_REPLIED')!;
  expect(event).toBeTruthy();
  await page.goto('/');
  await registerAndLogin(page, 'evpn-arp-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Novo laboratório', exact: true }).click();
  await page.getByLabel('Nome do laboratório').fill('EVPN ARP');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await page.locator('input[type=file][accept=".json,.shlab.json,.netlab.json"]').setInputFiles({
    name: 'evpn-arp.shlab.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(engine.snapshot())),
  });
  await page.locator('.event-filters').getByRole('button', { name: 'VXLAN / EVPN', exact: true }).click();
  await page.locator(`tr[data-event-id="${event.id}"]`).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('ARP respondido pelo VTEP');
  await expect(dialog).toContainText('não é uma resposta de saúde');
  await dialog.locator('.modal-head').getByRole('button', { name: 'Fechar', exact: true }).click();
  const inspect = async () => {
    await inspectDevice(page, 'VTEP-A');
    await page.locator('.inspector-tabs').getByRole('button', { name: 'VXLAN / EVPN', exact: true }).click();
  };
  await inspect();
  const checkbox = page.getByRole('checkbox', { name: 'Supressão ARP EVPN', exact: true });
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await page.getByRole('button', { name: 'Aplicar VNI', exact: true }).click();
  await expect(checkbox).not.toBeChecked();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE EVPN ARP/ }).click();
  await inspect();
  await expect(checkbox).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await checkbox.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('evpn-arp-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
});

test('BGP/EVPN binário: PDU legível, PCAP e inspeção mobile', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const engine = new SimulationEngine(makeTemplate('evpn'));
  engine.advanceTo(4000);
  const pc = engine.state.devices.find((d) => d.hostname === 'VM-A')!;
  engine.ping(pc.id, '10.50.0.20');
  engine.advanceTo(8000);
  const event = engine.state.events.findLast(
    (e) =>
      e.type === 'FRAME_SENT' &&
      e.frame?.packet?.protocol === 'TCP' &&
      e.frame.packet.data.charCodeAt(18) === 2
  )!;
  expect(event).toBeTruthy();
  await page.goto('/');
  await registerAndLogin(page, 'bgp-binary-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Novo laboratório', exact: true }).click();
  await page.getByLabel('Nome do laboratório').fill('BGP binário');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await page.locator('input[type=file][accept=".json,.shlab.json,.netlab.json"]').setInputFiles({
    name: 'bgp-binary.shlab.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(engine.snapshot())),
  });
  await page.locator('.event-filters').getByRole('button', { name: 'BGP', exact: true }).click();
  await page.locator(`tr[data-event-id="${event.id}"]`).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('summary').filter({ hasText: 'Campos do pacote e camadas' }).click();
  await expect(dialog).toContainText('Mensagem UPDATE');
  await expect(dialog).toContainText('EVPN MAC/IP e IMET / retiradas');
  await expect(dialog.getByLabel('Dados da aplicação transportados por TCP')).toHaveText(/^ff ff ff ff /);
  await expect(dialog.getByLabel('Dados da aplicação transportados por TCP')).toBeVisible();
  expect((await new AxeBuilder({ page }).include('dialog[open]').analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Dados da aplicação transportados por TCP').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('bgp-binary-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
  await dialog.locator('.modal-head').getByRole('button', { name: 'Fechar', exact: true }).click();
  await page.getByRole('button', { name: 'Opções do laboratório', exact: true }).click();
  await page.getByRole('button', { name: 'Exportar captura PCAP', exact: true }).click();
  const capture = page.getByRole('dialog', { name: 'Captura binária da simulação' });
  await expect(capture).toContainText('BGP/EVPN');
  await expect(capture).toContainText('0 omitidos');
  const pending = page.waitForEvent('download');
  await capture.getByRole('button', { name: 'Baixar PCAP', exact: true }).click();
  const download = await pending;
  const frames = decodePcap(await readFile((await download.path())!));
  expect(frames.some((r) => r.frame.transport?.payload?.[0] === 255)).toBe(true);
  expect(errors).toEqual([]);
});

test('BGP: sessões TCP, AS_PATH, política, falha, inspector e persistência mobile', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'bgp-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Três sistemas autônomos/ }).click();
  await page.getByLabel('Nome do laboratório').fill('BGP E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (hostname: string, tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await inspectDevice(page, hostname);
    await page.locator('.inspector-tabs').getByRole('button', { name: tab, exact: true }).click();
  };
  await inspect('R-01', 'BGP');
  const panel = page.locator('.bgp-panel');
  const best = panel.locator('tr[data-best="true"]').filter({ hasText: '192.168.20.0/24' });
  await advanceSimulation(
    page,
    async () => (await best.count()) > 0 && (await best.innerText()).includes('10.0.13.3'),
    240
  );
  await expect(panel.locator('tr[data-state="Established"]')).toHaveCount(2);
  const peers = await page.getByLabel('Vizinhos BGP').inputValue();
  await page.getByLabel('Vizinhos BGP').fill(
    peers
      .split('\n')
      .map((line) =>
        line.startsWith('10.0.12.2 ') ? line.replace('local-pref=100', 'local-pref=200') : line
      )
      .join('\n')
  );
  await page.getByRole('button', { name: 'Aplicar BGP', exact: true }).click();
  await advanceSimulation(
    page,
    async () => (await best.count()) > 0 && (await best.innerText()).includes('10.0.12.2'),
    260
  );
  await expect(best).toContainText('200 / 0');
  await page.screenshot({ path: 'test-results/bgp-policy-desktop.png', fullPage: true });
  await page.locator('.event-filters').getByRole('button', { name: 'BGP', exact: true }).click();
  await page
    .locator('.event-table-wrap tr')
    .filter({ hasText: 'FRAME_SENT' })
    .filter({ hasText: 'Frame' })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toContainText('TCP');
  await expect(page.getByRole('dialog')).toContainText('179');
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.getByLabel('Vizinhos BGP').fill(peers);
  await page.getByRole('button', { name: 'Aplicar BGP', exact: true }).click();
  await advanceSimulation(
    page,
    async () => (await best.count()) > 0 && (await best.innerText()).includes('10.0.13.3'),
    260
  );
  await switchTerminal(page, 'R-01', ['enable', 'conf t', 'interface Gi0/2', 'shutdown']);
  await page.locator('.inspector-tabs').getByRole('button', { name: 'BGP', exact: true }).click();
  await advanceSimulation(
    page,
    async () => (await best.count()) > 0 && (await best.innerText()).includes('10.0.12.2'),
    180
  );
  await expect(best).toContainText('65002 65003');
  await inspect('PC-01', 'TCP / HTTP');
  await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.tcp-result').innerText()).includes('Resposta encaminhada pelo BGP'),
    160
  );
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE BGP E2E/ }).click();
  await inspect('R-01', 'BGP');
  await expect(best).toContainText('65002 65003');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Vizinhos BGP').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/bgp-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

for (const [template, hostname] of [
  ['Um trunk, duas redes', 'R-VLAN'],
  ['VLANs com gateway no switch', 'SW-L3'],
]) {
  test('L3: ' + template + ' com HTTP, configuração e persistência', async ({ page }) => {
    test.setTimeout(180000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await registerAndLogin(page, 'l3-' + Date.now() + '@example.test');
    await page.getByRole('button', { name: 'Templates', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(template) }).click();
    await page.getByLabel('Nome do laboratório').fill('L3 E2E');
    await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
    const inspect = async (name: string, tab: string) => {
      const close = page.getByRole('button', { name: 'Fechar inspector' });
      if (await close.count()) await close.click();
      await inspectDevice(page, name);
      await page.locator('.inspector-tabs').getByRole('button', { name: tab, exact: true }).click();
    };
    await inspect(hostname, 'VLAN / VRF');
    await expect(page.locator('.layer3-panel')).toContainText(hostname === 'SW-L3' ? 'Vlan10' : 'Gi0/1.10');
    await page.getByLabel('VLAN da interface').fill('30');
    await page.getByRole('button', { name: 'Criar interface lógica' }).click();
    await page.locator('.inspector-tabs').getByRole('button', { name: 'Portas', exact: true }).click();
    await page
      .locator('.interface-item')
      .filter({ hasText: hostname === 'SW-L3' ? 'Vlan30' : 'Gi0/1.30' })
      .click();
    await page.getByLabel('Endereço IPv4', { exact: true }).fill('192.168.30.1');
    await page.getByRole('button', { name: 'Aplicar à simulação', exact: true }).click();
    await expect(page.locator('.interface-list')).toContainText('192.168.30.1/24');
    await inspect('PC-USERS', 'TCP / HTTP');
    await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
    await advanceSimulation(
      page,
      async () => (await page.locator('.tcp-result').innerText()).includes('HTTP entre VLANs'),
      150
    );
    await page.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect(page.locator('.project-title')).toContainText('Salvo');
    await page.reload();
    await page.getByRole('button', { name: /^LABORATÓRIO LIVRE L3 E2E/ }).click();
    await inspect(hostname, 'VLAN / VRF');
    await expect(page.locator('.layer3-panel')).toContainText('192.168.30.1/24');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.layer3-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/l3-' + hostname + '-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('L3: VRF mantém HTTP e IPs sobrepostos isolados no painel e no save/reload', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'vrf-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Mesmo endereço, redes separadas/ }).click();
  await page.getByLabel('Nome do laboratório').fill('VRF E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await inspectDevice(page, 'R-VRF');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'TCP / HTTP', exact: true }).click();
  await page.getByLabel('Destino TCP IPv4').fill('10.0.0.2');
  for (const vrf of ['BLUE', 'RED']) {
    await page.getByLabel('VRF do tráfego TCP').selectOption(vrf);
    await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
    await advanceSimulation(
      page,
      async () => (await page.locator('.tcp-result').innerText()).includes('Resposta da VRF ' + vrf),
      120
    );
  }
  await page.locator('.inspector-tabs').getByRole('button', { name: 'VLAN / VRF', exact: true }).click();
  await expect(page.getByLabel('VRF de Gi0/1')).toHaveValue('BLUE');
  await expect(page.getByLabel('VRF de Gi0/2')).toHaveValue('RED');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE VRF E2E/ }).click();
  await inspectDevice(page, 'R-VRF');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'VLAN / VRF', exact: true }).click();
  await expect(page.getByLabel('VRF de Gi0/2')).toHaveValue('RED');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('VRF de Gi0/2').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/vrf-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('Tracking: uplink reduz prioridade VRRP no painel e mantém HTTP', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'track-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Gateway atento ao uplink/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Tracking E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (name: string, tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await inspectDevice(page, name);
    await page.locator('.inspector-tabs').getByRole('button', { name: tab, exact: true }).click();
  };
  await inspect('R-PRIMARY', 'VRRP');
  await page.getByRole('button', { name: 'Editar VRID 10', exact: true }).click();
  await expect(page.getByLabel('Tracking VRRP')).toHaveValue('interface Gi0/2 80');
  await page.getByRole('button', { name: 'Aplicar grupo VRRP' }).click();
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await switchTerminal(page, 'R-PRIMARY', ['enable', 'conf t', 'interface Gi0/2', 'shutdown']);
  await page.locator('.inspector-tabs').getByRole('button', { name: 'VRRP', exact: true }).click();
  await expect(page.locator('.vrrp-panel')).toContainText('efetiva 70');
  await inspect('R-BACKUP', 'VRRP');
  await advanceSimulation(
    page,
    async () => (await page.locator('.vrrp-panel tr[data-state="ACTIVE"]').count()) === 2,
    180
  );
  await inspect('PC-01', 'TCP / HTTP');
  await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.tcp-result').innerText()).includes('HTTP pelo gateway VRRP'),
    160
  );
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE Tracking E2E/ }).click();
  await inspect('R-PRIMARY', 'VRRP');
  await expect(page.locator('.vrrp-panel')).toContainText('efetiva 70');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.vrrp-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/tracking-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('LACP: negocia, conserva HTTP com membro restante e persiste no mobile', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'lacp-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Dois cabos, um enlace/ }).click();
  await page.getByLabel('Nome do laboratório').fill('LACP E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (name: string, tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await inspectDevice(page, name);
    await page.locator('.inspector-tabs').getByRole('button', { name: tab, exact: true }).click();
  };
  await inspect('SW-A', 'LACP');
  await advanceSimulation(
    page,
    async () => (await page.locator('.lacp-panel tr[data-members="2"]').count()) === 1,
    180
  );
  await page.getByRole('button', { name: 'Editar Port-channel1', exact: true }).click();
  await expect(page.getByLabel('Modo LACP')).toHaveValue('active');
  await page.getByRole('button', { name: 'Cancelar edição' }).click();
  await inspect('PC-LACP', 'TCP / HTTP');
  await page.getByLabel('Destino TCP IPv4').fill('192.168.10.20');
  await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.tcp-result').innerText()).includes('HTTP pelo EtherChannel'),
    400
  );
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await switchTerminal(page, 'SW-A', ['enable', 'conf t', 'interface Gi0/1', 'shutdown']);
  await page.locator('.inspector-tabs').getByRole('button', { name: 'LACP', exact: true }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.lacp-panel tr[data-members="1"]').count()) === 1,
    180
  );
  await page.screenshot({ path: 'test-results/lacp-desktop.png', fullPage: true });
  await inspect('PC-LACP', 'TCP / HTTP');
  await page.getByLabel('Destino TCP IPv4').fill('192.168.10.20');
  await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.tcp-result').innerText()).includes('HTTP pelo EtherChannel'),
    160
  );
  await page.getByRole('button', { name: 'Ver toda a rede', exact: true }).click();
  await page.locator('.event-filters').getByRole('button', { name: 'LACP', exact: true }).click();
  await page.locator('.event-table-wrap tr').filter({ hasText: 'LACP_SENT' }).first().click();
  await page.getByRole('dialog').locator('.event-technical > summary').click();
  await expect(page.getByRole('dialog')).toContainText('Identidade local LACP');
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE LACP E2E/ }).click();
  await inspect('SW-A', 'LACP');
  await expect(page.locator('.lacp-panel tr[data-members="1"]')).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.lacp-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/lacp-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('IPv6 serviços: DHCPv6, UDP, TCP com janela e persistência mobile', async ({ page }) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await registerAndLogin(page, 'ipv6-services-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Serviços em uma rede IPv6/ }).click();
  await page.getByLabel('Nome do laboratório').fill('IPv6 Services E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await inspectDevice(page, 'PC-DHCP6');
    await page.locator('.inspector-tabs').getByRole('button', { name: tab, exact: true }).click();
  };
  await inspect('IPv6');
  await advanceSimulation(
    page,
    async () => (await page.locator('.ipv6-addresses').innerText()).includes('dhcp6 · preferred'),
    240
  );
  await expect(page.locator('[data-dhcp6-state]')).toHaveAttribute('data-dhcp6-state', 'BOUND');
  await page.getByLabel('Destino UDP IPv6').fill('2001:db8:2::10');
  await page.getByRole('button', { name: 'Enviar UDP IPv6' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.ipv6-services').innerText()).includes('Resposta de'),
    180
  );
  await inspect('TCP / HTTP');
  await page.getByLabel('Destino TCP IPv4').fill('2001:db8:2::10');
  await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.tcp-payload').innerText()).includes('HTTP sobre IPv6'),
    240
  );
  await expect(page.locator('.tcp-result')).toContainText('CWND');
  await expect(page.locator('.tcp-result')).toContainText('RTO');
  const text = 'IPv6 pela janela TCP. '.repeat(150);
  await page.getByLabel('Operação TCP').selectOption('echo');
  await page.getByLabel('Mensagem echo').fill(text);
  await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.tcp-payload').innerText()).trim() === text.trim(),
    420
  );
  await page.screenshot({ path: 'test-results/ipv6-services-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE IPv6 Services E2E/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await inspect('IPv6');
  await expect(page.locator('[data-dhcp6-state]')).toHaveAttribute('data-dhcp6-state', 'BOUND');
  await expect(page.locator('.ipv6-services')).toContainText('Resposta de');
  await page.screenshot({ path: 'test-results/ipv6-services-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('IPv6: SLAAC, ping roteado, Hop Limit, pacote e persistência mobile', async ({ page }) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await registerAndLogin(page, 'ipv6-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Endereços que chegam pela rede/ }).click();
  await page.getByLabel('Nome do laboratório').fill('IPv6 E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (name: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await inspectDevice(page, name);
    await page.locator('.inspector-tabs').getByRole('button', { name: 'IPv6', exact: true }).click();
  };
  await inspect('PC-V6-B');
  await advanceSimulation(
    page,
    async () => (await page.locator('.ipv6-addresses').innerText()).includes('slaac · preferred'),
    220
  );
  const target = (
    await page.locator('.ipv6-addresses code').filter({ hasText: '2001:db8:2:' }).innerText()
  ).split('/')[0];
  await inspect('PC-V6-A');
  await expect(page.getByLabel('Obter endereço e gateway por SLAAC')).toBeChecked();
  await page.getByRole('button', { name: 'Aplicar IPv6', exact: true }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.ipv6-addresses').innerText()).includes('slaac · preferred'),
    220
  );
  await page.getByLabel('Destino IPv6', { exact: true }).fill(target);
  await page.getByRole('button', { name: 'Enviar ping IPv6' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.ipv6-results').innerText()).includes('success'),
    180
  );
  await page.getByLabel('Hop Limit IPv6').fill('1');
  await page.getByRole('button', { name: 'Enviar ping IPv6' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.ipv6-results').innerText()).includes('time-exceeded'),
    150
  );
  await page.screenshot({ path: 'test-results/ipv6-desktop.png', fullPage: true });
  await page.locator('.event-filters').getByRole('button', { name: 'IPv6 / NDP', exact: true }).click();
  await page.locator('.event-table-wrap tr').filter({ hasText: 'NDP_SENT' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('IPv6 — ICMPv6');
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE IPv6 E2E/ }).click();
  await inspect('PC-V6-A');
  await expect(page.locator('.ipv6-results')).toContainText('success');
  await expect(page.locator('.ipv6-results')).toContainText('time-exceeded');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.ipv6-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/ipv6-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('Wireless: autenticação, HTTP pelo rádio, pacotes e persistência mobile', async ({ page }) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await registerAndLogin(page, 'wifi-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Do rádio à resposta HTTP/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Wireless E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (name: string, tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await inspectDevice(page, name);
    await page.locator('.inspector-tabs').getByRole('button', { name: tab, exact: true }).click();
  };
  await inspect('NOTEBOOK', 'Wireless');
  await page.getByLabel('Chave do SSID').fill('Wrong-Password');
  await page.getByRole('button', { name: 'Aplicar wireless' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.wireless-state strong').innerText()) === 'failed',
    300
  );
  await page.getByLabel('Chave do SSID').fill('Wireless-123');
  await page.getByRole('button', { name: 'Aplicar wireless' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.wireless-state strong').innerText()) === 'associated',
    320
  );
  await expect(page.locator('.wireless-link').first()).toContainText('RSSI');
  await page.screenshot({ path: 'test-results/wireless-desktop.png', fullPage: true });
  await page.locator('.inspector-tabs').getByRole('button', { name: 'TCP / HTTP', exact: true }).click();
  await page.getByLabel('Destino TCP IPv4').fill('192.168.50.20');
  await page.getByRole('button', { name: 'Iniciar tráfego TCP' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.tcp-result').innerText()).includes('HTTP atravessou o rádio'),
    250
  );
  await inspect('AP-CAMPUS', 'Wireless');
  await expect(page.getByLabel('Cobertura aproximada do AP')).toBeAttached();
  await page.locator('.event-filters').getByRole('button', { name: 'Wi-Fi', exact: true }).click();
  await page.locator('.event-table-wrap tr').filter({ hasText: 'WIFI_SENT' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('Wi-Fi —');
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE Wireless E2E/ }).click();
  await inspect('NOTEBOOK', 'Wireless');
  await expect(page.locator('.wireless-state strong')).toHaveText('associated');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.wireless-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/wireless-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('Automação: NETCONF, RESTCONF, telemetria, NTP e persistência mobile', async ({ page }) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await registerAndLogin(page, 'automation-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /A configuração chega pela rede/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Automation E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (name: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await inspectDevice(page, name);
    await page.locator('.inspector-tabs').getByRole('button', { name: 'Gerenciamento', exact: true }).click();
  };
  await inspect('PC-01');
  await page.getByLabel('Operação de gerenciamento').selectOption('automation');
  await page.getByRole('button', { name: 'Aplicar gerenciamento' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('[data-automation-status="success"]').count()) === 1,
    400
  );
  await expect(page.locator('[data-ntp-sync="true"]')).toContainText('stratum 2');
  await page.getByLabel('Operação de gerenciamento').selectOption('request');
  await page.getByText('Editor avançado JSON · Gerenciamento de rede JSON', { exact: true }).click();
  await page.getByLabel('Gerenciamento de rede JSON', { exact: true }).fill(
    JSON.stringify({
      target: '192.168.10.1',
      protocol: 'restconf',
      username: 'admin',
      password: 'rede-admin',
      key: 'remote-key',
      operation: 'get',
    })
  );
  await page.getByRole('button', { name: 'Aplicar gerenciamento' }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('[data-remote-status="success"]').count()) === 4,
    180
  );
  await page.getByText('Dados recebidos', { exact: true }).click();
  await expect(page.locator('.remote-panel pre')).toContainText('R-AUTOMATED');
  await page.screenshot({ path: 'test-results/automation-desktop.png', fullPage: true });
  await inspect('SERVER-01');
  await advanceSimulation(
    page,
    async () =>
      Number(await page.locator('[data-telemetry-records]').getAttribute('data-telemetry-records')) > 0,
    160
  );
  await page.getByRole('button', { name: 'Ver toda a rede', exact: true }).click();
  await page.locator('.event-filters').getByRole('button', { name: 'Gerenciamento', exact: true }).click();
  await advanceSimulation(
    page,
    async () =>
      (await page.locator('.event-table-wrap tr').filter({ hasText: 'TELEMETRY_SENT' }).count()) > 0,
    300
  );
  await page.locator('.event-table-wrap tr').filter({ hasText: 'TELEMETRY_SENT' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('TELEMETRY');
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE Automation E2E/ }).click();
  await inspect('PC-01');
  await expect(page.locator('[data-automation-status="success"]')).toContainText('3/3');
  await expect(page.locator('[data-ntp-sync="true"]')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.remote-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/automation-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('Catálogo: perfil QSFP, transceiver, duplicação, análise e persistência mobile', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await registerAndLogin(page, 'profiles-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Novo laboratório', exact: true }).click();
  await page.getByLabel('Nome do laboratório').fill('Profiles E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await page.getByLabel('Buscar equipamento', { exact: true }).fill('core');
  await page.locator('.equipment-card').filter({ hasText: 'Switch de core' }).click();
  await page.locator('.network-device').last().dblclick();
  await expect(page.locator('.inspector')).toContainText('NL Switch de core');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Portas', exact: true }).click();
  await expect(page.locator('.interface-item')).toHaveCount(8);
  await page.locator('.interface-item').filter({ hasText: 'Fo0/1' }).click();
  await page.getByLabel('Módulo transceiver').selectOption('dac');
  await page.getByRole('button', { name: 'Aplicar à simulação', exact: true }).click();
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await page.locator('.network-device').last().dblclick();
  await page.getByRole('button', { name: 'Duplicar', exact: true }).click();
  await expect(page.locator('.network-device')).toHaveCount(2);
  await page.getByRole('button', { name: 'Inspetor da rede', exact: true }).click();
  await expect(page.locator('.network-table')).toContainText('Switch de core');
  await page.getByRole('tab', { name: 'Interfaces', exact: true }).click();
  await expect(page.locator('.network-table tbody tr')).toHaveCount(16);
  await page.getByRole('tab', { name: 'Overlays / QoS', exact: true }).click();
  await page.getByRole('tab', { name: 'Interfaces', exact: true }).click();
  await page.screenshot({ path: 'test-results/profiles-desktop.png', fullPage: true });
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE Profiles E2E/ }).click();
  await expect(page.locator('.network-device')).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Inspetor da rede', exact: true }).click();
  await page.getByRole('tab', { name: 'Interfaces', exact: true }).click();
  await page.screenshot({ path: 'test-results/profiles-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('Lab avançado: reparar roteamento SVI, validar HTTP e persistir tarefas mobile', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/');
  await registerAndLogin(page, 'advanced-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.locator('.lesson-card').filter({ hasText: 'Primeira LAN' }).click();
  await page.getByRole('combobox', { name: 'Trilha', exact: true }).selectOption('svi-repair');
  await page.getByLabel('Nome do laboratório').fill('Advanced E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const close = async () =>
    page
      .getByRole('dialog')
      .locator('.modal-head')
      .getByRole('button', { name: 'Fechar', exact: true })
      .click();
  await page.getByRole('button', { name: 'Tarefas do laboratório', exact: true }).click();
  await expect(page.locator('.lab-task-list li')).toHaveCount(3);
  await page.getByRole('button', { name: 'Validar laboratório', exact: true }).click();
  await expect(page.locator('.lab-evaluation')).toContainText('Em andamento');
  await close();
  await switchTerminal(page, 'SW-L3', ['enable', 'conf t', 'ip routing']);
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await page.getByRole('button', { name: 'Tarefas do laboratório', exact: true }).click();
  await page.getByRole('button', { name: 'Validar laboratório', exact: true }).click();
  await expect(page.locator('.lab-evaluation')).toContainText('Laboratório concluído');
  await expect(page.locator('.lab-task-list li.passed')).toHaveCount(3);
  await page.screenshot({ path: 'test-results/advanced-desktop.png', fullPage: true });
  await close();
  await page.getByRole('button', { name: 'Inspetor da rede', exact: true }).click();
  await page.getByRole('tab', { name: 'Protocolos', exact: true }).click();
  await page.getByRole('tab', { name: 'Dependências', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Gateway');
  await close();
  await page.reload();
  await page.getByRole('button', { name: /^LABORATÓRIO GUIADO Advanced E2E/ }).click();
  await page.getByRole('button', { name: 'Tarefas do laboratório', exact: true }).click();
  await expect(page.locator('.lab-evaluation')).toContainText('Laboratório concluído');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/advanced-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Aprendizagem: editor de desafios, tutorial completo, pontuação e mobile', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await registerAndLogin(page, 'learning-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Sua primeira LAN/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Learning E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await page.getByRole('button', { name: 'Desafio', exact: true }).click();
  await page.getByLabel('Nome do desafio').fill('Minha LAN funcional');
  await page.getByRole('button', { name: 'Adicionar objetivo' }).click();
  await page.getByRole('button', { name: 'Salvar desafio e estado inicial' }).click();
  await expect(page.getByRole('heading', { name: 'Minha LAN funcional' })).toBeVisible();
  await page.getByRole('button', { name: 'Verificar objetivos' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Pontuação: 100/100');
  await page.getByRole('button', { name: 'Reiniciar topologia do desafio' }).click();
  await expect(page.locator('.workspace-alert')).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Fechar', exact: true }).click();
  await page.getByRole('button', { name: 'Tutorial', exact: true }).click();
  const tutorial = page.getByRole('complementary', { name: 'Tutorial interativo' });
  for (let step = 1; step <= 4; step++) {
    await expect(tutorial).toContainText('Etapa ' + step + ' de 5');
    await tutorial.getByRole('button', { name: 'Verificar etapa' }).click();
  }
  await expect(tutorial).toContainText('Etapa 5 de 5');
  await tutorial.getByRole('button', { name: 'Abrir área da etapa' }).click();
  await tutorial.getByRole('button', { name: 'Fechar tutorial' }).click();
  await page.locator('.inspector-tabs').getByRole('button', { name: 'TCP / HTTP', exact: true }).click();
  await page.getByLabel('Porta do serviço', { exact: true }).fill('7');
  await page.getByRole('button', { name: 'Salvar serviço', exact: true }).click();
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await page.getByRole('button', { name: 'Tutorial', exact: true }).click();
  await tutorial.getByRole('button', { name: 'Verificar etapa' }).click();
  await expect(tutorial.getByRole('status')).toContainText('Tutorial concluído');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/learning-tutorial-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await tutorial.getByRole('button', { name: 'Fechar tutorial' }).click();
  await page.getByRole('button', { name: 'Desafio', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Melhor resultado: 100/100');
  await page.screenshot({ path: 'test-results/learning-challenge-mobile.png', fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: 'Fechar', exact: true }).click();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await page.reload();
  await expect(page.getByText('Pontos', { exact: false })).toBeVisible();
  await expect(page.locator('.dashboard-stats')).toContainText('200');
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE Learning E2E/ }).click();
  await page.getByRole('button', { name: 'Tutorial', exact: true }).click();
  await expect(tutorial.getByRole('status')).toContainText('Tutorial concluído');
  expect(errors).toEqual([]);
});

for (const method of ['tls', 'peap'] as const) {
  test(`Wi-Fi empresarial: ${method}, HTTP, certificados e persistência mobile`, async ({ page }) => {
    test.setTimeout(180000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await registerAndLogin(page, 'enterprise-' + method + '-' + Date.now() + '@example.test');
    await page.getByRole('button', { name: 'Templates', exact: true }).click();
    await page.getByRole('button', { name: /Campus com autenticação empresarial/ }).click();
    await page.getByLabel('Nome do laboratório').fill('Enterprise E2E');
    await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
    if (method === 'peap') {
      await inspectDevice(page, 'RADIUS-CAMPUS');
      await page
        .locator('.inspector-tabs')
        .getByRole('button', { name: /CAPWAP|EAP empresarial|IDS \/ IPS/ })
        .click();
      await expect(page.getByLabel('Recurso de rede', { exact: true })).toHaveValue('eapServer');
      const server = JSON.parse(await page.getByLabel('Configuração de rede avançada').inputValue());
      server.method = method;
      server.users[0].password = 'campus-peap-password';
      await page.getByText('Editor avançado JSON · Configuração de rede avançada', { exact: true }).click();
      await page.getByLabel('Configuração de rede avançada', { exact: true }).fill(JSON.stringify(server));
      await page.getByRole('button', { name: 'Aplicar recurso de rede', exact: true }).click();
      await page.getByRole('button', { name: 'Fechar inspector' }).click();
    }
    await inspectDevice(page, 'CLIENT-CAMPUS');
    await page
      .locator('.inspector-tabs')
      .getByRole('button', { name: /CAPWAP|EAP empresarial|IDS \/ IPS/ })
      .click();
    await expect(page.getByLabel('Recurso de rede', { exact: true })).toHaveValue('eapSupplicant');
    if (method === 'peap') {
      const client = JSON.parse(await page.getByLabel('Configuração de rede avançada').inputValue());
      client.method = method;
      client.password = 'campus-peap-password';
      delete client.tls.identity;
      await page.getByText('Editor avançado JSON · Configuração de rede avançada', { exact: true }).click();
      await page.getByLabel('Configuração de rede avançada', { exact: true }).fill(JSON.stringify(client));
    }
    await page.getByRole('button', { name: 'Aplicar recurso de rede', exact: true }).click();
    await advanceSimulation(
      page,
      async () => {
        const status = await page.locator('.inspector-body').innerText();
        return status.includes('TLS ESTABLISHED') && status.includes('authorized');
      },
      400
    );
    await expect(page.locator('.inspector-body')).toContainText('authorized');
    await page.locator('.inspector-tabs').getByRole('button', { name: 'TCP / HTTP', exact: true }).click();
    await page.getByLabel('Destino TCP IPv4').fill('10.0.0.20');
    await page.getByRole('button', { name: 'Iniciar tráfego TCP', exact: true }).click();
    await advanceSimulation(
      page,
      async () => (await page.locator('.tcp-result').innerText()).includes('HTTP empresarial com EAP-TLS'),
      180
    );
    await page.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect(page.locator('.project-title')).toContainText('Salvo');
    await page.reload();
    await page.getByRole('button', { name: /^LABORATÓRIO LIVRE Enterprise E2E/ }).click();
    await inspectDevice(page, 'CLIENT-CAMPUS');
    await page
      .locator('.inspector-tabs')
      .getByRole('button', { name: /CAPWAP|EAP empresarial|IDS \/ IPS/ })
      .click();
    await expect(page.locator('.inspector-body')).toContainText('TLS ESTABLISHED');
    await expect(page.getByLabel('Recurso de rede', { exact: true })).toHaveValue('eapSupplicant');
    const restored = JSON.parse(await page.getByLabel('Configuração de rede avançada').inputValue());
    expect(restored.method).toBe(method);
    if (method === 'peap') expect(restored.password).toBe('campus-peap-password');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.inspector').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/enterprise-${method}-mobile.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('Workspace: desenho livre, comentário ancorado, histórico e telas ampliadas', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'canvas-tools-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Sua primeira LAN/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Workspace Extras E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const options = () => page.getByRole('button', { name: 'Opções do laboratório', exact: true });
  await options().click();
  await page.getByRole('button', { name: 'Adicionar comentário ancorado', exact: true }).click();
  await page.getByLabel('Comentário', { exact: true }).fill('Conferir VLAN e gateway');
  await page.getByRole('button', { name: 'Adicionar comentário', exact: true }).click();
  await expect(page.locator('.canvas-comment')).toContainText('Conferir VLAN e gateway');
  for (const background of ['light', 'gray', 'dark']) {
    await options().click();
    await page.getByLabel('Fundo do canvas', { exact: true }).selectOption(background);
    await page.getByRole('button', { name: 'Desenhar à mão livre', exact: true }).click();
    const layer = page.getByRole('region', { name: 'Área de desenho livre' });
    await expect(layer.locator('.drawing-hint')).toContainText('Escape cancela');
    const audit = await new AxeBuilder({ page })
      .include('.drawing-layer')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      audit.violations.map((violation) => ({
        id: violation.id,
        nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
      })),
      'Desenho no fundo ' + background
    ).toEqual([]);
    await layer.focus();
    await page.keyboard.press('Escape');
    await expect(layer).toHaveCount(0);
    await expect(page.locator('.canvas-drawing polyline')).toHaveCount(0);
  }
  await options().click();
  await page.getByRole('button', { name: 'Desenhar à mão livre', exact: true }).click();
  const bounds = await page.getByRole('region', { name: 'Área de desenho livre' }).boundingBox();
  if (!bounds) throw new Error('Área de desenho ausente');
  await page.mouse.move(bounds.x + 80, bounds.y + 180);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 140, bounds.y + 240, { steps: 10 });
  await page.mouse.move(bounds.x + 200, bounds.y + 180, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('.canvas-drawing polyline')).toHaveCount(1);
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.getByRole('button', { name: 'Voltar aos laboratórios', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Meus laboratórios', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Histórico de atividades' })).toContainText(
    'Criado · Workspace Extras E2E'
  );
  await page
    .locator('.activity-history li')
    .filter({ hasText: 'Workspace Extras E2E' })
    .first()
    .getByRole('button', { name: 'Abrir laboratório' })
    .click();
  await expect(page.locator('.canvas-drawing polyline')).toHaveCount(1);
  await expect(page.locator('.canvas-comment')).toHaveCount(1);
  for (const width of [768, 2560, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({ path: 'test-results/canvas-tools-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('Produto: infraestrutura, formulários guiados, acessibilidade e teclado', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const audit = async (name: string) => {
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/audit-' + name + '.json', JSON.stringify(result, null, 2));
    await testInfo.attach(name, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    expect(
      result.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
      }))
    ).toEqual([]);
  };
  await page.goto('/');
  await audit('landing');
  await registerAndLogin(page, 'product-' + Date.now() + '@example.test');
  await audit('dashboard');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Sua primeira LAN/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Produto E2E');
  await audit('modal');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName(/Criar laboratório/);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await audit('workspace');
  await page
    .locator('.equipment-card')
    .filter({ has: page.getByText('UPS', { exact: true }) })
    .click();
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Infraestrutura', exact: true }).click();
  await page.getByRole('button', { name: 'Adicionar carga', exact: true }).click();
  await page.getByLabel('Consumo (W)', { exact: true }).fill('20');
  await page.getByRole('button', { name: 'Aplicar UPS', exact: true }).click();
  await expect(page.locator('.infrastructure-panel')).toContainText('20 W');
  await audit('ups');
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await page
    .locator('.equipment-card')
    .filter({ has: page.getByText('IPS', { exact: true }) })
    .click();
  await page
    .locator('.inspector-tabs')
    .getByRole('button', { name: /CAPWAP|EAP empresarial|IDS \/ IPS/ })
    .click();
  await page.getByLabel('Recurso de rede', { exact: true }).selectOption('ids');
  await expect(page.getByLabel('Habilitado', { exact: true })).not.toBeChecked();
  await page.getByLabel('Habilitado', { exact: true }).check();
  await expect(page.getByLabel('Limiar de pacotes', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Adicionar regras', exact: true }).click();
  await page.getByRole('button', { name: 'Adicionar limiar de pacotes', exact: true }).click();
  await page.getByLabel('Limiar de pacotes', { exact: true }).fill('12');
  await page.getByRole('button', { name: 'Aplicar recurso de rede', exact: true }).click();
  const cfg = JSON.parse(
    await page.getByLabel('Configuração de rede avançada', { exact: true }).inputValue()
  );
  expect(cfg.rules[0].threshold).toBe(12);
  await audit('guided-ids');
  for (const width of [390, 768, 2560]) {
    await page.setViewportSize({ width, height: 960 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await audit('viewport-' + width);
  }
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  expect(errors).toEqual([]);
});

test('Topologia: vistas, clone de rack com revisão, undo e persistência', async ({ page }) => {
  await page.goto('/');
  await registerAndLogin(page, 'topology-clone-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Novo laboratório', exact: true }).click();
  await page.getByLabel('Nome do laboratório').fill('Vistas e clone');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const e = new SimulationEngine(),
    rack = e.addProfile('rack'),
    a = e.addDevice('pc'),
    b = e.addDevice('pc'),
    sw = e.addDevice('switch');
  rack.hostname = 'RACK-QA';
  a.hostname = 'HOST-A';
  b.hostname = 'HOST-B';
  Object.assign(a.interfaces[0], { ip: '192.168.70.10', prefix: 24 });
  Object.assign(b.interfaces[0], { ip: '192.168.70.11', prefix: 24 });
  e.connect({ device: a.id, port: 'p0' }, { device: sw.id, port: 'p0' });
  e.connect({ device: b.id, port: 'p0' }, { device: sw.id, port: 'p1' });
  e.configureInfrastructure(rack.id, {
    kind: 'rack',
    units: 42,
    ambientC: 22,
    ventilation: 1,
    slots: [
      { device: a.id, unit: 1, units: 1 },
      { device: b.id, unit: 2, units: 1 },
      { device: sw.id, unit: 3, units: 1 },
    ],
  });
  await page.locator('input[type=file][accept=".json,.shlab.json,.netlab.json"]').setInputFiles({
    name: 'rack.shlab.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(e.snapshot())),
  });
  await expect(page.locator('.workspace-status')).toContainText('4/2000');
  const view = page.getByLabel('Vista da topologia');
  await view.selectOption('logical');
  await expect(page.locator('.react-flow__node-device')).toHaveCount(3);
  await view.selectOption('physical');
  await expect(page.locator('.react-flow__node-device')).toHaveCount(4);
  const finder = page.getByRole('textbox', { name: 'Localizar equipamento' });
  await finder.fill('RACK-QA');
  await finder.press('Enter');
  await finder.press('Escape');
  await page.getByRole('button', { name: 'Opções do laboratório' }).click();
  await page.getByRole('button', { name: 'Clonar célula ou rack' }).click();
  await expect(page.getByRole('heading', { name: 'Clonar célula ou rack' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Aplicar clone' })).toBeVisible();
  await page.getByRole('button', { name: 'Aplicar clone' }).click();
  await expect(page.locator('.workspace-status')).toContainText('8/2000');
  await page.getByRole('button', { name: 'Desfazer', exact: true }).click();
  await expect(page.locator('.workspace-status')).toContainText('4/2000');
  await page.getByRole('button', { name: 'Refazer', exact: true }).click();
  await expect(page.locator('.workspace-status')).toContainText('8/2000');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);
});
test('Escala: Worker, 2000 equipamentos, viewport e pausa sem perder alterações', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(20000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let workers = 0;
  page.on('worker', () => workers++);
  const timing: unknown[] = [];
  page.on('console', (message) => {
    if (message.text().startsWith('worker-sample ')) timing.push(message.text());
  });
  await page.addInitScript(() => {
    const Base = window.Worker;
    window.Worker = class extends Base {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', (event) => {
          const d = event.data.delta;
          if (d)
            console.debug(
              'worker-sample ' +
                JSON.stringify({
                  at: performance.now(),
                  processed: d.processed,
                  pending: d.pending,
                  changed: d.devices.length,
                  patches: d.devicePatches?.length ?? 0,
                  bytes: new TextEncoder().encode(JSON.stringify(d)).length,
                })
            );
        });
      }
    };
  });
  await page.goto('/');
  await registerAndLogin(page, 'scale-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: /Sua primeira LAN/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Escala E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await expect(page.locator('.network-device')).toHaveCount(3);
  await page
    .locator('input[type=file][accept=".json,.shlab.json,.netlab.json"]')
    .setInputFiles('.data/benchmarks/topology2000.json');
  await expect(page.locator('.workspace-status')).toContainText('2000/2000');
  await page.getByRole('button', { name: /fit view|ajustar/i }).click();
  expect(await page.locator('.network-device').count()).toBeLessThan(2000);
  await page.getByLabel('Velocidade', { exact: true }).selectOption('5');
  await page.getByRole('button', { name: 'Executar simulação', exact: true }).click();
  await expect.poll(() => workers).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Pausar simulação', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Executar simulação', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Executar simulação', exact: true }).click();
  try {
    await expect
      .poll(async () => await page.locator('.pending-events').innerText(), { timeout: 60000 })
      .toBe('0 na fila');
  } finally {
    await testInfo.attach('worker-timing', {
      body: JSON.stringify(timing, null, 2),
      contentType: 'application/json',
    });
  }
  await page.getByRole('button', { name: 'Pausar simulação', exact: true }).click();
  await page.getByRole('button', { name: /Tráfego/ }).click();
  await expect(page.locator('.timeline')).toContainText('Recebido');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText('Salvo');
  await page.screenshot({ path: 'test-results/scale-2000.png' });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const samples = [];
  for (let i = 0; i < 3; i++) {
    samples.push(await cdp.send('Runtime.getHeapUsage'));
    await page.getByRole('button', { name: 'Executar simulação', exact: true }).click();
    await page.getByRole('button', { name: 'Pausar simulação', exact: true }).click();
    await cdp.send('HeapProfiler.collectGarbage');
  }
  const retained = samples.map((s) => s.usedSize);
  expect(Math.max(...retained)).toBeLessThan(256 * 1024 * 1024);
  expect(retained.at(-1)! - retained[0]).toBeLessThan(32 * 1024 * 1024);
  await testInfo.attach('browser-heap-2000', {
    body: JSON.stringify({ samples, budgetMiB: 256, growthMiB: 32 }, null, 2),
    contentType: 'application/json',
  });
  const evidenceDir = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/application-completion-2026-10-13';
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(
    evidenceDir + '/browser-heap-2000-' + testInfo.project.name + '.json',
    JSON.stringify(
      {
        samples,
        budgetMiB: 256,
        growthMiB: 32,
        project: testInfo.project.name,
        scope:
          'Heap principal após GC explícito, três ciclos de pausa/retomada do Worker; não representa heap interno do Worker.',
      },
      null,
      2
    )
  );
  await cdp.detach();
  expect(errors).toEqual([]);
});

test('Sessões: expiração remota, reentrada, revogação atual e troca de senha', async ({ page, browser }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const address = 'session-recovery-' + Date.now() + '@example.test';
  const nextPassword = 'My-Network-Lab-456!';
  await page.goto('/');
  await registerAndLogin(page, address);
  await page.getByRole('button', { name: 'Novo laboratório', exact: true }).click();
  await page.getByLabel('Nome do laboratório').fill('Sessão e integridade');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const origin = new URL(page.url()).origin;
  const other = await browser.newContext({ extraHTTPHeaders: { Origin: origin } });
  try {
    let login = await other.request.post(origin + '/api/auth/login', {
      data: { email: address, password },
    });
    if (login.status() === 429) {
      await waitForLoginRetry(login.headers()['retry-after']);
      login = await other.request.post(origin + '/api/auth/login', { data: { email: address, password } });
    }
    expect(login.status()).toBe(200);
    const { csrfToken } = await login.json();
    const sessions: { id: string; is_current: boolean }[] = await (
      await other.request.get(origin + '/api/auth/sessions')
    ).json();
    const primarySession = sessions.find((session) => !session.is_current);
    expect(primarySession).toBeDefined();
    const revoke = await other.request.delete(origin + '/api/auth/sessions/' + primarySession!.id, {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(revoke.status()).toBe(200);
    await page.getByLabel('Nome do laboratório').fill('Alteração sem sessão');
    await page.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Entrar no shLab', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Sua sessão expirou. Entre novamente.');
    const projects = await (await other.request.get(origin + '/api/projects')).json();
    expect(projects.map((project: { name: string }) => project.name)).toEqual(['Sessão e integridade']);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const audit = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(audit.violations.map((violation) => violation.id)).toEqual([]);
    const enter = async (secret: string) => {
      await page.getByLabel('E-mail', { exact: true }).fill(address);
      await page.getByLabel('Senha', { exact: true }).fill(secret);
      await submitLogin(page);
      await expect(page.getByRole('heading', { name: 'Meus laboratórios', exact: true })).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
    };
    await enter(password);
    await page.getByRole('button', { name: 'Conta e segurança', exact: true }).click();
    await page.getByRole('tab', { name: 'Sessões', exact: true }).click();
    await page.getByRole('button', { name: 'Encerrar esta sessão', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Entrar no shLab', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await enter(password);
    await page.getByRole('button', { name: 'Conta e segurança', exact: true }).click();
    await page.getByRole('tab', { name: 'Senha', exact: true }).click();
    await page.getByLabel('Senha atual', { exact: true }).fill(password);
    await page.getByLabel('Nova senha', { exact: true }).fill(nextPassword);
    await page.getByRole('button', { name: 'Alterar senha', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Entrar no shLab', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect((await other.request.get(origin + '/api/auth/me')).status()).toBe(401);
    await enter(nextPassword);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Meus laboratórios', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await other.close();
  }
});
