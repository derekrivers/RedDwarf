-- M25 — F-193: CI check observations.
--
-- Records every check_run / check_suite / status webhook event that fires
-- on a RedDwarf-authored PR head SHA. The auto-merge evaluator (F-194)
-- reads this table to decide whether every required check name in the
-- ticket's RequiredCheckContract has a `success` observation against the
-- current head SHA.
--
-- Why a dedicated table instead of evidence_records:
--   - Evidence records are scoped by task_id; CI checks are scoped by
--     (ticket_id, head_sha) which can produce many rows per ticket as
--     re-pushes mint new SHAs.
--   - The evaluator needs cheap "did checkName=X succeed on this SHA"
--     queries; a focused table with the right indexes is simpler than
--     overloading evidence kinds.
--
-- Idempotency: the unique key is (ticket_id, head_sha, source, check_name).
--   - source = "check_run" | "check_suite" | "status"
--   - re-firing the same webhook produces an UPSERT-able row, not a
--     duplicate. The evaluator always reads the latest observation per
--     (head_sha, check_name) tuple regardless of source.

CREATE TABLE IF NOT EXISTS ci_check_observations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id                TEXT NOT NULL REFERENCES ticket_specs(ticket_id) ON DELETE CASCADE,
  pr_number                INTEGER NOT NULL,
  head_sha                 TEXT NOT NULL,
  source                   TEXT NOT NULL CHECK (source IN ('check_run', 'check_suite', 'status')),
  check_name               TEXT NOT NULL,
  conclusion               TEXT NOT NULL,
  completed_at             TIMESTAMPTZ NOT NULL,
  raw_payload_evidence_id  TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, head_sha, source, check_name)
);

CREATE INDEX IF NOT EXISTS ci_check_observations_ticket_head_idx
  ON ci_check_observations(ticket_id, head_sha);

CREATE INDEX IF NOT EXISTS ci_check_observations_pr_idx
  ON ci_check_observations(pr_number);
