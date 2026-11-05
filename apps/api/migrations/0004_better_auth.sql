-- Better Auth 1.7 core tables for Cloudflare D1.
CREATE TABLE "user" (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);

CREATE TABLE session (
  id TEXT PRIMARY KEY NOT NULL,
  expiresAt DATE NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX session_userId_idx ON session(userId);

CREATE TABLE account (
  id TEXT PRIMARY KEY NOT NULL,
  issuer TEXT NOT NULL,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt DATE,
  refreshTokenExpiresAt DATE,
  scope TEXT,
  password TEXT,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);

CREATE UNIQUE INDEX account_issuer_accountId_uidx ON account(issuer, accountId);
CREATE INDEX account_userId_idx ON account(userId);

CREATE TABLE verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt DATE NOT NULL,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);

CREATE INDEX verification_identifier_idx ON verification(identifier);

ALTER TABLE jobs ADD COLUMN owner_user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
CREATE INDEX jobs_owner_user_id_idx ON jobs(owner_user_id);

CREATE TABLE script_storage (
  owner_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, job_id, key)
);
CREATE INDEX script_storage_job_idx ON script_storage(job_id);
