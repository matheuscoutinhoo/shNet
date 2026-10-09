import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from './db';
import { checkCsrf, currentUser, error } from './security';
export async function recordActivity(
  db: Database,
  user: string,
  project: string,
  action: string,
  name: string,
  revision?: number
) {
  await db.query(
    'INSERT INTO project_activity(user_id,project_id,action,name,revision) VALUES($1,$2,$3,$4,$5)',
    [user, project, action, name, revision ?? null]
  );
}
export async function registerActivity(app: FastifyInstance, db: Database) {
  app.get('/api/activity', async (req) => {
    const user = await currentUser(db, req);
    if (!user) throw error(401, 'Entre para continuar');
    const query = z
      .object({
        before: z
          .string()
          .regex(/^[1-9][0-9]{0,18}$/)
          .refine((value) => /^[0-9]+$/.test(value) && BigInt(value) <= 9223372036854775807n)
          .optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .strict()
      .parse(req.query);
    const rows = await db.query(
      'SELECT id::text,project_id,action,name,revision,created_at FROM project_activity WHERE user_id=$1 AND ($2::bigint IS NULL OR id<$2::bigint) ORDER BY id DESC LIMIT $3',
      [user.id, query.before ?? null, query.limit + 1]
    );
    return {
      entries: rows.slice(0, query.limit),
      next: rows.length > query.limit ? rows[query.limit - 1].id : null,
    };
  });
  app.post(
    '/api/projects/:id/visits',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const user = await currentUser(db, req);
      if (!user) throw error(401, 'Entre para continuar');
      checkCsrf(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      z.object({})
        .strict()
        .parse(req.body ?? {});
      await db.transaction(async (tx) => {
        const p = (
          await tx.query<{ name: string; revision: number }>(
            'SELECT name,revision FROM projects WHERE id=$1 AND user_id=$2 FOR UPDATE',
            [id, user.id]
          )
        )[0];
        if (!p) throw error(404, 'Laboratório não encontrado');
        await recordActivity(tx, user.id, id, 'opened', p.name, p.revision);
      });
      return { ok: true };
    }
  );
}
