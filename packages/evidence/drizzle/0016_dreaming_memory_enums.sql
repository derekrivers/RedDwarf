-- Feature 156: Add repo scope and agent_observed provenance for dreaming memory records.
-- These enum values support the OpenClaw dreaming memory integration where
-- agent session learnings are captured as repo-scoped memory records.
ALTER TYPE memory_scope ADD VALUE IF NOT EXISTS 'repo';
ALTER TYPE memory_provenance ADD VALUE IF NOT EXISTS 'agent_observed';
