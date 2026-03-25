DO $$
BEGIN
  CREATE TYPE memory_scope AS ENUM ('task', 'project', 'organization', 'external');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE memory_provenance AS ENUM ('human_curated', 'pipeline_derived', 'external_retrieval');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE memory_records
  ALTER COLUMN scope TYPE memory_scope USING scope::memory_scope;

ALTER TABLE memory_records
  ADD COLUMN IF NOT EXISTS provenance memory_provenance,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS repo TEXT,
  ADD COLUMN IF NOT EXISTS organization_id TEXT,
  ADD COLUMN IF NOT EXISTS source_uri TEXT,
  ADD COLUMN IF NOT EXISTS tags JSONB,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE memory_records
SET
  provenance = COALESCE(provenance, 'pipeline_derived'::memory_provenance),
  title = COALESCE(title, key),
  tags = COALESCE(tags, '[]'::jsonb),
  updated_at = COALESCE(updated_at, created_at),
  repo = CASE
    WHEN scope = 'task'::memory_scope THEN COALESCE(repo, NULL)
    ELSE repo
  END
WHERE provenance IS NULL
   OR title IS NULL
   OR tags IS NULL
   OR updated_at IS NULL;

ALTER TABLE memory_records
  ALTER COLUMN provenance SET NOT NULL,
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN tags SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;