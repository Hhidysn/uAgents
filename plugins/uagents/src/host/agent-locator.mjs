// agent-locator.mjs
//
// Windows agent discovery and trust verification (Gate 2.2, "Windows Agent Locator").
// Finds installations for managed targets (Doubao, TRAE, OpenCode, WorkBuddy, agy),
// verifies them against per-target manifests via the fixed PowerShell script
// (plugins/uagents/scripts/windows-host.ps1), and keeps a per-target trusted
// installation cache in the HostStore `installations` table.
//
// Discovery order (design 7.1): explicit config paths -> valid cache ->
// App Paths -> uninstall registry -> manifest known directories -> PATH.
// A cache hit is re-checked for path/size/mtime on every resolve; any change
// triggers a full re-verification and cache upsert.
//
// All failure signalling for resolve uses errors.mjs `fail()` with
// submission = 'not_sent' and minimally de-sensitised details (cause/path only,
// never environment or secrets).

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HostStoreError } from "./host-store.mjs";
import { fail } from "../protocol/errors.mjs";
import { nativeCliCandidates } from "../transports/cli-process.mjs";

export const VERIFIER_VERSION = "windows-host-v1";
export const DEFAULT_RUNNER_TIMEOUT_MS = 20_000;
export const CACHE_ID_PREFIX = "installation:";
const OPEN_CODE_SHIM_NAMES = new Set(["opencode", "opencode.cmd", "opencode.ps1"]);

// NOTE: launch_recipe intentionally does NOT live in the manifest; it stays in the
// per-target launcher modules (Gate 4/5) because it is version-controlled executable
// code, never data loaded from a cache.
//
// ── Identity sources ────────────────────────────────────────────────────────
// Product names, publishers, executable names and known install locations below
// were confirmed by read-only probes of the development machine (2026-09-05,
// registry uninstall entries + VersionInfo + Authenticode):
//   doubao : DoubaoWork.exe, ProductName "DoubaoWork Launcher", publisher
//            "Beijing Chuntian Zhiyun Technology Co., Ltd.", Authenticode Valid,
//            install dir %LOCALAPPDATA%\DoubaoWork\Application.
//   trae   : "Trae CN" and "TRAE SOLO CN" variants, publisher "Beijing Yinli
//            Catapult Technology Co., Ltd.", Authenticode Valid, both under
//            %LOCALAPPDATA%\Programs\. Trae CN wins via product_priority.
//   agy    : %LOCALAPPDATA%\agy\bin\agy.exe (no product/publisher metadata).
//   workbuddy : codebuddy.js inside the verified WorkBuddy install tree.
// Fields still pending the Gate 0 live spike: launch arguments, dedicated
// profile/CDP isolation, readiness surfaces. opencode keeps empty identity
// whitelists on purpose (npm CLI without version metadata; verified by
// structure + path resolution only).
// ───────────────────────────────────────────────────────────────────────────
export const TARGET_MANIFESTS = Object.freeze({
  doubao: Object.freeze({
    target: "doubao",
    artifact_kind: "desktop-exe",
    // Read-only probe 2026-09-05: registry DisplayName is the localized "豆包"
    // name, so uninstall discovery relies on DisplayIcon/known locations rather
    // than an ASCII display-name pattern.
    accepted_product_names: ["DoubaoWork Launcher"],
    accepted_publishers: ["Beijing Chuntian Zhiyun Technology Co., Ltd."],
    accepted_executable_names: ["DoubaoWork.exe"],
    known_install_locations: ["%LOCALAPPDATA%\\DoubaoWork\\Application\\DoubaoWork.exe"],
    path_commands: [],
    version_probe: "file_version",
    profile_strategy: "dedicated-profile",
    readiness_probe: "cdp-listener",
    product_priority: [],
  }),
  trae: Object.freeze({
    target: "trae",
    artifact_kind: "desktop-exe",
    // Read-only probe 2026-09-05: both variants are Authenticode-valid installs
    // from the same publisher; Trae CN is the documented primary variant.
    accepted_product_names: ["Trae CN", "TRAE SOLO CN"],
    accepted_publishers: ["Beijing Yinli Catapult Technology Co., Ltd."],
    accepted_executable_names: ["Trae CN.exe", "TRAE SOLO CN.exe"],
    known_install_locations: [
      "%LOCALAPPDATA%\\Programs\\Trae CN\\Trae CN.exe",
      "%LOCALAPPDATA%\\Programs\\TRAE SOLO CN\\TRAE SOLO CN.exe",
    ],
    path_commands: [],
    version_probe: "file_version",
    profile_strategy: "dedicated-profile",
    readiness_probe: "gateway-status",
    product_priority: ["Trae CN", "TRAE SOLO CN"],
  }),
  opencode: Object.freeze({
    target: "opencode",
    artifact_kind: "cli-entry",
    // [Gate 0] npm CLI: no publisher/product metadata is expected; entry points
    // and package layout still need live confirmation.
    accepted_product_names: [],
    accepted_publishers: [],
    accepted_executable_names: ["opencode", "opencode.cmd", "opencode.exe"],
    known_install_locations: [], // pending Gate 0.
    path_commands: ["opencode"],
    version_probe: "cli-version-flag",
    profile_strategy: "inherit-env",
    readiness_probe: "process-exit",
    product_priority: [],
  }),
  workbuddy: Object.freeze({
    target: "workbuddy",
    artifact_kind: "cli-entry",
    // Read-only probe 2026-09-05: codebuddy.js lives inside the WorkBuddy
    // install tree under resources/app.asar.unpacked/cli/dist/.
    accepted_product_names: [],
    accepted_publishers: [],
    accepted_executable_names: ["codebuddy.js"],
    known_install_locations: [
      "%ProgramFiles%\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\dist\\codebuddy.js",
    ],
    path_commands: [],
    version_probe: "cli-version-flag",
    profile_strategy: "inherit-env",
    readiness_probe: "process-exit",
    product_priority: [],
  }),
  agy: Object.freeze({
    target: "agy",
    artifact_kind: "cli-entry",
    // Read-only probe 2026-09-05: agy.exe under %LOCALAPPDATA%\agy\bin carries
    // no product/publisher metadata; verified by structure and path only.
    accepted_product_names: [],
    accepted_publishers: [],
    accepted_executable_names: ["agy", "agy.cmd", "agy.exe"],
    known_install_locations: ["%LOCALAPPDATA%\\agy\\bin\\agy.exe"],
    path_commands: ["agy"],
    version_probe: "cli-version-flag",
    profile_strategy: "inherit-env",
    readiness_probe: "process-exit",
    product_priority: [],
  }),
});

