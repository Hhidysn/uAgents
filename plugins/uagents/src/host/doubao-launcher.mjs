// doubao-launcher.mjs
//
// Gate 4: managed Doubao Work launcher. Launch contract confirmed by the
// Gate 0 live spike (docs/verification/2026-09-05-managed-launch-spike.md):
//   - DoubaoWork.exe accepts --user-data-dir and --remote-debugging-port,
//     keeps the dedicated profile isolated and serves CDP on the loopback.
//   - The spawned exe is a launcher (Application\DoubaoWork.exe); the real
//     browser listener lives in Application\app\DoubaoWork.exe and owns the
//     CDP port. Ownership must therefore be recorded from the listener PID.
//   - A fresh profile exposes CDP but no chat page until the user finishes
//     login/setup: that surface maps to waiting_user/preflight_login.
//   - The chat page URL is doubaowork://doubaowork-chat/chat (optionally
//     /<conversation-id> once a conversation exists).
//
// The launcher never receives or persists prompts, never navigates user
// windows, never kills anything: it only spawns its own ChildProcess and
// reports ownership evidence to the supervisor.

import { spawn } from "node:child_process";
import path from "node:path";
import { fail } from "../protocol/errors.mjs";
import { executableInInstallTree } from "./target-supervisor.mjs";

export const DOUBAO_PORT_CANDIDATES = Object.freeze([
  19222, 19223, 19224, 19225, 19226, 19227, 19228, 19229, 19230,
]);
export const CDP_READY_TIMEOUT_MS = 45_000;
export const CHAT_SURFACE_TIMEOUT_MS = 20_000;
export const CDP_POLL_MS = 400;
export const CHAT_BASE = "doubaowork://doubaowork-chat/chat";
const CHAT_URL = /^doubaowork:\/\/doubaowork-chat\/chat(?:\/(\d+))?$/;

// Minimal environment for the managed desktop instance (design §14): no
// unrelated provider variables are inherited. Chromium needs the Windows
// system locations; user profile data goes to the dedicated profile dir.
const MINIMAL_ENV_KEYS = Object.freeze([
  "SystemRoot", "windir", "SystemDrive", "ComSpec", "PATHEXT", "PATH",
  "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "ProgramData",
  "ProgramFiles", "ProgramFiles(x86)", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)",
  "USERDOMAIN", "USERNAME", "COMPUTERNAME", "NUMBER_OF_PROCESSORS", "OS",
  "PROCESSOR_ARCHITECTURE",
]);

