-- M25 — F-189: Project Mode auto-merge opt-in columns on project_specs.
--
-- `auto_merge_enabled` is the per-project switch. Defaults to FALSE so every
-- existing project keeps the historic human-merge behaviour and the evaluator
-- (F-194) treats them as `skip`.
--
-- `auto_merge_policy` is a snapshot of the resolved RequiredCheckContract
-- (filled in by F-190) so a historic auto-merge decision remains reproducible
-- even if the global contract is later tightened or relaxed. Stored as jsonb
-- with a default of `{}` so the column is non-null on legacy rows; the
-- evaluator treats `{}` as "no contract — ineligible for auto-merge" exactly
-- like an explicit empty contract.

ALTER TABLE project_specs
  ADD COLUMN IF NOT EXISTS auto_merge_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE project_specs
  ADD COLUMN IF NOT EXISTS auto_merge_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
