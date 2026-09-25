import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { HostStore, resolveHostRoot } from '../plugins/uagents/src/host/host-store.mjs';
import { createTargetSupervisor } from '../plugins/uagents/src/host/target-supervisor.mjs';
import {
  createTraeLauncher,
  minimalTraeEnvironment,
  TRAE_CDP_PORT_CANDIDATES,
  TRAE_GATEWAY_PORT_CANDIDATES,
} from '../plugins/uagents/src/host/trae-launcher.mjs';
import { UAgentsError } from '../plugins/uagents/src/protocol/errors.mjs';

const TRAE_EXE = 'C:\\fake\\Programs\\Trae CN\\Trae CN.exe';
const GATEWAY_PORT = TRAE_GATEWAY_PORT_CANDIDATES[0];
const CDP_PORT = TRAE_CDP_PORT_CANDIDATES[0];

function traeInstallation() {
  return {
    installation_id: 'inst-trae',
    target: 'trae',
    canonical_path: TRAE_EXE,
    discovery_source: 'known_locations',
    artifact_kind: 'desktop-exe',
    product_name: 'Trae CN',
    publisher: 'Beijing Yinli Catapult Technology Co., Ltd.',
    file_version: '2.3.77497',
    sha256: null,
    size: 214322576,
    mtime: 1788000000000,
    verifier_version: 'windows-host-v1',
    status: 'trusted',
    verified_at_ms: 1788000000000,
    last_success_at_ms: 1788000000000,
  };
}

const WORKBENCH_SURFACE = { kind: 'workspace', url: 'vscode-file://vscode-app/workbench.html', title: 'Trae CN' };
const SETUP_SURFACE = { kind: 'setup', url: 'vscode-file://vscode-app/setup/setup.html', title: 'Setup' };

// Programmable gateway /api/status. A real gateway reports the nonce it was
// started with; `adoptedNonce` mirrors that (the fake host's spawn wrapper
// sets it from TRAECN_GATEWAY_INSTANCE_NONCE). downCallsRemaining makes the
// endpoint unreachable for exactly N calls, then recover.
function fakeGatewayFetch({ nonce = 'nonce-1', surface = WORKBENCH_SURFACE, cdpReachable = true } = {}) {
  const state = { nonce, adoptedNonce: null, surface, cdpReachable, down: false, downCallsRemaining: 0, calls: [], authHeaders: [] };
  const fetchImpl = async (url, options = {}) => {
    state.calls.push(url);
    state.authHeaders.push(options.headers?.Authorization ?? null);
    if (state.downCallsRemaining > 0) {
      state.downCallsRemaining -= 1;
      throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } });
    }
    if (state.down) throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } });
    const body = {
      status: 'disconnected', service: 'traecn-cdp-http-bridge', version: '0.6.0',
      cdpReachable: state.cdpReachable, traeRunning: state.cdpReachable,
      surface: state.surface, instance_nonce: state.adoptedNonce ?? state.nonce,
    };
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => body,
    };
  };
  return { state, fetchImpl };
}