const DEFAULT_SCRIPT_URL = new URL("../../scripts/windows-host.ps1", import.meta.url);

function cacheIdFor(target) {
  return `${CACHE_ID_PREFIX}${target}`;
}

function installationIdentity(target, canonicalPath) {
  const digest = createHash("sha256").update(`${target}\n${canonicalPath}`).digest("hex");
  return `inst-${digest.slice(0, 24)}`;
}

// Expand %VAR% tokens against the injected environment (defaults to process.env).
function expandLocation(value, environment) {
  return String(value).replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (match, name) => {
    const resolved = environment && environment[name];
    return typeof resolved === "string" && resolved.length > 0 ? resolved : match;
  });
}

// Cheap cache freshness probe (path/size/mtime) performed directly via fs.stat.
// PowerShell is only used for discovery and identity verification.
async function statCandidate(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function sameMtime(leftMs, rightMs) {
  return typeof leftMs === "number" && typeof rightMs === "number" && Math.abs(leftMs - rightMs) <= 2;
}

// Hash CLI entries in the Node host process. The PowerShell host script runs
// with -NoProfile and is intentionally limited to identity checks; relying on
// a profile-provided Get-FileHash makes a valid installation appear untrusted
// on otherwise supported Windows hosts.
export async function hashFileSha256(filePath) {
  let before;
  try {
    before = await fs.stat(filePath);
  } catch {
    return null;
  }
  if (!before.isFile()) return null;

  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  } catch {
    return null;
  }

  let after;
  try {
    after = await fs.stat(filePath);
  } catch {
    return null;
  }
  if (
    !after.isFile() ||
    before.size !== after.size ||
    !sameMtime(before.mtimeMs, after.mtimeMs) ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  ) return null;

  return { sha256: hash.digest("hex"), size: before.size, mtime_ms: before.mtimeMs };
}

