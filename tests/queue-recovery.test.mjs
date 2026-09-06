import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FakeAdapter } from '../plugins/uagents/src/adapters/fake/adapter.mjs';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { acquireExecutionLeases, acquireTaskLease, releaseLeases } from '../plugins/uagents/src/runtime/leases.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { runTask } from '../plugins/uagents/src/runtime/worker.mjs';
import { bindProcessIdentity, createProvisionalProcess, getNativeProcess } from '../plugins/uagents/src/runtime/native-processes.mjs';
import { canonicalWorkspace } from '../plugins/uagents/src/runtime/workspace-key.mjs';

const base = path.resolve('.local', 'test-runs', randomUUID(), 'queue recovery');
fs.mkdirSync(base, { recursive: true });
const queueWorkerFixture = path.resolve('tests', 'fixtures', 'queue-worker-child.mjs');

const request = patch => ({
  schema_version: '1.0', request_id: randomUUID(), target: 'opencode',
  model: 'commandcode-goat/deepseek/deepseek-v4-flash', mode: 'analysis', prompt: 'bounded',
  execution: { observation_timeout_ms: 10_000, effort: 'medium', permission: 'native' },
  policy: { fallback: 'none', max_cost_usd: null }, ...patch,
});

test('bounded lease contention leaves a recoverable original attempt', async () => {
  await fixture('contention', async ({ control, service }) => {
    const registered = service.submit(request());
    const workspace = service.payload(registered.task_id).request.workspace;
    const held = acquireExecutionLeases(control, {
      target: 'opencode', workspace, ownerNonce: 'holder', ttlMs: 5_000,
    });
    const adapter = new FakeAdapter();
    const queued = await runTask({
      service, taskId: registered.task_id, adapter,
      leaseOptions: { maxLeaseWaitMs: 35, leaseRetryIntervalMs: 5, maxLeaseRetryIntervalMs: 10 },
    });
    assert.equal(queued.status, 'queued');
    assert.equal(queued.attempt.attempt_id, registered.attempt.attempt_id);
    assert.equal(queued.attempt.submission, 'not_sent');
    assert.equal(adapter.sendCount, 0);
    assert.equal(service.events(registered.task_id).at(-1).payload.queue.recoverable, true);

    releaseLeases(control, held);
    const recovered = service.recoverUnsent(registered.task_id);
    assert.equal(recovered.recoverable, true);
    assert.equal(recovered.attempt_id, registered.attempt.attempt_id);
    const completed = await runTask({ service, taskId: registered.task_id, adapter });
    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.attempt.attempt_id, registered.attempt.attempt_id);
    assert.equal(adapter.sendCount, 1);
  });
});

