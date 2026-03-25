DO $$
BEGIN
  CREATE TYPE failure_class AS ENUM (
    'planning_failure',
    'validation_failure',
    'review_failure',
    'integration_failure',
    'merge_failure',
    'policy_violation',
    'execution_loop'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE run_events
  ADD COLUMN IF NOT EXISTS failure_class failure_class,
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER;