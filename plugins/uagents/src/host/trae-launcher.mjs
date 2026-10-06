// trae-launcher.mjs
//
// Gate 5: managed TRAE CN + bundled gateway launcher. Launch contracts
// confirmed by the Gate 0 live spike (docs/verification/2026-09-05-managed-
// launch-spike.md):
//   - Trae CN.exe / TRAE SOLO CN.exe accept --user-data-dir and
//     --remote-debugging-port; the desktop process itself owns the CDP port.
//   - A fresh dedicated profile surfaces kind "setup" until the user finishes
//     first login; the workbench surface (kind "workspace") means ready.
//   - The bundled gateway (dist/gateway.cjs) starts in ~300ms, reports
//     /api/status and reconnects to the configured strict CDP port.
//
// Security boundaries (design §11/§14):
//   - A random capability token is generated per launch and stored only in
//     the host secrets file; the instance record keeps the file reference
//     (never the token). The token travels in memory to the adapter context.
//   - The gateway requires the token on every authenticated route; /api/status
//     is unauthenticated but carries a startup-injected instance nonce that
//     the client verifies (anti-impostor, not a secret).
//   - Minimal environment for both gateway and desktop: no provider variables.
//   - The launcher never kills anything except the ChildProcesses it spawned
//     in this call (on failure), never navigates or connects to unknown
//     listeners, and never receives or persists prompts.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveHostRoot } from "./host-store.mjs";
import { executableInInstallTree } from "./target-supervisor.mjs";
import { fail } from "../protocol/errors.mjs";

export const TRAE_CDP_PORT_CANDIDATES = Object.freeze([
  19322, 19323, 19324, 19325, 19326, 19327, 19328, 19329, 19330,
]);
export const TRAE_GATEWAY_PORT_CANDIDATES = Object.freeze([
  19422, 19423, 19424, 19425, 19426, 19427, 19428, 19429, 19430,
]);
const GATEWAY_READY_TIMEOUT_MS = 20_000;
const WORKBENCH_SURFACE_TIMEOUT_MS = 30_000;
export const POLL_MS = 500;
const CAPABILITY_FILE_NAME = "trae-gateway-token";

function windowsArguments(commandLine) {
  if (typeof commandLine !== "string" || commandLine.length > 32768 || /[\0\r\n]/.test(commandLine)) return null;
  const args = [];
  let i = 0;
  while (i < commandLine.length) {
    while (i < commandLine.length && /[ \t]/.test(commandLine[i])) i++;
    if (i === commandLine.length) break;
    let value = "", quoted = false;
    while (i < commandLine.length && (quoted || !/[ \t]/.test(commandLine[i]))) {
      let slashes = 0;
      while (commandLine[i] === "\\") { slashes++; i++; }
      if (commandLine[i] !== '"') {
        value += "\\".repeat(slashes);
        if (i < commandLine.length && (quoted || !/[ \t]/.test(commandLine[i]))) value += commandLine[i++];
        continue;
      }
      value += "\\".repeat(Math.floor(slashes / 2));
      if (slashes % 2) { value += '"'; i++; continue; }
      if (quoted && commandLine[i + 1] === '"') { value += '"'; i += 2; continue; }
      quoted = !quoted; i++;
    }
    if (quoted) return null;
    args.push(value);
  }
  return args;
}

function singleSwitch(args, name) {
  const values = [];
  for (let i = 1; i < args.length; i++) {
    const lower = args[i].toLowerCase();
    if (lower === name) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) return null;
      values.push(args[++i]);
    } else if (lower.startsWith(name + "=")) values.push(args[i].slice(name.length + 1));
  }
  return values.length === 1 ? values[0] : null;
}

function sameWindowsPath(left, right) {
  return typeof left === "string" && typeof right === "string" &&
    path.win32.isAbsolute(left) && path.win32.isAbsolute(right) &&
    path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

const GATEWAY_ENTRY = fileURLToPath(new URL("../../mcp/trae/dist/gateway.cjs", import.meta.url));

const MINIMAL_ENV_KEYS = Object.freeze([
  "SystemRoot", "windir", "SystemDrive", "ComSpec", "PATHEXT", "PATH",
  "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "ProgramData",
  "ProgramFiles", "ProgramFiles(x86)", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)",
  "USERDOMAIN", "USERNAME", "COMPUTERNAME", "NUMBER_OF_PROCESSORS", "OS",
  "PROCESSOR_ARCHITECTURE",
]);

