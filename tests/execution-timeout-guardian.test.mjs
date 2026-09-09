import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { persistCheckpoint } from '../plugins/uagents/src/runtime/checkpoints.mjs';
import {
  bindProcessIdentity,
  createProvisionalProcess,
  getNativeProcess,
  nativeLaunchFingerprint,
} from '../plugins/uagents/src/runtime/native-processes.mjs';
import {
  launchExecutionTimeoutGuardian,
  runExecutionTimeoutGuardian,
} from '../plugins/uagents/src/runtime/execution-timeout-guardian.mjs';
import {
  executionTimeoutEvidence,
  recordExecutionTimeoutGuardianReady,
  tryAcquireExecutionTimeoutClaim,
} from '../plugins/uagents/src/runtime/execution-timeout.mjs';

const root = path.resolve('.local', 'test-runs', randomUUID(), 'execution-timeout-guardian');
fs.mkdirSync(root, { recursive: true });

test('guardian launch waits for durable ready evidence, is detached, prompt-free, and uses a minimal environment', async () => {
  const stateRoot = path.join(root, `launch-${randomUUID()}`);
  const control = new ControlDatabase(stateRoot);
  const service = new TaskService(control);
  const registered = service.submit({
    schema_version: '1.0', request_id: randomUUID(), target: 'opencode',
    model: 'commandcode-goat/deepseek/deepseek-v4-flash', mode: 'analysis', prompt: 'fixture',
    execution: { observation_timeout_ms: 5_000, effort: 'medium', permission: 'native' },
    policy: { fallback: 'none', max_cost_usd: null },
  });
  const invocations = [];
  const children = [];
  try {
    const launched = launchExecutionTimeoutGuardian({
      control,
      attemptId: registered.attempt.attempt_id,
      executionTimeoutMs: 1_000,
      sourceFile: path.join(root, 'guardian.mjs'),
      readyTimeoutMs: 500,
      readyPollMs: 5,
      spawnImpl(command, args, options) {
        const child = new EventEmitter();
        child.pid = 1234 + children.length;
        child.unref = () => { child.unrefCalled = true; };
        child.kill = () => { child.killed = true; };
        children.push(child);
        invocations.push({ command, args, options, child });
        const slot = args.at(-2);
        queueMicrotask(() => {
          child.emit('spawn');
          setTimeout(() => recordExecutionTimeoutGuardianReady(control, registered.attempt.attempt_id, {
            slot,
            pid: child.pid,
          }), 10);
        });
        return child;
      },
    });
    const result = await launched;
    assert.equal(result.ready, true);
    assert.deepEqual(result.slots, ['primary', 'secondary']);
    assert.deepEqual(result.pids, [1234, 1235]);
    assert.equal(invocations.length, 2);
    for (const [index, invocation] of invocations.entries()) {
      assert.equal(invocation.command, process.execPath);
      assert.deepEqual(invocation.args.slice(-4), [
        control.root,
        registered.attempt.attempt_id,
        index === 0 ? 'primary' : 'secondary',
        '1000',
      ]);
      assert.equal(invocation.options.detached, true);
      assert.equal(invocation.options.shell, false);
      assert.equal(invocation.options.stdio, 'ignore');
      assert.equal(Object.keys(invocation.options.env).some(key => /api|token|key/i.test(key)), false);
      assert.equal(invocation.child.unrefCalled, true);
    }
  } finally { control.close(); }
});

test('guardian process exit before durable ready evidence fails closed', async () => {
  const stateRoot = path.join(root, `not-ready-${randomUUID()}`);
  const control = new ControlDatabase(stateRoot);
  const service = new TaskService(control);
  const registered = service.submit({
    schema_version: '1.0', request_id: randomUUID(), target: 'opencode',
    model: 'commandcode-goat/deepseek/deepseek-v4-flash', mode: 'analysis', prompt: 'fixture',
    execution: { observation_timeout_ms: 5_000, effort: 'medium', permission: 'native' },
    policy: { fallback: 'none', max_cost_usd: null },
  });
  const child = new EventEmitter();
  child.pid = 4321;
  child.kill = () => {};
  try {
    await assert.rejects(() => launchExecutionTimeoutGuardian({
      control,
      attemptId: registered.attempt.attempt_id,
      executionTimeoutMs: 1_000,
      sourceFile: path.join(root, 'guardian.mjs'),
      readyTimeoutMs: 100,
      readyPollMs: 5,
      spawnImpl() {
        queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 1); });
        return child;
      },
    }), error => error.code === 'execution_timeout_guardian_unavailable');
  } finally { control.close(); }
});

