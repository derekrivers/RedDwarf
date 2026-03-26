DO $$
BEGIN
  CREATE TYPE approval_request_status AS ENUM ('pending', 'approved', 'rejected', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE approval_decision AS ENUM ('approve', 'reject');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS approval_requests (
  request_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  phase task_phase NOT NULL,
  approval_mode approval_mode NOT NULL,
  status approval_request_status NOT NULL,
  risk_class risk_class NOT NULL,
  summary TEXT NOT NULL,
  requested_capabilities JSONB NOT NULL,
  allowed_paths JSONB NOT NULL,
  blocked_phases JSONB NOT NULL,
  policy_reasons JSONB NOT NULL,
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  decision approval_decision,
  decision_summary TEXT,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ
);
