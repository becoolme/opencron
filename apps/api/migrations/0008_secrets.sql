-- Per-account secrets, injected into that account's script runs as environment variables. `value` is AES-GCM
-- ciphertext (src/secrets.ts); the API never returns it.
CREATE TABLE secrets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_user_id, name)
);
