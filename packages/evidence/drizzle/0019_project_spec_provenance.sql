-- Project Mode: external-injection provenance
--
-- Records the Context-side provenance (spec id + version, adapter +
-- target schema) for every ProjectSpec injected through
-- POST /projects/inject. The UNIQUE (context_spec_id, context_version)
-- constraint is the idempotency key: re-posting the same spec version
-- never creates a second project.
--
-- Translation notes from the @context/reddwarf-adapter are persisted
-- inline on this row as jsonb. The evidence_records table wasn't a
-- natural fit here — it keys on task_id (we have no task at
-- pending_approval time) and its `kind` enum doesn't include a
-- translation-notes variant. Co-locating the notes with the
-- provenance row keeps the injection-time artefact next to the
-- relationship that gave rise to it.

CREATE TABLE IF NOT EXISTS project_spec_provenance (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             TEXT NOT NULL REFERENCES project_specs(project_id) ON DELETE CASCADE,
  context_spec_id        TEXT NOT NULL,
  context_version        INTEGER NOT NULL,
  adapter_version        TEXT NOT NULL,
  target_schema_version  TEXT NOT NULL,
  injected_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  injected_by            TEXT,
  translation_notes      JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (context_spec_id, context_version)
);

CREATE INDEX IF NOT EXISTS project_spec_provenance_project_id_idx
  ON project_spec_provenance(project_id);
