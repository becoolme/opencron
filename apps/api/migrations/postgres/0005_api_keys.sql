-- API keys for the Open API and the MCP endpoint. Only the SHA-256 of a key is stored; the key is shown once.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  created_at BIGINT NOT NULL,
  last_used_at BIGINT
);
CREATE INDEX api_keys_owner ON api_keys(owner_user_id);