function isOpenCodeNativeExecutable(candidatePath) {
  return process.platform === "win32" &&
    path.extname(candidatePath).toLowerCase() === ".exe" &&
    path.basename(candidatePath).toLowerCase() === "opencode.exe";
}

// Discovery is allowed to return an npm shim as a hint, but only a directly
// spawnable .exe can enter the trusted installation cache. Reuse the same
// native npm-layout candidate generator as the CLI transport and never invoke
// a shell to resolve the hint.
export async function resolveNativeExecutableCandidates(target, candidatePath) {
  if (target !== "opencode" || process.platform !== "win32") return [candidatePath];
  if (isOpenCodeNativeExecutable(candidatePath)) return [candidatePath];

  const leaf = path.basename(candidatePath).toLowerCase();
  if (!OPEN_CODE_SHIM_NAMES.has(leaf)) return [];
  const directory = path.dirname(path.resolve(candidatePath));
  const candidates = nativeCliCandidates("opencode", { PATH: directory });
  const resolved = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    const key = normalized.toLowerCase();
    if (seen.has(key) || !isOpenCodeNativeExecutable(normalized)) continue;
    seen.add(key);
    if (await statCandidate(normalized)) resolved.push(normalized);
  }
  return resolved;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeIdentityValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function basenameLower(p) {
  return typeof p === "string" ? path.basename(p).toLowerCase() : "";
}

// Does a cached record still describe something compatible with the manifest
// (identity whitelist unchanged between plugin versions)?
function isCacheCompatible(record, manifest) {
  if (!record || typeof record.canonical_path !== "string") return false;
  if (record.target !== manifest.target) return false;
  if (record.artifact_kind !== manifest.artifact_kind) return false;
  const product = normalizeIdentityValue(record.product_name);
  if (manifest.accepted_product_names.length > 0 && product.length > 0) {
    if (!manifest.accepted_product_names.some((p) => product.toUpperCase() === String(p).toUpperCase())) {
      return false;
    }
  }
  const publisher = normalizeIdentityValue(record.publisher);
  if (manifest.accepted_publishers.length > 0 && publisher.length > 0) {
    if (!manifest.accepted_publishers.some((p) => publisher.toUpperCase() === String(p).toUpperCase())) {
      return false;
    }
  }
  if (manifest.accepted_executable_names.length > 0) {
    const leaf = basenameLower(record.canonical_path);
    if (!manifest.accepted_executable_names.some((n) => basenameLower(n) === leaf)) {
      return false;
    }
  }
  if (manifest.target === "opencode" && process.platform === "win32" && !isOpenCodeNativeExecutable(record.canonical_path)) {
    return false;
  }
  if (manifest.artifact_kind === "cli-entry" && !/^[a-f0-9]{64}$/i.test(String(record.sha256 ?? ""))) {
    return false;
  }
  return true;
}

// Verify response from the script is trusted (checks all true).
function isTrustedResult(result, { requireHash = false } = {}) {
  return Boolean(
    isPlainObject(result) &&
      result.ok === true &&
      isPlainObject(result.checks) &&
      result.checks.canonical_ok === true &&
      result.checks.volume_ok === true &&
      result.checks.signature_ok === true &&
      result.checks.product_ok === true &&
      result.checks.publisher_ok === true &&
      result.checks.executable_ok === true &&
      (!requireHash || result.checks.hash_ok === true)
  );
}

// Distinguish a script-level failure ({ok:false,error:{...}}, no `checks`) from a
// per-candidate verification verdict ({ok,checks,...}). Script-level failures are
// infrastructure problems, not candidate verdicts, and must surface as such.
function assertVerificationDocument(result) {
  if (!isPlainObject(result)) {
    throw new HostStoreError("host_script_failed", "verify-installation returned an invalid document");
  }
  if (isPlainObject(result.error) && !isPlainObject(result.checks)) {
    throw new HostStoreError("host_script_failed", "verify-installation reported a host script error");
  }
  return result;
}

