// target-supervisor.mjs
//
// Target Supervisor core (Gate 3.1 of the managed agent lifecycle plan).
// Owns the per-user lifecycle of managed desktop agent instances: inspect
// (read-only), ensure (lease + resolve + reuse-or-launch) and stop (kill only
// ownership-proven instances). CLI targets are resolved and cached but never
// receive a desktop instance lease.
//
// Invariants (design §9/§13/§16):
//   - Supervisor never receives or persists prompts; `ensure` context is
//     whitelist-filtered to non-sensitive keys only.
//   - PID alone is never ownership evidence: pid + started_at + canonical path
//     must jointly match; listener PID is spot-checked when a port is known.
//   - Ports held by unknown processes surface `port_identity_mismatch`; the
//     supervisor never connects to or terminates such processes.
//   - Stale instances are marked and replaced by a new generation, never killed
//     implicitly by `ensure`.
//   - Host instance leases reuse the HostStore epoch/fencing primitives; a
//     failed `ensure` never leaves a lease behind.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HostStoreError, resolveHostRoot } from "./host-store.mjs";
import { CACHE_ID_PREFIX, createDefaultRunner } from "./agent-locator.mjs";
import { fail } from "../protocol/errors.mjs";

// Launcher-provided instance fields that may be persisted. The capability
// token is deliberately absent: it lives only in the host secrets file and in
// memory for the current ensure result.
const PERSISTED_LAUNCHER_FIELDS = Object.freeze([
  "desktop_pid", "gateway_pid", "gateway_started_at_ms", "gateway_port",
  "capability_file", "instance_nonce", "adopted",
]);
export const INSTANCE_LEASE_PREFIX = "instance:";
export const STARTED_AT_TOLERANCE_MS = 1000;
export const TASKKILL_TIMEOUT_MS = 10_000;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Context is whitelist-filtered: the supervisor must never accept or persist
// prompt-like content. Only a workspace string, an optional preferred port
// (a non-sensitive integer used for the pre-launch port identity check) and
// a refresh flag for the locator cache pass.
function safeContext(context) {
  if (!isPlainObject(context)) return {};
  const out = {};
  if (typeof context.workspace === "string" && context.workspace.length > 0) {
    out.workspace = context.workspace;
  }
  if (Number.isInteger(context.preferredPort)) {
    out.preferredPort = context.preferredPort;
  }
  if (context.refresh === true) {
    out.refresh = true;
  }
  return out;
}

function pathEquals(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return left.toLowerCase() === right.toLowerCase();
}

// Ownership accepts the verified install tree, not only the exact exe: the
// Doubao launcher (Application\DoubaoWork.exe) spawns the real listener from
// Application\app\DoubaoWork.exe (Gate 0 spike evidence). Any executable
// inside the verified installation's directory tree counts as the same image.
export function executableInInstallTree(executablePath, installationPath) {
  if (typeof executablePath !== "string" || typeof installationPath !== "string") return false;
  if (pathEquals(executablePath, installationPath)) return true;
  const installDir = path.dirname(installationPath).toLowerCase();
  return executablePath.toLowerCase().startsWith(installDir + path.sep);
}

function parseInstancePayload(row) {
  const payload = JSON.parse(row.payload);
  if (
    isPlainObject(payload) &&
    typeof payload.instance_id === "string" &&
    typeof payload.target === "string"
  ) {
    return payload;
  }
  return null;
}

function lifecycleSummary(instance, reused) {
  return {
    state: instance.state ?? "ready",
    instance_id: instance.instance_id,
    installation_id: instance.installation_id,
    profile_generation: instance.generation,
    started_by_uagents: instance.started_by_uagents === true,
    reused: reused === true,
  };
}

// locator.resolve() returns {installation, discovery_source, reused_cache};
// accept that wrapper as well as a bare installation object (stub locators).
function installationFrom(resolveResult) {
  if (isPlainObject(resolveResult) && isPlainObject(resolveResult.installation)) {
    return resolveResult.installation;
  }
  return resolveResult;
}

