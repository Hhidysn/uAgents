import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { persistCheckpoint } from '../plugins/uagents/src/runtime/checkpoints.mjs';
import {
  bindProcessIdentity,
  createProvisionalProcess,
  getNativeProcess,
  nativeLaunchFingerprint,
} from '../plugins/uagents/src/runtime/native-processes.mjs';
import { enforceExecutionTimeout, executionDeadlineAt } from '../plugins/uagents/src/runtime/execution-timeout.mjs';

const root = path.resolve('.local', 'test-runs', randomUUID(), 'execution-timeout');
fs.mkdirSync(root, { recursive: true });

test('execution deadline is derived from the durable possibly-sent checkpoint across reopen', () => {
  const state = path.join(root, `deadline-${randomUUID()}`);
  let control = new ControlDatabase(state);
  const fixture = createFixture(control, 10_000);
  persistCheckpoint(control, {
    taskId: fixture.taskId,
    attemptId: fixture.attemptId,
    kind: 'possibly_sent',
    payload: { target: 'opencode' },
    now: 50_000,
  });
  assert.equal(executionDeadlineAt(control, fixture.attemptId, 10_000), 60_000);
  control.close();
  control = new ControlDatabase(state);
  try {
    assert.equal(executionDeadlineAt(control, fixture.attemptId, 10_000), 60_000);
  } finally { control.close(); }
});

test('confirmed owned-tree timeout marks local process exited and releases workspace guard', async () => {
  const control = new ControlDatabase(path.join(root, `confirmed-${randomUUID()}`));
  try {
    const fixture = createFixture(control, 10_000);
    bindFixtureProcess(control, fixture);
    const result = await enforceExecutionTimeout({
      control,
      attemptId: fixture.attemptId,
      terminator: {
        terminateOwnedProcessTree: async () => ({ kind: 'terminated', reason: 'owned_process_tree_quiescent' }),
      },
      now: () => 70_000,
    });
    assert.equal(result.timed_out, true);
    assert.equal(result.termination_confirmed, true);
    assert.equal(result.error, 'execution_timeout');
    const processRecord = getNativeProcess(control, fixture.attemptId);
    assert.equal(processRecord.process_state, 'exited');
    assert.equal(processRecord.workspace_guard_state, 'released');
  } finally { control.close(); }
});

test('unconfirmed timeout never releases the durable workspace guard', async () => {
  const control = new ControlDatabase(path.join(root, `unknown-${randomUUID()}`));
  try {
    const fixture = createFixture(control, 10_000);
    bindFixtureProcess(control, fixture);
    const result = await enforceExecutionTimeout({
      control,
      attemptId: fixture.attemptId,
      terminator: {
        terminateOwnedProcessTree: async () => ({ kind: 'unconfirmed', reason: 'native_process_identity_mismatch' }),
      },
      now: () => 70_000,
    });
    assert.equal(result.timed_out, true);
    assert.equal(result.termination_confirmed, false);
    assert.equal(result.error, 'execution_timeout_termination_unconfirmed');
    const processRecord = getNativeProcess(control, fixture.attemptId);
    assert.equal(processRecord.process_state, 'unknown');
    assert.equal(processRecord.workspace_guard_state, 'unknown');
  } finally { control.close(); }
});

test('already-exited owned tree releases the guard without claiming a timeout kill', async () => {
  const control = new ControlDatabase(path.join(root, `already-exited-${randomUUID()}`));
  try {
    const fixture = createFixture(control, 10_000);
    bindFixtureProcess(control, fixture);
    const result = await enforceExecutionTimeout({
      control,
      attemptId: fixture.attemptId,
      terminator: {
        terminateOwnedProcessTree: async () => ({ kind: 'already_exited', reason: 'owned_process_tree_quiescent' }),
      },
      now: () => 70_000,
    });
    assert.equal(result.timed_out, false);
    assert.equal(result.already_exited, true);
    const processRecord = getNativeProcess(control, fixture.attemptId);
    assert.equal(processRecord.process_state, 'exited');
    assert.equal(processRecord.workspace_guard_state, 'released');
  } finally { control.close(); }
});

function createFixture(control, executionTimeoutMs) {
  const service = new TaskService(control);
  const task = service.submit({
    schema_version: '1.0',
    request_id: randomUUID(),
    target: 'opencode',
    model: 'commandcode-goat/deepseek/deepseek-v4-flash',
    mode: 'analysis',
    prompt: 'fixture',
    execution: { observation_timeout_ms: 5_000, execution_timeout_ms: null, effort: 'medium', permission: 'native' },
    policy: { fallback: 'none', max_cost_usd: null },
  });
  return {
    taskId: task.task_id,
    attemptId: task.attempt.attempt_id,
    workspace: service.payload(task.task_id).request.workspace,
    executionTimeoutMs,
  };
}

function bindFixtureProcess(control, fixture) {
  const executable = process.execPath;
  const fingerprint = nativeLaunchFingerprint({
    target: 'opencode',
    attemptId: fixture.attemptId,
    workspaceKey: fixture.workspace.toLowerCase(),
    executablePath: executable,
    argv: [],
  });
  createProvisionalProcess(control, {
    attemptId: fixture.attemptId,
    target: 'opencode',
    workspaceKey: fixture.workspace.toLowerCase(),
    executablePath: executable,
    launchFingerprint: fingerprint,
    stdoutRelpath: `native/${fixture.attemptId}/stdout.log`,
    stderrRelpath: `native/${fixture.attemptId}/stderr.log`,
  }, { now: 40_000 });
  bindProcessIdentity(control, fixture.attemptId, {
    pid: 4242,
    startedAtMs: 41_000,
    executablePath: executable,
  }, { now: 41_000 });
}
