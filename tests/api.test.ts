import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEmbedded, migrate, type Database } from '../apps/api/src/db';
import { buildApp } from '../apps/api/src/app';
import { runtimeConfig } from '../apps/api/src/config';
import railwayConfig from '../.railway/railway';
import { createRailwayContext, project as railwayProject } from 'railway/iac';
import { makeTemplate, SimulationEngine, templates } from '@shlab/engine';
import type { Mail } from '../apps/api/src/mailer';
import { createMailer } from '../apps/api/src/mailer';
import { api as browserApi, ApiError } from '../apps/web/src/api';
const origin = 'http://127.0.0.1:5173',
  password = 'Network-Lab-Test-123!';
let app: FastifyInstance, db: Database;
const mails: Mail[] = [];
type Client = { cookie: string; csrf: string; email: string };
describe('configuração de implantação', () => {
  it('aceita resposta nula e trata indisponibilidade HTTP sem JSON', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(null))
      .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await browserApi('/projects/test/progress')).toBeNull();
      await expect(browserApi('/projects')).rejects.toMatchObject({ name: 'Error', status: 502 });
      expect(ApiError.prototype).toBeInstanceOf(Error);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('declara Railway sem credenciais em código e com migration e healthcheck', async () => {
    const definition = await railwayConfig(
      createRailwayContext({ environment: 'production' }),
      railwayProject
    );
    const resources = definition.resources?.flat() ?? [];
    expect(definition.name).toBe('shLab');
    expect(resources).toHaveLength(2);
    expect(resources.find((resource) => resource.type === 'service')).toMatchObject({
      source: { repo: 'matheuscoutinhoo/shNet', branch: 'main', rootDirectory: '/' },
      build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
      deploy: {
        numReplicas: 1,
        healthcheckPath: '/api/health',
        preDeployCommand: ['node --import tsx apps/api/src/migrate.ts'],
      },
      variables: {
        DATABASE_URL: { type: 'reference', resource: 'database.postgres' },
        RESEND_API_KEY: { type: 'sharedReference', name: 'RESEND_API_KEY' },
      },
    });
    expect(resources.find((resource) => resource.type === 'database')).toMatchObject({
      name: 'postgres',
      engine: 'postgres',
    });
  });
  const production = {
    NODE_ENV: 'production',
    DATABASE_MODE: 'server',
    DATABASE_URL: 'postgresql://test@db/shlab',
    RAILWAY_PUBLIC_DOMAIN: 'shlab.up.railway.app',
    PORT: '8080',
  };
  it('usa PORT e escuta nas redes pública e privada do Railway', () => {
    expect(runtimeConfig(production)).toMatchObject({
      production: true,
      embedded: false,
      host: '::',
      port: 8080,
      origin: 'https://shlab.up.railway.app',
    });
    expect(runtimeConfig({ ...production, APP_ORIGIN: 'https://lab.example.test/' }).origin).toBe(
      'https://lab.example.test'
    );
  });
  it('recusa banco embarcado, origem insegura e porta inválida em produção', () => {
    expect(() => runtimeConfig({ ...production, DATABASE_MODE: 'embedded' })).toThrow('PostgreSQL');
    expect(() => runtimeConfig({ ...production, APP_ORIGIN: 'http://lab.example.test' })).toThrow('HTTPS');
    expect(() => runtimeConfig({ ...production, APP_ORIGIN: 'https://lab.example.test/path' })).toThrow(
      'origem'
    );
    expect(() => runtimeConfig({ ...production, PORT: 'invalid' })).toThrow('PORT');
    expect(runtimeConfig({ DATABASE_MODE: 'embedded' }).host).toBe('127.0.0.1');
    expect(() => runtimeConfig({ ...production, TRUSTED_PROXY_CIDRS: 'true' })).toThrow(
      'TRUSTED_PROXY_CIDRS'
    );
    expect(() => runtimeConfig({ ...production, TRUSTED_PROXY_CIDRS: '0.0.0.0/0' })).toThrow(
      'TRUSTED_PROXY_CIDRS'
    );
  });
  it('envia e-mail por HTTPS sem depender de SMTP no Railway Hobby', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'test-message' }));
    const mail = { to: 'test@example.test', subject: 'Verify', text: 'A test verification message' };
    await createMailer(
      {
        NODE_ENV: 'production',
        MAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 'test-only-key',
        MAIL_FROM: 'shLab <test@example.test>',
      },
      send
    )(mail);
    expect(send).toHaveBeenCalledOnce();
    const [url, options] = send.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(String(options?.body))).toEqual({
      from: 'shLab <test@example.test>',
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
    });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });
  it('recusa fallback local em produção e não expõe erros do provedor', async () => {
    expect(() =>
      createMailer({ NODE_ENV: 'production', MAIL_PROVIDER: 'local', MAIL_FROM: 'test@example.test' })
    ).toThrow('provedor');
    expect(() => createMailer({ MAIL_PROVIDER: 'resend' })).toThrow('RESEND_API_KEY');
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ message: 'sensitive-provider-detail' }, { status: 401 }));
    await expect(
      createMailer(
        { MAIL_PROVIDER: 'resend', RESEND_API_KEY: 'test-only-key', MAIL_FROM: 'test@example.test' },
        send
      )({ to: 'test@example.test', subject: 'Test', text: 'Test' })
    ).rejects.toThrow('Falha no provedor de e-mail (HTTP 401).');
  });
  it('preserva cookies Secure e rate limit por cliente atrás do proxy configurado', async () => {
    const productionApp = await buildApp({
      db,
      mailer: async () => {},
      origin: 'https://shlab.example.test',
      production: true,
      trustedProxies: ['10.0.0.1/32'],
      rateLimit: 1,
    });
    productionApp.get('/client-ip', { config: { rateLimit: false } }, (request) => ({ ip: request.ip }));
    const budgetPath = '/client-budget-' + Date.now();
    productionApp.get(budgetPath, async () => ({ ok: true }));
    try {
      const login = await productionApp.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: 'https://shlab.example.test' },
        payload: { email: a.email, password },
      });
      expect(login.statusCode).toBe(200);
      expect(login.headers['set-cookie']).toContain('Secure');
      for (const address of ['203.0.113.1', '203.0.113.2']) {
        expect(
          (
            await productionApp.inject({
              url: '/client-ip',
              remoteAddress: '10.0.0.1',
              headers: { 'x-forwarded-for': address },
            })
          ).json()
        ).toEqual({ ip: address });
        expect(
          (
            await productionApp.inject({
              url: budgetPath,
              remoteAddress: '10.0.0.1',
              headers: { 'x-forwarded-for': address },
            })
          ).statusCode,
          address
        ).toBe(200);
      }
      expect(
        (
          await productionApp.inject({
            url: budgetPath,
            remoteAddress: '10.0.0.1',
            headers: { 'x-forwarded-for': '203.0.113.1' },
          })
        ).statusCode
      ).toBe(429);
      expect(
        (await productionApp.inject({ url: '/api/health', remoteAddress: '203.0.113.1' })).statusCode
      ).toBe(200);
      expect(
        (
          await productionApp.inject({
            url: '/client-ip',
            remoteAddress: '198.51.100.1',
            headers: { 'x-forwarded-for': '203.0.113.99' },
          })
        ).json()
      ).toEqual({ ip: '198.51.100.1' });
    } finally {
      await productionApp.close();
    }
  });
});
let a: Client, b: Client;
function request(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' = 'GET',
  body?: Record<string, unknown>,
  client?: Client,
  headers: Record<string, string> = {},
  remoteAddress?: string
) {
  return app.inject({
    url: '/api' + path,
    remoteAddress,
    method,
    payload: body,
    headers: {
      origin,
      ...(client ? { cookie: client.cookie, 'x-csrf-token': client.csrf } : {}),
      ...headers,
    },
  });
}
function mailToken(address: string) {
  const mail = mails.filter((m) => m.to === address).at(-1)!;
  return mail.text.match(/#token=([\w-]+)/)![1];
}
async function signup(email: string, remoteAddress?: string): Promise<Client> {
  expect(
    (
      await request(
        '/auth/register',
        'POST',
        { name: 'Test User', email, password },
        undefined,
        {},
        remoteAddress
      )
    ).statusCode
  ).toBe(202);
  expect(
    (await request('/auth/verify-email', 'POST', { token: mailToken(email) }, undefined, {}, remoteAddress))
      .statusCode
  ).toBe(200);
  const login = await request('/auth/login', 'POST', { email, password }, undefined, {}, remoteAddress);
  expect(login.statusCode).toBe(200);
  return {
    cookie: login.cookies[0].name + '=' + login.cookies[0].value,
    csrf: login.json().csrfToken,
    email,
  };
}
beforeAll(async () => {
  db = process.env.TEST_DATABASE_URL
    ? (await import('../apps/api/src/db')).createPostgres(process.env.TEST_DATABASE_URL)
    : await createEmbedded();
  await migrate(db);
  app = await buildApp({
    db,
    mailer: async (m) => {
      mails.push(m);
    },
    origin,
    rateLimit: 2000,
  });
  await app.ready();
  a = await signup('a-' + Date.now() + '@example.test');
  b = await signup('b-' + Date.now() + '@example.test');
});
afterAll(async () => {
  await app?.close();
  await db?.close();
});
describe('autenticação e API privada', () => {
  it('persiste resposta DNS/TCP parcial e rejeita conexão de consulta adulterada', async () => {
    const created = await request('/projects', 'POST', { name: 'DNS TCP integration', template: 'dns' }, a);
    expect(created.statusCode).toBe(201);
    const project = created.json(),
      engine = new SimulationEngine(project.topology);
    const client = engine.state.devices[0],
      server = engine.state.devices.find((device) => device.type === 'server')!;
    for (let i = 1; i <= 32; i++)
      engine.configureDnsRecord(server.id, {
        name: 'large.lab',
        type: 'A',
        value: `203.0.113.${i}`,
        ttl: 60,
      });
    engine.lookupDns(client.id, 'large.lab');
    for (let i = 0; i < 300 && !client.tcpConnections?.[0]?.received; i++) engine.step();
    expect(client.dnsQueries![0].status).toBe('pending');
    const saved = await request(
      '/projects/' + project.id,
      'PUT',
      { name: project.name, revision: project.revision, topology: engine.snapshot() },
      a
    );
    expect(saved.statusCode).toBe(200);
    const loaded = await request('/projects/' + project.id, 'GET', undefined, a);
    const restored = new SimulationEngine(loaded.json().topology);
    const bad = engine.snapshot();
    bad.devices[0].dnsQueries![0].tcpConnection = 'tcp-unknown';
    expect(
      (
        await request(
          '/projects/' + project.id,
          'PUT',
          { name: project.name, revision: saved.json().revision, topology: bad },
          a
        )
      ).statusCode
    ).toBe(400);
    engine.advanceTo(3000);
    restored.advanceTo(3000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(restored.state.devices[0].dnsQueries![0].answers).toHaveLength(32);
  });
  it('persiste RIP com timers e rejeita métrica inválida', async () => {
    const created = await request('/projects', 'POST', { name: 'RIP integration', template: 'rip' }, a);
    expect(created.statusCode).toBe(201);
    const project = created.json(),
      engine = new SimulationEngine(project.topology);
    engine.advanceTo(10000);
    const saved = await request(
      '/projects/' + project.id,
      'PUT',
      { name: project.name, revision: project.revision, topology: engine.snapshot() },
      a
    );
    expect(saved.statusCode).toBe(200);
    const loaded = await request('/projects/' + project.id, 'GET', undefined, a);
    const restored = new SimulationEngine(loaded.json().topology);
    engine.advanceTo(35000);
    restored.advanceTo(35000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    const bad = engine.snapshot();
    bad.devices[0].rip!.table.find((entry) => entry.learnedFrom)!.metric = 16;
    expect(
      (
        await request(
          '/projects/' + project.id,
          'PUT',
          { name: project.name, revision: saved.json().revision, topology: bad },
          a
        )
      ).statusCode
    ).toBe(400);
  });
  it('salva e retoma OSPF em Exchange e recusa rotas ou timers adulterados', async () => {
    const created = await request('/projects', 'POST', { name: 'OSPF integration', template: 'ospf' }, a);
    expect(created.statusCode).toBe(201);
    const project = created.json(),
      engine = new SimulationEngine(project.topology);
    for (let i = 0; i < 30; i++) engine.step();
    const saved = await request(
      '/projects/' + project.id,
      'PUT',
      { name: project.name, revision: project.revision, topology: engine.snapshot() },
      a
    );
    expect(saved.statusCode).toBe(200);
    const loaded = await request('/projects/' + project.id, 'GET', undefined, a);
    const restored = new SimulationEngine(loaded.json().topology);
    engine.advanceTo(2000);
    restored.advanceTo(2000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    const timer = engine.snapshot();
    timer.queue = timer.queue.filter(({ action }) => action.kind !== 'ospf-tick');
    const route = engine.snapshot();
    route.devices[0].ospf!.routes[0].metric++;
    for (const topology of [timer, route])
      expect(
        (
          await request(
            '/projects/' + project.id,
            'PUT',
            { name: project.name, revision: saved.json().revision, topology },
            a
          )
        ).statusCode
      ).toBe(400);
  });
  it('salva VPN/SD-WAN durante negociação e rejeita timers ou underlay inconsistentes', async () => {
    const created = await request('/projects', 'POST', { name: 'SD-WAN integration', template: 'sdwan' }, a);
    expect(created.statusCode).toBe(201);
    const project = created.json(),
      engine = new SimulationEngine(project.topology);
    engine.advanceTo(1);
    const saved = await request(
      '/projects/' + project.id,
      'PUT',
      { name: project.name, revision: project.revision, topology: engine.snapshot() },
      a
    );
    expect(saved.statusCode).toBe(200);
    const loaded = await request('/projects/' + project.id, 'GET', undefined, a),
      restored = new SimulationEngine(loaded.json().topology);
    engine.advanceTo(7000);
    restored.advanceTo(7000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    const timer = engine.snapshot();
    timer.queue = timer.queue.filter((q) => q.action.kind !== 'tunnel-tick');
    const port = engine.snapshot();
    port.devices.find((d) => d.hostname === 'WAN-A')!.interfaces.find((p) => p.tunnel)!.tunnel!.underlay =
      'tun1';
    for (const topology of [timer, port])
      expect(
        (
          await request(
            '/projects/' + project.id,
            'PUT',
            { name: project.name, revision: saved.json().revision, topology },
            a
          )
        ).statusCode
      ).toBe(400);
  });
  it('persiste frames nas filas QoS e labels MPLS aguardando ARP', async () => {
    for (const template of ['qos', 'mpls']) {
      const created = await request('/projects', 'POST', { name: template + ' integration', template }, a);
      expect(created.statusCode).toBe(201);
      const project = created.json(),
        engine = new SimulationEngine(project.topology),
        client = engine.state.devices.find((d) => d.type === 'pc')!;
      engine.ping(client.id, '10.2.0.20');
      for (
        let n = 0;
        n < 200 &&
        !engine.state.devices.some(
          (d) => d.pending.some((p) => p.mpls) || d.interfaces.some((p) => p.qos?.queues.length)
        );
        n++
      )
        engine.step();
      const saved = await request(
        '/projects/' + project.id,
        'PUT',
        { name: project.name, revision: project.revision, topology: engine.snapshot() },
        a
      );
      expect(saved.statusCode).toBe(200);
      const loaded = await request('/projects/' + project.id, 'GET', undefined, a),
        restored = new SimulationEngine(loaded.json().topology);
      engine.advanceTo(2000);
      restored.advanceTo(2000);
      expect(restored.snapshot()).toEqual(engine.snapshot());
      expect(restored.state.probes[0].status).toBe('success');
    }
  });
  it('persiste autorização de rede e classificação HTTP em andamento sem aceitar estado forjado', async () => {
    for (const template of ['aaa', 'inspection']) {
      const created = await request('/projects', 'POST', { name: template + ' integration', template }, a);
      expect(created.statusCode).toBe(201);
      const project = created.json(),
        engine = new SimulationEngine(project.topology);
      if (template === 'aaa') {
        const sw = engine.state.devices.find((d) => d.type === 'switch')!;
        engine.loginNetwork(sw.id, 'admin', 'rede-admin');
        engine.advanceTo(1003);
      } else {
        const pc = engine.state.devices[0];
        engine.openTcp(
          pc.id,
          '192.168.20.10',
          80,
          'GET / HTTP/1.1\r\nX-Pad: ' + 'a'.repeat(1000) + '\r\nHost: blocked.lab\r\n\r\n',
          true
        );
        for (
          let n = 0;
          n < 200 &&
          !engine.state.devices.some((d) =>
            d.firewall?.application?.flows.some((f) => f.buffer.length || f.pendingSegments?.length)
          );
          n++
        )
          engine.step();
      }
      const saved = await request(
        '/projects/' + project.id,
        'PUT',
        { name: project.name, revision: project.revision, topology: engine.snapshot() },
        a
      );
      expect(saved.statusCode).toBe(200);
      const loaded = await request('/projects/' + project.id, 'GET', undefined, a),
        restored = new SimulationEngine(loaded.json().topology);
      engine.advanceTo(5000);
      restored.advanceTo(5000);
      expect(restored.snapshot()).toEqual(engine.snapshot());
      const bad = engine.snapshot();
      if (template === 'aaa') {
        bad.devices.find((d) => d.type === 'switch')!.interfaces[0].dot1x!.mac = '00:00:00:00:00:99';
      } else {
        bad.queue = bad.queue.filter((q) => q.action.kind !== 'inspection-expire');
      }
      expect(
        (
          await request(
            '/projects/' + project.id,
            'PUT',
            { name: project.name, revision: saved.json().revision, topology: bad },
            a
          )
        ).statusCode
      ).toBe(400);
    }
  });
  it('persiste VXLAN e EVPN com MAC/IP em troca e recusa RIB adulterada', async () => {
    const created = await request('/projects', 'POST', { name: 'EVPN integration', template: 'evpn' }, a);
    expect(created.statusCode).toBe(201);
    const project = created.json(),
      engine = new SimulationEngine(project.topology),
      client = engine.state.devices.find((d) => d.hostname === 'VM-A')!;
    engine.advanceTo(2000);
    engine.ping(client.id, '10.50.0.20');
    engine.advanceTo(3001);
    const saved = await request(
      '/projects/' + project.id,
      'PUT',
      { name: project.name, revision: project.revision, topology: engine.snapshot() },
      a
    );
    expect(saved.statusCode).toBe(200);
    const loaded = await request('/projects/' + project.id, 'GET', undefined, a),
      restored = new SimulationEngine(loaded.json().topology);
    engine.advanceTo(6000);
    restored.advanceTo(6000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    const bad = engine.snapshot();
    bad.devices
      .find((d) => d.hostname === 'VTEP-A')!
      .interfaces.find((p) => p.vxlan)!.vxlan!.routes[0].routeTarget = '65000:999';
    expect(
      (
        await request(
          '/projects/' + project.id,
          'PUT',
          { name: project.name, revision: saved.json().revision, topology: bad },
          a
        )
      ).statusCode
    ).toBe(400);
  });
  it('persiste automação, NETCONF, telemetria e NTP em trânsito e rejeita timers inválidos', async () => {
    const created = await request(
      '/projects',
      'POST',
      { name: 'Automation integration', template: 'automation' },
      a
    );
    expect(created.statusCode).toBe(201);
    const project = created.json(),
      engine = new SimulationEngine(project.topology),
      client = engine.state.devices[0];
    engine.runAutomation(client.id, {
      name: 'API job',
      username: 'admin',
      password: 'rede-admin',
      key: 'remote-key',
      steps: [
        {
          target: '192.168.10.1',
          protocol: 'netconf',
          operation: 'edit-config',
          datastore: 'candidate',
          patch: { hostname: 'R-API' },
        },
        { target: '192.168.10.1', protocol: 'netconf', operation: 'commit' },
      ],
    });
    engine.advanceTo(3);
    const pending = engine.snapshot(),
      saved = await request(
        '/projects/' + project.id,
        'PUT',
        { name: project.name, revision: project.revision, topology: pending },
        a
      );
    expect(saved.statusCode).toBe(200);
    const loaded = await request('/projects/' + project.id, 'GET', undefined, a),
      restored = new SimulationEngine(loaded.json().topology);
    engine.advanceTo(3000);
    restored.advanceTo(3000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(restored.device(client.id).automationJobs![0].status).toBe('success');
    expect(restored.device(client.id).ntp!.synchronized).toBe(true);
    expect(
      restored.state.devices.find((d) => d.type === 'server')!.telemetryCollector!.received
    ).toBeGreaterThan(0);
    const bad = structuredClone(pending);
    bad.queue = bad.queue.filter((q) => q.action.kind !== 'remote-timeout');
    expect(
      (
        await request(
          '/projects/' + project.id,
          'PUT',
          { name: project.name, revision: saved.json().revision, topology: bad },
          a
        )
      ).statusCode
    ).toBe(400);
  });
  it('persiste SNMP/syslog pendentes e rejeita consultas e registros inconsistentes', async () => {
    const created = await request(
      '/projects',
      'POST',
      { name: 'Management integration', template: 'management' },
      a
    );
    expect(created.statusCode).toBe(201);
    const project = created.json();
    const engine = new SimulationEngine(project.topology);
    const client = engine.state.devices[0];
    const server = engine.state.devices.find((device) => device.type === 'server')!;
    engine.querySnmp(client.id, server.interfaces[0].ip!, 'public', ['1.3.6.1.2.1.1.5.0']);
    engine.sendSyslog(client.id, 'Persistência de gerenciamento', 5);
    const pending = engine.snapshot();
    const saved = await request(
      '/projects/' + project.id,
      'PUT',
      { name: project.name, revision: project.revision, topology: pending },
      a
    );
    expect(saved.statusCode).toBe(200);
    const loaded = await request('/projects/' + project.id, 'GET', undefined, a);
    const restored = new SimulationEngine(loaded.json().topology);
    engine.advanceTo(1000);
    restored.advanceTo(1000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(restored.device(client.id).snmpQueries![0].status).toBe('success');
    expect(
      restored
        .device(server.id)
        .syslogServer!.entries.some((entry) => entry.message.text === 'Persistência de gerenciamento')
    ).toBe(true);
    const noTimer = structuredClone(pending);
    noTimer.queue = noTimer.queue.filter(({ action }) => action.kind !== 'snmp-timeout');
    const wrongPort = structuredClone(pending);
    wrongPort.devices[0].snmpQueries![0].port = 'missing';
    const badLog = engine.snapshot();
    badLog.devices.find((device) => device.id === server.id)!.syslogServer!.entries[0].message.timestamp =
      badLog.clock + 1;
    for (const topology of [noTimer, wrongPort, badLog])
      expect(
        (
          await request(
            '/projects/' + project.id,
            'PUT',
            { name: project.name, revision: saved.json().revision, topology },
            a
          )
        ).statusCode
      ).toBe(400);
    expect((await request('/projects/' + project.id, 'GET', undefined, b)).statusCode).toBe(404);
  });
  it('persiste subinterfaces/SVIs/VRF e rejeita tabelas e parents inválidos', async () => {
    for (const template of ['subinterfaces', 'svi', 'vrf'] as const) {
      const created = await request('/projects', 'POST', { name: 'L3 ' + template, template }, a);
      expect(created.statusCode).toBe(201);
      const project = created.json(),
        engine = new SimulationEngine(project.topology);
      if (template === 'vrf') engine.httpGet(engine.state.devices[0].id, '10.0.0.2', 80, '/', 'BLUE');
      else engine.ping(engine.state.devices.find((d) => d.type === 'pc')!.id, '192.168.20.10');
      engine.step();
      const pending = engine.snapshot();
      const saved = await request(
        '/projects/' + project.id,
        'PUT',
        { name: project.name, revision: project.revision, topology: pending },
        a
      );
      expect(saved.statusCode).toBe(200);
      const loaded = await request('/projects/' + project.id, 'GET', undefined, a),
        restored = new SimulationEngine(loaded.json().topology);
      engine.advanceTo(10000);
      restored.advanceTo(10000);
      expect(restored.snapshot()).toEqual(engine.snapshot());
      const invalid = structuredClone(pending);
      if (template === 'vrf') invalid.devices[0].interfaces[0].vrf = 'MISSING';
      else invalid.devices.flatMap((d) => d.interfaces).find((p) => p.logical)!.logical!.parent = 'MISSING';
      expect(
        (
          await request(
            '/projects/' + project.id,
            'PUT',
            { name: project.name, revision: saved.json().revision, topology: invalid },
            a
          )
        ).statusCode
      ).toBe(400);
    }
  });
  it('persiste associação wireless pendente e rejeita rádio ou timer adulterado', async () => {
    const created = await request('/projects', 'POST', { name: 'Wireless', template: 'wireless' }, a);
    expect(created.statusCode).toBe(201);
    const project = created.json(),
      engine = new SimulationEngine(project.topology);
    engine.advanceTo(1001);
    const saved = await request(
      '/projects/' + project.id,
      'PUT',
      { name: project.name, revision: project.revision, topology: engine.snapshot() },
      a
    );
    expect(saved.statusCode).toBe(200);
    const loaded = await request('/projects/' + project.id, 'GET', undefined, a),
      restored = new SimulationEngine(loaded.json().topology);
    engine.advanceTo(10000);
    restored.advanceTo(10000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(restored.state.devices[1].wireless?.phase).toBe('associated');
    const bad = engine.snapshot();
    bad.queue = bad.queue.filter((q) => q.action.kind !== 'wireless-tick');
    expect(
      (
        await request(
          '/projects/' + project.id,
          'PUT',
          { name: project.name, revision: saved.json().revision, topology: bad },
          a
        )
      ).statusCode
    ).toBe(400);
  });
  it('persiste DAD/SLAAC e NDP IPv6 pendentes e rejeita timers inválidos', async () => {
    const created = await request('/projects', 'POST', { name: 'IPv6', template: 'ipv6' }, a);
    expect(created.statusCode).toBe(201);
    const project = created.json(),
      engine = new SimulationEngine(project.topology);
    engine.advanceTo(1);
    const saved = await request(
      '/projects/' + project.id,
      'PUT',
      { name: project.name, revision: project.revision, topology: engine.snapshot() },
      a
    );
    expect(saved.statusCode).toBe(200);
    const loaded = await request('/projects/' + project.id, 'GET', undefined, a),
      restored = new SimulationEngine(loaded.json().topology);
    engine.advanceTo(10000);
    restored.advanceTo(10000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    const target = engine.state.devices[2].interfaces[0].ipv6!.addresses.find(
      (v) => v.origin === 'slaac'
    )!.ip;
    engine.state.devices[1].neighbors6 = [];
    const id = engine.ping6(engine.state.devices[1].id, target);
    const pending = engine.snapshot();
    expect(pending.devices[1].resolutions6).toHaveLength(1);
    const replay = new SimulationEngine(pending);
    engine.advanceTo(11000);
    replay.advanceTo(11000);
    expect(replay.snapshot()).toEqual(engine.snapshot());
    expect(engine.state.probes6?.find((p) => p.id === id)?.status).toBe('success');
    pending.queue = pending.queue.filter((q) => q.action.kind !== 'ndp-timer');
    expect(
      (
        await request(
          '/projects/' + project.id,
          'PUT',
          { name: project.name, revision: saved.json().revision, topology: pending },
          a
        )
      ).statusCode
    ).toBe(400);
  });
  it('persiste negociação EtherChannel e rejeita timer/membro inconsistentes', async () => {
    const created = await request('/projects', 'POST', { name: 'LACP', template: 'lacp' }, a);
    expect(created.statusCode).toBe(201);
    const project = created.json(),
      engine = new SimulationEngine(project.topology);
    engine.advanceTo(1);
    const pending = engine.snapshot(),
      saved = await request(
        '/projects/' + project.id,
        'PUT',
        { name: project.name, revision: project.revision, topology: pending },
        a
      );
    expect(saved.statusCode).toBe(200);
    const loaded = await request('/projects/' + project.id, 'GET', undefined, a),
      restored = new SimulationEngine(loaded.json().topology);
    engine.advanceTo(35000);
    restored.advanceTo(35000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    const badTimer = structuredClone(pending);
    badTimer.queue = badTimer.queue.filter(({ action }) => action.kind !== 'lacp-tick');
    const badMember = structuredClone(pending);
    badMember.devices[0].interfaces[0].channel = 'missing';
    for (const topology of [badTimer, badMember])
      expect(
        (
          await request(
            '/projects/' + project.id,
            'PUT',
            { name: project.name, revision: saved.json().revision, topology },
            a
          )
        ).statusCode
      ).toBe(400);
  });
  it('persiste TCP/BGP durante negociação e rejeita RIB/timer inconsistentes', async () => {
    const created = await request('/projects', 'POST', { name: 'BGP TCP', template: 'bgp' }, a);
    expect(created.statusCode).toBe(201);
    const project = created.json(),
      engine = new SimulationEngine(project.topology);
    engine.advanceTo(1001);
    const topology = engine.snapshot();
    const saved = await request(
      '/projects/' + project.id,
      'PUT',
      { name: project.name, revision: project.revision, topology },
      a
    );
    expect(saved.statusCode).toBe(200);
    const loaded = await request('/projects/' + project.id, 'GET', undefined, a),
      restored = new SimulationEngine(loaded.json().topology);
    engine.advanceTo(20000);
    restored.advanceTo(20000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    const badRoute = restored.snapshot();
    badRoute.devices[0].bgp!.routes[0].nextHop = '192.0.2.254';
    const badTimer = restored.snapshot();
    badTimer.queue = badTimer.queue.filter((item) => item.action.kind !== 'bgp-tick');
    for (const topology of [badRoute, badTimer])
      expect(
        (
          await request(
            '/projects/' + project.id,
            'PUT',
            { name: project.name, revision: saved.json().revision, topology },
            a
          )
        ).statusCode
      ).toBe(400);
  });
  it('persiste VRRP em eleição e retoma failover; recusa timer e VIP adulterados', async () => {
    const created = await request('/projects', 'POST', { name: 'Gateway VRRP', template: 'vrrp' }, a);
    expect(created.statusCode).toBe(201);
    const project = created.json();
    const engine = new SimulationEngine(project.topology);
    engine.state.devices[2].power = false;
    engine.advanceTo(5500);
    const pending = engine.snapshot();
    const saved = await request(
      '/projects/' + project.id,
      'PUT',
      { name: project.name, revision: project.revision, topology: pending },
      a
    );
    expect(saved.statusCode).toBe(200);
    const loaded = await request('/projects/' + project.id, 'GET', undefined, a);
    const restored = new SimulationEngine(loaded.json().topology);
    engine.advanceTo(10000);
    restored.advanceTo(10000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(restored.state.devices[3].vrrp!.groups.map((group) => group.state)).toEqual(['ACTIVE', 'ACTIVE']);
    const badVip = structuredClone(pending);
    badVip.devices[3].vrrp!.groups[0].vip = '192.168.99.1';
    const badTimer = structuredClone(pending);
    badTimer.queue = badTimer.queue.filter((item) => item.action.kind !== 'vrrp-timer');
    for (const topology of [badVip, badTimer])
      expect(
        (
          await request(
            '/projects/' + project.id,
            'PUT',
            { name: project.name, revision: saved.json().revision, topology },
            a
          )
        ).statusCode
      ).toBe(400);
    expect((await request('/projects/' + project.id, 'GET', undefined, b)).statusCode).toBe(404);
  });
  it('persiste zonas e erro ICMP citado em trânsito e rejeita política/citação adulteradas', async () => {
    const created = await request('/projects', 'POST', { name: 'Zonas ICMP', template: 'firewall-zones' }, a);
    expect(created.statusCode).toBe(201);
    const project = created.json();
    const engine = new SimulationEngine(project.topology);
    engine.ping(engine.state.devices[0].id, '192.168.20.10', 2);
    for (
      let i = 0;
      i < 100 &&
      !engine.state.queue.some(
        ({ action }) =>
          action.kind === 'deliver' && action.frame.packet?.protocol === 'ICMP' && action.frame.packet.error
      );
      i++
    )
      engine.step();
    const pending = engine.snapshot();
    expect(
      pending.queue.some(
        ({ action }) =>
          action.kind === 'deliver' && action.frame.packet?.protocol === 'ICMP' && action.frame.packet.error
      )
    ).toBe(true);
    const saved = await request(
      '/projects/' + project.id,
      'PUT',
      { name: project.name, revision: project.revision, topology: pending },
      a
    );
    expect(saved.statusCode).toBe(200);
    const loaded = await request('/projects/' + project.id, 'GET', undefined, a);
    const restored = new SimulationEngine(loaded.json().topology);
    engine.advanceTo(1000);
    restored.advanceTo(1000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(restored.state.probes[0].status).toBe('time-exceeded');
    const badPolicy = structuredClone(pending);
    badPolicy.devices[1].firewall!.zonePolicy!.rules[0].from = 'MISSING';
    const badQuote = structuredClone(pending);
    for (const { action } of badQuote.queue)
      if (action.kind === 'deliver' && action.frame.packet?.protocol === 'ICMP' && action.frame.packet.error)
        action.frame.packet.error.quote.src = '192.0.2.99';
    for (const topology of [badPolicy, badQuote])
      expect(
        (
          await request(
            '/projects/' + project.id,
            'PUT',
            { name: project.name, revision: saved.json().revision, topology },
            a
          )
        ).statusCode
      ).toBe(400);
  });
  it('persiste sessões UDP/ICMP do firewall e rejeita política e timer inconsistentes', async () => {
    const created = await request('/projects', 'POST', { name: 'Firewall UDP ICMP', template: 'tcp' }, a);
    expect(created.statusCode).toBe(201);
    const project = created.json();
    const engine = new SimulationEngine(project.topology);
    const client = engine.state.devices[0];
    const server = engine.state.devices.find((device) => device.type === 'server')!;
    const router = engine.state.devices.find((device) => device.type === 'router')!;
    engine.configureDnsRecord(server.id, { name: 'state.lab', type: 'A', value: '203.0.113.20', ttl: 0 });
    engine.lookupDns(client.id, 'state.lab', 'A', server.interfaces[0].ip, undefined, 'udp');
    engine.ping(client.id, server.interfaces[0].ip!);
    for (let i = 0; i < 150 && router.firewall!.sessions.length < 2; i++) engine.step();
    expect(router.firewall!.sessions.map((session) => session.protocol).sort()).toEqual(['ICMP', 'UDP']);
    const pending = engine.snapshot();
    const saved = await request(
      '/projects/' + project.id,
      'PUT',
      { name: project.name, revision: project.revision, topology: pending },
      a
    );
    expect(saved.statusCode).toBe(200);
    const loaded = await request('/projects/' + project.id, 'GET', undefined, a);
    const restored = new SimulationEngine(loaded.json().topology);
    engine.advanceTo(1000);
    restored.advanceTo(1000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(
      restored.device(router.id).firewall!.sessions.every((session) => session.state === 'REPLIED')
    ).toBe(true);
    const noTimer = structuredClone(pending);
    noTimer.queue = noTimer.queue.filter(({ action }) => action.kind !== 'firewall-expire');
    const disabledProtocol = structuredClone(pending);
    disabledProtocol.devices.find((device) => device.id === router.id)!.firewall!.protocols = ['TCP'];
    for (const topology of [noTimer, disabledProtocol])
      expect(
        (
          await request(
            '/projects/' + project.id,
            'PUT',
            { name: project.name, revision: saved.json().revision, topology },
            a
          )
        ).statusCode
      ).toBe(400);
  });
  it('persiste TCP/PAT/firewall em andamento e rejeita timers e segmentos adulterados', async () => {
    const created = await request('/projects', 'POST', { name: 'TCP integration', template: 'tcp' }, a);
    expect(created.statusCode).toBe(201);
    const project = created.json();
    const engine = new SimulationEngine(project.topology);
    const client = engine.state.devices[0];
    engine.httpGet(client.id, '192.168.20.10');
    for (let i = 0; i < 100 && !engine.state.devices.some((device) => device.firewall?.sessions.length); i++)
      engine.step();
    const pending = engine.snapshot();
    const saved = await request(
      '/projects/' + project.id,
      'PUT',
      { name: project.name, revision: project.revision, topology: pending },
      a
    );
    expect(saved.statusCode).toBe(200);
    const loaded = await request('/projects/' + project.id, 'GET', undefined, a);
    const restored = new SimulationEngine(loaded.json().topology);
    engine.advanceTo(1000);
    restored.advanceTo(1000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(restored.state.devices[0].tcpConnections![0].received).toContain('200 OK');
    const noRetry = structuredClone(pending);
    noRetry.queue = noRetry.queue.filter(({ action }) => action.kind !== 'tcp-timer');
    const noFirewallTimer = structuredClone(pending);
    noFirewallTimer.queue = noFirewallTimer.queue.filter(({ action }) => action.kind !== 'firewall-expire');
    const badSequence = structuredClone(pending);
    badSequence.devices[0].tcpConnections![0].pending!.packet.sequence++;
    for (const topology of [noRetry, noFirewallTimer, badSequence]) {
      expect(
        (
          await request(
            '/projects/' + project.id,
            'PUT',
            {
              name: project.name,
              revision: saved.json().revision,
              topology,
            },
            a
          )
        ).statusCode
      ).toBe(400);
    }
    expect((await request('/projects/' + project.id, 'GET', undefined, b)).statusCode).toBe(404);
  });
  let id = '',
    revision = 0;
  it('usa cookie HttpOnly/SameSite e requer verificação', async () => {
    const email = 'unverified-' + Date.now() + '@example.test';
    await request('/auth/register', 'POST', { name: 'User', email, password });
    expect((await request('/auth/login', 'POST', { email, password })).statusCode).toBe(403);
    const login = await request('/auth/login', 'POST', { email: a.email, password });
    const cookie = login.headers['set-cookie'] as string;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain(password);
  });
  it('recusa usuário anônimo, origem incorreta e CSRF ausente', async () => {
    expect((await request('/projects')).statusCode).toBe(401);
    expect(
      (await request('/projects', 'POST', { name: 'No' }, a, { origin: 'https://evil.test' })).statusCode
    ).toBe(403);
    expect((await request('/projects', 'POST', { name: 'No' }, a, { 'x-csrf-token': '' })).statusCode).toBe(
      403
    );
  });
  it('cria laboratório e persiste topologia validada', async () => {
    const response = await request('/projects', 'POST', { name: 'Inter-subnet lab', template: 'routed' }, a);
    expect(response.statusCode).toBe(201);
    id = response.json().id;
    revision = response.json().revision;
    const get = await request('/projects/' + id, 'GET', undefined, a);
    expect(get.json().topology.devices).toHaveLength(5);
  });
  it('nega IDOR em leitura, escrita, favoritos, snapshots e exclusão', async () => {
    for (const [url, method, body] of [
      ['/projects/' + id, 'GET', undefined],
      ['/projects/' + id, 'PUT', { name: 'Stolen', revision, topology: makeTemplate('empty') }],
      ['/projects/' + id + '/favorite', 'PATCH', { favorite: true }],
      ['/projects/' + id + '/snapshots', 'GET', undefined],
      ['/projects/' + id + '/snapshots', 'POST', { label: 'Stolen' }],
      ['/projects/' + id, 'DELETE', undefined],
    ] as const)
      expect((await request(url, method, body, b)).statusCode).toBe(404);
    expect((await request('/projects', 'GET', undefined, b)).json()).toEqual([]);
  });
  it('rejeita mass assignment, topologia inválida e conflito otimista', async () => {
    expect((await request('/projects', 'POST', { name: 'X', user_id: 'evil' }, a)).statusCode).toBe(400);
    const malformed = makeTemplate('lan');
    malformed.links[0].b.port = 'missing';
    expect(
      (await request('/projects/' + id, 'PUT', { name: 'X', revision, topology: malformed }, a)).statusCode
    ).toBe(400);
    const saved = await request(
      '/projects/' + id,
      'PUT',
      { name: 'Updated', revision, topology: makeTemplate('lan') },
      a
    );
    expect(saved.statusCode).toBe(200);
    expect(
      (
        await request(
          '/projects/' + id,
          'PUT',
          { name: 'Stale', revision, topology: makeTemplate('empty') },
          a
        )
      ).statusCode
    ).toBe(409);
    revision = saved.json().revision;
  });
  it('snapshot preserva documento e respeita ownership', async () => {
    const saved = await request('/projects/' + id + '/snapshots', 'POST', { label: 'Working LAN' }, a);
    expect(saved.statusCode).toBe(201);
    const version = saved.json().id;
    expect(
      (await request('/projects/' + id + '/snapshots/' + version, 'GET', undefined, a)).json().topology
        .devices
    ).toHaveLength(3);
    expect((await request('/projects/' + id + '/snapshots/' + version, 'GET', undefined, b)).statusCode).toBe(
      404
    );
  });
  it('persiste relay, reserva e ARP em trânsito; rejeita escopos, MACs e timers adulterados', async () => {
    const created = await request('/projects', 'POST', { name: 'DHCP central', template: 'dhcp-relay' }, a);
    expect(created.statusCode).toBe(201);
    const project = created.json(),
      engine = new SimulationEngine(project.topology);
    while (!engine.state.devices.some((device) => device.arpResolutions?.length))
      expect(engine.step()).toBe(true);
    const topology = engine.snapshot();
    const saved = await request(
      '/projects/' + project.id,
      'PUT',
      { name: project.name, revision: project.revision, topology },
      a
    );
    expect(saved.statusCode).toBe(200);
    const loaded = await request('/projects/' + project.id, 'GET', undefined, a),
      restored = new SimulationEngine(loaded.json().topology);
    expect(restored.snapshot()).toEqual(topology);
    engine.advanceTo(500);
    restored.advanceTo(500);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(restored.state.devices[0].interfaces[0].ip).toBe('192.168.10.60');
    expect((await request('/projects/' + project.id, 'GET', undefined, b)).statusCode).toBe(404);
    const badRelay = structuredClone(topology);
    badRelay.devices[0].interfaces[0].dhcpRelay = ['192.168.20.10'];
    const badScope = structuredClone(topology);
    badScope.devices.find((device) => device.dhcpServer)!.dhcpServer!.pools[0].relayAddress = '192.168.99.1';
    const badReservation = structuredClone(topology);
    const reservations = badReservation.devices.find((device) => device.dhcpServer)!.dhcpServer!.pools[0]
      .reservations!;
    reservations.push({ ...reservations[0] });
    const badTimer = structuredClone(topology);
    badTimer.queue = badTimer.queue.filter(({ action }) => action.kind !== 'arp-timeout');
    const badSource = structuredClone(topology);
    badSource.devices.find((device) => device.arpResolutions?.length)!.arpResolutions![0].sourceIp =
      '192.168.20.77';
    for (const invalid of [badRelay, badScope, badReservation, badTimer, badSource])
      expect(
        (
          await request(
            '/projects/' + project.id,
            'PUT',
            {
              name: project.name,
              revision: saved.json().revision,
              topology: invalid,
            },
            a
          )
        ).statusCode
      ).toBe(400);
    expect((await request('/projects/' + project.id, 'GET', undefined, a)).json().revision).toBe(
      saved.json().revision
    );
  });
  it('persiste leases DHCP e recusa adulteração de pools, leases e timers', async () => {
    const contract = (await request('/openapi.json')).json();
    expect(
      contract.paths['/api/projects'].post.requestBody.content['application/json'].schema.properties.template
        .enum
    ).toEqual(templates.map((template) => template.id));
    const created = await request('/projects', 'POST', { name: 'DHCP integration', template: 'dhcp' }, a);
    expect(created.statusCode).toBe(201);
    const project = created.json();
    const engine = new SimulationEngine(project.topology);
    for (const client of engine.state.devices.filter((device) => device.type === 'pc'))
      engine.requestDhcp(client.id, client.interfaces[0].id);
    engine.advanceTo(100);
    const saved = await request(
      '/projects/' + project.id,
      'PUT',
      {
        name: project.name,
        revision: project.revision,
        topology: engine.snapshot(),
      },
      a
    );
    expect(saved.statusCode).toBe(200);
    const loaded = await request('/projects/' + project.id, 'GET', undefined, a);
    const restored = new SimulationEngine(loaded.json().topology);
    expect(restored.state.devices[0].interfaces[0].dhcp?.status).toBe('bound');
    expect((await request('/projects/' + project.id, 'GET', undefined, b)).statusCode).toBe(404);
    const renewAt = engine.state.devices[0].interfaces[0].dhcp!.lease!.renewAt;
    engine.advanceTo(renewAt + 100);
    restored.advanceTo(renewAt + 100);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    const badPool = engine.snapshot();
    badPool.devices.find((device) => device.dhcpServer)!.dhcpServer!.pools[0].start = '10.0.0.10';
    const badLease = engine.snapshot();
    badLease.devices[0].interfaces[0].ip = '192.168.50.99';
    const badTimers = engine.snapshot();
    badTimers.queue = badTimers.queue.filter(
      ({ action }) => action.kind !== 'dhcp-client-timer' || action.timer !== 'expire'
    );
    for (const topology of [badPool, badLease, badTimers]) {
      expect(
        (
          await request(
            '/projects/' + project.id,
            'PUT',
            {
              name: project.name,
              revision: saved.json().revision,
              topology,
            },
            a
          )
        ).statusCode
      ).toBe(400);
    }
    expect((await request('/projects/' + project.id, 'GET', undefined, a)).json().revision).toBe(
      saved.json().revision
    );
  });
  it('persiste consultas e cache DNS e rejeita registros e timers adulterados', async () => {
    const created = await request('/projects', 'POST', { name: 'DNS integration', template: 'dns' }, a);
    expect(created.statusCode).toBe(201);
    const project = created.json();
    const engine = new SimulationEngine(project.topology);
    engine.lookupDns(engine.state.devices[0].id, 'web.lab');
    const pending = engine.snapshot();
    const saved = await request(
      '/projects/' + project.id,
      'PUT',
      { name: project.name, revision: project.revision, topology: pending },
      a
    );
    expect(saved.statusCode).toBe(200);
    const loaded = await request('/projects/' + project.id, 'GET', undefined, a);
    const restored = new SimulationEngine(loaded.json().topology);
    engine.advanceTo(300);
    restored.advanceTo(300);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(restored.state.devices[0].dnsQueries?.at(-1)?.status).toBe('success');
    expect(restored.state.devices[0].dnsCache).toHaveLength(1);
    const cacheSave = await request(
      '/projects/' + project.id,
      'PUT',
      {
        name: project.name,
        revision: saved.json().revision,
        topology: restored.snapshot(),
      },
      a
    );
    expect(cacheSave.statusCode).toBe(200);
    const badTimer = structuredClone(pending);
    badTimer.queue = badTimer.queue.filter(({ action }) => action.kind !== 'dns-timeout');
    const badCache = restored.snapshot();
    badCache.devices[0].dnsCache![0].expiresAt++;
    const badRecords = restored.snapshot();
    badRecords.devices
      .find((device) => device.dnsServer)!
      .dnsServer!.records.push({
        name: 'server.lab',
        type: 'CNAME',
        value: 'unrelated.lab',
        ttl: 60,
      });
    for (const topology of [badTimer, badCache, badRecords])
      expect(
        (
          await request(
            '/projects/' + project.id,
            'PUT',
            {
              name: project.name,
              revision: cacheSave.json().revision,
              topology,
            },
            a
          )
        ).statusCode
      ).toBe(400);
    expect((await request('/projects/' + project.id, 'GET', undefined, b)).statusCode).toBe(404);
  });
  it('persiste árvore RSTP e rejeita portas bloqueadas adulteradas', async () => {
    const created = await request('/projects', 'POST', { name: 'RSTP integration', template: 'rstp' }, a);
    expect(created.statusCode).toBe(201);
    const project = created.json();
    const engine = new SimulationEngine(project.topology);
    const access = engine.state.devices.find((device) => device.hostname === 'SW-03')!;
    engine.setPort(access.id, 'p1', false);
    engine.advanceTo(200);
    const saved = await request(
      '/projects/' + project.id,
      'PUT',
      { name: project.name, revision: project.revision, topology: engine.snapshot() },
      a
    );
    expect(saved.statusCode).toBe(200);
    const restored = new SimulationEngine(
      (await request('/projects/' + project.id, 'GET', undefined, a)).json().topology
    );
    engine.advanceTo(5000);
    restored.advanceTo(5000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(restored.device(access.id).spanningTree?.rootPort).toBe('p2');
    const bad = makeTemplate('rstp');
    const alternate = bad.devices
      .flatMap((device) => device.interfaces)
      .find((port) => port.spanningTree?.role === 'alternate')!;
    alternate.spanningTree!.state = 'forwarding';
    expect(
      (
        await request(
          '/projects/' + project.id,
          'PUT',
          { name: project.name, revision: saved.json().revision, topology: bad },
          a
        )
      ).statusCode
    ).toBe(400);
    expect((await request('/projects/' + project.id, 'GET', undefined, b)).statusCode).toBe(404);
  });
  it('edita o próprio perfil e revoga sessões sem expor tokens ou permitir IDOR', async () => {
    expect(
      (await request('/auth/profile', 'PATCH', { name: 'Updated User', user_id: 'other' }, a)).statusCode
    ).toBe(400);
    expect((await request('/auth/profile', 'PATCH', { name: 'Updated User' }, a)).json().name).toBe(
      'Updated User'
    );
    const sessions = (await request('/auth/sessions', 'GET', undefined, a)).json();
    expect(sessions.length).toBeGreaterThan(1);
    expect(sessions.every((session: Record<string, unknown>) => !('token_hash' in session))).toBe(true);
    const other = sessions.find((session: { is_current: boolean }) => !session.is_current);
    expect((await request('/auth/sessions/' + other.id, 'DELETE', undefined, b)).statusCode).toBe(404);
    expect((await request('/auth/sessions/' + other.id, 'DELETE', undefined, a)).statusCode).toBe(200);
    expect((await request('/auth/sessions/revoke-others', 'POST', undefined, a)).statusCode).toBe(200);
    expect((await request('/auth/sessions', 'GET', undefined, a)).json()).toHaveLength(1);
    expect((await request('/auth/me', 'GET', undefined, a)).statusCode).toBe(200);
  });
  it('exclui somente a própria conta com senha e remove os dados associados', async () => {
    const owner = await signup('delete-' + Date.now() + '@example.test');
    const created = (await request('/projects', 'POST', { name: 'Deletion test' }, owner)).json();
    expect((await request('/auth/account', 'DELETE', { password: 'incorrect' }, owner)).statusCode).toBe(400);
    expect((await request('/auth/account', 'DELETE', { password }, owner)).statusCode).toBe(200);
    expect((await request('/auth/me', 'GET', undefined, owner)).statusCode).toBe(401);
    expect(await db.query('SELECT id FROM projects WHERE id=$1', [created.id])).toHaveLength(0);
    await migrate(db);
    expect((await db.query('SELECT version FROM schema_migrations')).length).toBeGreaterThanOrEqual(2);
  });
  it('salva objetivos, avalia tráfego novo, preserva melhor pontuação e reinicia o estado inicial', async () => {
    const project = (
        await request('/projects', 'POST', { name: 'Custom challenge', template: 'lan' }, a)
      ).json(),
      url = '/projects/' + project.id;
    const [source, target] = project.topology.devices.filter((d: { type: string }) => d.type === 'pc');
    const definition = {
      schemaVersion: 1,
      name: 'Repare a LAN',
      description: 'Mantenha a conectividade.',
      objectives: [
        { id: 'pcs', label: 'Dois PCs', weight: 1, predicate: { kind: 'devices', type: 'pc', minimum: 2 } },
        {
          id: 'ping',
          label: 'Ping novo',
          weight: 3,
          predicate: { kind: 'ping', device: source.id, target: target.interfaces[0].ip },
        },
      ],
    };
    expect(
      (
        await request(
          url + '/challenge',
          'PUT',
          { revision: 0, projectRevision: project.revision, definition },
          b
        )
      ).statusCode
    ).toBe(404);
    const saved = await request(
      url + '/challenge',
      'PUT',
      { revision: 0, projectRevision: project.revision, definition },
      a
    );
    expect(saved.statusCode).toBe(200);
    const challenge = saved.json().challenge;
    expect(
      (await request(url + '/challenge/evaluate', 'POST', { revision: challenge.revision, score: 100 }, a))
        .statusCode
    ).toBe(400);
    const success = (
      await request(url + '/challenge/evaluate', 'POST', { revision: challenge.revision }, a)
    ).json();
    expect(success.result.score).toBe(100);
    const score = (await request('/learning/score', 'GET', undefined, a)).json();
    expect(score.sources.challenges).toBeGreaterThanOrEqual(100);
    project.topology.links[0].up = false;
    const broken = (
      await request(
        url,
        'PUT',
        { name: project.name, revision: project.revision, topology: project.topology },
        a
      )
    ).json();
    const failure = (
      await request(url + '/challenge/evaluate', 'POST', { revision: challenge.revision }, a)
    ).json();
    expect(failure.result.score).toBe(25);
    expect(failure.best_score).toBe(100);
    expect(
      (
        await request(
          url + '/challenge/reset',
          'POST',
          { revision: challenge.revision, projectRevision: project.revision },
          a
        )
      ).statusCode
    ).toBe(409);
    const reset = await request(
      url + '/challenge/reset',
      'POST',
      { revision: challenge.revision, projectRevision: broken.revision },
      a
    );
    expect(reset.statusCode).toBe(200);
    expect(reset.json().topology.links[0].up).toBe(true);
    expect(
      (
        await request(
          url + '/challenge',
          'PUT',
          { revision: challenge.revision, projectRevision: reset.json().revision, definition },
          a
        )
      ).statusCode
    ).toBe(200);
    expect((await request(url + '/challenge', 'GET', undefined, a)).json().progress).toBeNull();
    expect((await request('/learning/score', 'GET', undefined, a)).json().sources.challenges).toBe(
      score.sources.challenges - 100
    );
  });
  it('tutorial só avança em sequência, refaz evidência e agrega pontos sem duplicar tentativas', async () => {
    const project = (
        await request('/projects', 'POST', { name: 'Tutorial test', template: 'lan' }, a)
      ).json(),
      url = '/projects/' + project.id;
    expect((await request(url + '/tutorial', 'GET', undefined, b)).statusCode).toBe(404);
    expect((await request(url + '/tutorial/check', 'POST', { step: 4 }, a)).statusCode).toBe(409);
    for (let step = 0; step < 4; step++) {
      const result = await request(url + '/tutorial/check', 'POST', { step }, a);
      expect(result.statusCode).toBe(200);
      expect(result.json().step).toBe(step + 1);
    }
    const pending = await request(url + '/tutorial/check', 'POST', { step: 4 }, a);
    expect(pending.json().complete).toBe(false);
    expect(pending.json().step).toBe(4);
    const e = new SimulationEngine(project.topology),
      host = e.state.devices.filter((d) => d.type === 'pc')[1];
    e.configureTcpService(host.id, { port: 7, kind: 'echo', enabled: true });
    expect(
      (
        await request(
          url,
          'PUT',
          { name: project.name, revision: project.revision, topology: e.snapshot() },
          a
        )
      ).statusCode
    ).toBe(200);
    const complete = await request(url + '/tutorial/check', 'POST', { step: 4 }, a);
    expect(complete.json().complete).toBe(true);
    const score = (await request('/learning/score', 'GET', undefined, a)).json();
    expect(score.sources.tutorials).toBe(100);
    expect((await request(url + '/tutorial/check', 'POST', { step: 4 }, a)).statusCode).toBe(409);
    expect((await request('/learning/score', 'GET', undefined, a)).json()).toEqual(score);
  });
  it('avalia tarefas do lab no backend, persiste progresso e rejeita resultados enviados pelo cliente', async () => {
    const contract = (await request('/openapi.json')).json();
    expect(contract.paths['/api/auth/account'].delete).toBeDefined();
    expect(contract.paths['/api/projects/{id}/evaluate'].post).toBeDefined();
    const created = await request(
      '/projects',
      'POST',
      { name: 'Guided test', mode: 'guided', labId: 'lan-foundations' },
      a
    );
    expect(created.statusCode).toBe(201);
    const project = created.json();
    const url = '/projects/' + project.id;
    expect((await request(url + '/evaluate', 'POST', undefined, b)).statusCode).toBe(404);
    expect((await request(url + '/evaluate', 'POST', { passed: 4 }, a)).statusCode).toBe(400);
    const empty = await request(url + '/evaluate', 'POST', undefined, a);
    expect(empty.statusCode).toBe(200);
    expect(empty.json().result.complete).toBe(false);
    const saved = await request(
      url,
      'PUT',
      { name: project.name, revision: project.revision, topology: makeTemplate('lan') },
      a
    );
    expect(saved.statusCode).toBe(200);
    const result = await request(url + '/evaluate', 'POST', undefined, a);
    expect(result.json().result.complete).toBe(true);
    expect(result.json().revision).toBe(saved.json().revision);
    expect((await request(url + '/progress', 'GET', undefined, a)).json().completed).toBe(true);
    expect((await request(url + '/progress', 'GET', undefined, b)).statusCode).toBe(404);
  });
  it('avalia desafios avançados e persiste perfis e interfaces QSFP', async () => {
    for (const [labId, template] of [
      ['aaa-repair', 'aaa'],
      ['evpn-repair', 'evpn'],
      ['automation-repair', 'automation'],
    ] as const) {
      const created = await request(
        '/projects',
        'POST',
        { name: 'Advanced ' + labId, mode: 'guided', labId },
        a
      );
      expect(created.statusCode).toBe(201);
      const p = created.json(),
        url = '/projects/' + p.id;
      expect((await request(url + '/evaluate', 'POST', undefined, a)).json().result.complete).toBe(false);
      const e = new SimulationEngine(makeTemplate(template));
      e.addProfile('core');
      e.addProfile('ntp');
      const save = await request(
        url,
        'PUT',
        { name: p.name, revision: p.revision, topology: e.snapshot() },
        a
      );
      expect(save.statusCode).toBe(200);
      const result = await request(url + '/evaluate', 'POST', undefined, a);
      expect(result.statusCode).toBe(200);
      expect(result.json().result.complete).toBe(true);
      const topology = (await request(url, 'GET', undefined, a)).json().topology;
      expect(
        topology.devices.find((d: { profile?: string }) => d.profile === 'core').interfaces[0].media
      ).toBe('qsfp');
    }
  });
  it('payload oversized e JSON inválido são recusados', async () => {
    expect(
      (await request('/projects', 'POST', { name: 'x'.repeat(16 * 1024 * 1024 + 10) }, a)).statusCode
    ).toBe(413);
    expect(
      (
        await app.inject({
          url: '/api/projects',
          method: 'POST',
          headers: { origin, cookie: a.cookie, 'x-csrf-token': a.csrf, 'content-type': 'application/json' },
          payload: '{invalid',
        })
      ).statusCode
    ).toBe(400);
  });
  it('tokens são únicos, hashados e de uso único; reset revoga sessões', async () => {
    const res = await request('/auth/forgot-password', 'POST', { email: b.email });
    expect(res.statusCode).toBe(200);
    const value = mailToken(b.email);
    const tokens = await db.query<{ token_hash: string }>('SELECT token_hash FROM auth_tokens');
    expect(tokens.some((t) => t.token_hash === value)).toBe(false);
    expect(
      (await request('/auth/reset-password', 'POST', { token: value, password: 'A-new-password-123!' }))
        .statusCode
    ).toBe(200);
    expect((await request('/auth/me', 'GET', undefined, b)).statusCode).toBe(401);
    expect((await request('/auth/reset-password', 'POST', { token: value, password })).statusCode).toBe(400);
  });
  it('alterar senha exige a atual e revoga a sessão', async () => {
    expect(
      (
        await request(
          '/auth/change-password',
          'POST',
          { currentPassword: 'wrong', password: 'Another-password-123' },
          a
        )
      ).statusCode
    ).toBe(400);
    expect(
      (
        await request(
          '/auth/change-password',
          'POST',
          { currentPassword: password, password: 'Another-password-123' },
          a
        )
      ).statusCode
    ).toBe(200);
    expect((await request('/auth/me', 'GET', undefined, a)).statusCode).toBe(401);
  });
  it('rate limit responde 429 e mantém headers de segurança', async () => {
    let status = 0;
    for (let n = 0; n < 10; n++)
      status = (await request('/auth/login', 'POST', { email: 'absent@example.test', password: 'wrong' }))
        .statusCode;
    expect(status).toBe(429);
    const health = await request('/health');
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(health.headers['x-request-id']).toBeTruthy();
  });
});

describe('histórico privado de atividades', () => {
  it('registra ações atomicamente, pagina, mantém exclusão e protege ownership/CSRF', async () => {
    const owner = await signup('history-' + Date.now() + '@example.test', '127.0.0.2');
    const foreign = await signup('history-other-' + Date.now() + '@example.test', '127.0.0.3');
    const created = await request('/projects', 'POST', { name: 'Histórico LAN', template: 'lan' }, owner);
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect((await request('/projects/' + project.id + '/visits', 'POST', {}, foreign)).statusCode).toBe(404);
    expect(
      (await request('/projects/' + project.id + '/visits', 'POST', {}, owner, { 'x-csrf-token': 'bad' }))
        .statusCode
    ).toBe(403);
    expect((await request('/projects/' + project.id + '/visits', 'POST', {}, owner)).statusCode).toBe(200);
    expect(
      (await request('/projects/' + project.id + '/favorite', 'PATCH', { favorite: true }, owner)).statusCode
    ).toBe(200);
    const saved = await request(
      '/projects/' + project.id,
      'PUT',
      { name: project.name, revision: project.revision, topology: project.topology },
      owner
    );
    expect(saved.statusCode).toBe(200);
    expect(
      (
        await request(
          '/projects/' + project.id,
          'PUT',
          { name: project.name, revision: project.revision, topology: project.topology },
          owner
        )
      ).statusCode
    ).toBe(409);
    const first = (await request('/activity?limit=2', 'GET', undefined, owner)).json();
    expect(first.entries.map((entry: { action: string }) => entry.action)).toEqual(['updated', 'favorited']);
    const second = (await request('/activity?limit=2&before=' + first.next, 'GET', undefined, owner)).json();
    expect(second.entries.map((entry: { action: string }) => entry.action)).toEqual(['opened', 'created']);
    expect(second.next).toBeNull();
    expect(
      (await request('/activity', 'GET', undefined, foreign))
        .json()
        .entries.some((entry: { name: string }) => entry.name === project.name)
    ).toBe(false);
    expect((await request('/activity?before=9999999999999999999', 'GET', undefined, owner)).statusCode).toBe(
      400
    );
    expect((await request('/projects/' + project.id, 'DELETE', undefined, owner)).statusCode).toBe(200);
    const deleted = (await request('/activity', 'GET', undefined, owner)).json();
    expect(deleted.entries[0].action).toBe('deleted');
    expect(deleted.entries.every((entry: { project_id: unknown }) => entry.project_id === null)).toBe(true);
  });
});
