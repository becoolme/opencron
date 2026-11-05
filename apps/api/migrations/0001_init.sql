-- migrations/0001_init.sql

CREATE TABLE jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
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
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_jobs_due ON jobs(enabled, next_run_at);

CREATE TABLE executions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           INTEGER NOT NULL,
  started_at       INTEGER NOT NULL,
  duration_ms      INTEGER NOT NULL,
  status_code      INTEGER,
  ok               INTEGER NOT NULL,
  error            TEXT,
  response_snippet TEXT
);

CREATE INDEX idx_exec_job_time ON executions(job_id, started_at DESC);
CREATE INDEX idx_exec_time ON executions(started_at);
