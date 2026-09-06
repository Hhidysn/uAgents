CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE tasks (
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

CREATE TABLE attempts (
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

CREATE TABLE native_sessions (
  id INTEGER PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  target TEXT NOT NULL,
  native_session_id TEXT,
  native_task_id TEXT,
  native_status TEXT,
  evidence_ref TEXT,
  UNIQUE(attempt_id, native_session_id, native_task_id)
) STRICT;

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
  attempt_id TEXT REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(task_id, sequence)
) STRICT;

CREATE TABLE leases (
  resource_key TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  owner_nonce TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  fencing_token TEXT NOT NULL UNIQUE,
  expires_at_ms INTEGER NOT NULL,
  metadata_json TEXT NOT NULL
) STRICT;

CREATE TABLE idempotency (
  request_id TEXT PRIMARY KEY,
  raw_hash TEXT NOT NULL,
  effective_hash TEXT NOT NULL,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX events_task_idx ON events(task_id, sequence);
CREATE INDEX attempts_task_idx ON attempts(task_id, ordinal);
CREATE INDEX native_sessions_attempt_idx ON native_sessions(attempt_id);
CREATE INDEX leases_expiry_idx ON leases(expires_at_ms);

INSERT INTO metadata(key, value) VALUES ('schema_version', '2');

INSERT INTO tasks(
  task_id, request_id, raw_hash, effective_hash, target, status, native_outcome, objective_verdict,
  cancel_requested, model_requested, model_resolved, model_reported, model_verified, provider, route_id,
  resolution_json, verification_json, decision_json, store_schema_version, core_version, created_at_ms, updated_at_ms
) VALUES (
  'fixture-task-v2', 'fixture-task-v2', 'raw-v2', 'effective-v2', 'opencode', 'queued', NULL, NULL,
  0, 'commandcode-goat/deepseek/deepseek-v4-flash', 'commandcode-goat/deepseek/deepseek-v4-flash', NULL, 0,
  'opencode', 'commandcode-goat/deepseek/deepseek-v4-flash', '{"kind":"exact"}',
  '{"status":"unverified"}', '{"schema_version":"1.0","target":"opencode"}', 2, 'fixture-core-v2', 1000, 1001
);

INSERT INTO attempts(
  attempt_id, task_id, ordinal, status, submission, adapter_version, native_cli_version,
  owner_nonce, fencing_token, heartbeat_at_ms, created_at_ms, started_at_ms, finished_at_ms
) VALUES (
  'fixture-attempt-v2', 'fixture-task-v2', 1, 'queued', 'not_sent', 'fixture-adapter-v2', '1.18.13',
  NULL, NULL, NULL, 1000, NULL, NULL
);

INSERT INTO native_sessions(id, attempt_id, target, native_session_id, native_task_id, native_status, evidence_ref)
VALUES (1, 'fixture-attempt-v2', 'opencode', 'fixture-session-v2', NULL, 'historical-fixture', 'fixture:event');

INSERT INTO events(id, task_id, attempt_id, sequence, type, payload_json, created_at_ms)
VALUES (1, 'fixture-task-v2', 'fixture-attempt-v2', 1, 'task.queued', '{"fixture":true}', 1001);

INSERT INTO leases(resource_key, resource_type, owner_nonce, epoch, fencing_token, expires_at_ms, metadata_json)
VALUES ('fixture:lease', 'fixture', 'fixture-owner', 1, 'fixture-fence', 9999999999999, '{"fixture":true}');

INSERT INTO idempotency(request_id, raw_hash, effective_hash, task_id)
VALUES ('fixture-task-v2', 'raw-v2', 'effective-v2', 'fixture-task-v2');
