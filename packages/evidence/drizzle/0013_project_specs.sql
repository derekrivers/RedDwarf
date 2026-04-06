-- Project Mode: project_specs and ticket_specs tables
-- Extends the planning corridor with project-level decomposition

DO $$ BEGIN
  CREATE TYPE project_size AS ENUM ('small', 'medium', 'large');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE project_status AS ENUM (
    'draft',
    'clarification_pending',
    'pending_approval',
    'approved',
    'executing',
    'complete',
    'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE ticket_status AS ENUM (
    'pending',
    'dispatched',
    'in_progress',
    'pr_open',
    'merged',
    'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS project_specs (
  project_id        TEXT PRIMARY KEY,
  source_issue_id   TEXT,
  source_repo       TEXT NOT NULL,
  title             TEXT NOT NULL,
  summary           TEXT NOT NULL,
  project_size      project_size NOT NULL,
  status            project_status NOT NULL DEFAULT 'draft',
  complexity_classification JSONB,
  approval_decision TEXT,
  decided_by        TEXT,
  decision_summary  TEXT,
  amendments        TEXT,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_specs (
  ticket_id                TEXT PRIMARY KEY,
  project_id               TEXT NOT NULL REFERENCES project_specs(project_id),
  title                    TEXT NOT NULL,
  description              TEXT NOT NULL,
  acceptance_criteria      JSONB NOT NULL DEFAULT '[]'::jsonb,
  depends_on               JSONB NOT NULL DEFAULT '[]'::jsonb,
  status                   ticket_status NOT NULL DEFAULT 'pending',
  complexity_class         risk_class NOT NULL DEFAULT 'low',
  risk_class               risk_class NOT NULL DEFAULT 'low',
  github_sub_issue_number  INTEGER,
  github_pr_number         INTEGER,
  created_at               TIMESTAMPTZ NOT NULL,
  updated_at               TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ticket_specs_project_id ON ticket_specs(project_id);
CREATE INDEX IF NOT EXISTS idx_project_specs_source_repo ON project_specs(source_repo);
CREATE INDEX IF NOT EXISTS idx_project_specs_status ON project_specs(status);

-- Add project_size column to planning_specs for single-issue classification persistence
ALTER TABLE planning_specs ADD COLUMN IF NOT EXISTS project_size project_size DEFAULT 'small';