export function minimalDoubaoEnvironment(env = process.env) {
  const out = {};
  for (const key of MINIMAL_ENV_KEYS) {
    if (typeof env?.[key] === "string" && env[key].length > 0) out[key] = env[key];
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function fetchJsonLoopback(fetchImpl, port, pathname, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}${pathname}`, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function connectionRefused(error) {
  return error?.name === "AbortError" || error?.cause?.code === "ECONNREFUSED" || error?.cause?.code === "ECONNRESET";
}

// Port selection (plan Gate 3.1: fixed preferred port + small controlled spare
// segment live in launcher constants). Ports held by any process are skipped
// and never probed further: the launcher must not connect to or terminate
// unknown listeners.
export async function pickDoubaoPort(runPowerShell) {
  for (const port of DOUBAO_PORT_CANDIDATES) {
    const listener = await runPowerShell("inspect-listener", { port });
    if (listener && listener.listening !== true) return port;
  }
  fail("port_unavailable", "no free Doubao CDP port in the controlled segment", {
    category: "target",
    retryable: true,
    submission: "not_sent",
    details: { cause_code: "segment_exhausted" },
  });
}

// Surface classification shared by the launch path and supervisor reuse.
//   ready          - the chat page exists
//   waiting_user   - CDP is up but only login/setup surfaces exist
//   stale          - CDP refused/aborted: process alive but browser dead
export async function classifyDoubaoSurface(fetchImpl, port) {
  let targets;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return { state: "stale" };
    targets = await response.json();
  } catch (error) {
    if (connectionRefused(error)) return { state: "stale" };
    // Ambiguous (slow app, transient error): keep the current state.
    return null;
  }
  const pages = Array.isArray(targets) ? targets : [];
  if (pages.some((page) => page.type === "page" && CHAT_URL.test(page.url))) {
    return { state: "ready" };
  }
  return { state: "waiting_user", interaction_phase: "preflight_login" };
}

export function createDoubaoLauncher({
  fetchImpl = fetch,
  spawnImpl = spawn,
  now = () => Date.now(),
  cdpReadyTimeoutMs = CDP_READY_TIMEOUT_MS,
  chatSurfaceTimeoutMs = CHAT_SURFACE_TIMEOUT_MS,
  pollMs = CDP_POLL_MS,
} = {}) {
  // The supervisor passes spawnImpl in the launch args per the Gate 3.1
  // contract; the launcher deliberately ignores it and uses only the
  // constructor-injected spawnImpl - process creation for the managed
  // instance is owned by this version-controlled module.
  async function launch({ installation, profilePath, env, runPowerShell }) {
    const exe = installation.canonical_path;
    const port = await pickDoubaoPort(runPowerShell);
    const args = [`--user-data-dir=${profilePath}`, `--remote-debugging-port=${port}`];
    const child = spawnImpl(exe, args, {
      cwd: path.dirname(exe),
      env: minimalDoubaoEnvironment(env),
      stdio: "ignore",
      windowsHide: false,
    });
    if (typeof child?.pid !== "number") {
      fail("launch_failed", "Doubao Work could not be started", {
        category: "target", retryable: true, submission: "not_sent",
        details: { cause_code: "spawn_failed" },
      });
    }

    // Wait for CDP. If the launcher process exits first, the launch failed.
    const startedAt = now();
    let cdpUp = false;
    let exitCode = null;
    child.once?.("exit", (code) => { exitCode = code; });
    while (now() - startedAt < cdpReadyTimeoutMs) {
      if (exitCode !== null) {
        fail("launch_failed", "Doubao Work exited before its CDP endpoint became available", {
          category: "target", retryable: true, submission: "not_sent",
          details: { cause_code: "process_exited", exit_code: exitCode },
        });
      }
      const version = await fetchJsonLoopback(fetchImpl, port, "/json/version");
      if (version) { cdpUp = true; break; }
      await sleep(pollMs);
    }
    if (!cdpUp) {
      fail("launch_timeout", "Doubao Work CDP did not become ready in time", {
        category: "target", retryable: true, submission: "not_sent",
        details: { cause_code: "cdp_ready_timeout" },
      });
    }

    // Wait for the chat surface. A fresh profile shows login/setup instead:
    // that is the preflight login wait, not a failure.
    const chatStartedAt = now();
    let classification = null;
    while (now() - chatStartedAt < chatSurfaceTimeoutMs) {
      classification = await classifyDoubaoSurface(fetchImpl, port);
      if (classification && classification.state !== "waiting_user") break;
      await sleep(pollMs);
    }
    const state = classification?.state === "ready" ? "ready"
      : classification?.state === "waiting_user" ? "waiting_user"
        : fail("launch_failed", "Doubao Work surface could not be classified", {
            category: "target", retryable: true, submission: "not_sent",
            details: { cause_code: "surface_unclassified" },
          });

    // Ownership evidence: the listener process (app\ subdirectory exe), not
    // the launcher stub. Fail closed if the port holder is not inside the
    // verified install tree.
    const listener = await runPowerShell("inspect-listener", { port });
    if (!listener || listener.listening !== true || !Number.isInteger(listener.listener_pid)) {
      fail("managed_instance_identity_mismatch", "the Doubao CDP port has no identifiable listener", {
        category: "target", retryable: false, submission: "not_sent",
        details: { cause_code: "listener_missing" },
      });
    }
    const listenerProcess = await runPowerShell("inspect-process", { pid: listener.listener_pid });
    if (
      !listenerProcess ||
      listenerProcess.exists !== true ||
      typeof listenerProcess.started_at_ms !== "number" ||
      !executableInInstallTree(listenerProcess.executable_path, exe)
    ) {
      fail("managed_instance_identity_mismatch", "the Doubao CDP listener is not inside the verified installation", {
        category: "target", retryable: false, submission: "not_sent",
        details: { cause_code: "listener_identity_mismatch" },
      });
    }

    return {
      process: { pid: listener.listener_pid, started_at_ms: listenerProcess.started_at_ms },
      port,
      launcher_pid: child.pid,
      state,
      interaction_phase: state === "waiting_user" ? "preflight_login" : undefined,
    };
  }

  // The launcher is a callable (supervisor launch contract) carrying a
  // classify hook (supervisor reuse-path surface classification).
  async function launcher(args) {
    return launch(args);
  }
  launcher.classify = async ({ port }) => classifyDoubaoSurface(fetchImpl, port);
  return launcher;
}
