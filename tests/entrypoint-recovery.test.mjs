import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { UnifiedRuntime } from '../plugins/uagents/src/runtime/api.mjs';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { persistCheckpoint } from '../plugins/uagents/src/runtime/checkpoints.mjs';

test('fresh CLI reconcile and resume construct the host supervisor for managed tasks', () => {
  const root = path.resolve('.local', 'test-runs', randomUUID(), 'entrypoint recovery');
  const stateRoot = path.join(root, 'tasks');
  const localAppData = path.join(root, 'isolated-local-app-data');
  fs.mkdirSync(localAppData, { recursive: true });
  const control = new ControlDatabase(stateRoot);
  let taskId;
  try {
    const service = new TaskService(control);
    const task = service.submit({
      schema_version: '1.0', request_id: randomUUID(), target: 'doubao', model: 'default',
      mode: 'analysis', prompt: 'fixture; never send',
    });
    taskId = task.task_id;
    const attemptId = task.attempt.attempt_id;
    service.transition(taskId, 'queued', { attemptId });
    service.transition(taskId, 'starting', { attemptId });
    const lifecycle = {
      instance_id: 'fixture-missing-instance', installation_id: 'fixture-installation',
      profile_generation: 1, started_by_uagents: true,
    };
    persistCheckpoint(control, { taskId, attemptId, kind: 'possibly_sent', payload: { target: 'doubao', lifecycle } });
    persistCheckpoint(control, { taskId, attemptId, kind: 'accepted', payload: {
      target: 'doubao', lifecycle, handle: { session_id: 'fixture-conversation', task_id: 'fixture-page' },
    } });
    service.transition(taskId, 'waiting_user', { attemptId, evidenceStrength: 2 });
  } finally { control.close(); }

  // The isolated host store has no managed instance. Reaching its exact-
  // identity error proves the real CLI initialized the supervisor; no native
  // transport or process discovery is needed for this failure path.
  for (const command of ['reconcile', 'resume']) {
    const child = spawnSync(process.execPath, [
      path.resolve('plugins/uagents/bin/uagents.mjs'), command, taskId, '--state-dir', stateRoot,
    ], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
      env: { LOCALAPPDATA: localAppData, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    const envelope = JSON.parse(child.stdout.trim());
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, 'managed_instance_identity_mismatch');
    assert.equal(envelope.error.details.cause_code, 'instance_record_mismatch');
  }
  const reopened = new ControlDatabase(stateRoot);
  try {
    const status = new TaskService(reopened).status(taskId);
    assert.equal(status.status, 'waiting_user');
    assert.equal(status.attempt.submission, 'sent');
    assert.equal(reopened.raw.prepare('SELECT count(*) AS count FROM leases').get().count, 0);
  } finally { reopened.close(); }
});

test('queued duplicate submit recovers the same attempt after its worker exited', () => {
  const root = path.resolve('.local', 'test-runs', randomUUID(), 'queued API recovery');
  const spawns = [];
  const runtime = new UnifiedRuntime({ stateRoot: root, spawnWorker: (...args) => spawns.push(args) });
  try {
    const input = unsentRequest();
    const first = runtime.submit(input);
    runtime.service.transition(first.task_id, 'queued', { attemptId: first.attempt.attempt_id });
    const recovered = runtime.submit(input);
    assert.equal(recovered.duplicate, true);
    assert.equal(recovered.resumed, true);
    assert.equal(recovered.attempt.attempt_id, first.attempt.attempt_id);
    assert.equal(recovered.attempt.submission, 'not_sent');
    assert.equal(spawns.length, 2);
    assert.deepEqual(spawns[0], spawns[1]);
  } finally { runtime.close(); }
});

test('synchronous worker launch failure can be resumed with the original UUID', async () => {
  const root = path.resolve('.local', 'test-runs', randomUUID(), 'failed worker launch');
  const runtime = new UnifiedRuntime({ stateRoot: root, spawnWorker: () => { throw new Error('private transport detail'); } });
  try {
    const input = unsentRequest();
    assert.throws(() => runtime.submit(input), { code: 'worker_launch_failed', submission: 'not_sent' });
    const registered = runtime.status(input.request_id);
    const spawns = [];
    runtime.spawnWorker = (...args) => spawns.push(args);
    const resumed = await runtime.resume(input.request_id);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.attempt.attempt_id, registered.attempt.attempt_id);
    assert.equal(resumed.attempt.submission, 'not_sent');
    assert.deepEqual(spawns, [[root, input.request_id]]);
  } finally { runtime.close(); }
});

test('asynchronous worker launch errors remain recoverable after the CLI runtime closes', () => {
  const root = path.resolve('.local', 'test-runs', randomUUID(), 'async launch failure');
  const child = new EventEmitter();
  const runtime = new UnifiedRuntime({ stateRoot: root, spawnWorker: () => child });
  const input = unsentRequest();
  const registered = runtime.submit(input);
  runtime.close();
  child.emit('error', new Error('token=fixture-do-not-persist'));
  const control = new ControlDatabase(root);
  try {
    const service = new TaskService(control);
    const queued = service.status(input.request_id);
    assert.equal(queued.status, 'queued');
    assert.equal(queued.error.code, 'worker_launch_failed');
    assert.equal(queued.error.retryable, true);
    assert.equal(queued.attempt.attempt_id, registered.attempt.attempt_id);
    assert.equal(service.recoverUnsent(input.request_id).recoverable, true);
    assert.equal(JSON.stringify(service.events(input.request_id)).includes('fixture-do-not-persist'), false);
  } finally { control.close(); }
});

function unsentRequest() {
  return {
    schema_version: '1.0', request_id: randomUUID(), target: 'opencode',
    model: 'commandcode-goat/deepseek/deepseek-v4-flash', mode: 'analysis', prompt: 'fixture; never send',
  };
}
