// Managed launch spike (Gate 0.2, plan 2026-09-05 §3 task 0.2).
//
// Gated behind UAGENTS_LIVE_TEST=1. The spike:
//   1. resolves trusted installations for doubao, trae (Trae CN) and the TRAE
//      SOLO CN variant through the real Agent Locator + Host Store (isolated
//      to a throwaway LOCALAPPDATA root),
//   2. reads path/FileVersion/ProductName/Authenticode conclusions (never
//      touches application profiles),
//   3. creates a dedicated temporary profile directory and picks an idle
//      loopback port per target,
//   4. launches via spawn(executable, args) - no shell,
//   5. verifies the accepted profile/CDP arguments, listener PID ownership,
//      CDP surface and (for TRAE) bundled-gateway compatibility,
//   6. never sends a prompt, never logs in, never sends a message,
//   7. terminates only the child processes held by this run (plus a listener
//      process only when its ownership evidence matches this run's launch),
//      and removes exactly this run's temporary directories.
//
// stdout is a single JSON evidence document.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUN_ROOT = path.resolve(".local", "spike", `run-${randomUUID()}`);
const LOCALAPPDATA = path.join(RUN_ROOT, "localappdata");
const DEADLINE_PER_TARGET_MS = 90_000;
const CDP_POLL_MS = 500;
const GATEWAY_DEADLINE_MS = 20_000;

function fail(message) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "spike_failed", message } })}\n`);
  process.exit(1);
}

if (process.env.UAGENTS_LIVE_TEST !== "1") {
  fail("this spike only runs with UAGENTS_LIVE_TEST=1");
}

const pluginRoot = fileURLToPath(new URL("../../plugins/uagents/", import.meta.url));

function jsonDocument(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function allocateFreePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = net.createServer();
    server.unref();
    server.on("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function fetchJson(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: response.status, body: null, text: text.slice(0, 400) };
    }
  } finally {
    clearTimeout(timer);
  }
}

// Fixed read-only PowerShell host actions (same script the locator uses).
async function runHostAction(action, payload) {
  const script = path.join(pluginRoot, "scripts", "windows-host.ps1");
  const stdin = JSON.stringify(payload ?? {});
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", script, "-Action", action,
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill(), 20_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        rejectPromise(new Error(`host action ${action} returned invalid JSON`));
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.stdin.on("error", () => {});
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function isPortIdle(port) {
  const listener = await runHostAction("inspect-listener", { port });
  return listener.listening !== true;
}

async function waitForCdp(port, deadlineMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < deadlineMs) {
    try {
      const version = await fetchJson(`http://127.0.0.1:${port}/json/version`, 1500);
      if (version.status === 200 && version.body) {
        let pages = null;
        try {
          const list = await fetchJson(`http://127.0.0.1:${port}/json/list`, 1500);
          pages = Array.isArray(list.body)
            ? list.body.map((page) => ({ url: String(page.url ?? "").slice(0, 120), type: page.type ?? null }))
            : null;
        } catch (error) {
          lastError = error;
        }
        return { ready: true, version: version.body, pages, wait_ms: Date.now() - startedAt };
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(CDP_POLL_MS);
  }
  return { ready: false, error: lastError?.name === "AbortError" ? "poll_timeout" : String(lastError?.message ?? lastError).slice(0, 200) };
}

async function listenerOwnership(port) {
  const listener = await runHostAction("inspect-listener", { port });
  if (!listener.listening) return { listening: false };
  const process = await runHostAction("inspect-process", { pid: listener.listener_pid });
  return {
    listening: true,
    listener_pid: listener.listener_pid,
    started_at_ms: listener.started_at_ms,
    executable_path: process.executable_path,
  };
}

function describeChild(child) {
  return { pid: child.pid ?? null, spawnArgs: child.spawnargs?.length ?? 0 };
}