export function minimalTraeEnvironment(env = process.env) {
  const out = {};
  for (const key of MINIMAL_ENV_KEYS) {
    if (typeof env?.[key] === "string" && env[key].length > 0) out[key] = env[key];
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function pickPort(runPowerShell, candidates, errorCode) {
  for (const port of candidates) {
    const listener = await runPowerShell("inspect-listener", { port });
    if (listener && listener.listening !== true) return port;
  }
  fail(errorCode, `no free port in the controlled segment (${candidates[0]}-${candidates[candidates.length - 1]})`, {
    category: "target",
    retryable: true,
    submission: "not_sent",
    details: { cause_code: "segment_exhausted" },
  });
}

// Status reader with the capability token. Never logs the token; failures
// return null so callers decide the classification.
async function fetchGatewayStatus(fetchImpl, gatewayPort, token) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${gatewayPort}/api/status`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return { reachable: false, httpStatus: response.status };
    const body = await response.json();
    return { reachable: true, httpStatus: response.status, body };
  } catch {
    return { reachable: false, httpStatus: null };
  }
}

function surfaceClassification(body) {
  const surface = body?.surface;
  const kind = surface?.kind ?? null;
  const url = String(surface?.url ?? "").toLowerCase();
  if (kind === "workspace" && url.includes("workbench")) return { state: "ready" };
  if (kind === "setup") return { state: "waiting_user", interaction_phase: "preflight_login" };
  return null;
}

export function createTraeLauncher({
  fetchImpl = fetch,
  spawnImpl = spawn,
  nodePath = process.execPath,
  gatewayEntry = GATEWAY_ENTRY,
  now = () => Date.now(),
  gatewayReadyTimeoutMs = GATEWAY_READY_TIMEOUT_MS,
  workbenchSurfaceTimeoutMs = WORKBENCH_SURFACE_TIMEOUT_MS,
  pollMs = POLL_MS,
  stderr = process.stderr,
} = {}) {
  function secretsFile(env) {
    return path.join(resolveHostRoot(env), "secrets", CAPABILITY_FILE_NAME);
  }

  function gatewayStateDir(env) {
    return path.join(resolveHostRoot(env), "gateway", "trae");
  }

  function generateCapabilityToken(env) {
    const file = secretsFile(env);
    const token = randomBytes(32).toString("base64url");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, token, { encoding: "utf8", flag: "w" });
    // Best-effort current-user ACL (design §14): never a launch gate; a fixed
    // redacted warning on failure, never the token itself.
    try {
      const child = spawnImpl("icacls", [file, "/inheritance:r", "/grant:r", `${env?.USERNAME ?? ""}:F`], {
        windowsHide: true, stdio: "ignore",
      });
      child.once?.("exit", (code) => {
        if (code !== 0) stderr.write("uagents trae launcher: gateway capability file acl could not be applied (continuing)\n");
      });
      child.once?.("error", () => {
        stderr.write("uagents trae launcher: gateway capability file acl could not be applied (continuing)\n");
      });
    } catch {
      stderr.write("uagents trae launcher: gateway capability file acl could not be applied (continuing)\n");
    }
    return token;
  }

  function readCapabilityToken(env) {
    try {
      const token = fs.readFileSync(secretsFile(env), "utf8").trim();
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }

  function spawnGateway({ env, gatewayPort, cdpPort, token, nonce, installation, profilePath }) {
    const stateDir = gatewayStateDir(env);
    fs.mkdirSync(stateDir, { recursive: true });
    const child = spawnImpl(nodePath, [gatewayEntry], {
      cwd: path.dirname(gatewayEntry),
      windowsHide: true,
      stdio: "ignore",
      detached: process.platform === "win32",
      env: {
        ...minimalTraeEnvironment(env),
        TRAECN_GATEWAY_HOST: "127.0.0.1",
        TRAECN_GATEWAY_PORT: String(gatewayPort),
        TRAECN_GATEWAY_TOKEN: token,
        TRAECN_GATEWAY_INSTANCE_NONCE: nonce,
        TRAECN_CDP_HOST: "127.0.0.1",
        TRAECN_REMOTE_DEBUGGING_PORT: String(cdpPort),
        TRAECN_STRICT_CDP_PORT: "1",
        TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH: path.join(stateDir, "active-queue.json"),
        TRAECN_TASK_HISTORY_PERSISTENCE_PATH: path.join(stateDir, "task-history.json"),
        TRAECN_TASK_EVENT_PERSISTENCE_PATH: path.join(stateDir, "task-events.json"),
        TRAECN_AUDIT_LOG_DIR: path.join(stateDir, "audit"),
        TRAECN_LOG_DIR: path.join(stateDir, "logs"),
        TRAECN_AUTO_START_TRAE: "0",
        TRAECN_ENABLE_MOCK_BRIDGE: "0",
        TRAECN_BACKGROUND_MAX_RETRIES: "0",
        ...(installation?.canonical_path ? { TRAECN_BIN: installation.canonical_path } : {}),
        ...(profilePath ? { TRAECN_USER_DATA_DIR: profilePath } : {}),
      },
    });
    return child;
  }

  async function waitForGateway({ gatewayChild, gatewayPort, token, nonce, timeoutMs }) {
    const startedAt = now();
    let exitCode = null;
    gatewayChild.once?.("exit", (code) => { exitCode = code; });
    for (;;) {
      if (exitCode !== null) {
        fail("gateway_launch_failed", "the TRAE gateway exited before it became ready", {
          category: "target", retryable: true, submission: "not_sent",
          details: { cause_code: "gateway_exited", exit_code: exitCode },
        });
      }
      const status = await fetchGatewayStatus(fetchImpl, gatewayPort, token);
      if (status.reachable) {
        if (status.body?.instance_nonce !== nonce) {
          fail("gateway_identity_mismatch", "the TRAE gateway reported a foreign instance nonce", {
            category: "target", retryable: false, submission: "not_sent",
            details: { cause_code: "instance_nonce_mismatch" },
          });
        }
        if (status.httpStatus === 200) return;
      }
      if (now() - startedAt > timeoutMs) {
        fail("gateway_launch_failed", "the TRAE gateway did not become ready in time", {
          category: "target", retryable: true, submission: "not_sent",
          details: { cause_code: "gateway_ready_timeout" },
        });
      }
      await sleep(pollMs);
    }
  }

  async function launch({ installation, profilePath, env, runPowerShell, context = {} }) {
    const exe = installation.canonical_path;
    const personalProfilePath = typeof env?.APPDATA === "string" && path.isAbsolute(env.APPDATA)
      ? path.join(env.APPDATA, "Trae CN") : null;
    if (context.profileMode === "personal" && (
      path.basename(exe).toLowerCase() !== "trae cn.exe" ||
      !personalProfilePath || !fs.statSync(personalProfilePath, { throwIfNoEntry: false })?.isDirectory()
    )) {
      fail("invalid_request", "the existing personal TRAE CN profile is unavailable for this installation", {
        category: "target", submission: "not_sent",
      });
    }
    const actualProfilePath = context.profileMode === "personal" ? personalProfilePath : profilePath;
    const gatewayPort = await pickPort(runPowerShell, TRAE_GATEWAY_PORT_CANDIDATES, "gateway_launch_failed");
    const cdpPort = await pickPort(runPowerShell, TRAE_CDP_PORT_CANDIDATES, "port_unavailable");
    const token = generateCapabilityToken(env);
    const nonce = randomUUID();
    const gatewayStateDirPath = gatewayStateDir(env);

    // Failure guard: the launcher owns the ChildProcesses it spawned in this
    // call (design §13), so any post-spawn failure kills them before the
    // error propagates - a failed launch leaves no processes behind.
    let gatewayChild = null;
    let desktopChild = null;
    try {
      // 1. Gateway first (design §11 order): token file, minimal env, strict CDP.
      gatewayChild = spawnGateway({ env, gatewayPort, cdpPort, token, nonce, installation, profilePath });
      if (typeof gatewayChild?.pid !== "number") {
        fail("gateway_launch_failed", "the TRAE gateway could not be started", {
          category: "target", retryable: true, submission: "not_sent",
          details: { cause_code: "spawn_failed" },
        });
      }
      let gatewayStartedAtMs = null;
      try {
        const gatewayProcess = await runPowerShell("inspect-process", { pid: gatewayChild.pid });
        gatewayStartedAtMs = typeof gatewayProcess?.started_at_ms === "number" ? gatewayProcess.started_at_ms : null;
      } catch {}

      // 2. Wait for the gateway nonce (fails closed on impostor gateways).
      await waitForGateway({ gatewayChild, gatewayPort, token, nonce, timeoutMs: gatewayReadyTimeoutMs });

      // 3. Desktop instance with the dedicated profile and strict CDP port.
      desktopChild = spawnImpl(exe, [`--user-data-dir=${actualProfilePath}`, `--remote-debugging-port=${cdpPort}`], {
        cwd: path.dirname(exe),
        env: minimalTraeEnvironment(env),
        stdio: "ignore",
        detached: process.platform === "win32",
        windowsHide: false,
      });
      if (typeof desktopChild?.pid !== "number") {
        fail("launch_failed", "TRAE CN could not be started", {
          category: "target", retryable: true, submission: "not_sent",
          details: { cause_code: "spawn_failed" },
        });
      }

      // 4. Verify the CDP listener belongs to the verified install tree.
      let listener = null;
      const listenerDeadline = now() + workbenchSurfaceTimeoutMs;
      for (;;) {
        listener = await runPowerShell("inspect-listener", { port: cdpPort });
        if (listener && listener.listening === true && Number.isInteger(listener.listener_pid)) break;
        if (now() > listenerDeadline) {
          fail("launch_timeout", "the TRAE desktop CDP endpoint did not come up in time", {
            category: "target", retryable: true, submission: "not_sent",
            details: { cause_code: "cdp_ready_timeout" },
          });
        }
        await sleep(pollMs);
      }
      const listenerProcess = await runPowerShell("inspect-process", { pid: listener.listener_pid });
      if (
        !listenerProcess ||
        listenerProcess.exists !== true ||
        typeof listenerProcess.started_at_ms !== "number" ||
        !executableInInstallTree(listenerProcess.executable_path, exe)
      ) {
        fail("managed_instance_identity_mismatch", "the TRAE CDP listener is not inside the verified installation", {
          category: "target", retryable: false, submission: "not_sent",
          details: { cause_code: "listener_identity_mismatch" },
        });
      }

      // 5. Wait for the workbench surface. A fresh profile shows the setup
      //    surface: that is the preflight login wait, not a failure.
      const surfaceStartedAt = now();
      let classification = null;
      let sawCdpReachable = false;
      let gatewayDied = false;
      desktopChild.once?.("exit", () => { gatewayDied = true; });
      gatewayChild.once?.("exit", () => { gatewayDied = true; });
      for (;;) {
        if (gatewayDied) {
          fail("gateway_launch_failed", "the TRAE gateway or desktop exited during surface verification", {
            category: "target", retryable: true, submission: "not_sent",
            details: { cause_code: "process_exited" },
          });
        }
        const status = await fetchGatewayStatus(fetchImpl, gatewayPort, token);
        if (status.reachable && status.body?.instance_nonce === nonce) {
          sawCdpReachable = sawCdpReachable || status.body?.cdpReachable === true;
          classification = surfaceClassification(status.body);
          if (classification) break;
        }
        if (now() - surfaceStartedAt > workbenchSurfaceTimeoutMs) {
          if (!sawCdpReachable) {
            fail("launch_timeout", "the TRAE desktop never became reachable through the gateway", {
              category: "target", retryable: true, submission: "not_sent",
              details: { cause_code: "surface_timeout_no_cdp" },
            });
          }
          classification = { state: "waiting_user", interaction_phase: "preflight_login" };
          break;
        }
        await sleep(pollMs);
      }

      // The managed processes outlive this CLI request. Their identities are
      // recorded by the supervisor; keeping their handles referenced here
      // would prevent a one-shot `models` command from exiting.
      desktopChild.unref?.();
      gatewayChild.unref?.();
      return {
        process: { pid: listener.listener_pid, started_at_ms: listenerProcess.started_at_ms },
        port: cdpPort,
        desktop_pid: desktopChild.pid,
        gateway_pid: gatewayChild.pid,
        gateway_started_at_ms: gatewayStartedAtMs,
        gateway_port: gatewayPort,
        capability_file: secretsFile(env),
        instance_nonce: nonce,
        gateway_state_dir: gatewayStateDirPath,
        profile_path: actualProfilePath,
        capability_token: token, // in-memory only; never persisted
        state: classification.state,
        ...(classification.interaction_phase ? { interaction_phase: classification.interaction_phase } : {}),
      };
    } catch (error) {
      try { desktopChild?.kill(); } catch {}
      try { gatewayChild?.kill(); } catch {}
      throw error;
    }
  }

  // Login can restart the owned desktop. Recover only the same isolated
  // profile and port, after proving the old PID gone and a stable newer owner.
  async function recoverDesktopIdentity({ instance, installation, env, runPowerShell }) {
    try {
      if (instance?.target !== "trae" || instance.started_by_uagents !== true ||
          instance.installation_id !== installation?.installation_id ||
          instance.state === "stopped" || instance.status === "stopped" || Number.isFinite(instance.stopped_at_ms) ||
          !Number.isSafeInteger(instance.generation) || instance.generation < 1 ||
          !Number.isSafeInteger(instance.process_id) || instance.process_id <= 0 ||
          !Number.isSafeInteger(instance.process_started_at_ms) ||
          !TRAE_CDP_PORT_CANDIDATES.includes(instance.port)) return null;
      const profile = path.join(resolveHostRoot(env), "profiles", "trae", String(instance.generation));
      if (!sameWindowsPath(instance.profile_path, profile)) return null;
      const old = await runPowerShell("inspect-process", { pid: instance.process_id });
      if (old?.ok !== true || old.exists !== false) return null;
      async function sample() {
        const listener = await runPowerShell("inspect-listener", { port: instance.port });
        if (listener?.ok !== true || listener.listening !== true ||
            !Number.isSafeInteger(listener.listener_pid) || listener.listener_pid <= 0 || listener.listener_pid === instance.process_id) return null;
        const proc = await runPowerShell("inspect-process", { pid: listener.listener_pid, include_command_line: true });
        if (proc?.ok !== true || proc.exists !== true || proc.pid !== listener.listener_pid ||
            !Number.isSafeInteger(proc.started_at_ms) || proc.started_at_ms <= instance.process_started_at_ms ||
            listener.started_at_ms !== proc.started_at_ms ||
            !sameWindowsPath(proc.executable_path, installation.canonical_path) ||
            !sameWindowsPath(listener.executable_path, installation.canonical_path)) return null;
        const args = windowsArguments(proc.command_line);
        if (!args || !sameWindowsPath(singleSwitch(args, "--user-data-dir"), profile) ||
            singleSwitch(args, "--remote-debugging-port") !== String(instance.port)) return null;
        return { pid: proc.pid, started_at_ms: proc.started_at_ms };
      }
      const first = await sample(), second = first ? await sample() : null;
      if (!second || second.pid !== first.pid || second.started_at_ms !== first.started_at_ms) return null;
      return { process: second };
    } catch { return null; }
  }

  // Reuse-path surface classification. Ownership of the desktop listener is
  // already verified by the supervisor; this hook classifies the gateway and
  // its surface.
  async function classify({ port, instance, env }) {
    if (!Number.isInteger(instance?.gateway_port) || typeof instance?.capability_file !== "string") {
      return { state: "stale" };
    }
    const token = readCapabilityToken(env ?? process.env);
    if (!token) return { state: "stale" }; // lost capability file: cannot authenticate
    const status = await fetchGatewayStatus(fetchImpl, instance.gateway_port, token);
    if (!status.reachable) return { state: "gateway_down" };
    if (status.body?.instance_nonce !== instance.instance_nonce) return { state: "stale" }; // impostor gateway
    return surfaceClassification(status.body) ?? { state: "gateway_down" };
  }

  // Gateway-only recovery (design §11): the desktop instance is alive and
  // ownership-verified, only the gateway died. Restart the gateway with the
  // same persistence directory, capability file and instance nonce. Never
  // touches the desktop process; never re-sends anything.
  async function repair({ instance, installation, env, runPowerShell }) {
    const token = readCapabilityToken(env ?? process.env);
    if (!token) {
      fail("gateway_launch_failed", "the TRAE gateway capability file is missing", {
        category: "target", retryable: true, submission: "not_sent",
        details: { cause_code: "capability_file_missing" },
      });
    }
    const gatewayPort = instance.gateway_port;
    const listener = await runPowerShell("inspect-listener", { port: gatewayPort });
    if (listener && listener.listening === true) {
      // The old port is held by something else (possibly an impostor): never
      // kill it; report so the supervisor can fall back to a fresh launch.
      fail("gateway_launch_failed", "the TRAE gateway port is held by another process", {
        category: "target", retryable: true, submission: "not_sent",
        details: { cause_code: "gateway_port_occupied" },
      });
    }
    const child = spawnGateway({
      env,
      installation,
      profilePath: instance.profile_path,
      gatewayPort,
      cdpPort: instance.port,
      token,
      nonce: instance.instance_nonce,
    });
    if (typeof child?.pid !== "number") {
      fail("gateway_launch_failed", "the TRAE gateway could not be restarted", {
        category: "target", retryable: true, submission: "not_sent",
        details: { cause_code: "spawn_failed" },
      });
    }
    await waitForGateway({ gatewayChild: child, gatewayPort, token, nonce: instance.instance_nonce, timeoutMs: gatewayReadyTimeoutMs });
    let startedAtMs = null;
    try {
      const proc = await runPowerShell("inspect-process", { pid: child.pid });
      startedAtMs = typeof proc?.started_at_ms === "number" ? proc.started_at_ms : null;
    } catch {}
    child.unref?.();
    return { gateway_pid: child.pid, gateway_started_at_ms: startedAtMs };
  }

  async function readCapability({ env }) {
    return readCapabilityToken(env ?? process.env);
  }

  // This is deliberately stricter than the reuse classifier. A stale desktop
  // record is not authority to terminate a PID: prove the gateway process,
  // listener, capability and launch nonce before offering it for cleanup.
  async function verifyGatewayOwnership({ instance, env, runPowerShell }) {
    if (instance?.started_by_uagents !== true ||
        !Number.isInteger(instance.gateway_pid) ||
        !Number.isFinite(instance.gateway_started_at_ms) ||
        !Number.isInteger(instance.gateway_port) ||
        instance.capability_file !== secretsFile(env) ||
        typeof instance.instance_nonce !== "string" || instance.instance_nonce.length === 0) {
      return { owned: false, reason: "gateway_identity_incomplete" };
    }
    const listener = await runPowerShell("inspect-listener", { port: instance.gateway_port });
    const gateway = await runPowerShell("inspect-process", {
      pid: instance.gateway_pid, include_command_line: true,
    });
    if (listener?.listening !== true || listener.listener_pid !== instance.gateway_pid ||
        gateway?.exists !== true ||
        !Number.isFinite(gateway.started_at_ms) ||
        Math.abs(gateway.started_at_ms - instance.gateway_started_at_ms) > 1000 ||
        String(gateway.executable_path ?? "").toLowerCase() !== nodePath.toLowerCase() ||
        !String(gateway.command_line ?? "").toLowerCase().includes(gatewayEntry.toLowerCase())) {
      return { owned: false, reason: "gateway_process_identity_mismatch" };
    }
    const token = readCapabilityToken(env);
    if (!token) return { owned: false, reason: "gateway_capability_missing" };
    const status = await fetchGatewayStatus(fetchImpl, instance.gateway_port, token);
    if (!status.reachable || status.body?.instance_nonce !== instance.instance_nonce) {
      return { owned: false, reason: "gateway_nonce_mismatch" };
    }
    return { owned: true, status: status.body, token };
  }

  async function inspectOrphanGateway({ instance, env, runPowerShell }) {
    if (!Number.isInteger(instance?.process_id) || !Number.isInteger(instance?.port)) {
      return { safe: false, reason: "desktop_identity_incomplete" };
    }
    const desktop = await runPowerShell("inspect-process", { pid: instance.process_id });
    const cdp = await runPowerShell("inspect-listener", { port: instance.port });
    if (desktop?.exists !== false || cdp?.listening !== false) {
      return { safe: false, reason: "desktop_absence_unconfirmed" };
    }
    const gateway = await verifyGatewayOwnership({ instance, env, runPowerShell });
    if (!gateway.owned) return { safe: false, reason: gateway.reason };
    if (gateway.status?.cdpReachable !== false || gateway.status?.durability?.durabilityDegraded !== false) {
      return { safe: false, reason: "gateway_state_unconfirmed" };
    }
    let queue;
    try {
      const response = await fetchImpl(`http://127.0.0.1:${instance.gateway_port}/api/queue/status`, {
        headers: { Authorization: `Bearer ${gateway.token}` },
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) queue = await response.json();
    } catch {}
    if (!Array.isArray(queue?.tasks)) return { safe: false, reason: "gateway_queue_unconfirmed" };
    if (queue.tasks.length > 0) return { safe: false, reason: "gateway_tasks_active" };
    return { safe: true, pid: instance.gateway_pid };
  }

  async function launcher(args) {
    return launch(args);
  }
  launcher.classify = classify;
  launcher.recoverDesktopIdentity = recoverDesktopIdentity;
  launcher.repair = repair;
  launcher.readCapability = readCapability;
  launcher.verifyGatewayOwnership = verifyGatewayOwnership;
  launcher.inspectOrphanGateway = inspectOrphanGateway;
  return launcher;
}
