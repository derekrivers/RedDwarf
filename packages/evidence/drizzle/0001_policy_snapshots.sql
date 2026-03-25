CREATE TABLE policy_snapshots (
  task_id TEXT PRIMARY KEY,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);