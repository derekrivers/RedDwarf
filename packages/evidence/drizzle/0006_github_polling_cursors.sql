DO $$
BEGIN
  CREATE TYPE github_issue_polling_cursor_status AS ENUM ('succeeded', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS github_issue_polling_cursors (
  repo TEXT PRIMARY KEY,
  last_seen_issue_number INTEGER,
  last_seen_updated_at TIMESTAMPTZ,
  last_poll_started_at TIMESTAMPTZ,
  last_poll_completed_at TIMESTAMPTZ,
  last_poll_status github_issue_polling_cursor_status,
  last_poll_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);
