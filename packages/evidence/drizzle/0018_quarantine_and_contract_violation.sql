-- M24 — F-184 + F-186 enum extensions.
--
-- F-186: operator-driven quarantine state on task manifests so the dispatcher
--        skips the task until the operator explicitly releases it.
-- F-184: structured failureClass for deterministic contract-check rejections.

ALTER TYPE task_lifecycle_status ADD VALUE IF NOT EXISTS 'quarantined';
ALTER TYPE failure_class ADD VALUE IF NOT EXISTS 'contract_violation';