// Fake PowerShell + spawn pair: the desktop spawn occupies its
// --remote-debugging-port with an in-tree listener; `onGatewayEnv` observes
// gateway spawn environments (nonce adoption).
function fakeHost({ listenerExe = TRAE_EXE, killTracked = false, onGatewayEnv = null } = {}) {
  const listenerByPort = {};
  const processByPid = {};
  let nextPid = 5000;
  const spawned = [];
  const killed = [];
  const unrefed = [];
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
  const spawnImpl = (command, args, options) => {
    spawned.push({ command, args, options });
    if (onGatewayEnv && options?.env?.TRAECN_GATEWAY_INSTANCE_NONCE) {
      onGatewayEnv(options.env);
    }
    const pid = nextPid;
    nextPid += 1;
    const child = new EventEmitter();
    child.pid = pid;
    child.spawnargs = args;
    child.unref = () => { unrefed.push(pid); };
    child.kill = () => {
      killed.push(pid);
      if (killTracked) setImmediate(() => child.emit('exit', 0));
      return true;
    };
    const portArg = (args ?? []).find((arg) => String(arg).startsWith('--remote-debugging-port='));
    if (portArg) {
      const port = Number(portArg.split('=')[1]);
      listenerByPort[port] = { listening: true, listener_pid: pid, executable_path: listenerExe, started_at_ms: 1700000000000 + pid };
      processByPid[pid] = { started_at_ms: 1700000000000 + pid, executable_path: listenerExe };
    }
    return child;
  };
  return { runPowerShell, spawnImpl, listenerByPort, processByPid, spawned, killed, unrefed };
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
  const root = resolve('.local', 'test-runs', randomUUID(), 'trae launcher');
  mkdirSync(root, { recursive: true });
  return {
    root,
    env: { LOCALAPPDATA: root, USERNAME: 'tester', SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows' },
  };
}

function cleanupEnv(root, hostStore) {
  try { hostStore?.close(); } catch {}
  try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
}

describe('trae launcher', () => {
  test('launch brings up gateway then desktop, verifies nonce, returns in-memory token', async () => {
    const { root, env } = makeEnv();
    const gateway = fakeGatewayFetch();
    const host = fakeHost({
      onGatewayEnv: (spawnEnv) => { gateway.state.adoptedNonce = spawnEnv.TRAECN_GATEWAY_INSTANCE_NONCE; },
    });
    const launcher = createTraeLauncher({ fetchImpl: gateway.fetchImpl, spawnImpl: host.spawnImpl, pollMs: 10 });
    try {
      const launched = await launcher({
        installation: traeInstallation(),
        profilePath: 'C:\\host\\profiles\\trae\\1',
        env,
        runPowerShell: host.runPowerShell,
      });
      assert.equal(launched.state, 'ready');
      assert.equal(launched.process.pid >= 5000, true, 'ownership uses the desktop listener pid');
      assert.equal(launched.port, CDP_PORT);
      assert.equal(launched.gateway_port, GATEWAY_PORT);
      assert.equal(typeof launched.instance_nonce, 'string');
      assert.equal(gateway.state.adoptedNonce, launched.instance_nonce, 'the gateway must be started with the launch nonce');
      assert.equal(typeof launched.capability_token, 'string');
      assert.equal(existsSync(launched.capability_file), true);
      assert.equal(readFileSync(launched.capability_file, 'utf8'), launched.capability_token);
      assert.ok(gateway.state.authHeaders.some((header) => header === `Bearer ${launched.capability_token}`), 'token travels as Bearer auth');
      assert.ok(gateway.state.calls.every((url) => !url.includes(encodeURIComponent(launched.capability_token))), 'token never appears in URLs');
      const desktopSpawn = host.spawned.find((call) => call.command === TRAE_EXE);
      assert.ok(desktopSpawn, 'desktop spawned');
      assert.equal(desktopSpawn.options.detached, process.platform === 'win32');
      const gatewaySpawn = host.spawned.find(call => call.options.env?.TRAECN_GATEWAY_INSTANCE_NONCE);
      assert.equal(gatewaySpawn.options.detached, process.platform === 'win32');
      assert.equal(host.unrefed.length, 2, 'managed processes release CLI handles after launch');
      assert.equal(desktopSpawn.options.env.OPENAI_API_KEY, undefined, 'desktop env must be minimal');
      assert.equal(desktopSpawn.options.env.SystemRoot, 'C:\\Windows');
      assert.equal(desktopSpawn.options.cwd, 'C:\\fake\\Programs\\Trae CN');
    } finally {
      cleanupEnv(root, null);
    }
  });

  test('a fresh profile surfaces setup as waiting_user/preflight_login', async () => {
    const { root, env } = makeEnv();
    const gateway = fakeGatewayFetch({ surface: SETUP_SURFACE });
    const host = fakeHost({
      onGatewayEnv: (spawnEnv) => { gateway.state.adoptedNonce = spawnEnv.TRAECN_GATEWAY_INSTANCE_NONCE; },
    });
    const launcher = createTraeLauncher({ fetchImpl: gateway.fetchImpl, spawnImpl: host.spawnImpl, pollMs: 10 });
    try {
      const launched = await launcher({
        installation: traeInstallation(), profilePath: 'C:\\p', env, runPowerShell: host.runPowerShell,
      });
      assert.equal(launched.state, 'waiting_user');
      assert.equal(launched.interaction_phase, 'preflight_login');
    } finally {
      cleanupEnv(root, null);
    }
  });

  test('an impostor gateway (foreign nonce) fails closed and kills its children', async () => {
    const { root, env } = makeEnv();
    // No nonce adoption: the running gateway ignores our env, exactly the
    // impostor scenario the identity check exists for.
    const gateway = fakeGatewayFetch({ nonce: 'impostor' });
    const host = fakeHost({ killTracked: true });
    const launcher = createTraeLauncher({ fetchImpl: gateway.fetchImpl, spawnImpl: host.spawnImpl, pollMs: 10 });
    try {
      await assert.rejects(
        () => launcher({ installation: traeInstallation(), profilePath: 'C:\\p', env, runPowerShell: host.runPowerShell }),
        (error) => {
          assert.ok(error instanceof UAgentsError);
          assert.equal(error.code, 'gateway_identity_mismatch');
          assert.equal(error.submission, 'not_sent');
          return true;
        }
      );
      assert.equal(host.killed.length > 0, true, 'the launcher must clean up its own children');
    } finally {
      cleanupEnv(root, null);
    }
  });

  test('a gateway that never becomes ready is gateway_launch_failed', async () => {
    const { root, env } = makeEnv();
    const gateway = fakeGatewayFetch();
    gateway.state.down = true;
    const host = fakeHost();
    const launcher = createTraeLauncher({
      fetchImpl: gateway.fetchImpl, spawnImpl: host.spawnImpl, pollMs: 10, gatewayReadyTimeoutMs: 200,
    });
    try {
      await assert.rejects(
        () => launcher({ installation: traeInstallation(), profilePath: 'C:\\p', env, runPowerShell: host.runPowerShell }),
        (error) => error.code === 'gateway_launch_failed'
      );
      // one gateway spawn plus the icacls acl best-effort child; no desktop
      const realSpawns = host.spawned.filter((call) => call.command !== 'icacls');
      assert.equal(realSpawns.length, 1, 'failure happens before the desktop spawn');
    } finally {
      cleanupEnv(root, null);
    }
  });

  test('a CDP listener outside the verified install tree fails and kills both children', async () => {
    const { root, env } = makeEnv();
    const gateway = fakeGatewayFetch();
    const host = fakeHost({
      listenerExe: 'C:\\evil\\Trae.exe',
      killTracked: true,
      onGatewayEnv: (spawnEnv) => { gateway.state.adoptedNonce = spawnEnv.TRAECN_GATEWAY_INSTANCE_NONCE; },
    });
    const launcher = createTraeLauncher({ fetchImpl: gateway.fetchImpl, spawnImpl: host.spawnImpl, pollMs: 10 });
    try {
      await assert.rejects(
        () => launcher({ installation: traeInstallation(), profilePath: 'C:\\p', env, runPowerShell: host.runPowerShell }),
        (error) => error.code === 'managed_instance_identity_mismatch'
      );
      assert.equal(host.killed.length, 2, 'gateway and desktop are both cleaned up');
    } finally {
      cleanupEnv(root, null);
    }
  });

  test('the desktop never becomes reachable through the gateway is launch_timeout', async () => {
    const { root, env } = makeEnv();
    const gateway = fakeGatewayFetch();
    gateway.state.cdpReachable = false;
    gateway.state.surface = null;
    const host = fakeHost({
      onGatewayEnv: (spawnEnv) => { gateway.state.adoptedNonce = spawnEnv.TRAECN_GATEWAY_INSTANCE_NONCE; },
    });
    const launcher = createTraeLauncher({
      fetchImpl: gateway.fetchImpl, spawnImpl: host.spawnImpl, pollMs: 10, workbenchSurfaceTimeoutMs: 200,
    });
    try {
      await assert.rejects(
        () => launcher({ installation: traeInstallation(), profilePath: 'C:\\p', env, runPowerShell: host.runPowerShell }),
        (error) => error.code === 'launch_timeout'
      );
    } finally {
      cleanupEnv(root, null);
    }
  });

  test('classify reports ready, waiting_user, gateway_down and impostor-stale', async () => {
    const { root, env } = makeEnv();
    try {
      const capabilityFile = join(resolveHostRoot(env), 'secrets', 'trae-gateway-token');
      mkdirSync(join(resolveHostRoot(env), 'secrets'), { recursive: true });
      writeFileSync(capabilityFile, 'tok-1');
      const instance = { gateway_port: GATEWAY_PORT, capability_file: capabilityFile, instance_nonce: 'nonce-1' };
      const ready = fakeGatewayFetch();
      assert.deepEqual(await createTraeLauncher({ fetchImpl: ready.fetchImpl }).classify({ port: CDP_PORT, instance, env }), { state: 'ready' });
      const waiting = fakeGatewayFetch({ surface: SETUP_SURFACE });
      assert.deepEqual(
        await createTraeLauncher({ fetchImpl: waiting.fetchImpl }).classify({ port: CDP_PORT, instance, env }),
        { state: 'waiting_user', interaction_phase: 'preflight_login' }
      );
      const down = fakeGatewayFetch();
      down.state.down = true;
      assert.deepEqual(await createTraeLauncher({ fetchImpl: down.fetchImpl }).classify({ port: CDP_PORT, instance, env }), { state: 'gateway_down' });
      const impostor = fakeGatewayFetch({ nonce: 'other' });
      assert.deepEqual(await createTraeLauncher({ fetchImpl: impostor.fetchImpl }).classify({ port: CDP_PORT, instance, env }), { state: 'stale' });
    } finally {
      cleanupEnv(root, null);
    }
  });

  test('repair restarts the gateway with the same nonce and refuses an occupied port', async () => {
    const { root, env } = makeEnv();
    const gateway = fakeGatewayFetch();
    const host = fakeHost({
      onGatewayEnv: (spawnEnv) => { gateway.state.adoptedNonce = spawnEnv.TRAECN_GATEWAY_INSTANCE_NONCE; },
    });
    const launcher = createTraeLauncher({ fetchImpl: gateway.fetchImpl, spawnImpl: host.spawnImpl, pollMs: 10 });
    try {
      const capabilityFile = join(resolveHostRoot(env), 'secrets', 'trae-gateway-token');
      mkdirSync(join(resolveHostRoot(env), 'secrets'), { recursive: true });
      writeFileSync(capabilityFile, 'tok-keep');
      const instance = { gateway_port: GATEWAY_PORT, port: CDP_PORT, capability_file: capabilityFile, instance_nonce: 'nonce-keep' };
      const repaired = await launcher.repair({ instance, env, runPowerShell: host.runPowerShell });
      assert.equal(typeof repaired.gateway_pid, 'number');
      assert.equal(gateway.state.adoptedNonce, 'nonce-keep', 'repair must reuse the recorded instance nonce');
      assert.equal(host.unrefed.length, 1, 'repaired gateway releases its CLI handle');
      assert.ok(gateway.state.authHeaders.some((header) => header === 'Bearer tok-keep'));

      host.listenerByPort[GATEWAY_PORT] = { listening: true, listener_pid: 31337, executable_path: 'C:\\other\\x.exe' };
      await assert.rejects(
        () => launcher.repair({ instance, env, runPowerShell: host.runPowerShell }),
        (error) => error.code === 'gateway_launch_failed'
      );
      assert.equal(host.killed.includes(31337), false, 'an occupied gateway port is never killed');
    } finally {
      cleanupEnv(root, null);
    }
  });

  test('minimal environment keeps only system keys', () => {
    const env = minimalTraeEnvironment({ SystemRoot: 'C:\\Windows', SECRET_TOKEN: 'x', PATH: 'C:\\Windows' });
    assert.deepEqual(Object.keys(env).sort(), ['PATH', 'SystemRoot']);
  });
});

describe('supervisor with the trae launcher', () => {
  function setup({ personal = false } = {}) {
    const { root, env } = makeEnv();
    if (personal) {
      env.APPDATA = join(root, 'roaming');
      mkdirSync(join(env.APPDATA, 'Trae CN'), { recursive: true });
    }
    const hostStore = new HostStore({ env });
    const gateway = fakeGatewayFetch();
    const host = fakeHost({
      onGatewayEnv: (spawnEnv) => { gateway.state.adoptedNonce = spawnEnv.TRAECN_GATEWAY_INSTANCE_NONCE; },
    });
    const locator = { resolve: async () => ({ installation: traeInstallation() }) };
    const supervisor = createTargetSupervisor({
      hostStore,
      locator,
      runPowerShell: host.runPowerShell,
      env,
      launchers: { trae: createTraeLauncher({ fetchImpl: gateway.fetchImpl, spawnImpl: host.spawnImpl, pollMs: 10 }) },
    });
    const cleanup = () => cleanupEnv(root, hostStore);
    return { supervisor, hostStore, gateway, host, env, cleanup };
  }

  test('explicit personal profile launches under the existing TRAE user data and is reused', async () => {
    const ctx = setup({ personal: true });
    try {
      const first = await ctx.supervisor.ensure('trae', { profileMode: 'personal' });
      const expected = join(ctx.env.APPDATA, 'Trae CN');
      assert.equal(first.instance.profile_path, expected);
      const desktopSpawn = ctx.host.spawned.find(call => call.command === TRAE_EXE);
      assert.ok(desktopSpawn.args.includes(`--user-data-dir=${expected}`));
      ctx.supervisor.releaseInstanceLease(first.lease);
      const second = await ctx.supervisor.ensure('trae');
      assert.equal(second.mode, 'reuse');
      assert.equal(second.instance.instance_id, first.instance.instance_id);
      assert.equal(ctx.host.spawned.filter(call => call.command === TRAE_EXE).length, 1);
      ctx.supervisor.releaseInstanceLease(second.lease);
    } finally {
      ctx.cleanup();
    }
  });

  test('personal profile mode does not create a fresh login profile', async () => {
    const ctx = setup();
    try {
      ctx.env.APPDATA = join(ctx.env.LOCALAPPDATA, 'missing-roaming');
      await assert.rejects(
        () => ctx.supervisor.ensure('trae', { profileMode: 'personal' }),
        (error) => error.code === 'invalid_request'
      );
      assert.equal(ctx.host.spawned.length, 0);
    } finally {
      ctx.cleanup();
    }
  });

  test('ensure persists gateway references but never the capability token', async () => {
    const ctx = setup();
    try {
      const result = await ctx.supervisor.ensure('trae');
      assert.equal(result.mode, 'launched');
      assert.equal(result.lifecycle.state, 'ready');
      assert.equal(result.managed.gateway_port, GATEWAY_PORT);
      assert.equal(typeof result.managed.instance_nonce, 'string');
      assert.equal(typeof result.managed.capability_token, 'string');
      const rows = ctx.hostStore.raw('SELECT payload FROM managed_instances');
      const payload = JSON.parse(rows[0].payload);
      assert.equal(payload.gateway_port, GATEWAY_PORT);
      assert.equal(typeof payload.capability_file, 'string');
      assert.equal(payload.instance_nonce, result.managed.instance_nonce);
      assert.doesNotMatch(JSON.stringify(payload), /"capability_token"/, 'token must never persist');
      assert.doesNotMatch(JSON.stringify(payload), /prompt/i);
      const reused = await ctx.supervisor.ensure('trae');
      assert.equal(reused.mode, 'reuse');
      assert.equal(reused.lifecycle.state, 'ready');
      assert.equal(reused.managed.capability_token, result.managed.capability_token);
      assert.equal(reused.managed.instance_nonce, result.managed.instance_nonce);
    } finally {
      ctx.cleanup();
    }
  });

  test('gateway death between ensures is repaired and reuse succeeds', async () => {
    const ctx = setup();
    try {
      const first = await ctx.supervisor.ensure('trae');
      assert.equal(first.lifecycle.state, 'ready');
      ctx.hostStore.releaseLease(first.lease);
      // gateway dies: exactly one failed status call (the reuse classify),
      // then the repaired gateway comes back with the same nonce.
      ctx.gateway.state.downCallsRemaining = 1;
      const second = await ctx.supervisor.ensure('trae');
      assert.equal(second.mode, 'reuse', 'desktop is alive; only the gateway needed repair');
      assert.equal(second.lifecycle.state, 'ready');
      const third = await ctx.supervisor.ensure('trae');
      assert.equal(third.mode, 'reuse');
      assert.equal(third.managed.instance_nonce, first.managed.instance_nonce);
    } finally {
      ctx.cleanup();
    }
  });
});
