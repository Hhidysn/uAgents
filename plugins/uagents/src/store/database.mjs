import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fail } from '../protocol/errors.mjs';
import { SCHEMA_SQL, STORE_SCHEMA_VERSION } from './schema.mjs';

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
    this.#database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${Number(busyTimeoutMs)};`);
    const journalMode = this.#database.prepare('PRAGMA journal_mode = WAL').get().journal_mode;
    if (String(journalMode).toLowerCase() !== 'wal') fail('store_initialization_failed', 'SQLite WAL mode could not be enabled.');
    this.#database.exec(SCHEMA_SQL);
    this.#database.prepare('INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)').run('schema_version', String(STORE_SCHEMA_VERSION));
    const version = Number(this.#database.prepare('SELECT value FROM metadata WHERE key = ?').get('schema_version').value);
    if (version !== STORE_SCHEMA_VERSION) fail('incompatible_store_version', `Unsupported store schema version: ${version}`);
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
}

export function appendEvent(database, { taskId, attemptId = null, type, payload = {}, now = Date.now() }) {
  const next = Number(database.prepare('SELECT coalesce(max(sequence), 0) + 1 AS sequence FROM events WHERE task_id = ?').get(taskId).sequence);
  database.prepare('INSERT INTO events(task_id, attempt_id, sequence, type, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
    .run(taskId, attemptId, next, type, JSON.stringify(payload), now);
  return next;
}
