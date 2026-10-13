ALTER TABLE scenario_runs ADD COLUMN server_verification jsonb;
ALTER TABLE scenario_runs ADD CONSTRAINT scenario_run_verification_object
  CHECK (server_verification IS NULL OR jsonb_typeof(server_verification) = 'object');
