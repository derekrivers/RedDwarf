ALTER TABLE task_manifests
  ADD COLUMN IF NOT EXISTS dry_run BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS dry_run BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS dry_run BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_task_manifests_dry_run
  ON task_manifests (dry_run);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_dry_run
  ON pipeline_runs (dry_run);

CREATE INDEX IF NOT EXISTS idx_approval_requests_dry_run
  ON approval_requests (dry_run);
