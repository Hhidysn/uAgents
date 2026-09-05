import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { HostStore, HostStoreError, resolveHostRoot } from '../plugins/uagents/src/host/host-store.mjs';
import { createTargetSupervisor } from '../plugins/uagents/src/host/target-supervisor.mjs';
import { UAgentsError } from '../plugins/uagents/src/protocol/errors.mjs';

const INSTALLATION_PATH = 'C:\\fake\\App.exe';

function desktopInstallation(target = 'doubao') {
  return {
    installation_id: `inst-${target}`,
    target,
    canonical_path: INSTALLATION_PATH,
    discovery_source: 'known_locations',
    artifact_kind: 'desktop-exe',
    product_name: `${target} product`,
    publisher: 'Trusted Vendor',
    file_version: '1.2.3',
    sha256: null,
    size: 1024,
    mtime: 1700000000000,
    verifier_version: 'windows-host-v1',
    status: 'trusted',
    verified_at_ms: 1700000000000,
    last_success_at_ms: 1700000000000,
  };
}

function cliInstallation(target = 'opencode') {
  return {
    ...desktopInstallation(target),
    artifact_kind: 'cli-entry',
  };
}

// Programmable fake PowerShell runner: responses keyed by action+pid/port.
function fakeRunner({ processByPid = {}, listenerByPort = {} } = {}) {
  const calls = [];
  return {
    calls,
    processByPid,
    listenerByPort,
    runPowerShell: async (action, payload) => {
      calls.push({ action, payload });
      if (action === 'inspect-process') {
        const entry = processByPid[payload.pid];
        if (!entry) return { ok: true, exists: false, pid: payload.pid, started_at_ms: null, executable_path: null };
        return { ok: true, exists: true, pid: payload.pid, ...entry };
      }
      if (action === 'inspect-listener') {
        const entry = listenerByPort[payload.port];
        if (!entry) return { ok: true, listening: false, port: payload.port, listener_pid: null, started_at_ms: null, executable_path: null };
        return { ok: true, port: payload.port, ...entry };
      }
      throw new Error(`unexpected action ${action}`);
    },
  };
}

function taskkillRecorder() {
  const calls = [];
  return {
    calls,
    spawnImpl: () => {
      calls.push('taskkill');
      const child = new EventEmitter();
      setImmediate(() => child.emit('exit', 0));
      return child;
    },
  };
}

function fakeLauncher(results) {
  const calls = [];
  const launcher = async (args) => {
    calls.push(args);
    const next = results.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, launcher, results };
}

function makeEnv() {
  // Repository-standard local test root (.local/ is gitignored). Cleanup is
  // best-effort: SQLite WAL handles may outlive the test on Windows.
  const root = resolve('.local', 'test-runs', randomUUID(), 'target supervisor');
  mkdirSync(root, { recursive: true });
  return {
    root,
    env: { LOCALAPPDATA: root },
  };
}

function baseSetup({ runner, launcherResults, now }) {
  const { root, env } = makeEnv();
  const hostStore = new HostStore({ env });
  const locator = {
    resolve: async (target) =>
      target === 'opencode' ? cliInstallation(target) : desktopInstallation(target),
    inspect: async (target) => ({ target, candidates: [] }),
  };
  const { calls: killCalls, spawnImpl } = taskkillRecorder();
  const { calls: launcherCalls, launcher } = fakeLauncher(launcherResults);
  const supervisor = createTargetSupervisor({
    hostStore,
    locator,
    runPowerShell: runner.runPowerShell,
    env,
    now: now ?? (() => 1700000001000),
    launchers: { doubao: launcher, trae: launcher },
    spawnImpl,
  });
  const cleanup = () => {
    try {
      hostStore.close();
    } catch {
      // already closed
    }
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // best effort: WAL handle may still be held on Windows
    }
  };
  return { root, env, hostStore, locator, supervisor, launcherCalls, killCalls, cleanup };
}

const LAUNCH_ONE = { process: { pid: 4242, started_at_ms: 1111 }, port: 19222 };
const LAUNCH_TWO = { process: { pid: 5000, started_at_ms: 2222 }, port: 19223 };

