CREATE TABLE scenario_runs (
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 revision integer NOT NULL CHECK(revision > 0),
 source_hash text NOT NULL,
 topology jsonb NOT NULL,
 scenario jsonb NOT NULL,
 kind text NOT NULL CHECK(kind IN ('scenario','baseline')),
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','complete','cancelled')),
 report jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 CHECK((status='complete' AND report IS NOT NULL AND finished_at IS NOT NULL) OR (status='running' AND report IS NULL AND finished_at IS NULL) OR (status='cancelled' AND report IS NULL AND finished_at IS NOT NULL))
);
CREATE INDEX scenario_runs_project_idx ON scenario_runs(project_id,created_at DESC,id);
