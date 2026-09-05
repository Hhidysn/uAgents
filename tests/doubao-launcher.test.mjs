import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { HostStore, resolveHostRoot } from '../plugins/uagents/src/host/host-store.mjs';
import { createTargetSupervisor } from '../plugins/uagents/src/host/target-supervisor.mjs';
import {
  createDoubaoLauncher,
  pickDoubaoPort,
  minimalDoubaoEnvironment,
  DOUBAO_PORT_CANDIDATES,
} from '../plugins/uagents/src/host/doubao-launcher.mjs';
import { executableInInstallTree } from '../plugins/uagents/src/host/target-supervisor.mjs';
import { UAgentsError } from '../plugins/uagents/src/protocol/errors.mjs';

const INSTALLER_EXE = 'C:\\fake\\DoubaoWork\\Application\\DoubaoWork.exe';
const LISTENER_EXE = 'C:\\fake\\DoubaoWork\\Application\\app\\DoubaoWork.exe';
const FIRST_PORT = DOUBAO_PORT_CANDIDATES[0];
const SECOND_PORT = DOUBAO_PORT_CANDIDATES[1];

function doubaoInstallation() {
  return {
    installation_id: 'inst-doubao',
    target: 'doubao',
    canonical_path: INSTALLER_EXE,
    discovery_source: 'known_locations',
    artifact_kind: 'desktop-exe',
    product_name: 'DoubaoWork Launcher',
    publisher: 'Beijing Chuntian Zhiyun Technology Co., Ltd.',
    file_version: '2.27.8',
    sha256: null,
    size: 5280656,
    mtime: 1788000000000,
    verifier_version: 'windows-host-v1',
    status: 'trusted',
    verified_at_ms: 1788000000000,
    last_success_at_ms: 1788000000000,
  };
}

const CHAT_PAGE = [{ type: 'page', url: 'doubaowork://doubaowork-chat/chat', id: 'page-1' }];
const SETUP_PAGE = [{ type: 'page', url: 'doubaowork://doubaowork-chat/login', id: 'page-2' }];

// Stateful fake fetch: /json/version always answers once "up"; /json/list is
// programmable per call (surfaces, refusals, one-shot failures). listPages is
// read from state at request time so tests can mutate it between ensures.
function fakeFetch({ listPages = CHAT_PAGE, versionDown = false } = {}) {
  const state = { up: !versionDown, listCalls: 0, listScript: null, abortNextList: false, listPages };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/json/version')) {
      if (!state.up) throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } });
      return { ok: true, status: 200, json: async () => ({ Browser: 'Chrome/147.0.7727.149', 'Protocol-Version': '1.3' }) };
    }
    if (url.includes('/json/list')) {
      state.listCalls += 1;
      if (state.abortNextList) {
        state.abortNextList = false;
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      if (typeof state.listScript === 'function') return state.listScript(state.listCalls);
      if (!state.up) throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } });
      return { ok: true, status: 200, json: async () => state.listPages };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { state, calls, fetchImpl };
}

// Stateful fake PowerShell runner + spawn pair: spawning a child occupies the
// next free candidate port with a listener inside the verified install tree,
// mirroring the real Doubao launcher -> app\ listener relationship.
function fakeHost({ listenerExe = LISTENER_EXE } = {}) {
  const listenerByPort = {};
  const processByPid = {};
  let nextPid = 20740;
  const runPowerShell = async (action, payload) => {
    if (action === 'inspect-listener') {
      const entry = listenerByPort[payload.port];
      if (!entry) return { ok: true, listening: false, port: payload.port, listener_pid: null, executable_path: null };
      return { ok: true, port: payload.port, ...entry };
    }
    if (action === 'inspect-process') {
      const entry = processByPid[payload.pid];
      if (!entry) return { ok: true, exists: false, pid: payload.pid, started_at_ms: null, executable_path: null };
      return { ok: true, exists: true, pid: payload.pid, ...entry };
    }
    throw new Error(`unexpected action ${action}`);
  };
  const spawnCalls = [];
  const spawnImpl = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    const portArg = args.find((arg) => arg.startsWith('--remote-debugging-port='));
    const port = Number(portArg.split('=')[1]);
    const pid = nextPid;
    nextPid += 1;
    listenerByPort[port] = { listening: true, listener_pid: pid, executable_path: listenerExe, started_at_ms: 1700000000000 + pid };
    processByPid[pid] = { started_at_ms: 1700000000000 + pid, executable_path: listenerExe };
    const child = new EventEmitter();
    child.pid = pid;
    child.spawnargs = args;
    return child;
  };
  return { runPowerShell, spawnImpl, listenerByPort, processByPid, spawnCalls };
}