test('queued cancellation is observed during lease backoff and never sends', async () => {
  await fixture('cancel-while-queued', async ({ control, service }) => {
    const registered = service.submit(request());
    const workspace = service.payload(registered.task_id).request.workspace;
    const held = acquireExecutionLeases(control, {
      target: 'opencode', workspace, ownerNonce: 'holder', ttlMs: 5_000,
    });
    const adapter = new FakeAdapter();
    const running = runTask({
      service, taskId: registered.task_id, adapter,
      leaseOptions: { maxLeaseWaitMs: 2_000, leaseRetryIntervalMs: 5, maxLeaseRetryIntervalMs: 10 },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    service.requestCancel(registered.task_id);
    const cancelled = await running;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.attempt.submission, 'not_sent');
    assert.equal(adapter.sendCount, 0);
    releaseLeases(control, held);
  });
});

test('a waiting worker dispatches once when the occupied workspace is released', async () => {
  await fixture('release-during-wait', async ({ control, service }) => {
    const registered = service.submit(request());
    const held = acquireExecutionLeases(control, {
      target: 'opencode', workspace: service.payload(registered.task_id).request.workspace,
      ownerNonce: 'holder', ttlMs: 5_000,
    });
    const adapter = new FakeAdapter();
    const running = runTask({
      service, taskId: registered.task_id, adapter,
      leaseOptions: { maxLeaseWaitMs: 2_000, leaseRetryIntervalMs: 5, maxLeaseRetryIntervalMs: 10 },
    });
    assert.equal(service.status(registered.task_id).status, 'queued');
    assert.equal(adapter.sendCount, 0);
    releaseLeases(control, held);
    const completed = await running;
    assert.equal(completed.status, 'succeeded');
    assert.equal(adapter.sendCount, 1);
    assert.equal(control.raw.prepare('SELECT count(*) AS count FROM leases').get().count, 0);
  });
});

test('two independent Node workers recover one queued UUID without double dispatch', async () => {
  await fixture('cross-process-race', async ({ control, service }) => {
    const registered = service.submit(request());
    const taskId = registered.task_id;
    const workspace = service.payload(taskId).request.workspace;
    const held = acquireExecutionLeases(control, {
      target: 'opencode', workspace, ownerNonce: 'parent-holder', ttlMs: 5_000,
    });
    service.transition(taskId, 'queued', { attemptId: registered.attempt.attempt_id });

    const children = [startQueueWorker(control.root, taskId), startQueueWorker(control.root, taskId)];
    try {
      const ready = await withTimeout(Promise.all(children.map(child => child.ready)), 5_000, 'workers did not become ready');
      assert.deepEqual(ready.map(event => event.status), ['queued', 'queued']);
      assert.deepEqual(new Set(ready.map(event => event.attempt_id)), new Set([registered.attempt.attempt_id]));

      releaseLeases(control, held);
      const results = await withTimeout(Promise.all(children.map(child => child.result)), 10_000, 'workers did not finish');
      assert.equal(results.filter(event => event.type === 'result').length, 2);
      assert.equal(results.reduce((total, event) => total + event.send_count, 0), 1);
      assert.equal(results.every(event => event.attempt_id === registered.attempt.attempt_id), true);

      const events = service.events(taskId, { limit: 1_000 });
      assert.equal(events.filter(event => event.type === 'dispatch.possibly_sent').length, 1);
      assert.equal(events.filter(event => event.type === 'dispatch.accepted').length, 1);
      assert.equal(service.status(taskId).status, 'succeeded');
      assert.equal(control.raw.prepare('SELECT count(*) AS count FROM leases').get().count, 0);
    } finally {
      releaseLeasesIfHeld(control, held);
      for (const child of children) child.killIfRunning();
      await Promise.allSettled(children.map(child => child.closed));
    }
  });
});

test('same UUID workers cannot send twice after sequential lease ownership', async () => {
  await fixture('same-uuid-race', async ({ service }) => {
    const registered = service.submit(request());
    const firstAdapter = new FakeAdapter();
    const secondAdapter = new FakeAdapter();
    const [first, second] = await Promise.all([
      runTask({ service, taskId: registered.task_id, adapter: firstAdapter }),
      runTask({ service, taskId: registered.task_id, adapter: secondAdapter }),
    ]);
    assert.equal(first.status, 'succeeded');
    assert.ok(['starting', 'succeeded'].includes(second.status));
    assert.equal(firstAdapter.sendCount + secondAdapter.sendCount, 1);
    assert.equal(service.status(registered.task_id).status, 'succeeded');
    assert.equal(service.status(registered.task_id).attempt.attempt_id, registered.attempt.attempt_id);
  });
});

test('live task claim blocks recovery, then stale unsent claim recovers in place', async () => {
  await fixture('stale-claim', async ({ control, service }) => {
    const registered = service.submit(request());
    service.transition(registered.task_id, 'queued', { attemptId: registered.attempt.attempt_id });
    const taskLease = acquireTaskLease(control, { taskId: registered.task_id, ownerNonce: 'worker-a', ttlMs: 5_000 });
    const execution = acquireExecutionLeases(control, {
      target: 'opencode', workspace: service.payload(registered.task_id).request.workspace,
      ownerNonce: 'worker-a', ttlMs: 5_000,
    });
    const claimed = service.claimAttempt(registered.task_id, registered.attempt.attempt_id, execution[0]);
    assert.equal(claimed.claimed, true);
    const busy = service.recoverUnsent(registered.task_id);
    assert.equal(busy.recoverable, false);
    assert.equal(busy.reason, 'attempt_owned');

    releaseLeases(control, execution);
    releaseLeases(control, [taskLease]);
    const recovered = service.recoverUnsent(registered.task_id);
    assert.equal(recovered.recoverable, true);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.attempt_id, registered.attempt.attempt_id);
    assert.equal(service.status(registered.task_id).attempt.submission, 'not_sent');
  });
});

test('possibly-sent attempts are never eligible for recovery', async () => {
  await fixture('possibly-sent', async ({ service }) => {
    const registered = service.submit(request());
    const adapter = new FakeAdapter({ fault: 'after_checkpoint' });
    const uncertain = await runTask({ service, taskId: registered.task_id, adapter });
    assert.equal(uncertain.status, 'indeterminate');
    assert.equal(uncertain.attempt.submission, 'may_have_been_sent');
    const recovered = service.recoverUnsent(registered.task_id);
    assert.equal(recovered.recoverable, false);
    assert.equal(recovered.reason, 'submission_started');
    assert.equal(adapter.sendCount, 0);
  });
});

test('worker refreshes a dead foreign durable guard and dispatches only after quiescence', async () => {
  await fixture('durable-guard-refresh', async ({ control, service }) => {
    const foreign = service.submit(request());
    const workspace = service.payload(foreign.task_id).request.workspace;
    createRunningGuard(control, foreign.attempt.attempt_id, workspace, 'refresh');

    const current = service.submit(request({ workspace }));
    const adapter = new FakeAdapter();
    const inspector = {
      inspectProcess: async () => ({ kind: 'absent', pid: 77 }),
      inspectProcessTree: async () => ({ kind: 'quiescent', descendants: [] }),
    };
    const completed = await runTask({
      service,
      taskId: current.task_id,
      adapter,
      leaseOptions: {
        processInspector: inspector,
        maxLeaseWaitMs: 500,
        leaseRetryIntervalMs: 1,
        maxLeaseRetryIntervalMs: 2,
      },
    });
    assert.equal(completed.status, 'succeeded');
    assert.equal(adapter.sendCount, 1);
    assert.equal(getNativeProcess(control, foreign.attempt.attempt_id).workspace_guard_state, 'released');
  });
});

