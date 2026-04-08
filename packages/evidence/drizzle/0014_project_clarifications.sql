-- Project Mode Phase 3: clarification persistence on project_specs
-- Stores pending clarification questions and operator-submitted answers

ALTER TABLE project_specs ADD COLUMN IF NOT EXISTS clarification_questions JSONB;
ALTER TABLE project_specs ADD COLUMN IF NOT EXISTS clarification_answers JSONB;
ALTER TABLE project_specs ADD COLUMN IF NOT EXISTS clarification_requested_at TIMESTAMPTZ;