test('guardian ready handshake surfaces corrupted persisted evidence instead of timing out', async () => {
  const stateRoot = path.join(root, `corrupt-ready-${randomUUID()}`);
  const control = new ControlDatabase(stateRoot);
  const service = new TaskService(control);
  const registered = service.submit({
    schema_version: '1.0', request_id: randomUUID(), target: 'opencode',
    model: 'commandcode-goat/deepseek/deepseek-v4-flash', mode: 'analysis', prompt: 'fixture',
    execution: { observation_timeout_ms: 5_000, effort: 'medium', permission: 'native' },
    policy: { fallback: 'none', max_cost_usd: null },
  });
  const child = new EventEmitter();
  child.pid = 4401;
  child.kill = () => {};
  try {
    await assert.rejects(() => launchExecutionTimeoutGuardian({
      control,
      attemptId: registered.attempt.attempt_id,
      executionTimeoutMs: 1_000,
      sourceFile: path.join(root, 'guardian.mjs'),
      readyTimeoutMs: 500,
      readyPollMs: 5,
      spawnImpl(_command, args) {
        const slot = args.at(-2);
        queueMicrotask(() => {
          child.emit('spawn');
          recordExecutionTimeoutGuardianReady(control, registered.attempt.attempt_id, { slot, pid: child.pid });
          control.raw.prepare(`UPDATE events SET payload_json = '{bad' WHERE attempt_id = ? AND type = 'execution.timeout_guardian_ready'`).run(registered.attempt.attempt_id);
        });
        return child;
      },
    }), error => error.code === 'execution_timeout_guardian_unavailable' && error.cause instanceof SyntaxError);
  } finally { control.close(); }
});

test('secondary guardian failure after primary ready kills the primary and fails closed before send', async () => {
  const stateRoot = path.join(root, `secondary-not-ready-${randomUUID()}`);
  const control = new ControlDatabase(stateRoot);
  const service = new TaskService(control);
  const registered = service.submit({
    schema_version: '1.0', request_id: randomUUID(), target: 'opencode',
    model: 'commandcode-goat/deepseek/deepseek-v4-flash', mode: 'analysis', prompt: 'fixture',
    execution: { observation_timeout_ms: 5_000, effort: 'medium', permission: 'native' },
    policy: { fallback: 'none', max_cost_usd: null },
  });
  const children = [];
  try {
    await assert.rejects(() => launchExecutionTimeoutGuardian({
      control,
      attemptId: registered.attempt.attempt_id,
      executionTimeoutMs: 1_000,
      sourceFile: path.join(root, 'guardian.mjs'),
      readyTimeoutMs: 200,
      readyPollMs: 5,
      spawnImpl(_command, args) {
        const child = new EventEmitter();
        child.pid = 5100 + children.length;
        child.exitCode = null;
        child.unref = () => {};
        child.kill = () => { child.killed = true; };
        children.push(child);
        const slot = args.at(-2);
        queueMicrotask(() => {
          child.emit('spawn');
          if (slot === 'primary') {
            recordExecutionTimeoutGuardianReady(control, registered.attempt.attempt_id, { slot, pid: child.pid });
          } else {
            child.exitCode = 1;
            child.emit('exit', 1);
          }
        });
        return child;
      },
    }), error => error.code === 'execution_timeout_guardian_unavailable' && error.submission === 'not_sent');
    assert.equal(children.length, 2);
    assert.equal(children[0].killed, true);
  } finally { control.close(); }
});

test('guardian persists confirmed timeout evidence and releases the guard', async () => {
  const fixture = createFixture('confirmed');
  try {
    persistCheckpoint(fixture.control, {
      taskId: fixture.taskId,
      attemptId: fixture.attemptId,
      kind: 'possibly_sent',
      payload: { target: 'opencode' },
      now: Date.now() - 5_000,
    });
    const result = await runExecutionTimeoutGuardian(fixture.control.root, fixture.attemptId, {
      executionTimeoutMs: 1_000,
      inspector: liveFixtureInspector(),
      terminator: { terminateOwnedProcessTree: async () => ({ kind: 'terminated', reason: 'owned_process_tree_quiescent' }) },
      pollMs: 1,
    });
    assert.equal(result.mode, 'timeout_terminated');
    assert.equal(executionTimeoutEvidence(fixture.control, fixture.attemptId).termination_confirmed, true);
    const processRecord = getNativeProcess(fixture.control, fixture.attemptId);
    assert.equal(processRecord.process_state, 'exited');
    assert.equal(processRecord.workspace_guard_state, 'released');
  } finally { fixture.control.close(); }
});

test('guardian records unconfirmed timeout without releasing an uncertain writer', async () => {
  const fixture = createFixture('unconfirmed');
  try {
    persistCheckpoint(fixture.control, {
      taskId: fixture.taskId,
      attemptId: fixture.attemptId,
      kind: 'possibly_sent',
      payload: { target: 'opencode' },
      now: Date.now() - 5_000,
    });
    const result = await runExecutionTimeoutGuardian(fixture.control.root, fixture.attemptId, {
      executionTimeoutMs: 1_000,
      inspector: liveFixtureInspector(),
      terminator: { terminateOwnedProcessTree: async () => ({ kind: 'unconfirmed', reason: 'native_process_identity_mismatch' }) },
      pollMs: 1,
    });
    assert.equal(result.mode, 'timeout_unconfirmed');
    assert.equal(executionTimeoutEvidence(fixture.control, fixture.attemptId).termination_confirmed, false);
    const processRecord = getNativeProcess(fixture.control, fixture.attemptId);
    assert.equal(processRecord.process_state, 'unknown');
    assert.equal(processRecord.workspace_guard_state, 'unknown');
  } finally { fixture.control.close(); }
});