// Does a re-verification result still match the cached identity record?
// Product/publisher/canonical identity must match; file_version/size/mtime/sha
// are allowed to change (that is an upgrade, not an identity change).
function identityMatchesRecord(record, result) {
  const leftPath = typeof record.canonical_path === "string" ? record.canonical_path : "";
  const rightPath = typeof result.canonical_path === "string" ? result.canonical_path : "";
  if (basenameLower(leftPath) !== basenameLower(rightPath)) return false;
  const leftProduct = normalizeIdentityValue(record.product_name);
  const rightProduct = normalizeIdentityValue(result.product_name);
  if (leftProduct && rightProduct && leftProduct.toUpperCase() !== rightProduct.toUpperCase()) return false;
  const leftPublisher = normalizeIdentityValue(record.publisher);
  const rightPublisher = normalizeIdentityValue(result.publisher);
  if (leftPublisher && rightPublisher && leftPublisher.toUpperCase() !== rightPublisher.toUpperCase()) return false;
  return true;
}

function parseVersion(value) {
  const text = normalizeIdentityValue(value);
  if (!text) return [0];
  const parts = text.split(/[.\-+]/).map((part) => {
    const numeric = Number.parseInt(part, 10);
    return Number.isNaN(numeric) ? 0 : numeric;
  });
  while (parts.length > 0 && parts[parts.length - 1] === 0) parts.pop();
  return parts.length > 0 ? parts : [0];
}

function compareVersion(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    const av = i < a.length ? a[i] : 0;
    const bv = i < b.length ? b[i] : 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// Deterministic selection: explicit config first, then last-success cache,
// then product_priority -> FileVersion descending -> canonical path ascending.
function selectInstallation(candidates, manifest) {
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      priority: manifest.product_priority.indexOf(candidate.product_name),
    }))
    .sort((left, right) => {
      if (left.candidate.tier !== right.candidate.tier) return left.candidate.tier - right.candidate.tier;
      const lp = left.priority === -1 ? Number.MAX_SAFE_INTEGER : left.priority;
      const rp = right.priority === -1 ? Number.MAX_SAFE_INTEGER : right.priority;
      if (lp !== rp) return lp - rp;
      const versionDiff = compareVersion(right.candidate.file_version, left.candidate.file_version);
      if (versionDiff !== 0) return versionDiff;
      return String(left.candidate.canonical_path).localeCompare(String(right.candidate.canonical_path));
    });
  return ranked[0].candidate;
}

// Default runner: spawns the fixed PowerShell script, feeds stdin JSON, collects
// stdout, kills on timeout, parses the single JSON document.
export function createDefaultRunner({
  spawnImpl = spawn,
  timeoutMs = DEFAULT_RUNNER_TIMEOUT_MS,
  scriptUrl = DEFAULT_SCRIPT_URL,
} = {}) {
  const scriptPath = fileURLToPath(scriptUrl);
  return function runPowerShell(action, payload) {
    return new Promise((resolvePromise, rejectPromise) => {
      let child;
      try {
        child = spawnImpl("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-Action",
          action,
        ], {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        rejectPromise(new HostStoreError("host_script_failed", "failed to start the windows host script"));
        return;
      }

      let stdout = "";
      let settled = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          // ignore
        }
      }, timeoutMs);

      const finish = (fn, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(error);
      };

      child.stdout?.setEncoding?.("utf8");
      child.stdout?.on?.("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on?.("data", () => {
        // stderr is intentionally ignored: it may carry PowerShell error text and
        // must never reach callers.
      });
      child.stdin?.on?.("error", () => {
        // EPIPE when the child exits before we finish writing; harmless.
      });
      child.on("error", () => {
        finish(rejectPromise, new HostStoreError("host_script_failed", "the windows host script could not be started"));
      });
      child.on("close", (code) => {
        if (timedOut) {
          finish(rejectPromise, new HostStoreError("host_script_timeout", "the windows host script timed out"));
          return;
        }
        if (code !== 0) {
          finish(rejectPromise, new HostStoreError("host_script_failed", `the windows host script exited with code ${code}`));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          finish(rejectPromise, new HostStoreError("host_script_failed", "the windows host script returned invalid JSON"));
          return;
        }
        if (!isPlainObject(parsed)) {
          finish(rejectPromise, new HostStoreError("host_script_failed", "the windows host script returned a non-object document"));
          return;
        }
        finish(resolvePromise, parsed);
      });

      try {
        child.stdin.write(JSON.stringify(payload ?? {}));
        child.stdin.end();
      } catch {
        // stdin 'error' handler above swallows the failure.
      }
    });
  };
}

