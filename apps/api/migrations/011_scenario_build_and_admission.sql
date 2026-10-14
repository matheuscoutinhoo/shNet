ALTER TABLE scenario_runs ADD COLUMN build_identity jsonb;
CREATE TABLE scenario_verification_leases (
  name text PRIMARY KEY,
  token uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
