CREATE TABLE project_activity (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('created','updated','opened','favorited','unfavorited','deleted','snapshot')),
  name text NOT NULL,
  revision integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_activity_owner_cursor ON project_activity(user_id,id DESC);
