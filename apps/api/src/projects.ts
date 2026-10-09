import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { makeTemplate, templates, validateSnapshot, type TemplateId, type Snapshot } from '@shlab/engine';
import { labs, makeLab, evaluateLab, type LabId } from '@shlab/engine';
import { recordActivity } from './activity';
import { checkCsrf, currentUser, error } from './security';
import type { Database } from './db';
interface Project {
  id: string;
  user_id: string;
  name: string;
  topology: Snapshot;
  revision: number;
  favorite: boolean;
  updated_at: string;
  mode: 'free' | 'guided' | 'challenge';
  lab_id: LabId | null;
}
export async function registerProjects(
  app: FastifyInstance,
  db: Database,
  notify: (userId: string, data: unknown) => Promise<void>
) {
  const owner = async (req: FastifyRequest) => {
    const user = await currentUser(db, req);
    if (!user) throw error(401, 'Entre para continuar');
    if (req.method !== 'GET') checkCsrf(req);
    return user.id;
  };
  const projectId = (req: FastifyRequest) => z.object({ id: z.uuid() }).parse(req.params).id;
  app.get('/api/projects', async (req) => {
    const user = await owner(req);
    return db.query(
      "SELECT p.id,p.name,p.revision,p.favorite,p.updated_at,p.mode,p.lab_id,jsonb_array_length(p.topology->'devices') AS device_count,l.passed,l.total,l.completed FROM projects p LEFT JOIN lab_progress l ON l.project_id=p.id WHERE p.user_id=$1 ORDER BY p.favorite DESC,p.updated_at DESC",
      [user]
    );
  });
  app.post('/api/projects', async (req, reply) => {
    const user = await owner(req);
    const body = z
      .object({
        name: z.string().trim().min(1).max(100),
        template: z.enum(templates.map((t) => t.id) as [TemplateId, ...TemplateId[]]).default('empty'),
        background: z.enum(['light', 'gray', 'dark']).default('light'),
        mode: z.enum(['free', 'guided', 'challenge']).default('free'),
        labId: z.enum(labs.map((lab) => lab.id) as [LabId, ...LabId[]]).optional(),
      })
      .strict()
      .refine(
        (value) => (value.mode === 'free' ? value.labId === undefined : value.labId !== undefined),
        'Selecione um lab para modo guiado/desafio.'
      )
      .parse(req.body);
    const topology = body.labId ? makeLab(body.labId) : makeTemplate(body.template);
    topology.background = body.background;
    const project = await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user]);
      const count = await tx.query<{ n: string }>('SELECT count(*) AS n FROM projects WHERE user_id=$1', [
        user,
      ]);
      if (Number(count[0].n) >= 100) throw error(400, 'Limite de 100 laboratórios');
      const created = (
        await tx.query<Project>(
          'INSERT INTO projects(id,user_id,name,topology,mode,lab_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
          [randomUUID(), user, body.name, JSON.stringify(topology), body.mode, body.labId ?? null]
        )
      )[0];
      await recordActivity(tx, user, created.id, 'created', created.name, created.revision);
      return created;
    });
    await notify(user, { type: 'project.created', id: project.id });
    return reply.code(201).send(project);
  });
  app.get('/api/projects/:id', async (req) => {
    const user = await owner(req);
    const project = (
      await db.query<Project>('SELECT * FROM projects WHERE id=$1 AND user_id=$2', [projectId(req), user])
    )[0];
    if (!project) throw error(404, 'Laboratório não encontrado');
    return project;
  });
  app.get('/api/labs', async (req) => {
    await owner(req);
    return labs;
  });
  app.get('/api/projects/:id/progress', async (req) => {
    const user = await owner(req);
    const id = projectId(req);
    if (!(await db.query('SELECT id FROM projects WHERE id=$1 AND user_id=$2', [id, user])).length)
      throw error(404, 'Laboratório não encontrado');
    return (await db.query('SELECT * FROM lab_progress WHERE project_id=$1', [id]))[0] ?? null;
  });
  app.post(
    '/api/projects/:id/evaluate',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const user = await owner(req);
      z.object({})
        .strict()
        .parse(req.body ?? {});
      return db.transaction(async (tx) => {
        const project = (
          await tx.query<Project>('SELECT * FROM projects WHERE id=$1 AND user_id=$2 FOR UPDATE', [
            projectId(req),
            user,
          ])
        )[0];
        if (!project) throw error(404, 'Laboratório não encontrado');
        if (!project.lab_id) throw error(400, 'Laboratório livre não possui tarefas avaliáveis.');
        let result;
        try {
          result = evaluateLab(project.lab_id, project.topology);
        } catch (cause) {
          throw error(400, cause instanceof Error ? cause.message : 'Não foi possível avaliar a topologia.');
        }
        return (
          await tx.query(
            'INSERT INTO lab_progress(project_id,lab_id,revision,passed,total,result,completed,best_score) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(project_id) DO UPDATE SET revision=EXCLUDED.revision,passed=EXCLUDED.passed,total=EXCLUDED.total,result=EXCLUDED.result,completed=lab_progress.completed OR EXCLUDED.completed,best_score=greatest(lab_progress.best_score,EXCLUDED.best_score),checked_at=now() RETURNING *',
            [
              project.id,
              project.lab_id,
              project.revision,
              result.passed,
              result.total,
              JSON.stringify(result),
              result.complete,
              Math.floor((100 * result.passed) / Math.max(1, result.total)),
            ]
          )
        )[0];
      });
    }
  );
  app.put('/api/projects/:id', async (req) => {
    const user = await owner(req),
      id = projectId(req);
    const body = z
      .object({
        name: z.string().trim().min(1).max(100),
        revision: z.number().int().positive(),
        topology: z.unknown(),
      })
      .strict()
      .parse(req.body);
    let topology: Snapshot;
    try {
      topology = validateSnapshot(body.topology);
    } catch {
      throw error(400, 'Topologia inválida: verifique interfaces, cabos e configurações');
    }
    const project = await db.transaction(async (tx) => {
      const project = (
        await tx.query<Project>(
          'UPDATE projects SET name=$1,topology=$2,revision=revision+1,updated_at=now() WHERE id=$3 AND user_id=$4 AND revision=$5 RETURNING *',
          [body.name, JSON.stringify(topology), id, user, body.revision]
        )
      )[0];
      if (project) await recordActivity(tx, user, id, 'updated', project.name, project.revision);
      return project;
    });
    if (!project) {
      if (!(await db.query('SELECT id FROM projects WHERE id=$1 AND user_id=$2', [id, user])).length)
        throw error(404, 'Laboratório não encontrado');
      throw error(
        409,
        'Uma versão mais recente foi salva em outra aba. Exporte seu trabalho e reabra o laboratório.'
      );
    }
    await notify(user, { type: 'project.updated', id, revision: project.revision });
    return project;
  });
  app.patch('/api/projects/:id/favorite', async (req) => {
    const user = await owner(req),
      id = projectId(req),
      body = z.object({ favorite: z.boolean() }).strict().parse(req.body);
    await db.transaction(async (tx) => {
      const [result] = await tx.query<{ name: string; revision: number }>(
        'UPDATE projects SET favorite=$1 WHERE id=$2 AND user_id=$3 RETURNING name,revision',
        [body.favorite, id, user]
      );
      if (!result) throw error(404, 'Laboratório não encontrado');
      await recordActivity(
        tx,
        user,
        id,
        body.favorite ? 'favorited' : 'unfavorited',
        result.name,
        result.revision
      );
    });
    return { ok: true };
  });
  app.delete('/api/projects/:id', async (req) => {
    const user = await owner(req),
      id = projectId(req);
    await db.transaction(async (tx) => {
      const [project] = await tx.query<Project>(
        'SELECT * FROM projects WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [id, user]
      );
      if (!project) throw error(404, 'Laboratório não encontrado');
      await recordActivity(tx, user, id, 'deleted', project.name, project.revision);
      await tx.query('DELETE FROM projects WHERE id=$1 AND user_id=$2', [id, user]);
    });
    await notify(user, { type: 'project.deleted', id });
    return { ok: true };
  });
  app.get('/api/projects/:id/snapshots', async (req) => {
    const user = await owner(req),
      id = projectId(req);
    if (!(await db.query('SELECT id FROM projects WHERE id=$1 AND user_id=$2', [id, user])).length)
      throw error(404, 'Laboratório não encontrado');
    return db.query(
      'SELECT v.id,v.label,v.created_at FROM topology_versions v JOIN projects p ON p.id=v.project_id WHERE p.id=$1 AND p.user_id=$2 ORDER BY v.created_at DESC',
      [id, user]
    );
  });
  app.post('/api/projects/:id/snapshots', async (req, reply) => {
    const user = await owner(req),
      id = projectId(req),
      body = z
        .object({ label: z.string().trim().min(1).max(100) })
        .strict()
        .parse(req.body);
    const version = await db.transaction(async (tx) => {
      const project = (
        await tx.query<Project>('SELECT * FROM projects WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, user])
      )[0];
      if (!project) throw error(404, 'Laboratório não encontrado');
      const count = await tx.query<{ n: string }>(
        'SELECT count(*) AS n FROM topology_versions WHERE project_id=$1',
        [id]
      );
      if (Number(count[0].n) >= 50) throw error(400, 'Limite de 50 snapshots');
      const version = (
        await tx.query(
          'INSERT INTO topology_versions(id,project_id,label,topology) VALUES($1,$2,$3,$4) RETURNING id,label,created_at',
          [randomUUID(), id, body.label, JSON.stringify(project.topology)]
        )
      )[0];
      await recordActivity(tx, user, id, 'snapshot', project.name, project.revision);
      return version;
    });
    return reply.code(201).send(version);
  });
  app.get('/api/projects/:id/snapshots/:version', async (req) => {
    const user = await owner(req),
      params = z.object({ id: z.uuid(), version: z.uuid() }).parse(req.params);
    const row = (
      await db.query(
        'SELECT v.topology FROM topology_versions v JOIN projects p ON p.id=v.project_id WHERE p.id=$1 AND p.user_id=$2 AND v.id=$3',
        [params.id, user, params.version]
      )
    )[0];
    if (!row) throw error(404, 'Snapshot não encontrado');
    return row;
  });
}
