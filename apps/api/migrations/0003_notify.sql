-- migrations/0003_notify.sql

ALTER TABLE jobs ADD COLUMN notify_targets TEXT;
ALTER TABLE jobs ADD COLUMN last_notified_at INTEGER;
