ALTER TABLE scenario_runs DROP CONSTRAINT scenario_runs_status_check;
ALTER TABLE scenario_runs DROP CONSTRAINT scenario_runs_check;
ALTER TABLE scenario_runs ADD CONSTRAINT scenario_runs_status_check CHECK(status IN ('running','complete','cancelled','expired'));
ALTER TABLE scenario_runs ADD CONSTRAINT scenario_runs_check CHECK((status='complete' AND report IS NOT NULL AND finished_at IS NOT NULL) OR (status='running' AND report IS NULL AND finished_at IS NULL) OR (status IN ('cancelled','expired') AND report IS NULL AND finished_at IS NOT NULL));
