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
  let invocation;
  const child = new EventEmitter();
  child.pid = 1234;
  child.unref = () => { child.unrefCalled = true; };
  try {
    const launched = launchExecutionTimeoutGuardian({
      control,
      attemptId: registered.attempt.attempt_id,
      sourceFile: path.join(root, 'guardian.mjs'),
      readyTimeoutMs: 500,
      readyPollMs: 5,
      spawnImpl(command, args, options) {
        invocation = { command, args, options };
        queueMicrotask(() => {
          child.emit('spawn');
          setTimeout(() => recordExecutionTimeoutGuardianReady(control, registered.attempt.attempt_id), 10);
        });
        return child;
      },
    });
    const result = await launched;
    assert.equal(result.pid, 1234);
    assert.equal(result.ready, true);
    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args.slice(-2), [control.root, registered.attempt.attempt_id]);
    assert.equal(invocation.options.detached, true);
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.stdio, 'ignore');
    assert.equal(Object.keys(invocation.options.env).some(key => /api|token|key/i.test(key)), false);
    assert.equal(child.unrefCalled, true);
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
  // The source request is still rejected for a non-null execution timeout at
  // this implementation slice. Patch only the prompt-free persisted request
  // fixture so the guardian can exercise its deadline behavior before the
  // capability gate is opened.
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
