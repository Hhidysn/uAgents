import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fail } from '../protocol/errors.mjs';
import { MIGRATION_2_TO_3, SCHEMA_SQL, STORE_SCHEMA_VERSION } from './schema.mjs';

const V2_TABLES = Object.freeze(['metadata', 'tasks', 'attempts', 'native_sessions', 'events', 'leases', 'idempotency']);
const V3_TABLES = Object.freeze([...V2_TABLES, 'native_processes']);
const V3_INDEXES = Object.freeze(['events_task_idx', 'attempts_task_idx', 'native_sessions_attempt_idx', 'leases_expiry_idx', 'native_process_attempt_idx', 'native_process_guard_idx']);
const MIGRATION_BLOCKING_STATES = Object.freeze(['starting', 'running', 'waiting_user', 'indeterminate']);
const TERMINAL_STATES = Object.freeze(['succeeded', 'failed', 'cancelled']);
const NATIVE_PROCESS_COLUMNS = Object.freeze([
  'id', 'attempt_id', 'target', 'workspace_key', 'executable_path', 'executable_sha256', 'launch_fingerprint',
  'pid', 'process_started_at_ms', 'process_state', 'exit_code', 'stdout_relpath', 'stderr_relpath',
  'stdout_cursor_bytes', 'stderr_cursor_bytes', 'workspace_guard_state', 'observed_at_ms', 'exited_at_ms',
  'created_at_ms', 'updated_at_ms',
]);

export class ControlDatabase {
  #database;
  #transactionDepth = 0;

