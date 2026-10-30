// Audit-only API with a fresh in-memory database. Never opens the user's .data/postgres.
import { createServer } from 'vite';
import { createEmbedded, migrate } from '../../apps/api/src/db';
import { buildApp } from '../../apps/api/src/app';
import { createMailer } from '../../apps/api/src/mailer';

const db = await createEmbedded();
await migrate(db);
const api = await buildApp({
  db,
  mailer: createMailer({ MAIL_PROVIDER: 'local' }),
  origin: 'http://127.0.0.1:5194',
});
await api.listen({ host: '127.0.0.1', port: 3094 });
const web = await createServer({
  root: 'apps/web',
  configFile: 'apps/web/vite.config.ts',
  server: { host: '127.0.0.1', port: 5194, strictPort: true },
});
await web.listen();
const close = async () => {
  await web.close();
  await api.close();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