export function createTargetSupervisor({
  hostStore,
  locator,
  runPowerShell,
  env = process.env,
  now = () => Date.now(),
  launchers = null,
  spawnImpl = spawn,
  leaseTtlMs = 30_000,
  ownerNonce = randomUUID(),
} = {}) {
  if (!hostStore) {
    throw new HostStoreError("invalid_input", "hostStore is required");
  }
  if (!locator || typeof locator.resolve !== "function") {
    throw new HostStoreError("invalid_input", "locator with resolve() is required");
  }
  const runner = runPowerShell ?? createDefaultRunner({ env });
  const launcherTable = launchers ?? {};

  function listInstances(target) {
    const rows = hostStore.raw("SELECT instance_id, payload FROM managed_instances");
    const instances = [];
    for (const row of rows) {
      const payload = parseInstancePayload(row);
      if (payload && payload.target === target) instances.push(payload);
    }
    instances.sort((left, right) => (left.generation ?? 0) - (right.generation ?? 0));
    return instances;
  }

  // Ownership evidence: pid + started_at (±1s) + canonical path must all match;
  // when the instance declares a port, the listener must be owned by the same
  // pid. Read-only PowerShell actions only.
  async function verifyOwnership(instance, installation) {
    if (!isPlainObject(instance) || !Number.isInteger(instance.process_id)) return false;
    let proc;
    try {
      proc = await runner("inspect-process", { pid: instance.process_id });
    } catch {
      return false;
    }
    if (!isPlainObject(proc) || proc.exists !== true) return false;
    const startedOk =
      typeof proc.started_at_ms === "number" &&
      typeof instance.process_started_at_ms === "number" &&
      Math.abs(proc.started_at_ms - instance.process_started_at_ms) <= STARTED_AT_TOLERANCE_MS;
    const pathOk = executableInInstallTree(proc.executable_path, installation.canonical_path);
    if (!startedOk || !pathOk) return false;
    if (Number.isInteger(instance.port)) {
      let listener;
      try {
        listener = await runner("inspect-listener", { port: instance.port });
      } catch {
        return false;
      }
      if (!isPlainObject(listener) || listener.listening !== true) return false;
      if (listener.listener_pid !== instance.process_id) return false;
    }
    return true;
  }

  // Read-only: cached installation (if any) plus all recorded instances for
  // the target. Never resolves, launches or writes.
  function inspect(target) {
    const rows = hostStore.raw("SELECT instance_id, payload FROM managed_instances");
    const instances = [];
    for (const row of rows) {
      const payload = parseInstancePayload(row);
      if (payload && payload.target === target) instances.push(payload);
    }
    instances.sort((left, right) => (left.generation ?? 0) - (right.generation ?? 0));
    const installation = hostStore.getInstallation(`${CACHE_ID_PREFIX}${target}`);
    return { target, installation, instances };
  }

  function leaseFor(target) {
    return hostStore.acquireLease(`${INSTANCE_LEASE_PREFIX}${target}`, {
      resourceType: "host-instance",
      ownerNonce,
      ttlMs: leaseTtlMs,
      now: now(),
      metadata: { target },
    });
  }

  async function ensure(target, context = {}) {
    const safe = safeContext(context);

    // Resolve first: CLI targets never hold a desktop instance lease, and
    // concurrent read-only resolves across Task DBs are harmless. Only the
    // launch path is serialized by the Host lease.
    const installation = installationFrom(await locator.resolve(target, { refresh: safe.refresh === true }));
    if (
      !isPlainObject(installation) ||
      typeof installation.canonical_path !== "string" ||
      installation.canonical_path.length === 0
    ) {
      fail("installation_not_found", `no trusted installation for target "${target}"`, {
        category: "target",
        retryable: true,
        submission: "not_sent",
        details: { cause_code: "resolve_failed" },
      });
    }
    if (installation.artifact_kind !== "desktop-exe") {
      return { mode: "cli", installation };
    }

    const lease = leaseFor(target);
    try {
      const instances = listInstances(target);
      const latest = instances.length > 0 ? instances[instances.length - 1] : null;

      if (latest && (await verifyOwnership(latest, installation))) {
        // Surface classification is target knowledge: delegated to the
        // launcher's optional classify hook (doubao/trae launchers provide it;
        // plain launch functions and Gate 3.1 fakes keep ready semantics).
        const launcherEntry = launcherTable[target];
        let classification = null;
        if (Number.isInteger(latest.port) && typeof launcherEntry?.classify === "function") {
          try {
            classification = await launcherEntry.classify({ port: latest.port, instance: latest, env, runPowerShell: runner });
          } catch {
            classification = null;
          }
        }
        if (classification?.state === "gateway_down" && typeof launcherEntry?.repair === "function") {
          // Gateway-only recovery (design §11): the desktop instance is alive
          // and ownership-verified; restart the gateway with the same
          // persistence directory and nonce. If repair fails, converge by
          // marking the record stale and launching a fresh generation.
          try {
            await launcherEntry.repair({ instance: latest, env, runPowerShell: runner });
            classification = await launcherEntry.classify({ port: latest.port, instance: latest, env, runPowerShell: runner });
          } catch {
            classification = { state: "stale" };
          }
        }
        if (classification?.state === "stale") {
          // Process alive but its surface vanished (browser crash): mark stale
          // and fall through to a fresh launch.
          hostStore.markManagedInstanceStale(latest.instance_id, { now: now() });
        } else {
          const state = classification?.state === "waiting_user" ? "waiting_user"
            : classification?.state === "ready" ? "ready"
              : (latest.state ?? "ready");
          const refreshed = { ...latest, state, last_seen_at_ms: now() };
          hostStore.upsertManagedInstance(latest.instance_id, refreshed);
          // In-memory capability token for gateway-authenticated adapters:
          // read from the host secrets file, never re-persisted anywhere.
          let capabilityToken = null;
          if (typeof launcherEntry?.readCapability === "function") {
            try {
              capabilityToken = await launcherEntry.readCapability({ env });
            } catch {
              capabilityToken = null;
            }
          }
          return {
            mode: "reuse",
            installation,
            instance: refreshed,
            managed: {
              port: refreshed.port ?? null,
              instance_id: refreshed.instance_id,
              profile_generation: refreshed.generation,
              gateway_port: refreshed.gateway_port ?? null,
              instance_nonce: refreshed.instance_nonce ?? null,
              capability_token: capabilityToken,
            },
            lease,
            lifecycle: state === "waiting_user"
              ? {
                  state,
                  instance_id: refreshed.instance_id,
                  installation_id: refreshed.installation_id,
                  profile_generation: refreshed.generation,
                  started_by_uagents: refreshed.started_by_uagents === true,
                  reused: true,
                  interaction_phase: classification?.phase ?? "preflight_login",
                }
              : lifecycleSummary(refreshed, true),
          };
        }
      }
      if (latest) {
        // Evidence mismatch: mark stale and replace with a new generation.
        // Never kill the previous process from here.
        hostStore.markManagedInstanceStale(latest.instance_id, { now: now() });
      }

      if (Number.isInteger(safe.preferredPort)) {
        const listener = await runner("inspect-listener", { port: safe.preferredPort });
        if (isPlainObject(listener) && listener.listening === true) {
          // A valid managed instance would have been reused above; anything
          // still listening here is unmanaged from our perspective.
          fail("port_identity_mismatch", `port ${safe.preferredPort} is held by an unmanaged process`, {
            category: "target",
            retryable: true,
            submission: "not_sent",
            details: { cause_code: "port_in_use", port: safe.preferredPort },
          });
        }
      }

      const launcher = launcherTable[target];
      if (typeof launcher !== "function") {
        fail("launch_failed", `no launcher is registered for target "${target}"`, {
          category: "target",
          retryable: true,
          submission: "not_sent",
          details: { cause_code: "launcher_missing" },
        });
      }

      const generation = (latest?.generation ?? 0) + 1;
      const profilePath = path.join(resolveHostRoot(env), "profiles", target, String(generation));
      mkdirSync(profilePath, { recursive: true });

      const launched = await launcher({
        installation,
        profilePath,
        generation,
        lease,
        env,
        spawnImpl,
        runPowerShell: runner,
        now,
        context: safe,
      });
      if (
        !isPlainObject(launched) ||
        !isPlainObject(launched.process) ||
        !Number.isInteger(launched.process.pid)
      ) {
        fail("launch_failed", `launcher for target "${target}" returned an invalid result`, {
          category: "target",
          retryable: true,
          submission: "not_sent",
          details: { cause_code: "launcher_invalid_result" },
        });
      }

      const candidate = {
        process_id: launched.process.pid,
        process_started_at_ms: Number.isInteger(launched.process.started_at_ms)
          ? launched.process.started_at_ms
          : null,
        port: Number.isInteger(launched.port) ? launched.port : null,
      };
      if (!(await verifyOwnership(candidate, installation))) {
        fail("managed_instance_identity_mismatch", `launched instance for target "${target}" failed ownership verification`, {
          category: "target",
          retryable: false,
          submission: "not_sent",
          details: { cause_code: "ownership_verification_failed" },
        });
      }

      const instanceIdBase = `managed-${target}`;
      // An adopted instance reports the profile directory it is actually
      // running on; the record must describe reality, not the computed path.
      let instanceGeneration = generation;
      let instanceProfilePath = profilePath;
      if (launched.adopted === true && typeof launched.profile_path === "string" && launched.profile_path.length > 0) {
        instanceProfilePath = launched.profile_path;
        const leaf = launched.profile_path.match(/(?:^|[\\/])(\d+)(?:[\\/]?)$/);
        if (leaf) instanceGeneration = Number(leaf[1]);
      }
      const instanceId = `${instanceIdBase}-${instanceGeneration}-${now()}`;
      const instanceState = launched.state === "waiting_user" ? "waiting_user" : "ready";
      const instance = {
        instance_id: instanceId,
        target,
        installation_id: installation.installation_id,
        generation: instanceGeneration,
        state: instanceState,
        profile_path: instanceProfilePath,
        process_id: candidate.process_id,
        process_started_at_ms: candidate.process_started_at_ms,
        port: candidate.port,
        started_by_uagents: true,
        created_at_ms: now(),
        last_seen_at_ms: now(),
      };
      // Persist only whitelisted launcher fields (never the capability token).
      for (const field of PERSISTED_LAUNCHER_FIELDS) {
        if (launched[field] !== undefined) instance[field] = launched[field];
      }
      hostStore.upsertManagedInstance(instanceId, instance);
      const managed = {
        port: instance.port ?? null,
        instance_id: instance.instance_id,
        profile_generation: instance.generation,
        gateway_port: instance.gateway_port ?? null,
        instance_nonce: instance.instance_nonce ?? null,
        capability_token: launched.capability_token ?? null, // in-memory only
      };
      const lifecycle = instanceState === "waiting_user"
        ? {
            ...lifecycleSummary(instance, false),
            state: "waiting_user",
            interaction_phase: launched.interaction_phase ?? "preflight_login",
          }
        : lifecycleSummary(instance, false);
      return {
        mode: "launched",
        installation,
        instance,
        managed,
        lease,
        lifecycle,
      };
    } catch (error) {
      // Atomicity: a failed ensure must never leave a Host lease behind.
      try {
        hostStore.releaseLease(lease);
      } catch {
        // ignore release failures on the error path
      }
      throw error;
    }
  }

  // Reconcile an already accepted native task against the exact managed
  // desktop instance recorded with that attempt. This deliberately does not
  // call ensure(): a stale or missing instance is an identity failure, and
  // must never be replaced while a native task may still be running.
  async function reconcile(target, lifecycle = {}) {
    const lease = leaseFor(target);
    try {
      if (
        !isPlainObject(lifecycle) ||
        typeof lifecycle.instance_id !== "string" ||
        lifecycle.instance_id.length === 0 ||
        !Number.isInteger(lifecycle.profile_generation) ||
        lifecycle.profile_generation < 1
      ) {
        fail("managed_instance_identity_mismatch", "The task has no valid persisted managed instance identity", {
          category: "target",
          retryable: true,
          submission: "may_have_been_sent",
          details: { cause_code: "lifecycle_identity_missing" },
        });
      }

      const instance = hostStore.getManagedInstance(lifecycle.instance_id);
      if (
        !isPlainObject(instance) ||
        instance.instance_id !== lifecycle.instance_id ||
        instance.target !== target ||
        instance.generation !== lifecycle.profile_generation ||
        instance.started_by_uagents !== true ||
        ["stale", "stopped"].includes(instance.state)
      ) {
        fail("managed_instance_identity_mismatch", "The persisted managed instance is no longer valid", {
          category: "target",
          retryable: true,
          submission: "may_have_been_sent",
          details: { cause_code: "instance_record_mismatch" },
        });
      }
      if (lifecycle.started_by_uagents !== undefined && lifecycle.started_by_uagents !== true) {
        fail("managed_instance_identity_mismatch", "The task lifecycle does not identify a uAgents-managed instance", {
          category: "target",
          retryable: true,
          submission: "may_have_been_sent",
          details: { cause_code: "lifecycle_owner_mismatch" },
        });
      }
      if (
        lifecycle.installation_id !== undefined &&
        lifecycle.installation_id !== instance.installation_id
      ) {
        fail("managed_instance_identity_mismatch", "The task lifecycle installation does not match the managed instance", {
          category: "target",
          retryable: true,
          submission: "may_have_been_sent",
          details: { cause_code: "installation_identity_mismatch" },
        });
      }

      // The installation cache is the trust anchor captured by ensure. Do not
      // resolve a new installation here: doing so could make a replacement
      // install look like the original desktop instance.
      const installation = hostStore.getInstallation(`${CACHE_ID_PREFIX}${target}`);
      if (
        !isPlainObject(installation) ||
        installation.target !== target ||
        installation.installation_id !== instance.installation_id ||
        typeof installation.canonical_path !== "string" ||
        installation.canonical_path.length === 0
      ) {
        fail("managed_instance_identity_mismatch", "The original managed installation cannot be verified", {
          category: "target",
          retryable: true,
          submission: "may_have_been_sent",
          details: { cause_code: "installation_cache_missing" },
        });
      }
      if (!(await verifyOwnership(instance, installation))) {
        fail("managed_instance_identity_mismatch", "The original managed instance failed ownership verification", {
          category: "target",
          retryable: true,
          submission: "may_have_been_sent",
          details: { cause_code: "ownership_verification_failed" },
        });
      }

      const launcherEntry = launcherTable[target];
      let capabilityToken = null;
      if (typeof launcherEntry?.readCapability === "function") {
        try {
          capabilityToken = await launcherEntry.readCapability({ env });
        } catch {
          capabilityToken = null;
        }
        if (typeof capabilityToken !== "string" || capabilityToken.length === 0) {
          fail("gateway_identity_mismatch", "The original managed gateway capability is unavailable", {
            category: "target",
            retryable: true,
            submission: "may_have_been_sent",
            details: { cause_code: "capability_file_missing" },
          });
        }
      }

      // A launcher classifier may perform an inexpensive nonce/surface check
      // (TRAE uses this to reject a foreign gateway). It is validation only:
      // reconciliation never repairs or launches an instance.
      let classification = null;
      if (Number.isInteger(instance.port) && typeof launcherEntry?.classify === "function") {
        try {
          classification = await launcherEntry.classify({ port: instance.port, instance, env, runPowerShell: runner });
        } catch {
          classification = null;
        }
        if (classification?.state === "stale") {
          fail("managed_instance_identity_mismatch", "The original managed desktop surface is no longer valid", {
            category: "target",
            retryable: true,
            submission: "may_have_been_sent",
            details: { cause_code: "surface_identity_mismatch" },
          });
        }
      }

      if (!Number.isInteger(instance.port) || instance.port < 1024 || instance.port > 65535) {
        fail("managed_instance_identity_mismatch", "The original managed instance has no valid desktop port", {
          category: "target",
          retryable: true,
          submission: "may_have_been_sent",
          details: { cause_code: "managed_port_missing" },
        });
      }
      if (target === "trae" && (
        !Number.isInteger(instance.gateway_port) ||
        instance.gateway_port < 1024 ||
        instance.gateway_port > 65535 ||
        instance.instance_nonce === null ||
        instance.instance_nonce === undefined ||
        String(instance.instance_nonce).length === 0
      )) {
        fail("managed_instance_identity_mismatch", "The original managed TRAE gateway identity is incomplete", {
          category: "target",
          retryable: true,
          submission: "may_have_been_sent",
          details: { cause_code: "gateway_identity_missing" },
        });
      }

      return {
        mode: "reconcile",
        target,
        installation,
        instance,
        managed: {
          port: instance.port,
          instance_id: instance.instance_id,
          profile_generation: instance.generation,
          gateway_port: instance.gateway_port ?? null,
          instance_nonce: instance.instance_nonce ?? null,
          capability_token: capabilityToken,
        },
        lease,
        lifecycle: {
          state: instance.state ?? "ready",
          instance_id: instance.instance_id,
          installation_id: instance.installation_id,
          profile_generation: instance.generation,
          started_by_uagents: true,
          reused: true,
          ...(classification?.phase ? { interaction_phase: classification.phase } : {}),
        },
      };
    } catch (error) {
      // A failed validation must not strand the host lease. No process is
      // started or stopped on this path.
      try { hostStore.releaseLease(lease); } catch {}
      throw error;
    }
  }

  function killProcessTree(pid) {
    return new Promise((resolvePromise) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise();
      };
      const timer = setTimeout(finish, TASKKILL_TIMEOUT_MS);
      try {
        const child = spawnImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        child.once?.("exit", finish);
        child.once?.("close", finish);
        child.once?.("error", finish);
      } catch {
        finish();
      }
    });
  }

  async function stop(target) {
    // Taking the lease first prevents stopping an instance that another
    // worker currently holds for a live task (lease_conflict propagates).
    const lease = leaseFor(target);
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      try {
        hostStore.releaseLease(lease);
      } catch {
        // ignore
      }
    };
    try {
      const instances = listInstances(target);
      const latest = instances.length > 0 ? instances[instances.length - 1] : null;
      const notOwned = (causeCode) =>
        fail("stop_not_owned", `no owned managed instance to stop for target "${target}"`, {
          category: "conflict",
          retryable: false,
          submission: "not_sent",
          details: { cause_code: causeCode },
        });
      if (!latest || (latest.state ?? "ready") === "stopped") {
        throw notOwned("no_managed_instance");
      }
      const installation = hostStore.getInstallation(`${CACHE_ID_PREFIX}${target}`);
      let ownershipInstallation;
      if (
        !isPlainObject(installation) ||
        typeof installation.canonical_path !== "string" ||
        installation.canonical_path.length === 0
      ) {
        // Cache-less environments (tests, first-ever stop before any ensure in
        // this process) fall back to a fresh resolve, matching the ensure path.
        const resolved = installationFrom(await locator.resolve(target));
        if (!isPlainObject(resolved) || typeof resolved.canonical_path !== "string") {
          throw notOwned("installation_cache_missing");
        }
        ownershipInstallation = resolved;
      } else {
        ownershipInstallation = installation;
      }
      if (!(await verifyOwnership(latest, ownershipInstallation))) {
        // Evidence mismatch: refuse and never kill.
        throw notOwned("ownership_verification_failed");
      }
      await killProcessTree(latest.process_id);
      // Managed desktop instances may carry a companion gateway process
      // (TRAE). It is equally ours (started_by_uagents with a recorded pid),
      // so stopping the instance stops both.
      if (Number.isInteger(latest.gateway_pid)) {
        await killProcessTree(latest.gateway_pid);
      }
      const stopped = { ...latest, state: "stopped", stopped_at_ms: now() };
      hostStore.upsertManagedInstance(latest.instance_id, stopped);
      releaseOnce();
      return { mode: "stopped", instance_id: latest.instance_id };
    } catch (error) {
      releaseOnce();
      throw error;
    }
  }

  // Lease primitives exposed to the worker so a desktop task can renew the
  // Host instance lease on the shared heartbeat and release it in finally.
  function renewInstanceLease(lease, { ttlMs = leaseTtlMs } = {}) {
    return hostStore.renewLease(lease, { ttlMs, now: now() });
  }

  function releaseInstanceLease(lease) {
    return hostStore.releaseLease(lease);
  }

  return { inspect, ensure, reconcile, stop, renewInstanceLease, releaseInstanceLease, hostStore };
}

// Shared host control-plane factory for every entrypoint (CLI, unified MCP,
// worker subprocess). One construction path, one Host DB per Windows user.
// Construction is best-effort: a failure yields null so callers continue
// without the managed lifecycle, exactly like the worker path. The warning is
// a fixed string that never carries error messages, paths or environment.
export async function createHostSupervisor() {
  try {
    const [{ HostStore }, { createAgentLocator }, { createDoubaoLauncher }, { createTraeLauncher }] = await Promise.all([
      import("./host-store.mjs"),
      import("./agent-locator.mjs"),
      import("./doubao-launcher.mjs"),
      import("./trae-launcher.mjs"),
    ]);
    const hostStore = new HostStore();
    const locator = createAgentLocator({ hostStore });
    return createTargetSupervisor({
      hostStore,
      locator,
      launchers: { doubao: createDoubaoLauncher(), trae: createTraeLauncher() },
    });
  } catch {
    process.stderr.write("uagents: host supervisor unavailable, continuing without managed lifecycle\n");
    return null;
  }
}