function buildDiscoveryPayload(manifest, environment, { explicitPaths = [], includeUninstall = true } = {}) {
  const executableNames = manifest.accepted_executable_names;
  return {
    explicit_paths: explicitPaths.filter((p) => typeof p === "string" && p.length > 0),
    app_paths_names: executableNames,
    uninstall: includeUninstall
      ? {
          display_name_patterns: manifest.accepted_product_names.map((name) => `*${name}*`),
          executable_names: executableNames,
        }
      : {
          display_name_patterns: [],
          executable_names: executableNames,
        },
    known_locations: manifest.known_install_locations.map((location) => expandLocation(location, environment)),
    path_commands: manifest.path_commands,
  };
}

function buildVerifyPayload(manifest, candidatePath) {
  return {
    path: candidatePath,
    artifact_kind: manifest.artifact_kind,
    expected: {
      product_names: manifest.accepted_product_names,
      publishers: manifest.accepted_publishers,
      executable_names: manifest.accepted_executable_names,
    },
  };
}

async function verifyInstallation(runner, manifest, candidatePath) {
  const result = assertVerificationDocument(
    await runner("verify-installation", buildVerifyPayload(manifest, candidatePath))
  );
  return manifest.artifact_kind === "cli-entry" ? completeCliVerification(result) : result;
}

async function completeCliVerification(result) {
  const checks = { ...(result.checks ?? {}), hash_ok: false };
  let hashed = null;
  if (checks.canonical_ok === true && typeof result.canonical_path === "string") {
    hashed = await hashFileSha256(result.canonical_path);
  }
  const metadataMatches = Boolean(
    hashed &&
      (typeof result.size !== "number" || result.size === hashed.size) &&
      (typeof result.mtime_ms !== "number" || sameMtime(result.mtime_ms, hashed.mtime_ms))
  );
  checks.hash_ok = metadataMatches;
  return {
    ...result,
    sha256: metadataMatches ? hashed.sha256 : null,
    checks,
    ok: result.ok === true && checks.canonical_ok === true && checks.hash_ok === true,
  };
}

function discoveryTierFor(source) {
  return source === "explicit" ? 0 : 2;
}

function toCandidate(result, discoverySource, { tier = 2 } = {}) {
  return {
    tier,
    canonical_path: result.canonical_path,
    discovery_source: discoverySource,
    product_name: result.product_name ?? null,
    publisher: result.publisher ?? null,
    file_version: result.file_version ?? null,
    sha256: result.sha256 ?? null,
    size: typeof result.size === "number" ? result.size : null,
    mtime_ms: typeof result.mtime_ms === "number" ? result.mtime_ms : null,
  };
}

function toCandidateFromRecord(record, { tier = 1 } = {}) {
  return {
    tier,
    canonical_path: record.canonical_path,
    discovery_source: record.discovery_source ?? "cache",
    product_name: record.product_name ?? null,
    publisher: record.publisher ?? null,
    file_version: record.file_version ?? null,
    sha256: record.sha256 ?? null,
    size: typeof record.size === "number" ? record.size : null,
    mtime_ms: typeof record.mtime === "number" ? record.mtime : null,
    last_success_at_ms: typeof record.last_success_at_ms === "number" ? record.last_success_at_ms : null,
    verified_at_ms: typeof record.verified_at_ms === "number" ? record.verified_at_ms : null,
  };
}

