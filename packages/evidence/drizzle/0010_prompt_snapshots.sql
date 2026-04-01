CREATE TABLE IF NOT EXISTS prompt_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  phase task_phase NOT NULL,
  prompt_hash TEXT NOT NULL,
  prompt_path TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_snapshots_phase_hash
  ON prompt_snapshots (phase, prompt_hash);

CREATE INDEX IF NOT EXISTS idx_prompt_snapshots_captured_at
  ON prompt_snapshots (captured_at DESC);
