import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import console from 'node:console';
const out = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/application-stability-2026-10-13';
await mkdir(out + '/screenshots', { recursive: true });
const reference = await chromium.connectOverCDP('http://127.0.0.1:9223'),
  browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({
  storageState: await reference.contexts()[0].storageState(),
  viewport: { width: 1500, height: 1000 },
});
const page = await context.newPage(),
  errors = [],
  created = [],
  result = { checks: [], accessibility: [], errors };
context.on('page', (p) => p.on('pageerror', (error) => errors.push(error.message)));
page.on('pageerror', (error) => errors.push(error.message));
const root = 'http://127.0.0.1:5173';
await page.goto(root);
const me = await (await context.request.get(root + '/api/auth/me')).json(),
  headers = { Origin: root, 'X-CSRF-Token': me.csrfToken };
const call = async (path, method = 'GET', data) => {
  const response = await context.request.fetch(root + '/api' + path, {
    method,
    headers,
    ...(data ? { data } : {}),
  });
  const body = await response.json();
  if (!response.ok()) throw new Error(path + ': ' + response.status() + ' ' + body.message);
  return body;
};
async function open(p, name) {
  await p.goto(root);
  await p.getByRole('heading', { name, exact: true }).click();
  await expect(p.locator('.react-flow__node-device')).toHaveCount(3);
}
async function draftRows(p, project) {
  return p.evaluate(
    (project) =>
      new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open('shlab-project-drafts', 1);
        request.onsuccess = () => {
          const db = request.result,
            query = db.transaction('drafts').objectStore('drafts').getAll();
          query.onsuccess = () => {
            resolve(
              query.result
                .filter((d) => d.project === project)
                .map((d) => ({ key: d.key, name: d.name, revision: d.revision, editVersion: d.editVersion }))
            );
            db.close();
          };
          query.onerror = () => {
            reject(query.error);
            db.close();
          };
        };
        request.onerror = () => reject(request.error);
      }),
    project
  );
}
try {
  const project = await call('/projects', 'POST', { name: 'Aplicação QA ' + Date.now(), template: 'lan' });
  created.push(project.id);
  await open(page, project.name);
  const endpoint = '**/api/projects/' + project.id;
  const outage = async (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Falha local controlada' }),
        })
      : route.continue();
  await page.route(endpoint, outage);
  const recoveredName = project.name + ' recuperado';
  await page.getByLabel('Nome do laboratório', { exact: true }).fill(recoveredName);
  await expect.poll(() => draftRows(page, project.id)).toHaveLength(1);
  await expect(page.getByText('Falha local controlada', { exact: true })).toBeVisible();
  await page.unroute(endpoint, outage);
  await open(page, project.name);
  await page.getByText(/Rascunhos locais disponíveis/).click();
  await expect(page.getByText(/diferenças de configuração/)).toBeVisible();
  await page.getByRole('button', { name: 'Recuperar rascunho', exact: true }).click();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect.poll(async () => (await call('/projects/' + project.id)).name).toBe(recoveredName);
  await expect.poll(() => draftRows(page, project.id)).toHaveLength(0);
  result.checks.push(
    'Falha 503 → rascunho → recarga → comparação → recuperação → persistência sem rascunho obsoleto'
  );
  const second = await context.newPage();
  await open(second, recoveredName);
  await page.route(endpoint, outage);
  const localName = project.name + ' conflito';
  await page.getByLabel('Nome do laboratório', { exact: true }).fill(localName);
  await expect.poll(() => draftRows(page, project.id)).toHaveLength(1);
  const remoteName = project.name + ' remoto';
  await second.getByLabel('Nome do laboratório', { exact: true }).fill(remoteName);
  await second.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Salvar alterações em uma cópia', exact: true })
  ).toBeVisible();
  await page.screenshot({ path: out + '/screenshots/conflict.png' });
  await page.getByRole('button', { name: 'Salvar alterações em uma cópia', exact: true }).click();
  await expect(page.getByRole('heading', { name: localName + ' (recuperado)', exact: true })).toBeVisible();
  const copies = await call('/projects');
  const copy = copies.find((p) => p.name === localName + ' (recuperado)');
  if (!copy) throw new Error('Cópia não persistida');
  created.push(copy.id);
  if ((await call('/projects/' + project.id)).name !== remoteName)
    throw new Error('Conflito sobrescreveu o servidor');
  result.checks.push('Duas abas → conflito de revisão → cópia completa → versão remota preservada');
  await page.unroute(endpoint, outage);
  await open(page, remoteName);
  await page.route(endpoint, outage);
  await page.getByLabel('Nome do laboratório', { exact: true }).fill(project.name + ' arquivado');
  await expect.poll(() => draftRows(page, project.id)).toHaveLength(2);
  await second.getByLabel('Nome do laboratório', { exact: true }).fill(project.name + ' remoto 2');
  await second.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Carregar versão do servidor', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Carregar versão do servidor', exact: true }).click();
  await expect(page.getByLabel('Nome do laboratório', { exact: true })).toHaveValue(
    project.name + ' remoto 2'
  );
  await page.unroute(endpoint, outage);
  await page.getByLabel('Nome do laboratório', { exact: true }).fill(project.name + ' edição posterior');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect
    .poll(async () => (await call('/projects/' + project.id)).name)
    .toBe(project.name + ' edição posterior');
  const archived = await draftRows(page, project.id);
  if (!archived.some((d) => d.name === project.name + ' arquivado'))
    throw new Error('Nova edição eliminou o rascunho arquivado');
  result.checks.push('Carregar versão remota arquiva alterações anteriores e nova edição conserva o arquivo');
  await page.getByRole('button', { name: 'Opções do laboratório' }).click();
  await page.getByRole('button', { name: 'Organizar topologia', exact: true }).click();
  await page.getByRole('button', { name: /Desfazer/ }).click();
  await page.getByRole('button', { name: /Refazer/ }).click();
  await page.getByRole('button', { name: 'Opções do laboratório' }).click();
  await page.getByRole('button', { name: 'Validar rede e cenários' }).click();
  await page.getByRole('button', { name: 'Cenários e SLA' }).click();
  await page.getByRole('button', { name: 'Configuração e revisão', exact: true }).click();
  const bulkSource = (await call('/projects/' + project.id)).topology.devices.find((d) =>
    d.interfaces.some((p) => p.ip === '192.168.10.10')
  );
  await page
    .getByLabel('Configuração em lote', { exact: true })
    .fill(JSON.stringify([{ hostname: bulkSource.hostname, port: 'p0', description: 'Revisão em lote QA' }]));
  await page.getByRole('button', { name: 'Preparar alterações', exact: true }).click();
  await page.getByRole('button', { name: 'Aplicar proposta', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await call('/projects/' + project.id)).topology.devices.find((d) => d.id === bulkSource.id)
          .interfaces[0].description
    )
    .toBe('Revisão em lote QA');
  await page.getByRole('button', { name: 'Cenários e SLA' }).click();
  await page.getByText('Editar por formulário', { exact: true }).click();
  const protocol = page.getByLabel('Protocolo', { exact: true });
  await protocol.selectOption('dns');
  await expect(protocol.locator('option')).toHaveCount(9);
  await protocol.selectOption('icmp');
  await expect(page.getByRole('group', { name: /^Ações agendadas/ })).toBeVisible();
  await expect(page.getByRole('group', { name: /^Verificações de estado/ })).toBeVisible();
  const topology = (await call('/projects/' + project.id)).topology,
    source = topology.devices.find((d) => d.interfaces.some((p) => p.ip === '192.168.10.10')),
    target = topology.devices.find((d) => d.interfaces.some((p) => p.ip === '192.168.10.20'));
  const scenario = {
    name: 'Rollback na interface',
    durationMs: 4000,
    intervalMs: 1000,
    deadlineMs: 500,
    flows: [
      {
        name: 'Ping',
        source: source.id,
        target: '192.168.10.20',
        protocol: 'icmp',
        expect: 'allow',
        maxLossPercent: 100,
      },
    ],
    faults: [],
    actions: [
      {
        kind: 'configure',
        checkpoint: 'change',
        atMs: 1000,
        changes: [{ device: target.id, ports: [{ port: 'p0', adminUp: false, ip: null, prefix: null }] }],
      },
      { kind: 'rollback', checkpoint: 'change', atMs: 3000 },
    ],
  };
  await page.getByLabel('Definição do cenário', { exact: true }).fill(JSON.stringify(scenario));
  await expect(page.getByText('IPv4: valor removido', { exact: true })).toBeVisible();
  await expect(page.getByText('Prefixo: valor removido', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Executar cenário', exact: true }).click();
  await expect(page.getByText(/Rollback na interface · revisão.*Salvo/)).toBeVisible({ timeout: 30000 });
  const runs = await call('/projects/' + project.id + '/scenario-runs');
  const run = runs[0];
  if (
    run.report.actions.length !== 2 ||
    run.report.engineBuild !== 'development' ||
    run.build_identity.schemaVersion !== 11
  )
    throw new Error('Ações/build não persistidos');
  await page.getByText(/Rollback na interface · revisão/).click();
  await page.getByRole('button', { name: 'Verificar no servidor', exact: true }).click();
  await expect(page.getByText(/Reexecução no servidor: resultado confirmado/)).toBeVisible({
    timeout: 30000,
  });
  result.checks.push(
    'Autolayout/undo/redo, nove serviços no formulário, ações/assertions, execução, identidade do build e replay matched'
  );
  for (const [label, viewport] of [
    ['desktop', { width: 1500, height: 1000 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    await page.setViewportSize(viewport);
    const scan = await new AxeBuilder({ page }).analyze();
    result.accessibility.push({
      viewport: label,
      violations: scan.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
    });
    await page.screenshot({ path: out + '/screenshots/form-' + label + '.png', fullPage: true });
    expect(scan.violations).toHaveLength(0);
    expect(
      await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth)
    ).toBe(false);
  }
  await page.getByRole('button', { name: 'Fechar', exact: true }).click();
  await page.goto(root);
  await call('/projects/' + project.id, 'DELETE');
  await page.getByRole('button', { name: 'Rascunhos locais', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Recuperar em novo laboratório', exact: true }).first()
  ).toBeVisible();
  const ids = new Set((await call('/projects')).map((p) => p.id));
  const dashboardScan = await new AxeBuilder({ page }).analyze();
  expect(dashboardScan.violations).toHaveLength(0);
  expect(
    await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth)
  ).toBe(false);
  result.accessibility.push({ viewport: 'mobile-local-drafts', violations: [] });
  await page.getByRole('button', { name: 'Recuperar em novo laboratório', exact: true }).first().click();
  await expect(page.locator('.react-flow__node-device')).toHaveCount(3);
  const recovered = (await call('/projects')).find((p) => !ids.has(p.id));
  if (!recovered) throw new Error('Rascunho do projeto excluído não foi recuperado');
  created.push(recovered.id);
  result.checks.push(
    'Lote antigo validado/revisado/aplicado; gerenciador mobile recupera rascunho de projeto excluído'
  );
  expect(errors).toHaveLength(0);
  result.passed = true;
} finally {
  await writeFile(out + '/application-ui.json', JSON.stringify(result, null, 2));
  for (const id of created)
    await context.request.delete(root + '/api/projects/' + id, { headers }).catch(() => {});
  await browser.close();
  await reference.close();
}
console.log(
  JSON.stringify({
    passed: result.passed,
    checks: result.checks.length,
    accessibility: result.accessibility,
    errors,
  })
);
