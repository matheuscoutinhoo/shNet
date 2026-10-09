import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decodePcap } from '../../packages/simulation-engine/src';
const email = 'shlab-e2e-' + Date.now() + '@example.test',
  password = 'My-Network-Lab-123!';
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
  await page.getByRole('button', { name: 'Comece aqui' }).click();
  await page.getByLabel('Seu nome').fill('Network Explorer');
  await page.getByLabel('E-mail', { exact: true }).fill(address);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Criar conta', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('verificação');
  await page.goto(await verificationLink(address));
  await page.getByRole('button', { name: 'Verificar e-mail', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('E-mail verificado');
  await page.getByLabel('E-mail', { exact: true }).fill(address);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar no shLab' }).click();
  await expect(page.getByRole('heading', { name: 'Sua próxima conexão.' })).toBeVisible();
}
test('VPN e SD-WAN: configuração, controller, failover HTTP, PDU e persistência mobile', async ({ page }) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await registerAndLogin(page, 'sdwan-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: /A aplicação escolhe o caminho/ }).click();
  await page.getByLabel('Nome do laboratório').fill('SD-WAN E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (name: string, tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await page
      .locator('.network-device')
      .filter({ has: page.getByText(name, { exact: true }) })
      .click();
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
  await page.locator('.network-device').filter({ hasText: hostname }).click();
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
      await page.getByRole('button', { name: new RegExp(scenario.template) }).click();
      await page.getByLabel('Nome do laboratório').fill(scenario.name + ' E2E');
      await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
      const inspect = async (name: string, tab: string) => {
        const close = page.getByRole('button', { name: 'Fechar inspector' });
        if (await close.count()) await close.click();
        await page
          .locator('.network-device')
          .filter({ has: page.getByText(name, { exact: true }) })
          .click();
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
  await page.locator('.network-device').filter({ hasText: hostname }).click();
  await page.locator('.inspector-tabs').getByRole('button', { name: 'TCP / HTTP', exact: true }).click();
}
test('AAA: 802.1X, RADIUS, VLAN, TACACS+, HTTP e persistência mobile', async ({ page }) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await registerAndLogin(page, 'aaa-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: /A porta espera autorização/ }).click();
  await page.getByLabel('Nome do laboratório').fill('AAA E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (name: string, tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await page
      .locator('.network-device')
      .filter({ has: page.getByText(name, { exact: true }) })
      .click();
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
  await page.getByRole('button', { name: /O firewall lê a aplicação/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Inspection E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (name: string, tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await page
      .locator('.network-device')
      .filter({ has: page.getByText(name, { exact: true }) })
      .click();
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
  await page.getByRole('button', { name: /O BGP anuncia onde está o MAC/ }).click();
  await page.getByLabel('Nome do laboratório').fill('EVPN E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (name: string, tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await page
      .locator('.network-device')
      .filter({ has: page.getByText(name, { exact: true }) })
      .click();
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
  await page.locator('.event-filters').getByRole('button', { name: 'DHCP', exact: true }).click();
  await page.locator('.event-table tr').filter({ hasText: 'DHCP_RELAY_REPLY' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('giaddr (relay)');
  await expect(page.getByRole('dialog')).toContainText('192.168.10.1');
  await expect(page.getByRole('dialog')).toContainText('Relay hops');
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
  await page.getByRole('button', { name: /Rotas por distância/ }).click();
  await page.getByLabel('Nome do laboratório').fill('RIP E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await page
    .locator('.network-device')
    .filter({ has: page.getByText('R-01', { exact: true }) })
    .click();
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
  await page
    .locator('.network-device')
    .filter({ has: page.getByText('R-01', { exact: true }) })
    .click();
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
  await page.getByRole('button', { name: /Rotas que se adaptam/ }).click();
  await page.getByLabel('Nome do laboratório').fill('OSPF E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await page
    .locator('.network-device')
    .filter({ has: page.getByText('R-01', { exact: true }) })
    .click();
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
  await page
    .locator('.network-device')
    .filter({ has: page.getByText('R-01', { exact: true }) })
    .click();
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
  await page.getByRole('button', { name: /Rede sob observação/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Gerenciamento E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (hostname: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await page.locator('.network-device').filter({ hasText: hostname }).click();
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
  await page.getByRole('button', { name: /Três zonas, caminhos controlados/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Zonas E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async () => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await page.locator('.network-device').filter({ hasText: 'FW-EDGE' }).click();
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
  await page.locator('.event-filters').getByRole('button', { name: 'ACL / NAT', exact: true }).click();
  await advanceSimulation(
    page,
    async () => (await page.locator('.event-table').innerText()).includes('RELATED'),
    160
  );
  await page.locator('.event-filters').getByRole('button', { name: 'ICMP', exact: true }).click();
  await page.locator('.event-table-wrap tr').filter({ hasText: 'FRAME_SENT' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('Cabeçalho citado');
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
  await page.getByRole('button', { name: /Entre duas redes/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Firewall E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspectFirewall = async () => {
    await page.locator('.network-device').filter({ hasText: 'R-EDGE-01' }).click();
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
  await page.locator('.network-device').filter({ hasText: 'R-EDGE-01' }).click();
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Políticas', exact: true }).click();
  await expect(page.locator('.firewall-panel')).toContainText('CLOSING');
  await expect(page.locator('.firewall-panel')).toContainText('Descartes: 0');
  await page.locator('.event-filters').getByRole('button', { name: 'TCP', exact: true }).click();
  const packetRow = page.locator('.event-table-wrap tr').filter({ hasText: 'FRAME_SENT' }).last();
  await packetRow.click();
  await expect(page.getByRole('dialog')).toContainText('Acknowledgment');
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
  await page.locator('.network-device').filter({ hasText: hostname }).click();
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
  await page
    .locator('.network-device')
    .filter({ has: page.getByText(hostname, { exact: true }) })
    .click();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
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
async function configureIp(page: Page, hostname: string, ip: string) {
  await page.locator('.network-device').filter({ hasText: hostname }).click();
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
  await page.getByRole('button', { name: /Sua primeira LAN/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Canvas E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await page.locator('.network-device').filter({ hasText: 'PC-01' }).click();
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
  await page.getByRole('button', { name: 'Abrir laboratório guiado', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Modo do laboratório', exact: true })).toHaveValue(
    'guided'
  );
  await expect(page.getByRole('combobox', { name: 'Lab', exact: true })).toHaveValue('lan-foundations');
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
  await page.getByRole('button', { name: /Além da rede privada/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Políticas E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await page.locator('.network-device').filter({ hasText: 'R-EDGE-01' }).click();
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
  await expect(page.locator('.osi-stack > div')).toHaveCount(7);
  await page.screenshot({ path: 'test-results/osi-packet-desktop.png', fullPage: true });
  await page
    .getByRole('dialog')
    .locator('.modal-head')
    .getByRole('button', { name: 'Fechar', exact: true })
    .click();
  await page.locator('.network-device').filter({ hasText: 'R-EDGE-01' }).click();
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
  await page.locator('.network-device').filter({ hasText: 'R-EDGE-01' }).click();
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
  await page.locator('.network-device').filter({ hasText: 'R-EDGE-01' }).click();
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
    await expect(other.getByRole('heading', { name: 'Sua próxima conexão.' })).toBeVisible();
    await page.getByRole('button', { name: 'Conta e segurança', exact: true }).click();
    await page.getByLabel('Nome de exibição').fill('Network Builder');
    await page.getByRole('button', { name: 'Salvar perfil', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Perfil atualizado');
    await page.getByRole('tab', { name: 'Sessões', exact: true }).click();
    await expect(page.locator('.account-session')).toHaveCount(2);
    await page.screenshot({ path: 'test-results/account-desktop.png', fullPage: true });
    await page.getByRole('button', { name: 'Encerrar outra sessão', exact: true }).click();
    await expect(page.locator('.account-session')).toHaveCount(1);
    await other.reload();
    await expect(other.getByRole('heading', { name: 'Bem-vindo de volta.' })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('tab', { name: 'Perfil', exact: true }).click();
    await expect(page.getByLabel('Nome de exibição')).toHaveValue('Network Builder');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/account-mobile.png', fullPage: true });
    await page.getByRole('tab', { name: 'Excluir conta', exact: true }).click();
    await page.getByLabel('Confirme sua senha').fill(password);
    await page.getByLabel('Entendo que esta ação é irreversível').check();
    await page.getByRole('button', { name: 'Excluir minha conta', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Bem-vindo de volta.' })).toBeVisible();
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
  await page.getByRole('button', { name: /Redundância sem loops/ }).click();
  await page.getByLabel('Nome do laboratório').fill('RSTP E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await expect(page.locator('.network-device')).toHaveCount(5);
  await page.locator('.network-device').filter({ hasText: 'SW-03' }).click();
  await page.locator('.inspector-tabs').getByRole('button', { name: 'STP', exact: true }).click();
  await expect(page.locator('.stp-ports tr[data-port="p2"]')).toHaveAttribute('data-role', 'alternate');
  await expect(page.locator('.stp-blocked')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/rstp-workspace-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await rstpPing(page, 'Resposta em');
  await switchTerminal(page, 'SW-03', ['enable', 'configure terminal', 'interface Gi0/2', 'shutdown']);
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
  await expect(page.getByRole('dialog')).toContainText('RSTP BPDU');
  await expect(page.getByRole('dialog')).toContainText('Proposal / Agreement');
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
  await page.locator('.network-device').filter({ hasText: 'SW-03' }).click();
  await page.locator('.inspector-tabs').getByRole('button', { name: 'STP', exact: true }).click();
  await expect(page.locator('.stp-ports tr[data-port="p2"]')).toHaveAttribute('data-role', 'root');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/rstp-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('.network-device').filter({ hasText: 'SW-03' }).click();
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
  await expect(page.getByRole('heading', { name: 'Bem-vindo de volta.' })).toBeVisible();
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
  await page.locator('.network-device').filter({ hasText: clientA }).click();
  await page
    .locator('.network-device')
    .filter({ hasText: clientB })
    .click({ modifiers: ['Shift'] });
  await expect(page.locator('.network-device.selected')).toHaveCount(2);
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await expect(page.locator('.network-device.selected')).toHaveCount(0);
  await configureIp(page, clientA, '192.168.10.10');
  await configureIp(page, clientB, '192.168.10.20');
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
  await page.getByRole('button', { name: /Entre duas redes/ }).click();
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await page.getByRole('button', { name: 'Enviar ping', exact: true }).click();
  await page.getByRole('button', { name: 'Enfileirar ping' }).click();
  await page.getByLabel('Velocidade', { exact: true }).selectOption('5');
  await page.getByRole('button', { name: 'Executar simulação' }).click();
  await expect(page.locator('.probe-toast')).toContainText('Resposta em');
  await page.locator('.network-device').filter({ hasText: 'R-EDGE-01' }).click();
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
  await page.locator('.network-device').filter({ hasText: 'R-EDGE-01' }).click();
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
  await expect(page.getByRole('heading', { name: 'Sua próxima conexão.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
  await page.getByRole('button', { name: /^LABORATÓRIO LIVRE Entre duas redes/ }).click();
  await expect(page.locator('.network-device')).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/workspace-mobile.png', fullPage: true });
  await page.locator('.network-device').filter({ hasText: 'R-EDGE-01' }).click();
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
    await page.locator('.network-device').filter({ hasText: hostname }).click();
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
  await expect(page.locator('.event-table')).toContainText('DHCP_ACK');
  await page.locator('.event-table').getByRole('row').filter({ hasText: 'DHCP_ACK' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('17 (UDP)');
  await expect(page.getByRole('dialog')).toContainText('DNS option');
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
  await page.getByRole('button', { name: /Um gateway, dois roteadores/ }).click();
  await page.getByLabel('Nome do laboratório').fill('VRRP E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await expect(page.locator('.network-device')).toHaveCount(6);
  const inspect = async (hostname: string, tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await page.locator('.network-device').filter({ hasText: hostname }).click();
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
  await page.locator('.event-filters').getByRole('button', { name: 'VRRP', exact: true }).click();
  await page.locator('.event-table-wrap tr').filter({ hasText: 'VRRP_ADVERT_SENT' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('112 (VRRP)');
  await expect(page.getByRole('dialog')).toContainText('VRID / VIP');
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
  await panel.getByLabel('IP virtual').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/vrrp-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('BGP: sessões TCP, AS_PATH, política, falha, inspector e persistência mobile', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await registerAndLogin(page, 'bgp-' + Date.now() + '@example.test');
  await page.getByRole('button', { name: /Três sistemas autônomos/ }).click();
  await page.getByLabel('Nome do laboratório').fill('BGP E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (hostname: string, tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await page
      .locator('.network-device')
      .filter({ has: page.getByText(hostname, { exact: true }) })
      .click();
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
    await page.getByRole('button', { name: new RegExp(template) }).click();
    await page.getByLabel('Nome do laboratório').fill('L3 E2E');
    await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
    const inspect = async (name: string, tab: string) => {
      const close = page.getByRole('button', { name: 'Fechar inspector' });
      if (await close.count()) await close.click();
      await page
        .locator('.network-device')
        .filter({ has: page.getByText(name, { exact: true }) })
        .click();
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
  await page.getByRole('button', { name: /Mesmo endereço, redes separadas/ }).click();
  await page.getByLabel('Nome do laboratório').fill('VRF E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await page
    .locator('.network-device')
    .filter({ has: page.getByText('R-VRF', { exact: true }) })
    .click();
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
  await page
    .locator('.network-device')
    .filter({ has: page.getByText('R-VRF', { exact: true }) })
    .click();
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
  await page.getByRole('button', { name: /Gateway atento ao uplink/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Tracking E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (name: string, tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await page
      .locator('.network-device')
      .filter({ has: page.getByText(name, { exact: true }) })
      .click();
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
  await page.getByRole('button', { name: /Dois cabos, um enlace/ }).click();
  await page.getByLabel('Nome do laboratório').fill('LACP E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (name: string, tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await page
      .locator('.network-device')
      .filter({ has: page.getByText(name, { exact: true }) })
      .click();
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
  await page.locator('.event-filters').getByRole('button', { name: 'LACP', exact: true }).click();
  await page.locator('.event-table-wrap tr').filter({ hasText: 'LACP_SENT' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('Actor system / key / port');
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
  await page.getByRole('button', { name: /Serviços em uma rede IPv6/ }).click();
  await page.getByLabel('Nome do laboratório').fill('IPv6 Services E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await page
      .locator('.network-device')
      .filter({ has: page.getByText('PC-DHCP6', { exact: true }) })
      .click();
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
  await page.getByRole('button', { name: /Endereços que chegam pela rede/ }).click();
  await page.getByLabel('Nome do laboratório').fill('IPv6 E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (name: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await page
      .locator('.network-device')
      .filter({ has: page.getByText(name, { exact: true }) })
      .click();
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
  await expect(page.getByRole('dialog')).toContainText('IPv6 — ICMPv6 / NDP');
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
  await page.getByRole('button', { name: /Do rádio à resposta HTTP/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Wireless E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (name: string, tab: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await page
      .locator('.network-device')
      .filter({ has: page.getByText(name, { exact: true }) })
      .click();
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
  await expect(page.getByRole('dialog')).toContainText('802.11 — associação e segurança');
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
  await page.getByRole('button', { name: /A configuração chega pela rede/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Automation E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const inspect = async (name: string) => {
    const close = page.getByRole('button', { name: 'Fechar inspector' });
    if (await close.count()) await close.click();
    await page
      .locator('.network-device')
      .filter({ has: page.getByText(name, { exact: true }) })
      .click();
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
  await page.locator('.network-device').last().click();
  await expect(page.locator('.inspector')).toContainText('NL Switch de core');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Portas', exact: true }).click();
  await expect(page.locator('.interface-item')).toHaveCount(8);
  await page.locator('.interface-item').filter({ hasText: 'Fo0/1' }).click();
  await page.getByLabel('Módulo transceiver').selectOption('dac');
  await page.getByRole('button', { name: 'Aplicar à simulação', exact: true }).click();
  await page.getByRole('button', { name: 'Fechar inspector' }).click();
  await page.locator('.network-device').last().click();
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
  await page.getByRole('button', { name: 'Abrir laboratório guiado', exact: true }).click();
  await page.getByRole('combobox', { name: 'Lab', exact: true }).selectOption('svi-repair');
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
  await page.getByRole('button', { name: /Sua primeira LAN/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Learning E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  await page.getByRole('button', { name: 'Desafio', exact: true }).click();
  await page.getByLabel('Nome do desafio').fill('Minha LAN funcional');
  await page.getByRole('button', { name: 'Adicionar objetivo' }).click();
  await page.getByRole('button', { name: 'Salvar desafio e estado inicial' }).click();
  await expect(page.getByRole('heading', { name: 'Minha LAN funcional' })).toBeVisible();
  await page.getByRole('button', { name: 'Verificar objetivos' }).click();
  await expect(page.getByRole('status')).toContainText('Pontuação: 100/100');
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
  await expect(page.getByText('Pontos de aprendizagem')).toBeVisible();
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
    await page.getByRole('button', { name: /Campus com autenticação empresarial/ }).click();
    await page.getByLabel('Nome do laboratório').fill('Enterprise E2E');
    await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
    if (method === 'peap') {
      await page
        .locator('.network-device')
        .filter({ has: page.getByText('RADIUS-CAMPUS', { exact: true }) })
        .click();
      await page
        .locator('.inspector-tabs')
        .getByRole('button', { name: 'WLC / Mesh / IDS', exact: true })
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
    await page
      .locator('.network-device')
      .filter({ has: page.getByText('CLIENT-CAMPUS', { exact: true }) })
      .click();
    await page
      .locator('.inspector-tabs')
      .getByRole('button', { name: 'WLC / Mesh / IDS', exact: true })
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
    await page
      .locator('.network-device')
      .filter({ has: page.getByText('CLIENT-CAMPUS', { exact: true }) })
      .click();
    await page
      .locator('.inspector-tabs')
      .getByRole('button', { name: 'WLC / Mesh / IDS', exact: true })
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
  await page.getByRole('button', { name: /Sua primeira LAN/ }).click();
  await page.getByLabel('Nome do laboratório').fill('Workspace Extras E2E');
  await page.getByRole('button', { name: 'Criar e abrir laboratório' }).click();
  const options = () => page.getByRole('button', { name: 'Opções do laboratório', exact: true });
  await options().click();
  await page.getByRole('button', { name: 'Adicionar comentário ancorado', exact: true }).click();
  await page.getByLabel('Comentário', { exact: true }).fill('Conferir VLAN e gateway');
  await page.getByRole('button', { name: 'Adicionar comentário', exact: true }).click();
  await expect(page.locator('.canvas-comment')).toContainText('Conferir VLAN e gateway');
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
  await page.getByRole('button', { name: 'Histórico', exact: true }).click();
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
    .getByRole('button', { name: 'WLC / Mesh / IDS', exact: true })
    .click();
  await page.getByLabel('Recurso de rede', { exact: true }).selectOption('ids');
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
                })
            );
        });
      }
    };
  });
  await page.goto('/');
  await registerAndLogin(page, 'scale-' + Date.now() + '@example.test');
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
  expect(errors).toEqual([]);
});
