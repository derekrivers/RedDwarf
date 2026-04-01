CREATE TABLE IF NOT EXISTS eligibility_rejections (
  rejection_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  rejected_at TIMESTAMPTZ NOT NULL,
  reason_code TEXT NOT NULL,
  reason_detail TEXT,
  policy_version TEXT,
  source_issue JSONB,
  dry_run BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_eligibility_rejections_task_id
  ON eligibility_rejections (task_id);

CREATE INDEX IF NOT EXISTS idx_eligibility_rejections_rejected_at
  ON eligibility_rejections (rejected_at DESC);

CREATE INDEX IF NOT EXISTS idx_eligibility_rejections_reason_code
  ON eligibility_rejections (reason_code);