export function createAgentLocator({
  hostStore,
  runPowerShell,
  env = process.env,
  now = () => Date.now(),
  configOverrides = null,
  manifests = null,
} = {}) {
  if (!hostStore) {
    throw new HostStoreError("invalid_input", "hostStore is required");
  }
  const runner = runPowerShell ?? createDefaultRunner({ env });
  const manifestTable = { ...TARGET_MANIFESTS, ...(manifests ?? {}) };

  function manifestFor(target) {
    const manifest = manifestTable[target];
    if (!manifest || typeof manifest.target !== "string") {
      fail("invalid_target", `unknown target "${target}"`, {
        category: "user",
        retryable: false,
        submission: "not_sent",
        details: { cause_code: "unknown_target" },
      });
    }
    return manifest;
  }

  function explicitPathsFor(target) {
    if (!configOverrides || typeof configOverrides !== "object") return [];
    const byTarget = configOverrides.explicit_paths ?? configOverrides.explicitPaths;
    if (!byTarget || typeof byTarget !== "object") return [];
    const entries = byTarget[target];
    return Array.isArray(entries) ? entries.filter((p) => typeof p === "string" && p.length > 0) : [];
  }

  // Read-only inspection: enumerate candidates (explicit first, then manifest
  // sources), verify each existing file, and report. Never starts a process and
  // never reads or writes the HostStore installations cache.
  async function inspect(target) {
    const manifest = manifestFor(target);
    const explicitPaths = explicitPathsFor(target);
    const discovery = await runner(
      "discover-installations",
      buildDiscoveryPayload(manifest, env, { explicitPaths })
    );
    if (!isPlainObject(discovery) || !Array.isArray(discovery.candidates)) {
      throw new HostStoreError("host_script_failed", "discover-installations returned an invalid document");
    }
    const candidates = [];
    const seen = new Set();
    for (const candidate of discovery.candidates) {
      if (!isPlainObject(candidate)) continue;
      const candidatePath = typeof candidate.path === "string" ? candidate.path : "";
      if (!candidatePath) continue;
      const seenKey = candidatePath.toLowerCase();
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);
      if (candidate.exists !== true) {
        candidates.push({
          path: candidatePath,
          discovery_source: candidate.discovery_source ?? null,
          exists: false,
          verification: null,
        });
        continue;
      }
      const resolvedPaths = await resolveNativeExecutableCandidates(manifest.target, candidatePath);
      const verification = resolvedPaths.length > 0
        ? await verifyInstallation(runner, manifest, resolvedPaths[0])
        : null;
      candidates.push({
        path: candidatePath,
        discovery_source: candidate.discovery_source ?? null,
        exists: true,
        ...(manifest.target === "opencode" ? { resolved_paths: resolvedPaths } : {}),
        verification,
      });
    }
    return { target, artifact_kind: manifest.artifact_kind, candidates };
  }

  // Resolve a trusted installation for `target`, refreshing the HostStore cache.
  // `refresh: true` bypasses the cache slot entirely.
  async function resolve(target, { refresh = false } = {}) {
    const manifest = manifestFor(target);
    const nowMs = now();
    const cacheId = cacheIdFor(target);
    const candidates = [];
    const attemptedPaths = new Set();
    let sawExistingCandidate = false;
    let reusedCache = false;

    const rememberAttempted = (p) => {
      if (typeof p === "string" && p.length > 0) attemptedPaths.add(p.toLowerCase());
    };

    // ── Explicit config paths (tier 0). Verified like anything else: an explicit
    //    path only raises priority, it never bypasses trust verification.
    for (const explicitPath of explicitPathsFor(target)) {
      rememberAttempted(explicitPath);
      const executablePaths = await resolveNativeExecutableCandidates(target, explicitPath);
      if (executablePaths.length === 0) {
        if (await statCandidate(explicitPath)) sawExistingCandidate = true;
        continue;
      }
      for (const executablePath of executablePaths) {
        rememberAttempted(executablePath);
        const result = await verifyInstallation(runner, manifest, executablePath);
        if (isTrustedResult(result, { requireHash: manifest.artifact_kind === "cli-entry" })) {
          candidates.push(toCandidate(result, "explicit_config", { tier: 0 }));
          continue;
        }
        if (isPlainObject(result) && result.checks && result.checks.canonical_ok === true) {
          sawExistingCandidate = true;
        }
      }
    }

    // ── Valid cache slot (tier 1). Path/size/mtime are re-checked on every
    //    resolve; any change forces a full re-verification and upsert.
    if (!refresh) {
      const cached = hostStore.getInstallation(cacheId);
      if (isCacheCompatible(cached, manifest)) {
        const stat = await statCandidate(cached.canonical_path);
        if (stat === null) {
          // The path vanished: invalidate and keep discovering.
          hostStore.invalidateInstallation(cacheId);
        } else if (
          stat.size === cached.size &&
          sameMtime(stat.mtimeMs, cached.mtime)
        ) {
          // Unchanged: reuse without a re-verify call.
          reusedCache = true;
          rememberAttempted(cached.canonical_path);
          candidates.push(toCandidateFromRecord(cached, { tier: 1 }));
        } else {
          // Changed on disk: full re-verification.
          rememberAttempted(cached.canonical_path);
          const result = await verifyInstallation(runner, manifest, cached.canonical_path);
          if (isPlainObject(result) && typeof result.canonical_path === "string") {
            rememberAttempted(result.canonical_path);
          }
          if (isTrustedResult(result, { requireHash: manifest.artifact_kind === "cli-entry" })) {
            if (identityMatchesRecord(cached, result)) {
              candidates.push(toCandidate(result, cached.discovery_source ?? "cache", { tier: 1 }));
            } else {
              // The file at the cached path is now a different product.
              hostStore.invalidateInstallation(cacheId);
              fail("installation_changed", "the cached installation identity changed on disk", {
                category: "target",
                retryable: true,
                submission: "not_sent",
                details: { cause_code: "identity_mismatch", path: result.canonical_path },
              });
            }
          } else {
            if (isPlainObject(result) && result.checks && result.checks.canonical_ok === true) {
              sawExistingCandidate = true;
            }
            hostStore.invalidateInstallation(cacheId);
          }
        }
      }
    }

    // ── App Paths -> uninstall registry -> known locations -> PATH, in the fixed
    //    script order. Explicit entries inside the discovery result are tier 0.
    const discovery = await runner(
      "discover-installations",
      buildDiscoveryPayload(manifest, env, { explicitPaths: explicitPathsFor(target) })
    );
    if (!isPlainObject(discovery) || !Array.isArray(discovery.candidates)) {
      throw new HostStoreError("host_script_failed", "discover-installations returned an invalid document");
    }
    for (const candidate of discovery.candidates) {
      if (!isPlainObject(candidate)) continue;
      if (candidate.exists !== true) continue;
      const discoveredPath = typeof candidate.path === "string" ? candidate.path : "";
      if (!discoveredPath) continue;
      const discoveredKey = discoveredPath.toLowerCase();
      if (attemptedPaths.has(discoveredKey)) continue;
      const executablePaths = await resolveNativeExecutableCandidates(target, discoveredPath);
      rememberAttempted(discoveredPath);
      if (executablePaths.length === 0) {
        sawExistingCandidate = true;
        continue;
      }
      for (const candidatePath of executablePaths) {
        // A native candidate can be the discovered path itself (for example an
        // explicit PATH entry that already ends in .exe). The raw discovery
        // hint is remembered above, so allow that one same-path candidate while
        // still suppressing candidates seen through an earlier hint.
        if (candidatePath.toLowerCase() !== discoveredKey && attemptedPaths.has(candidatePath.toLowerCase())) continue;
        rememberAttempted(candidatePath);
        const result = await verifyInstallation(runner, manifest, candidatePath);
        if (isTrustedResult(result, { requireHash: manifest.artifact_kind === "cli-entry" })) {
          const source = candidate.discovery_source ?? "discovery";
          candidates.push(toCandidate(result, source, { tier: discoveryTierFor(source) }));
        } else {
          sawExistingCandidate = true;
        }
      }
    }

    if (candidates.length === 0) {
      if (sawExistingCandidate) {
        fail("installation_untrusted", "no installation candidate passed trust verification", {
          category: "target",
          retryable: false,
          submission: "not_sent",
          details: { cause_code: "verification_failed" },
        });
      }
      fail("installation_not_found", "no installation candidate was found", {
        category: "target",
        retryable: true,
        submission: "not_sent",
        details: { cause_code: "discovery_empty" },
      });
    }

    const chosen = selectInstallation(candidates, manifest);

    const installation = {
      installation_id: installationIdentity(target, chosen.canonical_path),
      target,
      canonical_path: chosen.canonical_path,
      discovery_source: chosen.discovery_source,
      artifact_kind: manifest.artifact_kind,
      product_name: chosen.product_name,
      publisher: chosen.publisher,
      file_version: chosen.file_version,
      sha256: chosen.sha256,
      size: chosen.size,
      mtime: chosen.mtime_ms,
      verifier_version: VERIFIER_VERSION,
      status: "trusted",
      verified_at_ms: reusedCache ? chosen.verified_at_ms : nowMs,
      last_success_at_ms: nowMs,
    };
    hostStore.upsertInstallation(cacheId, installation);

    return {
      installation,
      discovery_source: installation.discovery_source,
      reused_cache: reusedCache,
    };
  }

  return { inspect, resolve };
}
