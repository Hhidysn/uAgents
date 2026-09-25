// agent-locator.test.mjs
//
// Fixture tests for the Windows agent locator (Gate 2.2). PowerShell is always
// injected via a fake runner returning preset JSON documents - the tests never
// spawn a real powershell.exe. Each test gets a real HostStore under a fresh
// .local/test-runs/<uuid> directory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { HostStore, HostStoreError } from "../plugins/uagents/src/host/host-store.mjs";
import { createAgentLocator, createDefaultRunner, VERIFIER_VERSION, CACHE_ID_PREFIX } from "../plugins/uagents/src/host/agent-locator.mjs";
import { UAgentsError } from "../plugins/uagents/src/protocol/errors.mjs";

const CACHE_ID = (target) => `${CACHE_ID_PREFIX}${target}`;

// ── helpers ────────────────────────────────────────────────────────────────

function makeTestEnv(t) {
  const root = path.resolve(".local", "test-runs", randomUUID());
  const apps = path.join(root, "apps");
  mkdirSync(apps, { recursive: true });
  const env = { LOCALAPPDATA: root };
  const store = new HostStore({ env });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, env, apps, root };
}

function writeApp(dir, name, content = "app") {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, content, "utf8");
  const stat = statSync(filePath);
  return { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs };
}

function checkTable(overrides = {}) {
  return {
    canonical_ok: true,
    volume_ok: true,
    signature_ok: true,
    product_ok: true,
    publisher_ok: true,
    executable_ok: true,
    ...overrides,
  };
}

function verifyResponse(overrides = {}) {
  const canonicalPath = overrides.canonical_path ?? overrides.path;
  const checks = checkTable(overrides.checks);
  return {
    ok: checks.canonical_ok && checks.volume_ok && checks.signature_ok && checks.product_ok && checks.publisher_ok && checks.executable_ok,
    canonical_path: canonicalPath,
    signature: { status: overrides.signatureStatus ?? "Valid", status_message: overrides.signatureMessage ?? "Signature validated." },
    product_name: overrides.product_name ?? "TestDoubao",
    publisher: overrides.publisher ?? "Test Publisher",
    file_version: overrides.file_version ?? "1.0.0",
    size: overrides.size ?? 1234,
    mtime_ms: overrides.mtime_ms ?? 1700000000000,
    sha256: overrides.sha256 ?? null,
    checks,
  };
}

function discoverResponse(candidates) {
  return { ok: true, candidates };
}

function discoverCandidate(pathStr, discoverySource, exists = true) {
  return {
    path: pathStr,
    discovery_source: discoverySource,
    exists,
    product_name: null,
    publisher: null,
    file_version: null,
    size: null,
    mtime_ms: null,
  };
}