describe('target supervisor', () => {
  test('1) cli targets resolve without instance rows or instance leases', async () => {
    const runner = fakeRunner();
    const ctx = baseSetup({ runner, launcherResults: [LAUNCH_ONE] });
    try {
      const result = await ctx.supervisor.ensure('opencode');
      assert.equal(result.mode, 'cli');
      assert.equal(result.installation.artifact_kind, 'cli-entry');
      assert.equal(result.lease, undefined);
      const rows = ctx.hostStore.raw('SELECT payload FROM managed_instances');
      assert.equal(rows.length, 0);
      // ensure must not have taken an instance lease for the cli target
      const lease = ctx.hostStore.acquireLease('instance:opencode', { ownerNonce: 'other' });
      ctx.hostStore.releaseLease(lease);
    } finally {
      ctx.cleanup();
    }
  });

  test('2) first desktop ensure launches generation 1 and records ownership', async () => {
    const runner = fakeRunner({
      processByPid: { 4242: { started_at_ms: 1111, executable_path: INSTALLATION_PATH } },
      listenerByPort: { 19222: { listening: true, listener_pid: 4242, executable_path: INSTALLATION_PATH } },
    });
    const ctx = baseSetup({ runner, launcherResults: [LAUNCH_ONE] });
    try {
      const result = await ctx.supervisor.ensure('doubao', { workspace: 'C:\\ws' });
      assert.equal(result.mode, 'launched');
      assert.equal(result.lifecycle.state, 'ready');
      assert.equal(result.lifecycle.profile_generation, 1);
      assert.equal(result.lifecycle.started_by_uagents, true);
      assert.equal(result.lifecycle.reused, false);
      assert.equal(result.instance.state, 'ready');
      assert.equal(result.instance.generation, 1);
      assert.equal(result.instance.started_by_uagents, true);
      const expectedProfile = join(resolveHostRoot(ctx.env), 'profiles', 'doubao', '1');
      assert.equal(result.instance.profile_path, expectedProfile);
      assert.ok(existsSync(expectedProfile), 'profile directory must be created');
      assert.equal(ctx.launcherCalls.length, 1);
      assert.equal(ctx.launcherCalls[0].generation, 1);
      assert.equal(ctx.launcherCalls[0].profilePath, expectedProfile);
    } finally {
      ctx.cleanup();
    }
  });

  test('3) second ensure with matching evidence reuses without relaunch', async () => {
    const runner = fakeRunner({
      processByPid: { 4242: { started_at_ms: 1111, executable_path: INSTALLATION_PATH } },
      listenerByPort: { 19222: { listening: true, listener_pid: 4242, executable_path: INSTALLATION_PATH } },
    });
    const ctx = baseSetup({ runner, launcherResults: [LAUNCH_ONE] });
    try {
      await ctx.supervisor.ensure('doubao');
      const second = await ctx.supervisor.ensure('doubao');
      assert.equal(second.mode, 'reuse');
      assert.equal(second.lifecycle.reused, true);
      assert.equal(ctx.launcherCalls.length, 1, 'launcher must not be called again');
    } finally {
      ctx.cleanup();
    }
  });

  test('4) started-at mismatch after launch marks the instance stale and launches generation 2', async () => {
    // Launched evidence is valid at launch time; afterwards the recorded
    // started_at no longer matches the live process (PID reuse / restart).
    const runner = fakeRunner({
      processByPid: {
        4242: { started_at_ms: 1111, executable_path: INSTALLATION_PATH },
        5000: { started_at_ms: 2222, executable_path: INSTALLATION_PATH },
      },
      listenerByPort: {
        19222: { listening: true, listener_pid: 4242, executable_path: INSTALLATION_PATH },
        19223: { listening: true, listener_pid: 5000, executable_path: INSTALLATION_PATH },
      },
    });
    const ctx = baseSetup({ runner, launcherResults: [LAUNCH_ONE, LAUNCH_TWO] });
    try {
      await ctx.supervisor.ensure('doubao');
      // the live process identity changes after the fact
      runner.processByPid[4242] = { started_at_ms: 9999, executable_path: INSTALLATION_PATH };
      const second = await ctx.supervisor.ensure('doubao');
      assert.equal(second.mode, 'launched');
      assert.equal(second.instance.generation, 2);
      const rows = ctx.hostStore.raw('SELECT payload FROM managed_instances');
      const payloads = rows.map((row) => JSON.parse(row.payload));
      const stale = payloads.find((p) => p.generation === 1);
      assert.equal(stale.status, 'stale');
      const fresh = payloads.find((p) => p.generation === 2);
      assert.equal(fresh.state, 'ready');
      assert.equal(ctx.killCalls.length, 0, 'ensure must never kill');
    } finally {
      ctx.cleanup();
    }
  });

  test('5) executable path mismatch after launch marks stale and relaunches without killing', async () => {
    // The launched process initially reports the trusted image; only after the
    // first ensure completes does the evidence change (simulating process
    // replacement / image swap). Post-launch verification must pass at launch
    // time, then the next ensure must mark the instance stale and relaunch.
    const runner = fakeRunner({
      processByPid: {
        4242: { started_at_ms: 1111, executable_path: INSTALLATION_PATH },
        5000: { started_at_ms: 2222, executable_path: INSTALLATION_PATH },
      },
      listenerByPort: {
        19222: { listening: true, listener_pid: 4242, executable_path: INSTALLATION_PATH },
        19223: { listening: true, listener_pid: 5000, executable_path: INSTALLATION_PATH },
      },
    });
    const ctx = baseSetup({ runner, launcherResults: [LAUNCH_ONE, LAUNCH_TWO] });
    try {
      await ctx.supervisor.ensure('doubao');
      // evidence changes after the fact
      runner.processByPid[4242] = { started_at_ms: 1111, executable_path: 'C:\\evil\\App.exe' };
      const second = await ctx.supervisor.ensure('doubao');
      assert.equal(second.mode, 'launched');
      assert.equal(second.instance.generation, 2);
      assert.equal(ctx.killCalls.length, 0);
    } finally {
      ctx.cleanup();
    }
  });

  test('6) a port held by an unknown process is port_identity_mismatch', async () => {
    const runner = fakeRunner({
      listenerByPort: { 19222: { listening: true, listener_pid: 999, executable_path: 'C:\\unknown\\other.exe' } },
    });
    const ctx = baseSetup({ runner, launcherResults: [LAUNCH_ONE] });
    try {
      await assert.rejects(
        () => ctx.supervisor.ensure('doubao', { preferredPort: 19222 }),
        (error) => {
          assert.ok(error instanceof UAgentsError);
          assert.equal(error.code, 'port_identity_mismatch');
          assert.equal(error.submission, 'not_sent');
          return true;
        }
      );
      assert.equal(ctx.launcherCalls.length, 0);
      // failed ensure must not leave a lease behind
      const lease = ctx.hostStore.acquireLease('instance:doubao', { ownerNonce: 'other' });
      ctx.hostStore.releaseLease(lease);
    } finally {
      ctx.cleanup();
    }
  });

  test('7) stop kills only ownership-proven instances and releases the lease', async () => {
    const runner = fakeRunner({
      processByPid: { 4242: { started_at_ms: 1111, executable_path: INSTALLATION_PATH } },
      listenerByPort: { 19222: { listening: true, listener_pid: 4242, executable_path: INSTALLATION_PATH } },
    });
    const ctx = baseSetup({ runner, launcherResults: [LAUNCH_ONE] });
    try {
      await ctx.supervisor.ensure('doubao');
      const stopped = await ctx.supervisor.stop('doubao');
      assert.equal(stopped.mode, 'stopped');
      assert.deepEqual(ctx.killCalls, ['taskkill']);
      const rows = ctx.hostStore.raw('SELECT payload FROM managed_instances');
      const payload = JSON.parse(rows[0].payload);
      assert.equal(payload.state, 'stopped');
      // lease released after stop
      const lease = ctx.hostStore.acquireLease('instance:doubao', { ownerNonce: 'other' });
      ctx.hostStore.releaseLease(lease);
    } finally {
      ctx.cleanup();
    }
  });

  test('7b) stop without matching ownership refuses and never kills', async () => {
    const runner = fakeRunner({
      processByPid: {
        4242: { started_at_ms: 1111, executable_path: INSTALLATION_PATH },
        4243: { started_at_ms: 1111, executable_path: 'C:\\elsewhere\\App.exe' },
      },
      listenerByPort: { 19222: { listening: true, listener_pid: 4242, executable_path: INSTALLATION_PATH } },
    });
    const ctx = baseSetup({ runner, launcherResults: [LAUNCH_ONE] });
    try {
      await ctx.supervisor.ensure('doubao');
      // evidence disappears: process no longer exists
      delete runner.processByPid[4242];
      await assert.rejects(
        () => ctx.supervisor.stop('doubao'),
        (error) => {
          assert.ok(error instanceof UAgentsError);
          assert.equal(error.code, 'stop_not_owned');
          return true;
        }
      );
      assert.equal(ctx.killCalls.length, 0, 'stop must never kill unproven instances');
      // stop with no record at all
      await assert.rejects(
        () => ctx.supervisor.stop('trae'),
        (error) => {
          assert.equal(error.code, 'stop_not_owned');
          return true;
        }
      );
    } finally {
      ctx.cleanup();
    }
  });

  test('8) concurrent ensures across supervisors serialize on the host lease', async () => {
    const { root, env } = makeEnv();
    try {
      const hostStore = new HostStore({ env });
      const locator = { resolve: async () => desktopInstallation() };
      const runner = fakeRunner({
        processByPid: { 4242: { started_at_ms: 1111, executable_path: INSTALLATION_PATH } },
        listenerByPort: { 19222: { listening: true, listener_pid: 4242, executable_path: INSTALLATION_PATH } },
      });
      let releaseLauncher;
      const gate = new Promise((resolvePromise) => { releaseLauncher = resolvePromise; });
      let releaseStarted;
      const started = new Promise((resolvePromise) => { releaseStarted = resolvePromise; });
      const launcherA = async () => {
        releaseStarted();
        await gate;
        return LAUNCH_ONE;
      };
      const supervisorA = createTargetSupervisor({
        hostStore, locator, runPowerShell: runner.runPowerShell, env,
        launchers: { doubao: launcherA }, ownerNonce: 'worker-a',
      });
      const pending = supervisorA.ensure('doubao');
      await started;
      // worker-b must be fenced while a holds the instance lease
      assert.throws(
        () => hostStore.acquireLease('instance:doubao', { ownerNonce: 'worker-b' }),
        (error) => error instanceof UAgentsError && error.code === 'lease_conflict'
      );
      releaseLauncher();
      const result = await pending;
      assert.equal(result.mode, 'launched');
      // a still holds the lease after a successful ensure
      assert.throws(
        () => hostStore.acquireLease('instance:doubao', { ownerNonce: 'worker-b' }),
        (error) => error instanceof UAgentsError && error.code === 'lease_conflict'
      );
      hostStore.releaseLease(result.lease);
      const leaseB = hostStore.acquireLease('instance:doubao', { ownerNonce: 'worker-b' });
      hostStore.releaseLease(leaseB);
    } finally {
      try {
        hostStore.close();
      } catch {
        // already closed
      }
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // best effort
      }
    }
  });

  test('9) a failed launcher propagates, releases the lease, records nothing', async () => {
    const runner = fakeRunner();
    const ctx = baseSetup({ runner, launcherResults: [new UAgentsError('launch_failed', 'boom')] });
    try {
      await assert.rejects(
        () => ctx.supervisor.ensure('doubao'),
        (error) => {
          assert.ok(error instanceof UAgentsError);
          assert.equal(error.code, 'launch_failed');
          return true;
        }
      );
      const rows = ctx.hostStore.raw('SELECT payload FROM managed_instances');
      assert.equal(rows.length, 0);
      const lease = ctx.hostStore.acquireLease('instance:doubao', { ownerNonce: 'other' });
      ctx.hostStore.releaseLease(lease);
    } finally {
      ctx.cleanup();
    }
  });

  test('10) ensure context drops prompt-like fields entirely', async () => {
    const runner = fakeRunner({
      processByPid: { 4242: { started_at_ms: 1111, executable_path: INSTALLATION_PATH } },
      listenerByPort: { 19222: { listening: true, listener_pid: 4242, executable_path: INSTALLATION_PATH } },
    });
    const ctx = baseSetup({ runner, launcherResults: [LAUNCH_ONE] });
    try {
      const result = await ctx.supervisor.ensure('doubao', {
        prompt: 'secret user prompt',
        workspace: 'C:\\ws',
      });
      assert.equal(result.mode, 'launched');
      const serialized = JSON.stringify({ result, instance: result.instance, launcherArgs: ctx.launcherCalls[0] });
      assert.ok(!serialized.includes('"prompt"'), 'prompt key must never persist');
      assert.ok(!serialized.includes('secret user prompt'), 'prompt value must never persist');
      assert.equal(ctx.launcherCalls[0].context.workspace, 'C:\\ws');
      assert.equal(ctx.launcherCalls[0].context.prompt, undefined);
    } finally {
      ctx.cleanup();
    }
  });
});