test('worker keeps an unresolved durable guard queued and preserves the specific wait reason', async () => {
  await fixture('durable-guard-unknown', async ({ control, service }) => {
    const foreign = service.submit(request());
    const workspace = service.payload(foreign.task_id).request.workspace;
    createRunningGuard(control, foreign.attempt.attempt_id, workspace, 'unknown');

    const current = service.submit(request({ workspace }));
    const adapter = new FakeAdapter();
    const inspector = {
      inspectProcess: async () => ({ kind: 'inspection_failed', code: 'process_inspection_failed' }),
      inspectProcessTree: async () => { throw new Error('must not inspect tree'); },
    };
    const queued = await runTask({
      service,
      taskId: current.task_id,
      adapter,
      leaseOptions: {
        processInspector: inspector,
        maxLeaseWaitMs: 15,
        leaseRetryIntervalMs: 1,
        maxLeaseRetryIntervalMs: 2,
      },
    });
    assert.equal(queued.status, 'queued');
    assert.equal(adapter.sendCount, 0);
    const last = service.events(current.task_id).at(-1);
    assert.equal(last.payload.queue.reason, 'workspace_execution_unknown');
    assert.equal(last.payload.error.code, 'workspace_execution_unknown');
  });
});

test('normal fresh dispatch rejects a same-Attempt native process row', async () => {
  await fixture('same-attempt-no-redispatch', async ({ control, service }) => {
    const registered = service.submit(request());
    const workspace = service.payload(registered.task_id).request.workspace;
    createRunningGuard(control, registered.attempt.attempt_id, workspace, 'same-attempt');
    const adapter = new FakeAdapter();
    await assert.rejects(() => runTask({ service, taskId: registered.task_id, adapter }), {
      code: 'invalid_state_transition',
    });
    assert.equal(adapter.sendCount, 0);
    assert.deepEqual(service.recoverUnsent(registered.task_id).reason, 'native_process');
    assert.throws(() => service.resume(registered.task_id), { code: 'resume_not_allowed' });

    service.requestCancel(registered.task_id);
    const cancelled = service.cancelUnsent(registered.task_id, registered.attempt.attempt_id);
    assert.equal(cancelled.cancelled, false);
    assert.notEqual(cancelled.status.status, 'cancelled');
  });
});

async function fixture(name, operation) {
  const control = new ControlDatabase(path.join(base, `${name}-${randomUUID()}`));
  try { await operation({ control, service: new TaskService(control) }); }
  finally { control.close(); }
}

function createRunningGuard(control, attemptId, workspace, suffix) {
  const executablePath = path.resolve(base, `${suffix}-opencode.exe`);
  createProvisionalProcess(control, {
    attemptId,
    target: 'opencode',
    workspaceKey: canonicalWorkspace(workspace),
    executablePath,
    executableSha256: 'a'.repeat(64),
    launchFingerprint: 'b'.repeat(64),
    stdoutRelpath: `native/${attemptId}/stdout.log`,
    stderrRelpath: `native/${attemptId}/stderr.log`,
  }, { now: 1000 });
  bindProcessIdentity(control, attemptId, { pid: 77, startedAtMs: 2000, executablePath }, { now: 1001 });
}

function startQueueWorker(root, taskId) {
  const child = spawn(process.execPath, [queueWorkerFixture, root, taskId], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let output = '';
  let readyResolve;
  let readyReject;
  let resultResolve;
  let resultReject;
  let readyEvent = null;
  let resultEvent = null;
  let closedResolve;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
  const closed = new Promise(resolve => { closedResolve = resolve; });
  const parse = chunk => {
    output += chunk;
    const lines = output.split(/\r?\n/);
    output = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch (error) {
        const parseError = new Error(`Invalid queue worker output: ${line}`);
        parseError.cause = error;
        readyReject(parseError);
        resultReject(parseError);
        continue;
      }
      if (event.type === 'ready' && !readyEvent) {
        readyEvent = event;
        readyResolve(event);
      } else if (event.type === 'result' && !resultEvent) {
        resultEvent = event;
        resultResolve(event);
      } else if (event.type === 'error') {
        const childError = new Error(`${event.code}: ${event.message}`);
        childError.code = event.code;
        readyReject(childError);
        resultReject(childError);
      }
    }
  };
  child.stdout.on('data', parse);
  child.stderr.on('data', () => {});
  child.once('error', error => {
    readyReject(error);
    resultReject(error);
    closedResolve();
  });
  child.once('close', code => {
    if (!readyEvent) readyReject(new Error(`queue worker exited before ready (${code})`));
    if (!resultEvent) resultReject(new Error(`queue worker exited before result (${code})`));
    closedResolve();
  });
  return {
    ready,
    result,
    closed,
    killIfRunning() { if (child.exitCode === null && !child.killed) child.kill(); },
  };
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function releaseLeasesIfHeld(control, leases) {
  if (leases?.length) releaseLeases(control, leases);
}