function pathEquals(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

// Fake runner with per-action presets; records every call.
function makeFakeRunner({ discover, verifyByPath, onVerify = null } = {}) {
  const calls = { discover: [], verify: [], all: [] };
  const runner = async (action, payload) => {
    calls.all.push({ action, payload });
    if (action === "discover-installations") {
      calls.discover.push(payload);
      if (typeof discover === "function") return discover(payload);
      return discover;
    }
    if (action === "verify-installation") {
      calls.verify.push(payload);
      if (typeof onVerify === "function") onVerify(payload);
      const entry = (verifyByPath ?? {})[payload.path.toLowerCase()];
      if (typeof entry === "function") return entry(payload);
      if (entry) return entry;
      throw new Error(`unexpected verify-installation call for ${payload.path}`);
    }
    throw new Error(`unexpected action ${action}`);
  };
  return { runner, calls };
}

// Reusable injected manifest; mirrors the shape of TARGET_MANIFESTS.
function manifest(overrides = {}) {
  return {
    target: "doubao",
    artifact_kind: "desktop-exe",
    accepted_product_names: ["TestDoubao"],
    accepted_publishers: ["Test Publisher"],
    accepted_executable_names: ["Doubao.exe"],
    known_install_locations: [],
    path_commands: [],
    version_probe: "file_version",
    profile_strategy: "dedicated-profile",
    readiness_probe: "cdp-listener",
    product_priority: [],
    ...overrides,
  };
}

function cacheRecord(overrides = {}) {
  return {
    installation_id: "inst-cached",
    target: "doubao",
    canonical_path: overrides.canonical_path ?? "C:\\Apps\\Doubao\\Doubao.exe",
    discovery_source: "uninstall_registry",
    artifact_kind: "desktop-exe",
    product_name: "TestDoubao",
    publisher: "Test Publisher",
    file_version: "1.0.0",
    sha256: null,
    size: 1234,
    mtime: 1700000000000,
    verifier_version: VERIFIER_VERSION,
    status: "trusted",
    verified_at_ms: 1600000000000,
    last_success_at_ms: 1600000000000,
    ...overrides,
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

test("1) multiple valid candidates are deterministically ranked (higher FileVersion, then canonical path)", async (t) => {
  const { store, apps } = makeTestEnv(t);
  const dirA = path.join(apps, "a");
  const dirM = path.join(apps, "m");
  const dirZ = path.join(apps, "z");
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirM, { recursive: true });
  mkdirSync(dirZ, { recursive: true });
  const a = path.join(dirA, "Doubao.exe");
  const m = path.join(dirM, "Doubao.exe");
  const z = path.join(dirZ, "Doubao.exe");
  writeFileSync(a, "a", "utf8");
  writeFileSync(m, "m", "utf8");
  writeFileSync(z, "z", "utf8");

  const fake = makeFakeRunner({
    discover: discoverResponse([
      discoverCandidate(z, "uninstall_registry"),
      discoverCandidate(a, "app_paths"),
      discoverCandidate(m, "known_locations"),
    ]),
    verifyByPath: {
      [z.toLowerCase()]: verifyResponse({ canonical_path: z, file_version: "2.0.0" }),
      [a.toLowerCase()]: verifyResponse({ canonical_path: a, file_version: "2.0.0" }),
      [m.toLowerCase()]: verifyResponse({ canonical_path: m, file_version: "1.0.0" }),
    },
  });

  const locator = createAgentLocator({ hostStore: store, runPowerShell: fake.runner, manifests: { doubao: manifest() } });
  const result = await locator.resolve("doubao");
  assert.equal(result.installation.canonical_path, a);
  assert.equal(result.installation.file_version, "2.0.0");
  assert.equal(result.reused_cache, false);
  assert.equal(result.discovery_source, "app_paths");
  // tie-break on canonical path lexicographic ascending
  assert.equal(fake.calls.verify.length, 3);
  const cache = store.getInstallation(CACHE_ID("doubao"));
  assert.equal(cache.canonical_path, a);
  assert.equal(cache.status, "trusted");
});

test("2) unchanged cache hit is reused without any verify call", async (t) => {
  const { store, apps } = makeTestEnv(t);
  const file = writeApp(apps, "Doubao.exe");
  const cached = cacheRecord({
    canonical_path: file.path,
    size: file.size,
    mtime: Math.round(file.mtimeMs),
    last_success_at_ms: 1600000000000,
    verified_at_ms: 1600000000000,
  });
  store.upsertInstallation(CACHE_ID("doubao"), cached);

  const fake = makeFakeRunner({ discover: discoverResponse([]) });
  const locator = createAgentLocator({
    hostStore: store,
    runPowerShell: fake.runner,
    now: () => 1750000000000,
    manifests: { doubao: manifest() },
  });

  const result = await locator.resolve("doubao");
  assert.equal(result.reused_cache, true);
  assert.equal(fake.calls.verify.length, 0);
  assert.equal(fake.calls.discover.length, 1);
  assert.equal(result.installation.canonical_path, file.path);
  const updated = store.getInstallation(CACHE_ID("doubao"));
  assert.equal(updated.last_success_at_ms, 1750000000000);
  assert.equal(updated.verified_at_ms, 1600000000000);
  assert.equal(updated.size, file.size);
});

test("3) cache hit with changed size/mtime triggers a full re-verify and cache update", async (t) => {
  const { store, apps } = makeTestEnv(t);
  const file = writeApp(apps, "Doubao.exe", "old");
  const stale = cacheRecord({
    canonical_path: file.path,
    size: 999,
    mtime: 1000000000000,
    verified_at_ms: 1600000000000,
  });
  store.upsertInstallation(CACHE_ID("doubao"), stale);

  const fake = makeFakeRunner({
    discover: discoverResponse([]),
    verifyByPath: {
      [file.path.toLowerCase()]: verifyResponse({ canonical_path: file.path, file_version: "2.0.0", size: 5000, mtime_ms: 1710000000000 }),
    },
  });
  const locator = createAgentLocator({ hostStore: store, runPowerShell: fake.runner, manifests: { doubao: manifest() } });

  const result = await locator.resolve("doubao");
  assert.equal(result.reused_cache, false);
  assert.equal(fake.calls.verify.length, 1);
  assert.equal(result.installation.file_version, "2.0.0");
  const updated = store.getInstallation(CACHE_ID("doubao"));
  assert.equal(updated.size, 5000);
  assert.equal(updated.mtime, 1710000000000);
  assert.equal(updated.file_version, "2.0.0");
  assert.notEqual(updated.verified_at_ms, 1600000000000);
});

test("4) vanished cache path is invalidated and discovery continues to the next candidate", async (t) => {
  const { store, apps } = makeTestEnv(t);
  const ghost = path.join(apps, "Ghost", "Doubao.exe");
  const cached = cacheRecord({ canonical_path: ghost, size: 1234, mtime: 1700000000000 });
  store.upsertInstallation(CACHE_ID("doubao"), cached);

  const survivorDir = path.join(apps, "survivor");
  mkdirSync(survivorDir, { recursive: true });
  const survivor = path.join(survivorDir, "Doubao.exe");
  writeFileSync(survivor, "s", "utf8");

  const fake = makeFakeRunner({
    discover: discoverResponse([discoverCandidate(survivor, "uninstall_registry")]),
    verifyByPath: {
      [survivor.toLowerCase()]: verifyResponse({ canonical_path: survivor, file_version: "3.0.0" }),
    },
  });
  const locator = createAgentLocator({ hostStore: store, runPowerShell: fake.runner, manifests: { doubao: manifest() } });

  const result = await locator.resolve("doubao");
  assert.equal(result.reused_cache, false);
  assert.equal(result.installation.canonical_path, survivor);
  assert.equal(fake.calls.verify.length, 1);
  const cache = store.getInstallation(CACHE_ID("doubao"));
  assert.equal(cache.canonical_path, survivor);
});

test("5) a candidate from the wrong publisher is rejected with installation_untrusted", async (t) => {
  const { store, apps } = makeTestEnv(t);
  const imposter = path.join(apps, "Imposter.exe");
  writeFileSync(imposter, "x", "utf8");

  const fake = makeFakeRunner({
    discover: discoverResponse([discoverCandidate(imposter, "uninstall_registry")]),
    verifyByPath: {
      [imposter.toLowerCase()]: verifyResponse({
        canonical_path: imposter,
        publisher: "Malicious Corp",
        checks: { publisher_ok: false },
      }),
    },
  });
  const locator = createAgentLocator({ hostStore: store, runPowerShell: fake.runner, manifests: { doubao: manifest() } });

  await assert.rejects(
    () => locator.resolve("doubao"),
    (err) => err instanceof UAgentsError && err.code === "installation_untrusted" && err.submission === "not_sent"
  );
  assert.equal(store.getInstallation(CACHE_ID("doubao")), null);
});

test("6) a fake same-name file with the wrong product name is rejected", async (t) => {
  const { store, apps } = makeTestEnv(t);
  const fakeExe = path.join(apps, "Doubao.exe");
  writeFileSync(fakeExe, "x", "utf8");

  const fake = makeFakeRunner({
    discover: discoverResponse([discoverCandidate(fakeExe, "path")]),
    verifyByPath: {
      [fakeExe.toLowerCase()]: verifyResponse({
        canonical_path: fakeExe,
        product_name: "Totally Different Product",
        checks: { product_ok: false },
      }),
    },
  });
  const locator = createAgentLocator({ hostStore: store, runPowerShell: fake.runner, manifests: { doubao: manifest() } });

  await assert.rejects(
    () => locator.resolve("doubao"),
    (err) => err instanceof UAgentsError && err.code === "installation_untrusted"
  );
  assert.equal(store.getInstallation(CACHE_ID("doubao")), null);
});

test("7) explicit config path wins but still must pass verification", async (t) => {
  const { store, apps } = makeTestEnv(t);
  const dirExplicit = path.join(apps, "explicit");
  const dirOther = path.join(apps, "other");
  mkdirSync(dirExplicit, { recursive: true });
  mkdirSync(dirOther, { recursive: true });
  const explicit = path.join(dirExplicit, "Doubao.exe");
  const other = path.join(dirOther, "Doubao.exe");
  writeFileSync(explicit, "e", "utf8");
  writeFileSync(other, "o", "utf8");

  const fake = makeFakeRunner({
    discover: discoverResponse([
      discoverCandidate(explicit, "explicit"),
      discoverCandidate(other, "known_locations"),
    ]),
    verifyByPath: {
      [explicit.toLowerCase()]: verifyResponse({ canonical_path: explicit, file_version: "1.0.0" }),
      [other.toLowerCase()]: verifyResponse({ canonical_path: other, file_version: "9.9.9" }),
    },
  });
  const locator = createAgentLocator({
    hostStore: store,
    runPowerShell: fake.runner,
    configOverrides: { explicit_paths: { doubao: [explicit] } },
    manifests: { doubao: manifest() },
  });

  const result = await locator.resolve("doubao");
  assert.equal(result.installation.canonical_path, explicit);
  assert.equal(result.discovery_source, "explicit_config");
});

test("7b) an untrusted explicit path is not trusted by virtue of being configured", async (t) => {
  const { store, apps } = makeTestEnv(t);
  const explicit = path.join(apps, "Doubao.exe");
  writeFileSync(explicit, "x", "utf8");

  const fake = makeFakeRunner({
    discover: discoverResponse([discoverCandidate(explicit, "explicit")]),
    verifyByPath: {
      [explicit.toLowerCase()]: verifyResponse({
        canonical_path: explicit,
        checks: { product_ok: false, publisher_ok: false },
      }),
    },
  });
  const locator = createAgentLocator({
    hostStore: store,
    runPowerShell: fake.runner,
    configOverrides: { explicit_paths: { doubao: [explicit] } },
    manifests: { doubao: manifest() },
  });

  await assert.rejects(
    () => locator.resolve("doubao"),
    (err) => err instanceof UAgentsError && err.code === "installation_untrusted"
  );
});

test("8) inspect performs no cache read or write and returns candidate details", async (t) => {
  const { store, apps } = makeTestEnv(t);
  const real = path.join(apps, "Doubao.exe");
  const ghost = path.join(apps, "Ghost.exe");
  writeFileSync(real, "r", "utf8");

  const fake = makeFakeRunner({
    discover: discoverResponse([
      discoverCandidate(real, "uninstall_registry"),
      discoverCandidate(ghost, "known_locations", false),
    ]),
    verifyByPath: {
      [real.toLowerCase()]: verifyResponse({ canonical_path: real, file_version: "1.2.3" }),
    },
  });
  const locator = createAgentLocator({ hostStore: store, runPowerShell: fake.runner, manifests: { doubao: manifest() } });

  const inspection = await locator.inspect("doubao");
  assert.equal(inspection.target, "doubao");
  assert.equal(inspection.candidates.length, 2);
  const existing = inspection.candidates.find((c) => c.exists === true);
  const missing = inspection.candidates.find((c) => c.exists === false);
  assert.equal(existing.verification.file_version, "1.2.3");
  assert.equal(existing.verification.checks.product_ok, true);
  assert.equal(missing.verification, null);
  assert.equal(store.getInstallation(CACHE_ID("doubao")), null);
  const rows = store.raw("SELECT id FROM installations");
  assert.equal(rows.length, 0);
  assert.equal(fake.calls.discover.length, 1);
});

test("9) default runner surfaces timeout, bad JSON and non-zero exit as HostStoreError", async (t) => {
  // helper to stub powershell.exe
  const stubSpawn = ({ stdout = "", exitCode = 0, hang = false } = {}) => {
    const calls = [];
    const spawnImpl = (file, args, options) => {
      calls.push({ file, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.stdin.on("error", () => {});
      child.kill = () => {
        if (!hang) return;
        setImmediate(() => child.emit("close", null, "SIGTERM"));
      };
      if (!hang) {
        setImmediate(() => {
          child.stdout.end(stdout);
          child.stderr.end();
          child.emit("close", exitCode);
        });
      }
      return child;
    };
    return { spawnImpl, calls };
  };

  // valid document
  {
    const stub = stubSpawn({ stdout: '{"ok":true,"value":1}' });
    const runner = createDefaultRunner({ spawnImpl: stub.spawnImpl });
    const result = await runner("verify-installation", { path: "x" });
    assert.deepEqual(result, { ok: true, value: 1 });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].file, "powershell.exe");
    const joined = stub.calls[0].args.join(" ");
    assert.match(joined, /-NoProfile/);
    assert.match(joined, /-NonInteractive/);
    assert.match(joined, /-ExecutionPolicy Bypass/);
    assert.match(joined, /windows-host\.ps1/);
    assert.match(joined, /-Action verify-installation/);
  }

  // timeout -> host_script_timeout
  {
    const stub = stubSpawn({ hang: true });
    const runner = createDefaultRunner({ spawnImpl: stub.spawnImpl, timeoutMs: 40 });
    await assert.rejects(
      () => runner("discover-installations", {}),
      (err) => err instanceof HostStoreError && err.code === "host_script_timeout"
    );
  }

  // bad JSON -> host_script_failed
  {
    const stub = stubSpawn({ stdout: "this is not json" });
    const runner = createDefaultRunner({ spawnImpl: stub.spawnImpl, timeoutMs: 1000 });
    await assert.rejects(
      () => runner("discover-installations", {}),
      (err) => err instanceof HostStoreError && err.code === "host_script_failed"
    );
  }

  // non-zero exit -> host_script_failed
  {
    const stub = stubSpawn({ stdout: "{}", exitCode: 3 });
    const runner = createDefaultRunner({ spawnImpl: stub.spawnImpl, timeoutMs: 1000 });
    await assert.rejects(
      () => runner("discover-installations", {}),
      (err) => err instanceof HostStoreError && err.code === "host_script_failed"
    );
  }
});

test("9b) cli-entry resolution computes sha256 in Node without PowerShell hashing", async (t) => {
  const { store, apps } = makeTestEnv(t);
  const cli = path.join(apps, "opencode.exe");
  writeFileSync(cli, "MZ fixture executable", "utf8");
  const stats = statSync(cli);
  const expectedHash = createHash("sha256").update(readFileSync(cli)).digest("hex");

  const cliManifest = manifest({
    target: "opencode",
    artifact_kind: "cli-entry",
    accepted_product_names: [],
    accepted_publishers: [],
    accepted_executable_names: ["opencode.exe", "opencode.cmd", "opencode"],
    path_commands: ["opencode"],
  });
  const fake = makeFakeRunner({
    discover: discoverResponse([discoverCandidate(cli, "path")]),
    verifyByPath: {
      [cli.toLowerCase()]: verifyResponse({
        canonical_path: cli,
        product_name: null,
        publisher: null,
        file_version: null,
        signature: { status: "NotSigned", status_message: "" },
        sha256: null,
        size: stats.size,
        mtime_ms: Math.round(stats.mtimeMs),
      }),
    },
  });
  const locator = createAgentLocator({ hostStore: store, runPowerShell: fake.runner, manifests: { opencode: cliManifest } });

  const result = await locator.resolve("opencode");
  assert.equal(result.installation.artifact_kind, "cli-entry");
  assert.equal(result.installation.sha256, expectedHash);
  // PowerShell identity verification remains separate from Node-side hashing.
  const verifyPayload = fake.calls.verify[0];
  assert.equal(verifyPayload.hash_required, undefined);
  assert.equal(fake.calls.verify.length, 1);
});

test("9d) an npm shim discovery hint resolves and caches the real OpenCode executable", async (t) => {
  const { store, apps } = makeTestEnv(t);
  const npmRoot = path.join(apps, "npm path");
  const shim = path.join(npmRoot, "opencode");
  const binary = path.join(npmRoot, "node_modules", "opencode-ai", "bin", "opencode.exe");
  mkdirSync(path.dirname(binary), { recursive: true });
  writeFileSync(shim, "#!/bin/sh\nexec node_modules/opencode-ai/bin/opencode.exe\n", "utf8");
  writeFileSync(binary, "MZ fixture native executable", "utf8");
  const stats = statSync(binary);
  const expectedHash = createHash("sha256").update(readFileSync(binary)).digest("hex");
  const cliManifest = manifest({
    target: "opencode",
    artifact_kind: "cli-entry",
    accepted_product_names: [],
    accepted_publishers: [],
    accepted_executable_names: ["opencode.exe", "opencode.cmd", "opencode.ps1", "opencode"],
    path_commands: ["opencode"],
  });
  const fake = makeFakeRunner({
    discover: discoverResponse([discoverCandidate(shim, "path")]),
    verifyByPath: {
      [binary.toLowerCase()]: verifyResponse({
        canonical_path: binary,
        product_name: null,
        publisher: null,
        file_version: null,
        size: stats.size,
        mtime_ms: Math.round(stats.mtimeMs),
        sha256: null,
      }),
    },
  });
  const locator = createAgentLocator({ hostStore: store, runPowerShell: fake.runner, manifests: { opencode: cliManifest } });

  const result = await locator.resolve("opencode");
  assert.equal(result.installation.canonical_path, binary);
  assert.equal(path.extname(result.installation.canonical_path).toLowerCase(), ".exe");
  assert.equal(result.installation.sha256, expectedHash);
  assert.equal(fake.calls.verify.length, 1);
  assert.equal(fake.calls.verify[0].path, binary);
  assert.equal(store.getInstallation(CACHE_ID("opencode")).canonical_path, binary);
});

test("9f) a dsh npm shim resolves to the package JS bin entry", async (t) => {
  const { store, apps } = makeTestEnv(t);
  const npmRoot = path.join(apps, "dsh npm");
  const shim = path.join(npmRoot, "dsh.cmd");
  const packageRoot = path.join(npmRoot, "node_modules", "@deepseek-ai", "dsh");
  const packageJson = path.join(packageRoot, "package.json");
  const entry = path.join(packageRoot, "lib", "bin.js");
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(shim, "@echo off", "utf8");
  writeFileSync(packageJson, JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.5-rc.1", bin: { dsh: "lib/bin.js" } }), "utf8");
  writeFileSync(entry, "console.log('fixture dsh')", "utf8");
  const stats = statSync(entry);
  const expectedHash = createHash("sha256").update(readFileSync(entry)).digest("hex");
  const cliManifest = manifest({
    target: "dsh",
    artifact_kind: "cli-entry",
    accepted_product_names: [],
    accepted_publishers: [],
    accepted_executable_names: ["bin.js"],
    path_commands: ["dsh"],
  });
  const fake = makeFakeRunner({
    discover: discoverResponse([discoverCandidate(shim, "path")]),
    verifyByPath: {
      [entry.toLowerCase()]: verifyResponse({
        canonical_path: entry,
        product_name: null,
        publisher: null,
        file_version: null,
        size: stats.size,
        mtime_ms: Math.round(stats.mtimeMs),
        sha256: null,
      }),
    },
  });
  const locator = createAgentLocator({ hostStore: store, runPowerShell: fake.runner, manifests: { dsh: cliManifest } });

  const result = await locator.resolve("dsh");
  assert.equal(result.installation.canonical_path, entry);
  assert.equal(result.installation.sha256, expectedHash);
  assert.equal(fake.calls.verify.length, 1);
  assert.equal(fake.calls.verify[0].path, entry);
  assert.equal(store.getInstallation(CACHE_ID("dsh")).canonical_path, entry);
});

test("9g) a Codex npm shim resolves to the package JS bin entry", async (t) => {
  const { store, apps } = makeTestEnv(t);
  const npmRoot = path.join(apps, "codex npm");
  const shim = path.join(npmRoot, "codex.cmd");
  const packageRoot = path.join(npmRoot, "node_modules", "@openai", "codex");
  const packageJson = path.join(packageRoot, "package.json");
  const entry = path.join(packageRoot, "bin", "codex.js");
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(shim, "@echo off", "utf8");
  writeFileSync(packageJson, JSON.stringify({ name: "@openai/codex", version: "0.153.4", bin: { codex: "bin/codex.js" } }), "utf8");
  writeFileSync(entry, "console.log('fixture codex')", "utf8");
  const stats = statSync(entry);
  const expectedHash = createHash("sha256").update(readFileSync(entry)).digest("hex");
  const cliManifest = manifest({
    target: "codex",
    artifact_kind: "cli-entry",
    accepted_product_names: [],
    accepted_publishers: [],
    accepted_executable_names: ["codex.js"],
    path_commands: ["codex"],
  });
  const fake = makeFakeRunner({
    discover: discoverResponse([discoverCandidate(shim, "path")]),
    verifyByPath: {
      [entry.toLowerCase()]: verifyResponse({
        canonical_path: entry, product_name: null, publisher: null, file_version: null,
        size: stats.size, mtime_ms: Math.round(stats.mtimeMs), sha256: null,
      }),
    },
  });
  const locator = createAgentLocator({ hostStore: store, runPowerShell: fake.runner, manifests: { codex: cliManifest } });
  const result = await locator.resolve("codex");
  assert.equal(result.installation.canonical_path, entry);
  assert.equal(result.installation.sha256, expectedHash);
  assert.equal(fake.calls.verify[0].path, entry);
  assert.equal(store.getInstallation(CACHE_ID("codex")).canonical_path, entry);
});

test("9h) a Claude Code npm shim resolves to the package native executable", { skip: process.platform !== "win32" }, async (t) => {
  const { store, apps } = makeTestEnv(t);
  const npmRoot = path.join(apps, "claude npm");
  const shim = path.join(npmRoot, "claude.cmd");
  const packageRoot = path.join(npmRoot, "node_modules", "@anthropic-ai", "claude-code");
  const packageJson = path.join(packageRoot, "package.json");
  const entry = path.join(packageRoot, "bin", "claude.exe");
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(shim, "@echo off", "utf8");
  writeFileSync(packageJson, JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.251", bin: { claude: "bin/claude.exe" } }), "utf8");
  writeFileSync(entry, "MZ fixture claude", "utf8");
  const stats = statSync(entry);
  const expectedHash = createHash("sha256").update(readFileSync(entry)).digest("hex");
  const cliManifest = manifest({ target: "claudeCode", artifact_kind: "cli-entry",
    accepted_product_names: ["Claude Code"], accepted_publishers: ["Anthropic PBC"],
    accepted_executable_names: ["claude.exe"], path_commands: ["claude"] });
  const fake = makeFakeRunner({ discover: discoverResponse([discoverCandidate(shim, "path")]),
    verifyByPath: { [entry.toLowerCase()]: verifyResponse({ canonical_path: entry,
      product_name: "Claude Code", publisher: "Anthropic PBC", size: stats.size,
      mtime_ms: Math.round(stats.mtimeMs), sha256: null }) } });
  const locator = createAgentLocator({ hostStore: store, runPowerShell: fake.runner, manifests: { claudeCode: cliManifest } });
  const result = await locator.resolve("claudeCode");
  assert.equal(result.installation.canonical_path, entry);
  assert.equal(result.installation.sha256, expectedHash);
  assert.equal(fake.calls.verify[0].path, entry);
});

test("9e) a cached OpenCode shim is not reused as the final installation entry", async (t) => {
  const { store, apps } = makeTestEnv(t);
  const npmRoot = path.join(apps, "cached npm");
  const shim = path.join(npmRoot, "opencode.cmd");
  const binary = path.join(npmRoot, "node_modules", "opencode-ai", "bin", "opencode.exe");
  mkdirSync(path.dirname(binary), { recursive: true });
  writeFileSync(shim, "@echo off", "utf8");
  writeFileSync(binary, "MZ cached fixture native executable", "utf8");
  const shimStats = statSync(shim);
  const binaryStats = statSync(binary);
  const expectedHash = createHash("sha256").update(readFileSync(binary)).digest("hex");
  store.upsertInstallation(CACHE_ID("opencode"), {
    installation_id: "inst-cached-shim",
    target: "opencode",
    canonical_path: shim,
    discovery_source: "path",
    artifact_kind: "cli-entry",
    product_name: null,
    publisher: null,
    file_version: null,
    sha256: null,
    size: shimStats.size,
    mtime: Math.round(shimStats.mtimeMs),
    verifier_version: VERIFIER_VERSION,
    status: "trusted",
    verified_at_ms: 1600000000000,
    last_success_at_ms: 1600000000000,
  });
  const cliManifest = manifest({
    target: "opencode",
    artifact_kind: "cli-entry",
    accepted_product_names: [],
    accepted_publishers: [],
    accepted_executable_names: ["opencode.exe", "opencode.cmd", "opencode"],
    path_commands: ["opencode"],
  });
  const fake = makeFakeRunner({
    discover: discoverResponse([discoverCandidate(shim, "path")]),
    verifyByPath: {
      [binary.toLowerCase()]: verifyResponse({
        canonical_path: binary,
        product_name: null,
        publisher: null,
        file_version: null,
        size: binaryStats.size,
        mtime_ms: Math.round(binaryStats.mtimeMs),
        sha256: null,
      }),
    },
  });
  const locator = createAgentLocator({ hostStore: store, runPowerShell: fake.runner, manifests: { opencode: cliManifest } });

  const result = await locator.resolve("opencode");
  assert.equal(result.reused_cache, false);
  assert.equal(result.installation.canonical_path, binary);
  assert.equal(result.installation.sha256, expectedHash);
  assert.equal(fake.calls.verify.length, 1);
});

test("9c) cached record whose identity changed on disk raises installation_changed", async (t) => {
  const { store, apps } = makeTestEnv(t);
  const file = writeApp(apps, "Doubao.exe");
  // Manifest with empty whitelists (as for CLI-style targets): any identity is
  // still "trusted" by verification, so the stale cached identity is the only
  // signal that the file at this path has been replaced.
  const openManifest = manifest({
    accepted_product_names: [],
    accepted_publishers: [],
  });
  // Stale record with the previous identity and an outdated size to force a re-verify.
  const cached = cacheRecord({
    canonical_path: file.path,
    size: 999,
    mtime: 1000000000000,
    product_name: "OldProduct",
    publisher: "Old Publisher",
  });
  store.upsertInstallation(CACHE_ID("doubao"), cached);

  const fake = makeFakeRunner({
    discover: discoverResponse([]),
    verifyByPath: {
      [file.path.toLowerCase()]: verifyResponse({
        canonical_path: file.path,
        product_name: "NewProduct",
        publisher: "New Publisher",
      }),
    },
  });
  const locator = createAgentLocator({ hostStore: store, runPowerShell: fake.runner, manifests: { doubao: openManifest } });

  await assert.rejects(
    () => locator.resolve("doubao"),
    (err) => err instanceof UAgentsError && err.code === "installation_changed"
  );
  assert.equal(store.getInstallation(CACHE_ID("doubao")), null);
});