  constructor(root, { create = true, busyTimeoutMs = 10_000 } = {}) {
    if (!path.isAbsolute(root)) fail('invalid_workspace', 'Control database root must be absolute.');
    if (create) fs.mkdirSync(root, { recursive: true });
    const realRoot = fs.realpathSync(root);
    this.root = realRoot;
    this.file = path.join(realRoot, 'control.db');
    this.#database = new DatabaseSync(this.file);
    try {
      this.#database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${Number(busyTimeoutMs)};`);
      this.#initializeStore();
      // WAL is a supported-store runtime property, not migration evidence.
      // Enabling it only after schema/version acceptance keeps rejected
      // unknown, partial and migration-blocked stores byte-for-byte in their
      // prior journal mode.
      ensureWalMode(this.#database, busyTimeoutMs);
    } catch (error) {
      try { this.#database.close(); } catch {}
      throw error;
    }
  }

  get raw() { return this.#database; }

  transaction(operation, mode = 'IMMEDIATE') {
    if (this.#transactionDepth) return operation(this.#database);
    this.#database.exec(`BEGIN ${mode}`);
    this.#transactionDepth++;
    try {
      const result = operation(this.#database);
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#database.exec('ROLLBACK'); } catch {}
      throw error;
    } finally {
      this.#transactionDepth--;
    }
  }

  close() { this.#database.close(); }

  #initializeStore() {
    const userTables = this.#database.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map(row => row.name);

    if (!userTables.includes('metadata')) {
      if (userTables.length) {
        fail('incompatible_store_version', 'Control database contains tables but no schema metadata.');
      }
      this.transaction(database => {
        // Another process may have initialized this empty file after the
        // read above but before our BEGIN IMMEDIATE acquired the writer lock.
        // Re-check under the transaction so concurrent first-open is safe and
        // a concurrently-created partial store is never silently completed.
        const currentTables = database.prepare(`SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map(row => row.name);
        if (currentTables.includes('metadata')) return;
        if (currentTables.length) fail('incompatible_store_version', 'Control database contains tables but no schema metadata.');
        database.exec(SCHEMA_SQL);
        database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('schema_version', String(STORE_SCHEMA_VERSION));
      });
      // A concurrent initializer may have won the race. Route through the
      // normal version/schema checks instead of assuming our branch created it.
      return this.#initializeStore();
    }

    const metadata = this.#database.prepare('SELECT value FROM metadata WHERE key = ?').get('schema_version');
    if (!metadata || !/^\d+$/.test(String(metadata.value))) {
      fail('incompatible_store_version', 'Control database schema metadata is missing or invalid.');
    }
    const version = Number(metadata.value);
    if (version === STORE_SCHEMA_VERSION) {
      this.#verifySchema(V3_TABLES, V3_INDEXES, version);
      this.#verifyNativeProcessSchema();
      return;
    }
    if (version !== 2) fail('incompatible_store_version', `Unsupported store schema version: ${version}`);

    this.#verifySchema(V2_TABLES, [], version);
    this.transaction(database => {
      // Re-evaluate under BEGIN IMMEDIATE. An older runtime may have changed
      // a task between the initial schema read and our writer-lock acquire.
      const blockers = migrationBlockers(database);
      if (blockers.length) {
        fail('store_migration_blocked', 'Control store v2 contains tasks that may already have started native execution.', {
          category: 'runtime', retryable: true, submission: 'not_sent', details: { blockers },
        });
      }
      try {
        database.exec(MIGRATION_2_TO_3);
      } catch (error) {
        fail('incompatible_store_version', 'Control store v2 could not be migrated to schema 3.', {
          category: 'runtime', retryable: false, submission: 'not_sent', details: { cause_code: 'migration_failed' }, cause: error,
        });
      }
      database.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(String(STORE_SCHEMA_VERSION), 'schema_version');
    });
    this.#verifySchema(V3_TABLES, V3_INDEXES, STORE_SCHEMA_VERSION);
    this.#verifyNativeProcessSchema();
  }

  #verifySchema(requiredTables, requiredIndexes, version) {
    const tables = new Set(this.#database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(row => row.name));
    const indexes = new Set(this.#database.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all().map(row => row.name));
    const missingTables = requiredTables.filter(name => !tables.has(name));
    const missingIndexes = requiredIndexes.filter(name => !indexes.has(name));
    if (missingTables.length || missingIndexes.length) {
      fail('incompatible_store_version', `Control database schema ${version} is incomplete.`, {
        details: { missing_tables: missingTables, missing_indexes: missingIndexes },
      });
    }
  }

  #verifyNativeProcessSchema() {
    const columns = this.#database.prepare("PRAGMA table_info('native_processes')").all();
    const names = columns.map(row => String(row.name));
    if (names.length !== NATIVE_PROCESS_COLUMNS.length || names.some((name, index) => name !== NATIVE_PROCESS_COLUMNS[index])) {
      fail('incompatible_store_version', 'Control database schema 3 has an incompatible native_processes column layout.');
    }
    const byName = new Map(columns.map(row => [String(row.name), row]));
    const requiredNotNull = [
      'attempt_id', 'target', 'executable_path', 'launch_fingerprint', 'process_state', 'stdout_relpath', 'stderr_relpath',
      'stdout_cursor_bytes', 'stderr_cursor_bytes', 'workspace_guard_state', 'observed_at_ms', 'created_at_ms', 'updated_at_ms',
    ];
    if (Number(byName.get('id')?.pk) !== 1 || requiredNotNull.some(name => Number(byName.get(name)?.notnull) !== 1)) {
      fail('incompatible_store_version', 'Control database schema 3 has incompatible native_processes key/nullability constraints.');
    }

    const foreignKeys = this.#database.prepare("PRAGMA foreign_key_list('native_processes')").all();
    const attemptForeignKey = foreignKeys.some(row => row.table === 'attempts' && row.from === 'attempt_id' && row.to === 'attempt_id');
    if (!attemptForeignKey) fail('incompatible_store_version', 'Control database schema 3 is missing the native process Attempt foreign key.');

    assertIndexColumns(this.#database, 'native_process_attempt_idx', ['attempt_id']);
    assertIndexColumns(this.#database, 'native_process_guard_idx', ['workspace_guard_state', 'process_state']);

    const tableSql = String(this.#database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'native_processes'").get()?.sql ?? '')
      .replace(/\s+/g, ' ').toLowerCase();
    const requiredChecks = [
      "process_state in ('starting', 'running', 'exited', 'unknown')",
      "workspace_guard_state in ('held', 'released', 'unknown')",
      'stdout_cursor_bytes >= 0',
      'stderr_cursor_bytes >= 0',
      "process_state != 'running' or (pid is not null and process_started_at_ms is not null)",
    ];
    if (requiredChecks.some(fragment => !tableSql.includes(fragment))) {
      fail('incompatible_store_version', 'Control database schema 3 is missing required native process constraints.');
    }
  }
}

export function appendEvent(database, { taskId, attemptId = null, type, payload = {}, now = Date.now() }) {
  const next = Number(database.prepare('SELECT coalesce(max(sequence), 0) + 1 AS sequence FROM events WHERE task_id = ?').get(taskId).sequence);
  database.prepare('INSERT INTO events(task_id, attempt_id, sequence, type, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
    .run(taskId, attemptId, next, type, JSON.stringify(payload), now);
  return next;
}

function ensureWalMode(database, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  for (;;) {
    try {
      const journalMode = database.prepare('PRAGMA journal_mode = WAL').get().journal_mode;
      if (String(journalMode).toLowerCase() !== 'wal') fail('store_initialization_failed', 'SQLite WAL mode could not be enabled.');
      return;
    } catch (error) {
      if (!sqliteBusy(error) || Date.now() >= deadline) throw error;
      const remaining = Math.max(1, deadline - Date.now());
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(25, remaining));
    }
  }
}

function sqliteBusy(error) {
  return Number(error?.errcode) === 5 || /database is (?:locked|busy)/i.test(String(error?.message ?? ''));
}

function migrationBlockers(database) {
  return database.prepare(`
    SELECT t.task_id, t.status AS task_status, a.submission
    FROM tasks t
    LEFT JOIN attempts a ON a.task_id = t.task_id
      AND a.ordinal = (SELECT max(a2.ordinal) FROM attempts a2 WHERE a2.task_id = t.task_id)
    WHERE t.status IN (${MIGRATION_BLOCKING_STATES.map(() => '?').join(', ')})
      OR a.submission = 'may_have_been_sent'
      OR (t.status NOT IN (${TERMINAL_STATES.map(() => '?').join(', ')}) AND a.submission = 'sent')
    ORDER BY t.task_id
  `).all(...MIGRATION_BLOCKING_STATES, ...TERMINAL_STATES).map(row => ({
    task_id: String(row.task_id),
    status: String(row.task_status),
    submission: row.submission === null ? null : String(row.submission),
  }));
}

function assertIndexColumns(database, indexName, expected) {
  const actual = database.prepare(`PRAGMA index_info('${indexName}')`).all().map(row => String(row.name));
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    fail('incompatible_store_version', `Control database schema 3 has an incompatible ${indexName} definition.`);
  }
}
