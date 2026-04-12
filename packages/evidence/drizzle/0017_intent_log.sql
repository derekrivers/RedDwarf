-- R-18: Write-ahead intent log for external side effects.
-- Before performing an external mutation (GitHub PR, OpenClaw dispatch),
-- the pipeline writes an intent record. On crash recovery, pending intents
-- are reconciled — either replayed or marked as abandoned.

CREATE TABLE IF NOT EXISTS intent_log (
  intent_id    TEXT        PRIMARY KEY,
  task_id      TEXT        NOT NULL,
  run_id       TEXT        NOT NULL,
  phase        TEXT        NOT NULL,
  intent_type  TEXT        NOT NULL,  -- 'openclaw_dispatch' | 'github_create_pr' | 'github_create_branch'
  status       TEXT        NOT NULL DEFAULT 'pending',  -- 'pending' | 'completed' | 'failed' | 'abandoned'
  payload      JSONB       NOT NULL DEFAULT '{}',
  result       JSONB,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_intent_log_status ON intent_log (status);
CREATE INDEX IF NOT EXISTS idx_intent_log_task_id ON intent_log (task_id);
CREATE INDEX IF NOT EXISTS idx_intent_log_created_at ON intent_log (created_at);
