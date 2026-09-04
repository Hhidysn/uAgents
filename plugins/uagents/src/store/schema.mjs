export const STORE_SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  raw_hash TEXT NOT NULL,
  effective_hash TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  native_outcome TEXT,
  objective_verdict TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
  model_requested TEXT,
  model_resolved TEXT,
  model_reported TEXT,
  model_verified INTEGER NOT NULL DEFAULT 0 CHECK(model_verified IN (0, 1)),
  provider TEXT,
  route_id TEXT,
  resolution_json TEXT,
  verification_json TEXT,
  decision_json TEXT NOT NULL,
  store_schema_version INTEGER NOT NULL,
  core_version TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  status TEXT NOT NULL,
  submission TEXT NOT NULL CHECK(submission IN ('not_sent', 'may_have_been_sent', 'sent')),
  adapter_version TEXT,
  native_cli_version TEXT,
  owner_nonce TEXT,
  fencing_token TEXT,
  heartbeat_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  UNIQUE(task_id, ordinal)
) STRICT;

CREATE TABLE IF NOT EXISTS native_sessions (
  id INTEGER PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  target TEXT NOT NULL,
  native_session_id TEXT,
  native_task_id TEXT,
  native_status TEXT,
  evidence_ref TEXT,
  UNIQUE(attempt_id, native_session_id, native_task_id)
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
  attempt_id TEXT REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(task_id, sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS leases (
  resource_key TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  owner_nonce TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  fencing_token TEXT NOT NULL UNIQUE,
  expires_at_ms INTEGER NOT NULL,
  metadata_json TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS idempotency (
  request_id TEXT PRIMARY KEY,
  raw_hash TEXT NOT NULL,
  effective_hash TEXT NOT NULL,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS events_task_idx ON events(task_id, sequence);
CREATE INDEX IF NOT EXISTS attempts_task_idx ON attempts(task_id, ordinal);
CREATE INDEX IF NOT EXISTS native_sessions_attempt_idx ON native_sessions(attempt_id);
CREATE INDEX IF NOT EXISTS leases_expiry_idx ON leases(expires_at_ms);
`;