function exitingSpawnImpl() {
  const child = new EventEmitter();
  child.pid = 1;
  child.spawnargs = [];
  return () => {
    setImmediate(() => child.emit('exit', 1));
    return child;
  };
}

function makeEnv() {
  const root = resolve('.local', 'test-runs', randomUUID(), 'doubao launcher');
  mkdirSync(root, { recursive: true });
  return { root, env: { LOCALAPPDATA: root } };
}

function cleanupEnv(root, hostStore) {
  try { hostStore?.close(); } catch {}
  try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
}

describe('doubao launcher', () => {
  test('pickDoubaoPort skips occupied ports inside the controlled segment', async () => {
    const runPowerShell = async (action, payload) => {
      if (action === 'inspect-listener') {
        return payload.port === FIRST_PORT
          ? { ok: true, listening: true, listener_pid: 999, executable_path: 'C:\\unknown\\x.exe' }
          : { ok: true, listening: false, port: payload.port };
      }
      throw new Error('unexpected');
    };
    assert.equal(await pickDoubaoPort(runPowerShell), SECOND_PORT);
  });

  test('pickDoubaoPort fails with port_unavailable when the segment is exhausted', async () => {
    const runPowerShell = async () => ({ ok: true, listening: true, listener_pid: 999, executable_path: 'C:\\unknown\\x.exe' });
    await assert.rejects(
      () => pickDoubaoPort(runPowerShell),
      (error) => {
        assert.ok(error instanceof UAgentsError);
        assert.equal(error.code, 'port_unavailable');
        assert.equal(error.submission, 'not_sent');
        return true;
      }
    );
  });

  test('launch returns listener ownership evidence and ready state on the chat surface', async () => {
    const host = fakeHost();
    const { fetchImpl } = fakeFetch({ listPages: CHAT_PAGE });
    const launcher = createDoubaoLauncher({ fetchImpl, spawnImpl: host.spawnImpl, pollMs: 10 });
    const launched = await launcher({
      installation: doubaoInstallation(),
      profilePath: 'C:\\host\\profiles\\doubao\\1',
      env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows', OPENAI_API_KEY: 'must-not-leak' },
      runPowerShell: host.runPowerShell,
    });
    assert.equal(launched.state, 'ready');
    assert.equal(launched.interaction_phase, undefined);
    assert.equal(launched.process.pid, 20740, 'ownership must use the listener pid, not the launcher stub');
    assert.equal(launched.process.started_at_ms, 1700000000000 + 20740);
    assert.equal(launched.port, FIRST_PORT);
    assert.equal(launched.launcher_pid, 20740);
    const spawnCall = host.spawnCalls[0];
    assert.equal(spawnCall.command, INSTALLER_EXE);
    assert.deepEqual(spawnCall.args, [
      '--user-data-dir=C:\\host\\profiles\\doubao\\1',
      `--remote-debugging-port=${FIRST_PORT}`,
    ]);
    assert.equal(spawnCall.options.env.OPENAI_API_KEY, undefined, 'minimal env must not inherit provider variables');
    assert.equal(spawnCall.options.env.SystemRoot, 'C:\\Windows');
    assert.equal(spawnCall.options.cwd, 'C:\\fake\\DoubaoWork\\Application');
  });

  test('the spawned process runs with a minimal environment', async () => {
    const host = fakeHost();
    let capturedOptions = null;
    const capturingSpawn = (command, args, options) => {
      capturedOptions = options;
      return host.spawnImpl(command, args, options);
    };
    const { fetchImpl } = fakeFetch({ listPages: CHAT_PAGE });
    const launcher = createDoubaoLauncher({ fetchImpl, spawnImpl: capturingSpawn, pollMs: 10 });
    await launcher({
      installation: doubaoInstallation(),
      profilePath: 'C:\\host\\profiles\\doubao\\1',
      env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows', OPENAI_API_KEY: 'must-not-leak', ANTHROPIC_API_KEY: 'nope' },
      runPowerShell: host.runPowerShell,
    });
    assert.equal(capturedOptions.env.OPENAI_API_KEY, undefined, 'provider variables must not leak into the managed instance');
    assert.equal(capturedOptions.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(capturedOptions.env.SystemRoot, 'C:\\Windows');
  });

  test('a fresh profile with only setup surfaces returns waiting_user/preflight_login', async () => {
    const host = fakeHost();
    const { fetchImpl } = fakeFetch({ listPages: SETUP_PAGE });
    const launcher = createDoubaoLauncher({ fetchImpl, spawnImpl: host.spawnImpl, pollMs: 10, chatSurfaceTimeoutMs: 300 });
    const launched = await launcher({
      installation: doubaoInstallation(),
      profilePath: 'C:\\host\\profiles\\doubao\\1',
      env: {},
      runPowerShell: host.runPowerShell,
    });
    assert.equal(launched.state, 'waiting_user');
    assert.equal(launched.interaction_phase, 'preflight_login');
  });

  test('a listener outside the verified install tree fails closed', async () => {
    const host = fakeHost({ listenerExe: 'C:\\evil\\App.exe' });
    const { fetchImpl } = fakeFetch({ listPages: CHAT_PAGE });
    const launcher = createDoubaoLauncher({ fetchImpl, spawnImpl: host.spawnImpl, pollMs: 10 });
    await assert.rejects(
      () => launcher({
        installation: doubaoInstallation(),
        profilePath: 'C:\\host\\profiles\\doubao\\1',
        env: {},
        runPowerShell: host.runPowerShell,
      }),
      (error) => {
        assert.equal(error.code, 'managed_instance_identity_mismatch');
        assert.equal(error.submission, 'not_sent');
        return true;
      }
    );
  });

  test('CDP that never becomes ready is launch_timeout; an early exit is launch_failed', async () => {
    const host = fakeHost();
    const { fetchImpl } = fakeFetch({ versionDown: true });
    const launcher = createDoubaoLauncher({ fetchImpl, spawnImpl: host.spawnImpl, pollMs: 10, cdpReadyTimeoutMs: 200 });
    await assert.rejects(
      () => launcher({ installation: doubaoInstallation(), profilePath: 'C:\\p', env: {}, runPowerShell: host.runPowerShell }),
      (error) => error.code === 'launch_timeout'
    );

    const earlyExitLauncher = createDoubaoLauncher({
      // CDP stays down so the exit event is the first failure signal the
      // launch loop observes (version polling must not win the race).
      fetchImpl: fakeFetch({ versionDown: true }).fetchImpl,
      spawnImpl: exitingSpawnImpl(),
      pollMs: 10,
    });
    await assert.rejects(
      () => earlyExitLauncher({ installation: doubaoInstallation(), profilePath: 'C:\\p', env: {}, runPowerShell: host.runPowerShell }),
      (error) => error.code === 'launch_failed'
    );
  });

  test('classify reports ready, waiting_user and stale surfaces', async () => {
    const ready = fakeFetch({ listPages: CHAT_PAGE });
    assert.deepEqual(await createDoubaoLauncher({ fetchImpl: ready.fetchImpl }).classify({ port: 1 }), { state: 'ready' });
    const waiting = fakeFetch({ listPages: SETUP_PAGE });
    assert.deepEqual(
      await createDoubaoLauncher({ fetchImpl: waiting.fetchImpl }).classify({ port: 1 }),
      { state: 'waiting_user', interaction_phase: 'preflight_login' }
    );
    const stale = fakeFetch();
    stale.state.listScript = () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
    assert.deepEqual(await createDoubaoLauncher({ fetchImpl: stale.fetchImpl }).classify({ port: 1 }), { state: 'stale' });
  });

  test('a user daily window on the preferred port is skipped, never touched', async () => {
    // Simulate the user's own Doubao window occupying the preferred port.
    // The launcher must pick the next free segment port and must neither
    // connect to, navigate, nor terminate the unknown listener.
    const host = fakeHost();
    host.listenerByPort[FIRST_PORT] = {
      listening: true, listener_pid: 31337, executable_path: 'C:\\Users\\daily\\DoubaoWork.exe', started_at_ms: 1,
    };
    host.processByPid[31337] = { started_at_ms: 1, executable_path: 'C:\\Users\\daily\\DoubaoWork.exe' };
    const { fetchImpl } = fakeFetch({ listPages: CHAT_PAGE });
    const launcher = createDoubaoLauncher({ fetchImpl, spawnImpl: host.spawnImpl, pollMs: 10 });
    const launched = await launcher({
      installation: doubaoInstallation(),
      profilePath: 'C:\\host\\profiles\\doubao\\1',
      env: {},
      runPowerShell: host.runPowerShell,
    });
    assert.equal(launched.port, SECOND_PORT, 'the daily window port must be skipped');
    assert.equal(launched.process.pid !== 31337, true, 'the daily window process must not be adopted');
    // the daily window's listener record is untouched
    assert.equal(host.listenerByPort[FIRST_PORT].listener_pid, 31337);
    // no kill capability exists in the launcher contract at all
    assert.equal(typeof launcher.kill, 'undefined');
  });

  test('a clean stub exit (code 0) is a handover, not a failure', async () => {
    // Real DoubaoWork.exe is a stub that spawns app\DoubaoWork.exe and exits
    // 0 (installed-CLI E2E evidence). The launcher must keep waiting for CDP.
    const host = fakeHost();
    const { fetchImpl } = fakeFetch({ listPages: CHAT_PAGE });
    const spawnOnce = (command, args, options) => {
      const registered = host.spawnImpl(command, args, options);
      setImmediate(() => registered.emit('exit', 0));
      return registered;
    };
    const launcher = createDoubaoLauncher({ fetchImpl, spawnImpl: spawnOnce, pollMs: 10 });
    const launched = await launcher({
      installation: doubaoInstallation(),
      profilePath: 'C:\\host\\profiles\\doubao\\1',
      env: {},
      runPowerShell: host.runPowerShell,
    });
    assert.equal(launched.state, 'ready');
    assert.equal(launched.process.pid, 20740, 'ownership comes from the listener, not the exited stub');
    assert.equal(launched.launcher_pid, 20740);
  });

  test('an unrecorded managed instance is adopted instead of duplicated', async () => {
    // Reproduction of the installed-CLI orphan: a previous launch recorded
    // nothing, but the browser is alive on a controlled port with the managed
    // profile root in its command line. The next launch must adopt it.
    const { root, env } = makeEnv();
    try {
      const host = fakeHost();
      const profileRoot = join(resolveHostRoot(env), 'profiles', 'doubao');
      const orphanProfile = join(profileRoot, '1');
      const orphanListenerPath = 'C:\\fake\\DoubaoWork\\Application\\app\\DoubaoWork.exe';
      const orphanPid = 32004;
      host.listenerByPort[FIRST_PORT] = { listening: true, listener_pid: orphanPid, executable_path: orphanListenerPath, started_at_ms: 1788598413788 };
      host.processByPid[orphanPid] = {
        started_at_ms: 1788598413781,
        executable_path: orphanListenerPath,
        command_line: `"${orphanListenerPath}" --user-data-dir=${orphanProfile} --remote-debugging-port=${FIRST_PORT} --start_time=1788598413781`,
      };
      const { fetchImpl } = fakeFetch({ listPages: CHAT_PAGE });
      const spawnCalls = [];
      const launcher = createDoubaoLauncher({
        fetchImpl,
        spawnImpl: (...spawnArgs) => { spawnCalls.push(spawnArgs); return fakeHost().spawnImpl('noop', []); },
        pollMs: 10,
      });
      const launched = await launcher({
        installation: doubaoInstallation(),
        profilePath: join(profileRoot, '2'),
        env,
        runPowerShell: host.runPowerShell,
      });
      assert.equal(launched.adopted, true, 'the orphan must be adopted');
      assert.equal(launched.process.pid, orphanPid);
      assert.equal(launched.port, FIRST_PORT);
      assert.equal(launched.profile_path.toLowerCase(), orphanProfile.toLowerCase());
      assert.equal(spawnCalls.length, 0, 'no duplicate spawn may happen');
      // a user daily window (foreign profile) is never adopted
      host.listenerByPort[SECOND_PORT] = { listening: true, listener_pid: 4242, executable_path: orphanListenerPath, started_at_ms: 1788598413999 };
      host.processByPid[4242] = {
        started_at_ms: 1788598413999,
        executable_path: orphanListenerPath,
        command_line: `"${orphanListenerPath}" --user-data-dir=C:\\Users\\daily\\DoubaoWork --remote-debugging-port=${SECOND_PORT}`,
      };
      const second = await launcher({
        installation: doubaoInstallation(),
        profilePath: join(profileRoot, '3'),
        env,
        runPowerShell: host.runPowerShell,
      });
      assert.equal(second.process.pid, orphanPid, 'the foreign-profile window must stay unadopted');
    } finally {
      cleanupEnv(root, null);
    }
  });

  test('minimal environment keeps only system keys', () => {
    const env = minimalDoubaoEnvironment({ SystemRoot: 'C:\\Windows', SECRET_TOKEN: 'x', ANOTHER_SECRET: 'y', PATH: 'C:\\Windows' });
    assert.deepEqual(Object.keys(env).sort(), ['PATH', 'SystemRoot']);
  });
});

describe('supervisor with the doubao launcher', () => {
  function setup() {
    const { root, env } = makeEnv();
    const hostStore = new HostStore({ env });
    const host = fakeHost();
    const fetch = fakeFetch({ listPages: CHAT_PAGE });
    const locator = { resolve: async () => ({ installation: doubaoInstallation() }) };
    const supervisor = createTargetSupervisor({
      hostStore,
      locator,
      runPowerShell: host.runPowerShell,
      env,
      launchers: { doubao: createDoubaoLauncher({ fetchImpl: fetch.fetchImpl, spawnImpl: host.spawnImpl, pollMs: 10, chatSurfaceTimeoutMs: 500 }) },
    });
    const cleanup = () => cleanupEnv(root, hostStore);
    return { supervisor, hostStore, locator, host, fetch, env, cleanup };
  }

  test('ensure launches a ready instance and reuse classifies the live surface', async () => {
    const ctx = setup();
    try {
      const launched = await ctx.supervisor.ensure('doubao');
      assert.equal(launched.mode, 'launched');
      assert.equal(launched.lifecycle.state, 'ready');
      assert.equal(launched.instance.process_id, 20740, 'instance records the listener pid');
      assert.equal(launched.instance.port, FIRST_PORT);
      const reused = await ctx.supervisor.ensure('doubao');
      assert.equal(reused.mode, 'reuse');
      assert.equal(reused.lifecycle.state, 'ready');
      assert.equal(reused.lifecycle.reused, true);
    } finally {
      ctx.cleanup();
    }
  });

  test('a logged-out surface launches and reuses as waiting_user/preflight_login', async () => {
    const ctx = setup();
    try {
      ctx.fetch.state.listPages = SETUP_PAGE;
      const first = await ctx.supervisor.ensure('doubao');
      assert.equal(first.mode, 'launched');
      assert.equal(first.lifecycle.state, 'waiting_user');
      assert.equal(first.lifecycle.interaction_phase, 'preflight_login');
      const second = await ctx.supervisor.ensure('doubao');
      assert.equal(second.mode, 'reuse');
      assert.equal(second.lifecycle.state, 'waiting_user');
      assert.equal(second.lifecycle.interaction_phase, 'preflight_login');
      const rows = ctx.hostStore.raw('SELECT payload FROM managed_instances');
      const payload = JSON.parse(rows[0].payload);
      // The instance row records the waiting state; the transient
      // preflight_login phase lives in the lifecycle summary (asserted above).
      assert.equal(payload.state, 'waiting_user');
      assert.doesNotMatch(JSON.stringify(payload), /"prompt"/i);
    } finally {
      ctx.cleanup();
    }
  });

  test('login completing between ensures flips the reuse classification to ready', async () => {
    const ctx = setup();
    try {
      ctx.fetch.state.listPages = SETUP_PAGE;
      const first = await ctx.supervisor.ensure('doubao');
      assert.equal(first.lifecycle.state, 'waiting_user');
      // the user finishes login in the dedicated window
      ctx.fetch.state.listPages = CHAT_PAGE;
      const second = await ctx.supervisor.ensure('doubao');
      assert.equal(second.mode, 'reuse');
      assert.equal(second.lifecycle.state, 'ready');
      const rows = ctx.hostStore.raw('SELECT payload FROM managed_instances');
      assert.equal(JSON.parse(rows[0].payload).state, 'ready');
    } finally {
      ctx.cleanup();
    }
  });

  test('a vanished browser surface marks the instance stale and relaunches a new generation', async () => {
    const ctx = setup();
    try {
      const first = await ctx.supervisor.ensure('doubao');
      assert.equal(first.lifecycle.state, 'ready');
      // The worker would release the host lease when its run ends.
      ctx.hostStore.releaseLease(first.lease);

      // Browser crash: exactly the next list call aborts, then recovers.
      ctx.fetch.state.abortNextList = true;
      const secondSupervisor = createTargetSupervisor({
        hostStore: ctx.hostStore,
        locator: ctx.locator,
        runPowerShell: ctx.host.runPowerShell,
        env: ctx.env,
        launchers: { doubao: createDoubaoLauncher({ fetchImpl: ctx.fetch.fetchImpl, spawnImpl: ctx.host.spawnImpl, pollMs: 10 }) },
        ownerNonce: 'second-worker',
      });
      const second = await secondSupervisor.ensure('doubao');
      assert.equal(second.mode, 'launched');
      assert.equal(second.lifecycle.state, 'ready');
      assert.equal(second.instance.generation, 2);
      assert.equal(second.instance.port, SECOND_PORT, 'the crashed listener still holds the old port');
      const rows = ctx.hostStore.raw('SELECT payload FROM managed_instances');
      const payloads = rows.map((row) => JSON.parse(row.payload));
      assert.equal(payloads.find((p) => p.generation === 1).status, 'stale');
      assert.equal(payloads.find((p) => p.generation === 2).state, 'ready');
    } finally {
      ctx.cleanup();
    }
  });
});
