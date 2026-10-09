ALTER TABLE sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE sessions ADD COLUMN user_agent text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX sessions_public_id_idx ON sessions(id);