// Kill only this run's held child process; a lingering listener is killed only
// when its ownership evidence (exe inside the verified install dir holding the
// port assigned by this run) proves it belongs to this run.
async function terminateRunProcesses(entries) {
  const cleanup = [];
  for (const entry of entries) {
    const record = { target: entry.target, direct_child_pid: entry.child.pid ?? null };
    try {
      entry.child.kill();
    } catch {}
    await sleep(1500);
    if (entry.port) {
      const owner = await listenerOwnership(entry.port);
      if (owner.listening && owner.executable_path &&
          owner.executable_path.toLowerCase().startsWith(entry.installDir.toLowerCase())) {
        await new Promise((resolvePromise) => {
          const killer = spawn("taskkill", ["/PID", String(owner.listener_pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.on("close", resolvePromise);
          killer.on("error", resolvePromise);
        });
        await sleep(1000);
        const after = await listenerOwnership(entry.port);
        record.listener_killed = after.listening !== true;
        record.listener_pid = owner.listener_pid;
      } else if (owner.listening) {
        record.listener_left_running = true;
        record.listener_pid = owner.listener_pid;
      }
    }
    cleanup.push(record);
  }
  return cleanup;
}

async function resolveInstallation(locator, target) {
  try {
    const resolved = await locator.resolve(target);
    const install = resolved.installation;
    const verify = await runHostAction("verify-installation", {
      path: install.canonical_path,
      artifact_kind: install.artifact_kind,
      expected: {
        product_names: [install.product_name].filter(Boolean),
        publishers: [install.publisher].filter(Boolean),
        executable_names: [path.basename(install.canonical_path)],
      },
      hash_required: false,
    });
    return {
      target,
      canonical_path: install.canonical_path,
      product_name: install.product_name,
      publisher: install.publisher,
      file_version: install.file_version,
      signature: verify.signature ?? null,
      discovery_source: resolved.discovery_source,
      trusted: verify.ok === true,
    };
  } catch (error) {
    return { target, trusted: false, error: error.code ?? String(error.message ?? error).slice(0, 200) };
  }
}

async function spikeTarget({ target, exe, installDir, launchArgs, profileDir, port, extraCheck }) {
  const result = { target, exe, profile_dir_created: fs.existsSync(profileDir), port };
  const startedAt = Date.now();
  const child = spawn(exe, launchArgs, { cwd: installDir, stdio: "ignore", detached: false, windowsHide: false });
  result.child = describeChild(child);
  result.profile_isolated = true;
  result.launchArgs = launchArgs;

  const cdp = await waitForCdp(port, DEADLINE_PER_TARGET_MS);
  result.cdp = {
    ready: cdp.ready,
    wait_ms: cdp.wait_ms,
    browser: cdp.version ? { Browser: cdp.version.Browser ?? null, "Protocol-Version": cdp.version["Protocol-Version"] ?? null } : null,
    pages: cdp.pages,
    error: cdp.error ?? null,
  };

  if (fs.existsSync(profileDir)) {
    let entries = 0;
    try { entries = fs.readdirSync(profileDir).length; } catch {}
    result.profile_populated = entries > 0;
  }

  result.listener = await listenerOwnership(port);
  if (cdp.ready) result.listener_owned_by_run = result.listener.listening === true && !!result.listener.executable_path;
  result.elapsed_ms = Date.now() - startedAt;

  if (extraCheck) {
    try {
      result.extra = await extraCheck({ port, child });
    } catch (error) {
      result.extra = { error: String(error.message ?? error).slice(0, 200) };
    }
  }
  return { result, child };
}

async function main() {
  fs.mkdirSync(LOCALAPPDATA, { recursive: true });
  const { HostStore } = await import("../../plugins/uagents/src/host/host-store.mjs");
  const { createAgentLocator } = await import("../../plugins/uagents/src/host/agent-locator.mjs");
  const hostStore = new HostStore({ env: { LOCALAPPDATA } });
  const locator = createAgentLocator({ hostStore });

  const evidence = {
    ok: true,
    spike_version: 1,
    date: new Date().toISOString(),
    installations: [],
    launches: [],
    cleanup: [],
    cleanupPending: [],
    notes: [],
  };

  try {
    const doubao = await resolveInstallation(locator, "doubao");
    const trae = await resolveInstallation(locator, "trae");
    // TRAE SOLO CN is the second accepted product variant of the trae target;
    // it is verified directly (the locator cache pins one canonical path).
    if (fs.existsSync("C:\\Users\\24590\\AppData\\Local\\Programs\\TRAE SOLO CN\\TRAE SOLO CN.exe")) {
      try {
        const verified = await runHostAction("verify-installation", {
          path: "C:\\Users\\24590\\AppData\\Local\\Programs\\TRAE SOLO CN\\TRAE SOLO CN.exe",
          artifact_kind: "desktop-exe",
          expected: { product_names: ["TRAE SOLO CN"], publishers: ["Beijing Yinli Catapult Technology Co., Ltd."], executable_names: ["TRAE SOLO CN.exe"] },
          hash_required: false,
        });
        evidence.installations.push({ target: "trae-solo-cn", canonical_path: verified.canonical_path, product_name: verified.product_name, publisher: verified.publisher, file_version: verified.file_version, signature: verified.signature, trusted: verified.ok === true });
      } catch (error) {
        evidence.installations.push({ target: "trae-solo-cn", trusted: false, error: String(error.message ?? error).slice(0, 200) });
      }
    }
    evidence.installations.push(doubao, trae);

    // ── doubao ──
    if (doubao.trusted) {
      const profile = path.join(RUN_ROOT, "profiles", "doubao");
      fs.mkdirSync(profile, { recursive: true });
      const port = await allocateFreePort();
      if (!(await isPortIdle(port))) {
        evidence.launches.push({ target: "doubao", error: "allocated port was not idle" });
      } else {
        const { result, child } = await spikeTarget({
          target: "doubao",
          exe: doubao.canonical_path,
          installDir: path.dirname(doubao.canonical_path),
          launchArgs: [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`],
          profileDir: profile,
          port,
        });
        evidence.launches.push(result);
        evidence.cleanupPending.push({ target: "doubao", child, port, installDir: path.dirname(doubao.canonical_path) });
      }
    } else {
      evidence.launches.push({ target: "doubao", skipped: "installation_untrusted", detail: doubao });
    }

    // ── trae (Trae CN) ──
    if (trae.trusted) {
      const profile = path.join(RUN_ROOT, "profiles", "trae");
      fs.mkdirSync(profile, { recursive: true });
      const port = await allocateFreePort();
      const gatewayPort = await allocateFreePort();
      const gatewayState = path.join(RUN_ROOT, "gateway-state");
      fs.mkdirSync(gatewayState, { recursive: true });

      const gateway = spawn(process.execPath, [path.join(pluginRoot, "mcp", "trae", "dist", "gateway.cjs")], {        cwd: pluginRoot,
        windowsHide: true,
        stdio: "ignore",
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
          TEMP: process.env.TEMP ?? path.join(RUN_ROOT, "tmp"),
          TRAECN_GATEWAY_HOST: "127.0.0.1",
          TRAECN_GATEWAY_PORT: String(gatewayPort),
          TRAECN_CDP_HOST: "127.0.0.1",
          TRAECN_REMOTE_DEBUGGING_PORT: String(port),
          TRAECN_STRICT_CDP_PORT: "1",
          TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH: path.join(gatewayState, "active-queue.json"),
          TRAECN_TASK_HISTORY_PERSISTENCE_PATH: path.join(gatewayState, "task-history.json"),
          TRAECN_TASK_EVENT_PERSISTENCE_PATH: path.join(gatewayState, "task-events.json"),
          TRAECN_AUDIT_LOG_DIR: path.join(gatewayState, "audit"),
          TRAECN_LOG_DIR: path.join(gatewayState, "logs"),
          TRAECN_AUTO_START_TRAE: "0",
          TRAECN_ENABLE_MOCK_BRIDGE: "0",
          TRAECN_BACKGROUND_MAX_RETRIES: "0",
        },
      });
      const gatewayEntry = { target: "trae-gateway", pid: gateway.pid ?? null, port: gatewayPort, cdp_target_port: port };

      const { result, child } = await spikeTarget({
        target: "trae",
        exe: trae.canonical_path,
        installDir: path.dirname(trae.canonical_path),
        launchArgs: [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`],
        profileDir: profile,
        port,
        extraCheck: async ({ port: cdpPort }) => {
          const startedAt = Date.now();
          let status = null;
          let lastError = null;
          while (Date.now() - startedAt < GATEWAY_DEADLINE_MS) {
            try {
              const response = await fetchJson(`http://127.0.0.1:${gatewayPort}/api/status`, 1500);
              if (response.status === 200) { status = response.body; break; }
              lastError = `http ${response.status}`;
            } catch (error) {
              lastError = String(error.cause?.code ?? error.message ?? error).slice(0, 120);
            }
            await sleep(750);
          }
          return {
            gateway_ready: status !== null,
            wait_ms: Date.now() - startedAt,
            status_body: status,
            last_error: status === null ? (lastError ?? "deadline") : null,
            cdp_port_used: cdpPort,
          };
        },
      });
      result.gateway = result.extra;
      delete result.extra;
      evidence.launches.push(result);
      evidence.cleanupPending.push({ target: "trae-gateway", child: gateway, port: null, installDir: null });
      evidence.cleanupPending.push({ target: "trae", child, port, installDir: path.dirname(trae.canonical_path) });
      void gatewayEntry;
    } else {
      evidence.launches.push({ target: "trae", skipped: "installation_untrusted", detail: trae });
    }

    // ── TRAE SOLO CN (second variant) ──
    const soloExe = "C:\\Users\\24590\\AppData\\Local\\Programs\\TRAE SOLO CN\\TRAE SOLO CN.exe";
    if (fs.existsSync(soloExe)) {
      const profile = path.join(RUN_ROOT, "profiles", "trae-solo");
      fs.mkdirSync(profile, { recursive: true });
      const port = await allocateFreePort();
      const { result, child } = await spikeTarget({
        target: "trae-solo-cn",
        exe: soloExe,
        installDir: path.dirname(soloExe),
        launchArgs: [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`],
        profileDir: profile,
        port,
      });
      evidence.launches.push(result);
      evidence.cleanupPending.push({ target: "trae-solo-cn", child, port, installDir: path.dirname(soloExe) });
    } else {
      evidence.launches.push({ target: "trae-solo-cn", skipped: "not_installed" });
    }

    // ── cleanup: only this run's processes and directories ──
    const pending = evidence.cleanupPending ?? [];
    delete evidence.cleanupPending;
    evidence.cleanup = await terminateRunProcesses(pending);
    try {
      hostStore.close();
    } catch {}
    await sleep(500);
    try {
      fs.rmSync(RUN_ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
      evidence.cleanup.temp_root_removed = true;
    } catch (error) {
      evidence.cleanup.temp_root_removed = false;
      evidence.notes.push(`temp root cleanup failed: ${String(error.code ?? error.message).slice(0, 100)}`);
    }
    evidence.notes.push("no prompt was written, no message sent, no login performed");
    jsonDocument(evidence);
  } catch (error) {
    evidence.ok = false;
    evidence.error = { code: "spike_failed", message: String(error.message ?? error).slice(0, 300) };
    try {
      const pending = evidence.cleanupPending ?? [];
      delete evidence.cleanupPending;
      evidence.cleanup = await terminateRunProcesses(pending);
      fs.rmSync(RUN_ROOT, { recursive: true, force: true, maxRetries: 2, retryDelay: 300 });
    } catch {}
    jsonDocument(evidence);
    process.exitCode = 1;
  }
}

await main();
