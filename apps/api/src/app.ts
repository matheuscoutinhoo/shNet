import Fastify from 'fastify';
import { sharedRateLimitStore } from './shared-rate-limit';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { Database } from './db';
import type { Mailer } from './mailer';
import { registerAuth } from './auth';
import { registerProjects } from './projects';
import { registerActivity } from './activity';
import { registerLearning } from './learning';
import { checkOrigin, currentUser, error } from './security';
import { openapi } from './openapi';
import { registerObservability } from './observability';
interface Options {
  db: Database;
  mailer: Mailer;
  origin: string;
  production?: boolean;
  logger?: boolean;
  rateLimit?: number;
  trustedProxies?: string[];
  metricsToken?: string;
  backupFile?: string;
}
export async function buildApp(options: Options) {
  const { db, mailer, origin, production = false } = options;
  const app = Fastify({
    bodyLimit: 16 * 1024 * 1024,
    logger: options.logger
      ? {
          redact: [
            'req.headers.cookie',
            'req.headers.authorization',
            'req.headers.x-csrf-token',
            'res.headers.set-cookie',
          ],
          serializers: { req: (r) => ({ method: r.method, url: r.url.split('?')[0], remoteAddress: r.ip }) },
        }
      : false,
    genReqId: () => randomUUID(),
    trustProxy: options.trustedProxies?.length ? options.trustedProxies : false,
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
      },
    },
    hsts: production ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  await app.register(rateLimit, {
    max: options.rateLimit ?? 300,
    timeWindow: '1 minute',
    store: sharedRateLimitStore(db),
    skipOnError: false,
  });
  await app.register(websocket);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) checkOrigin(req, origin);
  });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send({
        message: 'Dados inválidos',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    const status =
      typeof err === 'object' && err !== null && 'statusCode' in err ? Number(err.statusCode) : 500;
    if (status >= 500) req.log.error({ err, event: 'request.failed' }, 'Falha na requisição');
    reply.code(status >= 400 && status <= 599 ? status : 500).send({
      message: status < 500 && err instanceof Error ? err.message : 'Erro interno. Tente novamente.',
      requestId: req.id,
    });
  });
  const clients = new Map<WebSocket, { userId: string; check: () => Promise<boolean> }>();
  const deliver = (userId: string, data: unknown) => {
    for (const [socket, client] of clients)
      if (client.userId === userId)
        void client
          .check()
          .then((ok) => {
            if (ok && socket.readyState === 1) socket.send(JSON.stringify(data));
            else socket.close();
          })
          .catch(() => socket.close());
  };
  let notificationReady = true;
  const unsubscribe = await db.subscribe?.(
    'shlab_events',
    (payload) => {
      try {
        const message = JSON.parse(payload);
        if (typeof message.userId === 'string' && message.data && typeof message.data.type === 'string')
          deliver(message.userId, message.data);
      } catch {
        app.log.warn({ event: 'notification.invalid' }, 'Notificação inválida.');
      }
    },
    (connected) => {
      notificationReady = connected;
      if (!connected) {
        app.log.error({ event: 'notification.disconnected' }, 'Canal PostgreSQL indisponível.');
        for (const socket of clients.keys()) socket.close(1012, 'Reconectando notificações');
      }
    }
  );
  const notify = async (userId: string, data: unknown) => {
    if (!db.subscribe) {
      deliver(userId, data);
      return;
    }
    const payload = JSON.stringify({ userId, data });
    if (Buffer.byteLength(payload) > 7900) throw new Error('Notificação excede limite.');
    await db.query('SELECT pg_notify($1,$2)', ['shlab_events', payload]);
  };
  app.get(
    '/api/events',
    {
      websocket: true,
      preValidation: async (req) => {
        checkOrigin(req, origin);
        if (!(await currentUser(db, req))) throw error(401, 'Sessão expirada');
      },
    },
    async (socket, req) => {
      const user = await currentUser(db, req);
      if (!user) {
        socket.close();
        return;
      }
      clients.set(socket, { userId: user.id, check: async () => !!(await currentUser(db, req)) });
      socket.on('close', () => clients.delete(socket));
      socket.on('error', () => clients.delete(socket));
      socket.on('message', () => socket.close(1008, 'Canal apenas de notificações'));
    }
  );
  const timer = setInterval(() => {
    for (const [socket, c] of clients)
      void c
        .check()
        .then((ok) => {
          if (!ok) socket.close();
        })
        .catch(() => socket.close());
  }, 30000);
  timer.unref();
  const cleanup = setInterval(() => {
    void db
      .query(
        'DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires_at<clock_timestamp() ORDER BY expires_at LIMIT 1000)'
      )
      .catch((error) =>
        app.log.error({ err: error, event: 'rate_limit.cleanup_failed' }, 'Falha na limpeza de limites.')
      );
  }, 60000);
  cleanup.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    clearInterval(cleanup);
    await unsubscribe?.();
    for (const socket of clients.keys()) socket.close();
  });
  registerObservability(app, db, {
    metricsToken: options.metricsToken,
    backupFile: options.backupFile,
    notificationReady: () => notificationReady,
  });
  app.get('/api/openapi.json', async () => openapi);
  await registerAuth(app, { db, mailer, origin, production });
  await registerProjects(app, db, notify);
  await registerActivity(app, db);
  await registerLearning(app, db, notify);
  return app;
}
