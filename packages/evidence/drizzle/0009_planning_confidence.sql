ALTER TABLE planning_specs
  ADD COLUMN IF NOT EXISTS confidence_level TEXT NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS confidence_reason TEXT NOT NULL DEFAULT 'Confidence not yet recorded.';

ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS confidence_level TEXT,
  ADD COLUMN IF NOT EXISTS confidence_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_planning_specs_confidence_level
  ON planning_specs (confidence_level);

CREATE INDEX IF NOT EXISTS idx_approval_requests_confidence_level
  ON approval_requests (confidence_level);
