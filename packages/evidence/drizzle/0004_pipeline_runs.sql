DO $$
BEGIN
  CREATE TYPE concurrency_strategy AS ENUM ('serialize', 'escalate');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE pipeline_run_status AS ENUM ('active', 'completed', 'blocked', 'failed', 'stale', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS pipeline_runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  concurrency_key TEXT NOT NULL,
  strategy concurrency_strategy NOT NULL,
  status pipeline_run_status NOT NULL,
  blocked_by_run_id TEXT NULL,
  overlap_reason TEXT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  last_heartbeat_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NULL,
  stale_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS pipeline_runs_concurrency_key_idx
  ON pipeline_runs (concurrency_key, status, started_at DESC);

CREATE INDEX IF NOT EXISTS pipeline_runs_task_id_idx
  ON pipeline_runs (task_id, started_at DESC);