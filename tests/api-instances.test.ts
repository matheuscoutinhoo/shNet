import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { buildApp } from '../apps/api/src/app';
import { createEmbedded, createPostgres, migrate, type Database } from '../apps/api/src/db';
import type { FastifyInstance } from 'fastify';
import type { Mail } from '../apps/api/src/mailer';
let db: Database, a: FastifyInstance, b: FastifyInstance, base: string;
const origin = 'http://instances.example.test',
  mails: Mail[] = [],
  prefix = 'instances-' + Date.now();
beforeAll(async () => {
  db = process.env.TEST_DATABASE_URL ? createPostgres(process.env.TEST_DATABASE_URL) : await createEmbedded();
  await migrate(db);
  a = await buildApp({
    db,
    origin,
    mailer: async (m) => {
      mails.push(m);
    },
    rateLimit: 2000,
  });
  b = await buildApp({
    db,
    origin,
    mailer: async (m) => {
      mails.push(m);
    },
    rateLimit: 2000,
  });
  for (const app of [a, b])
    app.get('/api/shared-budget', { config: { rateLimit: { max: 2, timeWindow: 60000 } } }, async () => ({
      ok: true,
    }));
  await a.ready();
  base = await b.listen({ host: '127.0.0.1', port: 0 });
}, 20000);
afterAll(async () => {
  await a?.close();
  await b?.close();
  if (db) {
    await db.query('DELETE FROM users WHERE email LIKE $1', [prefix + '%']);
    await db.close();
  }
});
async function signup(app: FastifyInstance, suffix: string, peer: string) {
  const email = prefix + suffix + '@example.test',
    password = 'Instances-Network-123!';
  const req = (url: string, payload: unknown) =>
    app.inject({
      url: '/api/auth/' + url,
      method: 'POST',
      payload: payload as Record<string, unknown>,
      remoteAddress: peer,
      headers: { origin },
    });
  expect((await req('register', { name: 'Instances', email, password })).statusCode).toBe(202);
  const token = mails.find((m) => m.to === email)!.text.match(/#token=([\w-]+)/)![1];
  expect((await req('verify-email', { token })).statusCode).toBe(200);
  const login = await req('login', { email, password });
  expect(login.statusCode).toBe(200);
  return {
    cookie: String(login.headers['set-cookie']).split(';')[0],
    csrf: login.json().csrfToken,
    email,
    password,
  };
}
describe('Coordenação entre instâncias', () => {
  it('isola donos atrás de NAT sem permitir novos orçamentos por sessão ou cookie inválido', async () => {
    const owner = await signup(a, 'budget-owner', '203.0.113.191');
    const other = await signup(b, 'budget-other', '203.0.113.192');
    const query = (app: FastifyInstance, cookie: string) =>
      app.inject({ url: '/api/shared-budget', remoteAddress: '203.0.113.193', headers: { cookie } });
    expect((await query(a, owner.cookie)).statusCode).toBe(200);
    expect((await query(b, owner.cookie)).statusCode).toBe(200);
    expect((await query(a, owner.cookie)).statusCode).toBe(429);
    expect((await query(b, other.cookie)).statusCode).toBe(200);
    const second = await b.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '203.0.113.191',
      headers: { origin },
      payload: { email: owner.email, password: owner.password },
    });
    expect(second.statusCode).toBe(200);
    expect((await query(b, String(second.headers['set-cookie']).split(';')[0])).statusCode).toBe(429);
    for (const [i, status] of [200, 200, 429].entries())
      expect((await query(i % 2 ? a : b, 'shlab_session=invalid-' + i)).statusCode).toBe(status);
  });
  it('mantém o limite de login por IP mesmo alternando sessões válidas', async () => {
    const owner = await signup(a, 'login-budget-owner', '203.0.113.197');
    const other = await signup(b, 'login-budget-other', '203.0.113.198');
    for (let i = 0; i < 9; i++) {
      const app = i % 2 ? a : b;
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '203.0.113.199',
        headers: { origin, cookie: i % 2 ? owner.cookie : other.cookie },
        payload: { email: owner.email, password: 'Incorrect-password-123!' },
      });
      expect(response.statusCode).toBe(i < 8 ? 401 : 429);
    }
  });
  it('compartilha o orçamento por rota/IP e mantém outro IP independente', async () => {
    const query = (app: FastifyInstance, peer = '203.0.113.187') =>
      app.inject({ url: '/api/shared-budget', remoteAddress: peer });
    expect((await query(a)).statusCode).toBe(200);
    expect((await query(b)).statusCode).toBe(200);
    expect((await query(a)).statusCode).toBe(429);
    expect((await query(b, '203.0.113.188')).statusCode).toBe(200);
  });
  it('propaga alterações pelo PostgreSQL para outro processo lógico e preserva privacidade', async () => {
    const owner = await signup(a, 'owner', '203.0.113.189'),
      foreign = await signup(b, 'foreign', '203.0.113.190');
    const socket = new WebSocket(base.replace(/^http/, 'ws') + '/api/events', {
        headers: { origin, cookie: owner.cookie },
      }),
      other = new WebSocket(base.replace(/^http/, 'ws') + '/api/events', {
        headers: { origin, cookie: foreign.cookie },
      }),
      messages: unknown[] = [];
    other.on('message', (data) => messages.push(JSON.parse(String(data))));
    try {
      await Promise.all([once(socket, 'open'), once(other, 'open')]);
      const received = once(socket, 'message');
      const created = await a.inject({
        url: '/api/projects',
        method: 'POST',
        remoteAddress: '203.0.113.189',
        headers: { origin, cookie: owner.cookie, 'x-csrf-token': owner.csrf },
        payload: { name: 'Across instances', template: 'empty' },
      });
      expect(created.statusCode).toBe(201);
      const [data] = await received;
      expect(JSON.parse(String(data))).toEqual({ type: 'project.created', id: created.json().id });
      expect(messages).toEqual([]);
    } finally {
      socket.terminate();
      other.terminate();
    }
  }, 10000);
});