test('guardian surfaces unexpected workspace guard refresh failures', async () => {
  const fixture = createFixture('refresh-programmer-error');
  try {
    persistCheckpoint(fixture.control, {
      taskId: fixture.taskId,
      attemptId: fixture.attemptId,
      kind: 'possibly_sent',
      payload: { target: 'opencode' },
      now: Date.now(),
    });
    await assert.rejects(() => runExecutionTimeoutGuardian(fixture.control.root, fixture.attemptId, {
      executionTimeoutMs: 60_000,
      inspector: {
        inspectProcess: async () => { throw new TypeError('fixture programmer error'); },
        inspectProcessTree: async () => ({ kind: 'quiescent', descendants: [] }),
      },
      pollMs: 1,
    }), TypeError);
  } finally { fixture.control.close(); }
});

test('secondary guardian takes over an expired dead claimant and enforces the deadline once', async () => {
  const fixture = createFixture('claim-failover');
  let clock = 2_010;
  let terminateCalls = 0;
  try {
    persistCheckpoint(fixture.control, {
      taskId: fixture.taskId,
      attemptId: fixture.attemptId,
      kind: 'possibly_sent',
      payload: { target: 'opencode' },
      now: 0,
    });
    const deadClaim = tryAcquireExecutionTimeoutClaim(fixture.control, fixture.attemptId, {
      ownerNonce: 'dead-primary',
      ttlMs: 50,
      now: 2_000,
    });
    assert.ok(deadClaim);

    const result = await runExecutionTimeoutGuardian(fixture.control.root, fixture.attemptId, {
      slot: 'secondary',
      executionTimeoutMs: 1_000,
      inspector: liveFixtureInspector(),
      terminator: {
        terminateOwnedProcessTree: async () => {
          terminateCalls += 1;
          return { kind: 'terminated', reason: 'owned_process_tree_quiescent' };
        },
      },
      claimTtlMs: 100,
      claimHeartbeatMs: 20,
      pollMs: 10,
      now: () => clock,
      sleep: async ms => { clock += ms; },
    });
    assert.equal(result.mode, 'timeout_terminated');
    assert.equal(terminateCalls, 1);
    assert.equal(executionTimeoutEvidence(fixture.control, fixture.attemptId).termination_confirmed, true);
  } finally { fixture.control.close(); }
});

function createFixture(label) {
  const control = new ControlDatabase(path.join(root, `${label}-${randomUUID()}`));
  const service = new TaskService(control);
  const task = service.submit({
    schema_version: '1.0',
    request_id: randomUUID(),
    target: 'opencode',
    model: 'commandcode-goat/deepseek/deepseek-v4-flash',
    mode: 'analysis',
    prompt: 'guardian fixture',
    execution: { observation_timeout_ms: 5_000, execution_timeout_ms: null, effort: 'medium', permission: 'native' },
    policy: { fallback: 'none', max_cost_usd: null },
  });
  // Keep this helper platform-independent: the request fixture is registered
  // without a timeout, then the persisted request is patched so direct
  // guardian tests do not depend on the Windows-only policy capability gate.
  const requestFile = path.join(control.root, 'tasks', task.task_id, 'request.json');
  const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  request.execution.execution_timeout_ms = 1_000;
  fs.writeFileSync(requestFile, `${JSON.stringify(request)}\n`, 'utf8');

  const workspace = service.payload(task.task_id).request.workspace;
  const fingerprint = nativeLaunchFingerprint({
    target: 'opencode', attemptId: task.attempt.attempt_id, workspaceKey: workspace.toLowerCase(),
    executablePath: process.execPath, argv: [],
  });
  createProvisionalProcess(control, {
    attemptId: task.attempt.attempt_id,
    target: 'opencode',
    workspaceKey: workspace.toLowerCase(),
    executablePath: process.execPath,
    launchFingerprint: fingerprint,
    stdoutRelpath: `native/${task.attempt.attempt_id}/stdout.log`,
    stderrRelpath: `native/${task.attempt.attempt_id}/stderr.log`,
  });
  bindProcessIdentity(control, task.attempt.attempt_id, {
    pid: 4242, startedAtMs: 41_000, executablePath: process.execPath,
  });
  return { control, taskId: task.task_id, attemptId: task.attempt.attempt_id };
}

function liveFixtureInspector() {
  return {
    inspectProcess: async () => ({
      kind: 'alive',
      pid: 4242,
      started_at_ms: 41_000,
      executable_path: process.execPath,
    }),
    inspectProcessTree: async () => ({ kind: 'active_descendants', descendants: [] }),
  };
}
