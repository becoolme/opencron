-- migrations/0002_script_jobs.sql

ALTER TABLE jobs ADD COLUMN type TEXT NOT NULL DEFAULT 'url';
ALTER TABLE jobs ADD COLUMN script TEXT;
ALTER TABLE jobs ADD COLUMN script_version INTEGER NOT NULL DEFAULT 1;

-- Relax url NOT NULL (needed for type='script' jobs).
-- SQLite doesn't support ALTER COLUMN DROP NOT NULL, so rebuild the table.
CREATE TABLE jobs_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  url             TEXT,
  method          TEXT NOT NULL DEFAULT 'GET',
  headers         TEXT,
  body            TEXT,
  cron            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  timeout_ms      INTEGER NOT NULL DEFAULT 30000,
  next_run_at     INTEGER NOT NULL,
  last_run_at     INTEGER,
  last_status     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  type            TEXT NOT NULL DEFAULT 'url',
  script          TEXT,
  script_version  INTEGER NOT NULL DEFAULT 1
);

INSERT INTO jobs_new (id, name, url, method, headers, body, cron, enabled, timeout_ms,
                     next_run_at, last_run_at, last_status, created_at, updated_at,
                     type, script, script_version)
  SELECT id, name, url, method, headers, body, cron, enabled, timeout_ms,
         next_run_at, last_run_at, last_status, created_at, updated_at,
         type, script, script_version
  FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE INDEX idx_jobs_due ON jobs(enabled, next_run_at);
