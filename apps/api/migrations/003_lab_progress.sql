ALTER TABLE projects ADD COLUMN mode text NOT NULL DEFAULT 'free' CHECK(mode IN ('free','guided','challenge'));
ALTER TABLE projects ADD COLUMN lab_id text;
CREATE TABLE lab_progress (
 project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 lab_id text NOT NULL,
 revision integer NOT NULL,
 passed integer NOT NULL,
 total integer NOT NULL,
 result jsonb NOT NULL,
 completed boolean NOT NULL DEFAULT false,
 checked_at timestamptz NOT NULL DEFAULT now()
);