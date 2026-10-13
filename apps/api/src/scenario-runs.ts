import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ScenarioRunner,
  scenarioSchema,
  scenarioReportSchema,
  canonicalScenarioJson,
  type Snapshot,
  type Scenario,
  type ScenarioReport,
  ENGINE_CONTRACT_VERSION,
} from '@shlab/engine';
import { replayScenario } from './scenario-replay';
import type { Database } from './db';
import { databaseJson } from './database-json';
import { currentUser, checkCsrf, error } from './security';
interface Run {
  id: string;
  project_id: string;
  revision: number;
  source_hash: string;
  topology: Snapshot;
  scenario: Scenario;
  kind: 'scenario' | 'baseline';
  status: 'running' | 'complete' | 'cancelled' | 'expired';
  report: ScenarioReport | null;
  created_at: string;
  finished_at: string | null;
  server_verification?: {
    status: 'matched' | 'mismatch';
    engineContract: string;
    verifiedAt: string;
    reportHash: string;
  } | null;
}
const verified = (row: Run) => ({
  ...row,
  verification: {
    execution: 'client' as const,
    samples:
      row.report?.integrityVersion === 2 && scenarioReportSchema.safeParse(row.report).success
        ? 'samples-v2'
        : 'legacy-unverified',
    ...(row.server_verification ? { replay: row.server_verification } : {}),
  },
});
export async function registerScenarioRuns(app: FastifyInstance, db: Database) {
  const owner = async (req: FastifyRequest) => {
    const user = await currentUser(db, req);
    if (!user) throw error(401, 'Entre para continuar');
    if (req.method !== 'GET') checkCsrf(req);
    return user.id;
  };
  const params = (req: FastifyRequest) =>
    z.object({ id: z.uuid(), run: z.uuid().optional() }).strict().parse(req.params);
  const columns =
    'r.id,r.project_id,r.revision,r.source_hash,r.scenario,r.kind,r.status,r.report,r.created_at,r.finished_at,r.server_verification';
  const owned = async (tx: Database, id: string, user: string) => {
    const [p] = await tx.query<{ id: string; revision: number; topology: Snapshot }>(
      'SELECT id,revision,topology FROM projects WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [id, user]
    );
    if (!p) throw error(404, 'Laboratório não encontrado');
    await tx.query(
      "UPDATE scenario_runs SET status='expired',finished_at=now() WHERE project_id=$1 AND status='running' AND created_at < now() - interval '15 minutes'",
      [id]
    );
    return p;
  };
  app.post(
    '/api/projects/:id/scenario-runs',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const user = await owner(req),
        { id } = params(req);
      const body = z
        .object({
          revision: z.number().int().positive(),
          kind: z.enum(['scenario', 'baseline']),
          scenario: scenarioSchema,
        })
        .strict()
        .parse(req.body);
      if (body.kind === 'baseline' && body.scenario.faults.length)
        throw error(400, 'Baseline não permite falhas agendadas.');
      const run = await db.transaction(async (tx) => {
        const project = await owned(tx, id, user);
        if (body.revision !== project.revision)
          throw error(409, 'Salve e atualize o laboratório antes de executar o cenário.');
        const [count] = await tx.query<{ n: string }>(
          'SELECT count(*) AS n FROM scenario_runs WHERE project_id=$1',
          [id]
        );
        if (Number(count.n) >= 50)
          throw error(400, 'Limite de 50 ensaios. Exporte e exclua resultados antigos.');
        try {
          new ScenarioRunner(project.topology, body.scenario);
        } catch (e) {
          throw error(400, (e as Error).message);
        }
        const hash = createHash('sha256').update(canonicalScenarioJson(project.topology)).digest('hex');
        return (
          await tx.query<Run>(
            'INSERT INTO scenario_runs(id,project_id,revision,source_hash,topology,scenario,kind) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [
              randomUUID(),
              id,
              project.revision,
              hash,
              databaseJson(project.topology),
              databaseJson(body.scenario),
              body.kind,
            ]
          )
        )[0];
      });
      return reply.code(201).send(verified(run));
    }
  );
  app.get('/api/projects/:id/scenario-runs', async (req) => {
    const user = await owner(req),
      { id } = params(req);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(50).default(10) })
      .strict()
      .parse(req.query);
    if (!(await db.query('SELECT id FROM projects WHERE id=$1 AND user_id=$2', [id, user])).length)
      throw error(404, 'Laboratório não encontrado');
    await db.query(
      "UPDATE scenario_runs SET status='expired',finished_at=now() WHERE project_id=$1 AND status='running' AND created_at < now() - interval '15 minutes'",
      [id]
    );
    return (
      await db.query<Run>(
        'SELECT ' +
          columns +
          ' FROM scenario_runs r JOIN projects p ON p.id=r.project_id WHERE p.id=$1 AND p.user_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT $3',
        [id, user, limit]
      )
    ).map(verified);
  });
  app.get('/api/projects/:id/scenario-runs/:run', async (req) => {
    const user = await owner(req),
      { id, run } = params(req);
    const [row] = await db.query<Run>(
      'SELECT r.* FROM scenario_runs r JOIN projects p ON p.id=r.project_id WHERE p.id=$1 AND p.user_id=$2 AND r.id=$3',
      [id, user, run]
    );
    if (!row) throw error(404, 'Ensaio não encontrado');
    if (row.status === 'running' && Date.now() - new Date(row.created_at).getTime() >= 15 * 60000) {
      const [expired] = await db.query<Run>(
        "UPDATE scenario_runs SET status='expired',finished_at=now() WHERE id=$1 AND status='running' RETURNING *",
        [run]
      );
      if (expired) return verified(expired);
    }
    return verified(row);
  });
  app.put('/api/projects/:id/scenario-runs/:run', async (req) => {
    const user = await owner(req),
      { id, run } = params(req);
    const body = z.object({ report: scenarioReportSchema }).strict().parse(req.body);
    if (Buffer.byteLength(JSON.stringify(body.report)) > 2 * 1024 * 1024)
      throw error(400, 'Relatório excede 2 MiB.');
    return db.transaction(async (tx) => {
      await owned(tx, id, user);
      const [row] = await tx.query<Run>(
        'SELECT * FROM scenario_runs WHERE project_id=$1 AND id=$2 FOR UPDATE',
        [id, run]
      );
      if (!row) throw error(404, 'Ensaio não encontrado');
      if (canonicalScenarioJson(body.report.scenario) !== canonicalScenarioJson(row.scenario))
        throw error(400, 'Relatório pertence a outro cenário.');
      if (
        row.status === 'complete' &&
        canonicalScenarioJson(row.report) === canonicalScenarioJson(body.report)
      )
        return verified(row);
      if (!['running', 'expired'].includes(row.status)) throw error(409, 'Ensaio já finalizado.');
      return verified(
        (
          await tx.query<Run>(
            "UPDATE scenario_runs SET status='complete',report=$1,finished_at=now() WHERE id=$2 RETURNING *",
            [databaseJson(body.report), run]
          )
        )[0]
      );
    });
  });
  app.post(
    '/api/projects/:id/scenario-runs/:run/verify',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req) => {
      const user = await owner(req),
        { id, run } = params(req);
      const [row] = await db.query<Run>(
        'SELECT r.* FROM scenario_runs r JOIN projects p ON p.id=r.project_id WHERE p.id=$1 AND p.user_id=$2 AND r.id=$3',
        [id, user, run]
      );
      if (!row) throw error(404, 'Ensaio não encontrado');
      if (row.status !== 'complete' || !row.report) throw error(409, 'Salve o resultado antes de verificar.');
      if (row.report.engineContract !== ENGINE_CONTRACT_VERSION)
        throw error(409, 'Contrato do motor diferente. Execute um novo ensaio com a versão atual.');
      const authoritative = scenarioReportSchema.parse(await replayScenario(row.topology, row.scenario));
      const reportHash = createHash('sha256').update(canonicalScenarioJson(row.report)).digest('hex');
      const verification = {
        status:
          canonicalScenarioJson(authoritative) === canonicalScenarioJson(row.report) ? 'matched' : 'mismatch',
        engineContract: ENGINE_CONTRACT_VERSION,
        verifiedAt: new Date().toISOString(),
        reportHash,
      };
      const [saved] = await db.query<Run>(
        "UPDATE scenario_runs SET server_verification=$1 WHERE id=$2 AND project_id=$3 AND status='complete' RETURNING *",
        [databaseJson(verification), run, id]
      );
      if (!saved) throw error(409, 'Ensaio removido durante a verificação.');
      return verified(saved);
    }
  );
  app.patch('/api/projects/:id/scenario-runs/:run', async (req) => {
    const user = await owner(req),
      { id, run } = params(req);
    z.object({ status: z.literal('cancelled') })
      .strict()
      .parse(req.body);
    return db.transaction(async (tx) => {
      await owned(tx, id, user);
      const [row] = await tx.query<Run>(
        "UPDATE scenario_runs SET status='cancelled',finished_at=now() WHERE project_id=$1 AND id=$2 AND status='running' RETURNING *",
        [id, run]
      );
      if (!row) throw error(409, 'Ensaio não está em execução.');
      return row;
    });
  });
  app.delete('/api/projects/:id/scenario-runs/:run', async (req) => {
    const user = await owner(req),
      { id, run } = params(req);
    return db.transaction(async (tx) => {
      await owned(tx, id, user);
      if (
        !(await tx.query('DELETE FROM scenario_runs WHERE project_id=$1 AND id=$2 RETURNING id', [id, run]))
          .length
      )
        throw error(404, 'Ensaio não encontrado');
      return { ok: true };
    });
  });
}
