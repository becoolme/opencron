-- Sandboxed D1 table dedicated to Dynamic Worker scripts.
-- The parent Worker injects owner_user_id and job_id; scripts only control
-- record_key and the string data field through a structured RPC API.
CREATE TABLE script_records (
  owner_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  record_key TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, job_id, record_key)
);

CREATE INDEX script_records_job_idx ON script_records(job_id);
