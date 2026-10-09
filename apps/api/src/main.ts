import { existsSync } from 'node:fs';
import staticFiles from '@fastify/static';
import { createEmbedded, createPostgres, migrate } from './db';
import { createMailer } from './mailer';
import { buildApp } from './app';
import { runtimeConfig, runtimePaths } from './config';
const { production, embedded, origin, host, port, trustedProxies } = runtimeConfig(process.env);
if (production && !existsSync(runtimePaths.web))
  throw new Error('Frontend de produção ausente. Execute npm run build.');
const db = embedded ? await createEmbedded(runtimePaths.embedded) : createPostgres(process.env.DATABASE_URL!);
if (embedded) await migrate(db);
const app = await buildApp({
  db,
  mailer: createMailer(),
  origin,
  production,
  trustedProxies,
  logger: true,
  metricsToken: process.env.METRICS_TOKEN,
  backupFile: process.env.BACKUP_STATUS_FILE,
});
const web = runtimePaths.web;
if (existsSync(web)) {
  await app.register(staticFiles, { root: web });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/')
      ? reply.code(404).send({ message: 'Rota não encontrada' })
      : reply.sendFile('index.html')
  );
}
const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
await app.listen({ host, port });
