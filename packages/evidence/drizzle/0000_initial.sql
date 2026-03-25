CREATE TYPE task_phase AS ENUM (
  'intake',
  'eligibility',
  'planning',
  'policy_gate',
  'development',
  'validation',
  'review',
  'scm',
  'archive'
);

CREATE TYPE task_lifecycle_status AS ENUM (
  'draft',
  'ready',
  'active',
  'blocked',
  'completed',
  'failed',
  'cancelled'
);

CREATE TYPE phase_lifecycle_status AS ENUM (
  'pending',
  'running',
  'passed',
  'failed',
  'escalated',
  'skipped'
);

CREATE TYPE risk_class AS ENUM ('low', 'medium', 'high');
CREATE TYPE approval_mode AS ENUM ('auto', 'review_required', 'human_signoff_required', 'disallowed');
CREATE TYPE evidence_kind AS ENUM ('manifest', 'planning_spec', 'phase_record', 'gate_decision', 'run_event', 'file_artifact');
CREATE TYPE event_level AS ENUM ('info', 'warn', 'error');

CREATE TABLE task_manifests (
  task_id TEXT PRIMARY KEY,
  source JSONB NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  priority INTEGER NOT NULL,
  risk_class risk_class NOT NULL,
  approval_mode approval_mode NOT NULL,
  current_phase task_phase NOT NULL,
  lifecycle_status task_lifecycle_status NOT NULL,
  assigned_agent_type TEXT NOT NULL,
  requested_capabilities JSONB NOT NULL,
  retry_count INTEGER NOT NULL,
  evidence_links JSONB NOT NULL,
  workspace_id TEXT,
  branch_name TEXT,
  pr_number INTEGER,
  policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE phase_records (
  record_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  phase task_phase NOT NULL,
  status phase_lifecycle_status NOT NULL,
  actor TEXT NOT NULL,
  summary TEXT NOT NULL,
  details JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (record_id, task_id)
);

CREATE TABLE planning_specs (
  spec_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  assumptions JSONB NOT NULL,
  affected_areas JSONB NOT NULL,
  constraints JSONB NOT NULL,
  acceptance_criteria JSONB NOT NULL,
  test_expectations JSONB NOT NULL,
  recommended_agent_type TEXT NOT NULL,
  risk_class risk_class NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE evidence_records (
  record_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind evidence_kind NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL,
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE run_events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  phase task_phase NOT NULL,
  level event_level NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE memory_records (
  memory_id TEXT PRIMARY KEY,
  task_id TEXT,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
