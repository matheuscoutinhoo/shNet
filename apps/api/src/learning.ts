import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  evaluateChallenge,
  evaluateTutorial,
  validateChallenge,
  networkTutorial,
  type ChallengeRecord,
  type LearningEvaluation,
  type LearningProgress,
  type LearningScore,
  type Snapshot,
} from '@shlab/engine';
import type { Database } from './db';
import { checkCsrf, currentUser, error } from './security';
type StoredChallenge = ChallengeRecord & { baseline: Snapshot };
type Project = { id: string; topology: Snapshot; revision: number };
type ProgressRow = LearningProgress & { tutorial_step: number };

export async function registerLearning(
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
  const project = async (tx: Database, req: FastifyRequest, user: string, lock = false) => {
    const id = z.object({ id: z.uuid() }).parse(req.params).id;
    const row = (
      await tx.query<Project>(
        'SELECT id,topology,revision FROM projects WHERE id=$1 AND user_id=$2' + (lock ? ' FOR UPDATE' : ''),
        [id, user]
      )
    )[0];
    if (!row) throw error(404, 'Laboratório não encontrado');
    return row;
  };
  const publicChallenge = (row: StoredChallenge | undefined) =>
    row
      ? {
          project_id: row.project_id,
          revision: row.revision,
          definition: row.definition,
          updated_at: row.updated_at,
        }
      : null;
  const conflict = () =>
    error(409, 'A definição ou a topologia mudou. Reabra o painel para carregar a revisão atual.');

  app.get('/api/projects/:id/challenge', async (req) => {
    const p = await project(db, req, await owner(req));
    const challenge = (
      await db.query<StoredChallenge>('SELECT * FROM project_challenges WHERE project_id=$1', [p.id])
    )[0];
    const progress =
      (
        await db.query<ProgressRow>(
          "SELECT * FROM learning_progress WHERE project_id=$1 AND goal='challenge'",
          [p.id]
        )
      )[0] ?? null;
    return { challenge: publicChallenge(challenge), progress };
  });
  app.put('/api/projects/:id/challenge', async (req) => {
    const user = await owner(req),
      body = z
        .object({
          revision: z.number().int().nonnegative(),
          projectRevision: z.number().int().positive(),
          definition: z.unknown(),
        })
        .strict()
        .parse(req.body);
    return db.transaction(async (tx) => {
      const p = await project(tx, req, user, true);
      if (p.revision !== body.projectRevision) throw conflict();
      const previous = (
        await tx.query<StoredChallenge>('SELECT * FROM project_challenges WHERE project_id=$1 FOR UPDATE', [
          p.id,
        ])
      )[0];
      if ((previous?.revision ?? 0) !== body.revision) throw conflict();
      let definition;
      try {
        definition = validateChallenge(body.definition, p.topology);
      } catch (cause) {
        throw error(400, cause instanceof Error ? cause.message : 'Definição inválida.');
      }
      const row = (
        await tx.query<StoredChallenge>(
          'INSERT INTO project_challenges(project_id,definition,baseline) VALUES($1,$2,$3) ON CONFLICT(project_id) DO UPDATE SET definition=EXCLUDED.definition,baseline=EXCLUDED.baseline,revision=project_challenges.revision+1,updated_at=now() RETURNING *',
          [p.id, JSON.stringify(definition), JSON.stringify(p.topology)]
        )
      )[0];
      // Editing the goal invalidates previous evidence and its points; revisions cannot farm points.
      await tx.query("DELETE FROM learning_progress WHERE project_id=$1 AND goal='challenge'", [p.id]);
      return { challenge: publicChallenge(row), progress: null };
    });
  });
  app.post('/api/projects/:id/challenge/reset', async (req) => {
    const user = await owner(req),
      body = z
        .object({ revision: z.number().int().positive(), projectRevision: z.number().int().positive() })
        .strict()
        .parse(req.body);
    const result = await db.transaction(async (tx) => {
      const p = await project(tx, req, user, true),
        c = (
          await tx.query<StoredChallenge>('SELECT * FROM project_challenges WHERE project_id=$1', [p.id])
        )[0];
      if (!c) throw error(404, 'Defina um desafio antes de reiniciá-lo.');
      if (c.revision !== body.revision || p.revision !== body.projectRevision) throw conflict();
      return (
        await tx.query<Project>(
          'UPDATE projects SET topology=$1,revision=revision+1,updated_at=now() WHERE id=$2 RETURNING *',
          [JSON.stringify(c.baseline), p.id]
        )
      )[0];
    });
    await notify(user, { type: 'project.updated', id: result.id, revision: result.revision });
    return result;
  });
  app.post(
    '/api/projects/:id/challenge/evaluate',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const user = await owner(req),
        body = z.object({ revision: z.number().int().positive() }).strict().parse(req.body);
      return db.transaction(async (tx) => {
        const p = await project(tx, req, user, true),
          c = (
            await tx.query<StoredChallenge>('SELECT * FROM project_challenges WHERE project_id=$1', [p.id])
          )[0];
        if (!c) throw error(404, 'Defina um desafio antes de avaliá-lo.');
        if (c.revision !== body.revision) throw conflict();
        let result: LearningEvaluation;
        try {
          result = evaluateChallenge(c.definition, p.topology);
        } catch (cause) {
          throw error(400, cause instanceof Error ? cause.message : 'Avaliação indisponível.');
        }
        return (
          await tx.query<ProgressRow>(
            "INSERT INTO learning_progress(project_id,goal,revision,definition_revision,result,best_score,completed) VALUES($1,'challenge',$2,$3,$4,$5,$6) ON CONFLICT(project_id,goal) DO UPDATE SET revision=EXCLUDED.revision,definition_revision=EXCLUDED.definition_revision,result=EXCLUDED.result,best_score=greatest(learning_progress.best_score,EXCLUDED.best_score),completed=learning_progress.completed OR EXCLUDED.completed,checked_at=now() RETURNING *",
            [p.id, p.revision, c.revision, JSON.stringify(result), result.score, result.complete]
          )
        )[0];
      });
    }
  );
  app.get('/api/projects/:id/tutorial', async (req) => {
    const p = await project(db, req, await owner(req)),
      r = (
        await db.query<ProgressRow>(
          "SELECT * FROM learning_progress WHERE project_id=$1 AND goal='tutorial'",
          [p.id]
        )
      )[0];
    return {
      step: r?.tutorial_step ?? 0,
      total: networkTutorial.length,
      complete: r?.completed ?? false,
      result: r?.result ?? null,
      revision: r?.revision ?? p.revision,
      checked_at: r?.checked_at ?? null,
    };
  });
  app.post(
    '/api/projects/:id/tutorial/check',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const user = await owner(req),
        body = z
          .object({
            step: z
              .number()
              .int()
              .min(0)
              .max(networkTutorial.length - 1),
          })
          .strict()
          .parse(req.body);
      return db.transaction(async (tx) => {
        const p = await project(tx, req, user, true),
          r = (
            await tx.query<ProgressRow>(
              "SELECT * FROM learning_progress WHERE project_id=$1 AND goal='tutorial' FOR UPDATE",
              [p.id]
            )
          )[0];
        if (body.step !== (r?.tutorial_step ?? 0) || r?.completed) throw conflict();
        let result: LearningEvaluation;
        try {
          result = evaluateTutorial(p.topology, body.step);
        } catch (cause) {
          throw error(400, cause instanceof Error ? cause.message : 'Tutorial indisponível.');
        }
        const step = result.complete ? body.step + 1 : body.step,
          complete = step === networkTutorial.length,
          score = Math.floor((100 * step) / networkTutorial.length);
        const stored = (
          await tx.query<ProgressRow>(
            "INSERT INTO learning_progress(project_id,goal,revision,result,best_score,completed,tutorial_step) VALUES($1,'tutorial',$2,$3,$4,$5,$6) ON CONFLICT(project_id,goal) DO UPDATE SET revision=EXCLUDED.revision,result=EXCLUDED.result,best_score=greatest(learning_progress.best_score,EXCLUDED.best_score),completed=EXCLUDED.completed,tutorial_step=EXCLUDED.tutorial_step,checked_at=now() RETURNING *",
            [p.id, p.revision, JSON.stringify(result), score, complete, step]
          )
        )[0];
        return {
          step,
          total: networkTutorial.length,
          complete,
          result,
          revision: p.revision,
          checked_at: stored.checked_at,
        };
      });
    }
  );
  app.get('/api/learning/score', async (req): Promise<LearningScore> => {
    const user = await owner(req);
    const builtins = await db.query<{ score: number; completed: boolean }>(
      'SELECT max(l.best_score) AS score,bool_or(l.completed) AS completed FROM lab_progress l JOIN projects p ON p.id=l.project_id WHERE p.user_id=$1 GROUP BY l.lab_id',
      [user]
    );
    const custom = await db.query<{ goal: string; best_score: number; completed: boolean }>(
      'SELECT l.goal,l.best_score,l.completed FROM learning_progress l JOIN projects p ON p.id=l.project_id WHERE p.user_id=$1',
      [user]
    );
    const challenges = custom.filter((r) => r.goal === 'challenge'),
      tutorials = custom.filter((r) => r.goal === 'tutorial');
    const tutorialScore = tutorials.length ? Math.max(...tutorials.map((r) => r.best_score)) : 0;
    const labsScore = builtins.reduce((n, r) => n + Number(r.score), 0),
      challengesScore = challenges.reduce((n, r) => n + r.best_score, 0);
    return {
      score: labsScore + challengesScore + tutorialScore,
      completed:
        builtins.filter((r) => r.completed).length +
        challenges.filter((r) => r.completed).length +
        Number(tutorials.some((r) => r.completed)),
      activities: builtins.length + challenges.length + Number(!!tutorials.length),
      sources: { labs: labsScore, challenges: challengesScore, tutorials: tutorialScore },
    };
  });
}
