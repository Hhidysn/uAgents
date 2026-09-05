import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
  acquireLeaseRow,
  renewLeases,
  releaseLeases,
  assertFencing,
} from "../runtime/leases.mjs";

const FORBIDDEN_KEY_PATTERN = /prompt|token|secret|password|cookie|authorization/i;

const SCHEMA_VERSION = "1";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS installations (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS managed_instances (
  instance_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  resource_key TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  owner_nonce TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  fencing_token TEXT NOT NULL UNIQUE,
  expires_at_ms INTEGER NOT NULL,
  metadata_json TEXT NOT NULL
) STRICT;
`;

export class HostStoreError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = "HostStoreError";
    this.code = code;
  }
}

export function resolveHostRoot(env = process.env) {
  const base = env?.LOCALAPPDATA;
  if (typeof base !== "string" || base.length === 0 || !path.isAbsolute(base)) {
    throw new HostStoreError("invalid_workspace", "LOCALAPPDATA must be an absolute path");
  }
  return path.resolve(base, "uAgents", "host-v1");
}

function assertWritable(value, seen) {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      throw new HostStoreError("invalid_input", `refusing to persist forbidden key "${key}"`);
    }
    assertWritable(item, seen);
  }
}

export class HostStore {
  #db;
  #installUpsert;
  #installGet;
  #installDelete;
  #instanceUpsert;
  #instanceGet;
  #inTransaction = false;

  constructor({ env = process.env } = {}) {
    const hostRoot = resolveHostRoot(env);
    fs.mkdirSync(hostRoot, { recursive: true });
    const db = new DatabaseSync(path.join(hostRoot, "host.db"));
    this.#db = db;
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
    this.#installUpsert = db.prepare(
      "INSERT INTO installations (id, payload, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at"
    );
    this.#installGet = db.prepare("SELECT payload FROM installations WHERE id = ?");
    this.#installDelete = db.prepare("DELETE FROM installations WHERE id = ?");
    this.#instanceUpsert = db.prepare(
      "INSERT INTO managed_instances (instance_id, payload, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(instance_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at"
    );
    this.#instanceGet = db.prepare("SELECT payload FROM managed_instances WHERE instance_id = ?");
  }

  upsertInstallation(id, payload) {
    if (payload === undefined || payload === null) {
      throw new HostStoreError("invalid_input", "payload must be an object");
    }
    assertWritable(payload, new WeakSet());
    this.#installUpsert.run(id, JSON.stringify(payload), Date.now());
  }

  getInstallation(id) {
    const row = this.#installGet.get(id);
    return row === undefined ? null : JSON.parse(row.payload);
  }

  invalidateInstallation(id) {
    this.#installDelete.run(id);
  }

  upsertManagedInstance(instanceId, payload) {
    if (payload === undefined || payload === null) {
      throw new HostStoreError("invalid_input", "payload must be an object");
    }
    assertWritable(payload, new WeakSet());
    this.#instanceUpsert.run(instanceId, JSON.stringify(payload), Date.now());
  }

  getManagedInstance(instanceId) {
    const row = this.#instanceGet.get(instanceId);
    return row === undefined ? null : JSON.parse(row.payload);
  }

  markManagedInstanceStale(instanceId, { now = Date.now() } = {}) {
    const row = this.#instanceGet.get(instanceId);
    if (row === undefined) return false;
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = {};
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      payload = {};
    }
    payload.status = "stale";
    payload.stale_at_ms = now;
    this.#instanceUpsert.run(instanceId, JSON.stringify(payload), now);
    return true;
  }

  #sanitizeMetadata(metadata) {
    if (metadata === undefined || metadata === null) return {};
    if (typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new HostStoreError("invalid_input", "metadata must be an object");
    }
    assertWritable(metadata, new WeakSet());
    return metadata;
  }

  acquireLease(resourceKey, {
    resourceType = "host",
    ownerNonce,
    ttlMs = 30_000,
    now = Date.now(),
    metadata,
  } = {}) {
    if (typeof resourceKey !== "string" || resourceKey.length === 0) {
      throw new HostStoreError("invalid_input", "resourceKey must be a non-empty string");
    }
    if (typeof ownerNonce !== "string" || ownerNonce.length === 0) {
      throw new HostStoreError("invalid_input", "ownerNonce must be a non-empty string");
    }
    const safeMetadata = this.#sanitizeMetadata(metadata);
    return this.transaction((database) =>
      acquireLeaseRow(database, resourceKey, resourceType, ownerNonce, ttlMs, now, safeMetadata)
    );
  }

  renewLease(lease, { ttlMs = 30_000, now = Date.now() } = {}) {
    return renewLeases(this, [lease], { ttlMs, now })[0];
  }

  releaseLease(lease) {
    return releaseLeases(this, [lease]);
  }

  assertLease(lease, now = Date.now()) {
    if (!this.#db) {
      throw new HostStoreError("store_closed", "HostStore is closed");
    }
    return assertFencing(this.#db, lease, now);
  }

  transaction(fn) {
    if (typeof fn !== "function") {
      throw new HostStoreError("invalid_input", "transaction expects a function");
    }
    if (!this.#db) {
      throw new HostStoreError("store_closed", "HostStore is closed");
    }
    if (this.#inTransaction) {
      return fn(this.#db);
    }
    this.#inTransaction = true;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn(this.#db);
      this.#db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {}
      throw err;
    } finally {
      this.#inTransaction = false;
    }
  }

  raw(sql, params = []) {
    if (!this.#db) {
      throw new HostStoreError("store_closed", "HostStore is closed");
    }
    const verb = sql.trimStart().slice(0, 6).toUpperCase();
    if (verb !== "SELECT" && verb !== "PRAGMA") {
      throw new HostStoreError("invalid_input", "raw access is read-only");
    }
    return this.#db.prepare(sql).all(...params);
  }

  close() {
    const db = this.#db;
    if (!db) return;
    this.#db = null;
    db.close();
  }
}
