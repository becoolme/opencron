-- Alert channels: a destination saved once per workspace (or per project) and shared by many jobs. The config holds
-- webhook URLs and tokens and is stored encrypted, so moving each job's notify_targets into channels happens in code
-- (see channel-migration.ts) on the first scheduler tick, which then clears the column.
CREATE TABLE alert_channels (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- NULL: every project of the workspace can use it
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  auto_enable INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX alert_channels_org_idx ON alert_channels(organization_id);

CREATE TABLE job_channels (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES alert_channels(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, channel_id)
);
CREATE INDEX job_channels_channel_idx ON job_channels(channel_id);

-- Finds the jobs whose notify_targets still wait to become channels.
CREATE INDEX jobs_notify_pending_idx ON jobs(id) WHERE notify_targets IS NOT NULL;
