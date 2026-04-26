-- M25 — F-190: RequiredCheckContract on ProjectSpec and TicketSpec.
--
-- Adds a structured contract that the auto-merge evaluator (F-194) reads to
-- decide whether "build green" is a real signal: which checks must pass,
-- the minimum number of checks observed, and whether [skip ci] / empty-test-
-- diff PRs are forbidden. Stored as jsonb on both `project_specs` and
-- `ticket_specs` so per-ticket overrides are possible while still letting
-- the project-level contract act as the default.
--
-- Default `{}` is treated as "no contract" by F-194 — auto-merge is skipped
-- and the PR falls back to human review. The Holly planner (F-191) is what
-- populates this column at planning time; pre-F-191 historical projects
-- thus stay safe by construction.
--
-- The auto_merge_policy column on project_specs (added in 0020) is a SEPARATE,
-- frozen-at-approval-time snapshot of the resolved contract — that exists so
-- a historic decision is reproducible if the live contract is later edited.
-- This column is the LIVE contract.

ALTER TABLE project_specs
  ADD COLUMN IF NOT EXISTS required_check_contract JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ticket_specs
  ADD COLUMN IF NOT EXISTS required_check_contract JSONB NOT NULL DEFAULT '{}'::jsonb;
