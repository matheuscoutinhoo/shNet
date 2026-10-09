CREATE TABLE project_challenges (
 project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 definition jsonb NOT NULL,
 baseline jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE learning_progress (
 project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 goal text NOT NULL CHECK(goal IN ('challenge','tutorial')),
 revision integer NOT NULL,
 definition_revision integer NOT NULL DEFAULT 1,
 result jsonb NOT NULL,
 best_score integer NOT NULL CHECK(best_score BETWEEN 0 AND 100),
 completed boolean NOT NULL DEFAULT false,
 tutorial_step integer NOT NULL DEFAULT 0 CHECK(tutorial_step BETWEEN 0 AND 5),
 checked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,goal)
);
