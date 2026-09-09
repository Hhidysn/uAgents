import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { HostStore, resolveHostRoot } from "../plugins/uagents/src/host/host-store.mjs";

const invalidWorkspace = (err) => err.code === "invalid_workspace";
const invalidInput = (err) => err.code === "invalid_input";
const leaseConflict = (err) => err.code === "lease_conflict";

function makeEnv() {
  const localAppData = mkdtempSync(join(tmpdir(), "ua-host-store-"));
  return { env: { LOCALAPPDATA: localAppData }, localAppData };
}

function withStore(t) {
  const { env, localAppData } = makeEnv();
  let store;
  t.after(() => {
    store?.close();
    rmSync(localAppData, { recursive: true, force: true });
  });
  store = new HostStore({ env });
  return { store, env, localAppData };
}

test("resolveHostRoot defaults to process.env and resolves LOCALAPPDATA/uAgents/host-v1", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-host-root-"));
  try {
    const resolved = resolveHostRoot({ LOCALAPPDATA: root });
    assert.equal(resolved, join(root, "uAgents", "host-v1"));
    assert.equal(isAbsolute(resolved), true);
    assert.equal(typeof resolveHostRoot(), "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveHostRoot rejects missing or relative LOCALAPPDATA", () => {
  assert.throws(() => resolveHostRoot({}), invalidWorkspace);
  assert.throws(() => resolveHostRoot({ LOCALAPPDATA: "relative/path" }), invalidWorkspace);
  assert.throws(() => resolveHostRoot({ LOCALAPPDATA: 42 }), invalidWorkspace);
});

test("opens host.db in WAL mode with task-schema leases table and schema_version=1", (t) => {
  const { store } = withStore(t);
  const tables = store
    .raw("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((row) => row.name);
  assert.deepEqual(tables, ["installations", "leases", "managed_instances", "metadata"]);
  assert.equal(store.raw("PRAGMA journal_mode")[0].journal_mode, "wal");
  const [version] = store.raw("SELECT value FROM metadata WHERE key = 'schema_version'");
  assert.equal(version.value, "1");
  const columns = store.raw("PRAGMA table_info(leases)").map((col) => col.name);
  assert.deepEqual(columns, [
    "resource_key",
    "resource_type",
    "owner_nonce",
    "epoch",
    "fencing_token",
    "expires_at_ms",
    "metadata_json",
  ]);
});

test("constructor only accepts env injection; task root cannot move host root or host.db", (t) => {
  const { store, localAppData } = withStore(t);
  const taskRoot = mkdtempSync(join(tmpdir(), "ua-task-root-"));
  t.after(() => rmSync(taskRoot, { recursive: true, force: true }));

  assert.equal(existsSync(join(localAppData, "uAgents", "host-v1", "host.db")), true);
  assert.equal(existsSync(join(taskRoot, "uAgents", "host-v1", "host.db")), false);
  assert.equal(existsSync(join(taskRoot, "host.db")), false);

  store.upsertInstallation("shared", { id: "shared" });

  const same = new HostStore({ env: { LOCALAPPDATA: localAppData }, taskRoot, root: taskRoot });
  try {
    assert.deepEqual(same.getInstallation("shared"), { id: "shared" });
  } finally {
    same.close();
  }
  assert.equal(existsSync(join(taskRoot, "uAgents", "host-v1", "host.db")), false);
});

test("installations: upsert, get, invalidate", (t) => {
  const { store } = withStore(t);
  assert.equal(store.getInstallation("inst-1"), null);
  store.upsertInstallation("inst-1", { id: "inst-1", version: "1.0.0" });
  store.upsertInstallation("inst-1", { id: "inst-1", version: "1.0.1" });
  assert.deepEqual(store.getInstallation("inst-1"), { id: "inst-1", version: "1.0.1" });
  store.invalidateInstallation("inst-1");
  assert.equal(store.getInstallation("inst-1"), null);
  store.invalidateInstallation("missing");
  assert.equal(store.getInstallation("missing"), null);
});

test("managed instances: upsert, get", (t) => {
  const { store } = withStore(t);
  assert.equal(store.getManagedInstance("run-1"), null);
  store.upsertManagedInstance("run-1", { id: "run-1", installationId: "inst-1", pid: 4242 });
  assert.deepEqual(store.getManagedInstance("run-1"), {
    id: "run-1",
    installationId: "inst-1",
    pid: 4242,
  });
});

test("markManagedInstanceStale keeps the row and stamps status/stale_at_ms", (t) => {
  const { store, env } = withStore(t);
  const before = Date.now() - 5_000;
  store.upsertManagedInstance("run-1", { id: "run-1", installationId: "inst-1", pid: 4242 });
  store.markManagedInstanceStale("run-1", { now: before });

  const stale = store.getManagedInstance("run-1");
  assert.notEqual(stale, null);
  assert.equal(stale.status, "stale");
  assert.equal(stale.stale_at_ms, before);
  const [rawRow] = store.raw("SELECT payload FROM managed_instances WHERE instance_id = ?", [
    "run-1",
  ]);
  assert.equal(rawRow.payload, JSON.stringify(stale));

  const reopened = new HostStore({ env });
  try {
    const persisted = reopened.getManagedInstance("run-1");
    assert.equal(persisted.status, "stale");
    assert.equal(persisted.stale_at_ms, before);
    assert.equal(persisted.pid, 4242);
  } finally {
    reopened.close();
  }

  assert.equal(store.markManagedInstanceStale("missing"), false);
});

test("rejects payloads containing forbidden keys at any depth, case-insensitive", (t) => {
  const { store } = withStore(t);
  for (const key of [
    "prompt", "token", "secret", "password", "cookie", "authorization",
    "api_key", "apiKey", "private_key", "privateKey",
  ]) {
    assert.throws(() => store.upsertInstallation("k", { [key]: "x" }), invalidInput);
  }
  assert.throws(
    () => store.upsertInstallation("k", { nested: { list: [{ token: "x" }] } }),
    invalidInput
  );
  assert.throws(
    () => store.upsertManagedInstance("m", { env: { AUTHORIZATION: "Bearer x" } }),
    invalidInput
  );
  assert.throws(
    () => store.upsertInstallation("k", { config: { api_token: "abc" } }),
    invalidInput
  );
  assert.throws(
    () => store.upsertManagedInstance("m", { auth: { clientSecret: "zzz" } }),
    invalidInput
  );
  assert.throws(() => store.upsertInstallation("k", { My_Prompt_Text: 1 }), invalidInput);
  assert.throws(
    () => store.acquireLease("k", { ownerNonce: "o", metadata: { api_token: "x" } }),
    invalidInput
  );
  assert.equal(store.getInstallation("k"), null);
  assert.equal(store.getManagedInstance("m"), null);
});

test("raw access is read-only and cannot bypass sensitive-field validation", (t) => {
  const { store } = withStore(t);
  assert.throws(
    () => store.raw("INSERT INTO installations(id, payload, updated_at) VALUES (?, ?, ?)", [
      "unsafe",
      JSON.stringify({ api_token: "x" }),
      Date.now(),
    ]),
    invalidInput
  );
  assert.equal(store.getInstallation("unsafe"), null);
});

test("transaction commits, nests, passes database, and rolls back", (t) => {
  const { store } = withStore(t);
  const result = store.transaction((database) => {
    assert.equal(typeof database.prepare, "function");
    store.upsertInstallation("a", { id: "a" });
    store.transaction(() => store.upsertInstallation("n", { id: "n" }));
    store.upsertInstallation("b", { id: "b" });
    return 7;
  });
  assert.equal(result, 7);
  assert.deepEqual(store.getInstallation("a"), { id: "a" });
  assert.deepEqual(store.getInstallation("n"), { id: "n" });
  assert.deepEqual(store.getInstallation("b"), { id: "b" });
  assert.throws(
    () =>
      store.transaction(() => {
        store.upsertInstallation("c", { id: "c" });
        throw new Error("boom");
      }),
    /boom/
  );
  assert.equal(store.getInstallation("c"), null);
});

test("acquireLease: first acquire has epoch=1 and expired leases are taken over at epoch=2", (t) => {
  const { store } = withStore(t);
  const first = store.acquireLease("host:primary", {
    ownerNonce: "owner-a",
    ttlMs: 1_000,
    now: 1_000,
    metadata: { workspace: "F:/repo" },
  });
  assert.equal(first.epoch, 1);
  assert.equal(first.resource_type, "host");
  assert.equal(first.owner_nonce, "owner-a");
  assert.equal(first.expires_at_ms, 2_000);
  assert.equal(typeof first.fencing_token, "string");
  assert.deepEqual(JSON.parse(store.raw("SELECT metadata_json FROM leases WHERE resource_key = 'host:primary'")[0].metadata_json), { workspace: "F:/repo" });

  assert.throws(
    () =>
      store.acquireLease("host:primary", {
        ownerNonce: "owner-b",
        ttlMs: 1_000,
        now: 1_500,
      }),
    leaseConflict
  );

  const takeover = store.acquireLease("host:primary", {
    ownerNonce: "owner-b",
    ttlMs: 1_000,
    now: 2_001,
  });
  assert.equal(takeover.epoch, 2);
  assert.notEqual(takeover.fencing_token, first.fencing_token);
  assert.equal(takeover.owner_nonce, "owner-b");
});

test("old owner cannot renew or assert after takeover, and old release does not delete the new lease", (t) => {
  const { store } = withStore(t);
  const first = store.acquireLease("host:primary", {
    ownerNonce: "owner-a",
    ttlMs: 100,
    now: 1_000,
  });
  const second = store.acquireLease("host:primary", {
    ownerNonce: "owner-b",
    ttlMs: 1_000,
    now: 1_101,
  });
  assert.equal(second.epoch, 2);

  assert.throws(() => store.renewLease(first, { ttlMs: 100, now: 1_200 }), leaseConflict);
  assert.throws(() => store.assertLease(first, 1_200), leaseConflict);

  store.releaseLease(first);
  const stillThere = store.raw("SELECT owner_nonce, epoch FROM leases WHERE resource_key = 'host:primary'")[0];
  assert.equal(stillThere.owner_nonce, "owner-b");
  assert.equal(Number(stillThere.epoch), 2);

  const renewed = store.renewLease(second, { ttlMs: 1_000, now: 1_300 });
  assert.equal(renewed.expires_at_ms, 2_300);
  assert.equal(store.assertLease(second, 1_400), true);
  store.releaseLease(second);
  assert.equal(store.raw("SELECT resource_key FROM leases WHERE resource_key = 'host:primary'").length, 0);
});

test("close is idempotent and raw fails afterwards", (t) => {
  const { env, localAppData } = makeEnv();
  t.after(() => rmSync(localAppData, { recursive: true, force: true }));
  const store = new HostStore({ env });
  store.close();
  store.close();
  assert.throws(() => store.raw("SELECT 1"));
});
