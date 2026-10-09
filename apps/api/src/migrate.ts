import { createPostgres, migrate } from './db';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL obrigatório');
const db = createPostgres(process.env.DATABASE_URL);
try {
  await migrate(db);
  console.info('Migrations aplicadas');
} finally {
  await db.close();
}
