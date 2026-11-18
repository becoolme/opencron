-- Workspaces (Better Auth organizations), members, invitations and projects. Every existing account becomes the owner
-- of a personal workspace with one "Default" project, and its jobs, secrets and API keys move into it.
CREATE TABLE organization (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo TEXT,
  createdAt DATE NOT NULL,
  metadata TEXT
);

CREATE TABLE member (
  id TEXT PRIMARY KEY NOT NULL,
  organizationId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  createdAt DATE NOT NULL
);
CREATE UNIQUE INDEX member_org_user_uidx ON member(organizationId, userId);
CREATE INDEX member_userId_idx ON member(userId);

CREATE TABLE invitation (
  id TEXT PRIMARY KEY NOT NULL,
  organizationId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  expiresAt DATE NOT NULL,
  createdAt DATE NOT NULL,
  inviterId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX invitation_organizationId_idx ON invitation(organizationId);
CREATE INDEX invitation_email_idx ON invitation(email);

ALTER TABLE session ADD COLUMN activeOrganizationId TEXT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (organization_id, name)
);

ALTER TABLE jobs ADD COLUMN organization_id TEXT REFERENCES organization(id) ON DELETE CASCADE;
ALTER TABLE jobs ADD COLUMN project_id TEXT REFERENCES projects(id);
CREATE INDEX jobs_org_project_idx ON jobs(organization_id, project_id);

ALTER TABLE api_keys ADD COLUMN organization_id TEXT REFERENCES organization(id) ON DELETE CASCADE;
-- JSON array of project ids the key may use; NULL or [] means every project in the workspace.
ALTER TABLE api_keys ADD COLUMN project_ids TEXT;
CREATE INDEX api_keys_org ON api_keys(organization_id);

-- Secrets become workspace-wide. owner_user_id stays as the account whose id seals the ciphertext.
CREATE TABLE secrets_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (organization_id, name)
);

-- Backfill.
INSERT OR IGNORE INTO organization (id, name, slug, createdAt)
  SELECT 'ws_' || id, name, 'ws-' || lower(id), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM "user";
INSERT OR IGNORE INTO member (id, organizationId, userId, role, createdAt)
  SELECT 'mb_' || id, 'ws_' || id, id, 'owner', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM "user";
INSERT OR IGNORE INTO projects (id, organization_id, name, created_at)
  SELECT 'pj_' || id, 'ws_' || id, 'Default', CAST(strftime('%s', 'now') AS INTEGER) FROM "user";

UPDATE jobs SET owner_user_id = (SELECT id FROM "user" ORDER BY createdAt, id LIMIT 1) WHERE owner_user_id IS NULL;
UPDATE jobs SET organization_id = 'ws_' || owner_user_id, project_id = 'pj_' || owner_user_id
  WHERE organization_id IS NULL AND owner_user_id IS NOT NULL;
UPDATE api_keys SET organization_id = 'ws_' || owner_user_id WHERE organization_id IS NULL;
UPDATE session SET activeOrganizationId = 'ws_' || userId WHERE activeOrganizationId IS NULL;

INSERT INTO secrets_new (id, organization_id, owner_user_id, name, value, note, created_at, updated_at)
  SELECT id, 'ws_' || owner_user_id, owner_user_id, name, value, note, created_at, updated_at FROM secrets;
DROP TABLE secrets;
ALTER TABLE secrets_new RENAME TO secrets;
