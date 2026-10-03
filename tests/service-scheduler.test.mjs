import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FakeAdapter } from '../plugins/uagents/src/adapters/fake/adapter.mjs';
import { UnifiedRuntime } from '../plugins/uagents/src/runtime/api.mjs';
import { acquireExecutionLeases, acquireLeaseRow, acquireTaskLease, releaseLeases } from '../plugins/uagents/src/runtime/leases.mjs';
import { createProvisionalProcess } from '../plugins/uagents/src/runtime/native-processes.mjs';
import { runTask } from '../plugins/uagents/src/runtime/worker.mjs';
import { TaskScheduler } from '../plugins/uagents/src/service/scheduler.mjs';

const base = path.resolve('.local', 'test-runs', randomUUID(), 'service scheduler');
const workerFixture = path.resolve('tests', 'fixtures', 'service-scheduler-worker.mjs');
const request = patch => ({
  schema_version: '1.0', request_id: randomUUID(), target: 'opencode',
  model: 'commandcode-goat/deepseek/deepseek-v4-flash', mode: 'analysis', prompt: 'bounded',
  execution: { observation_timeout_ms: 10_000, effort: 'medium', permission: 'native' },
  policy: { fallback: 'none', max_cost_usd: null }, ...patch,
});

test('a timer resumes an abandoned queued task through the existing worker and same attempt', async () => {
  await fixture('automatic-recovery', async ({ runtime, scheduler }) => {
    const registered = runtime.submit(request());
    const held = acquireExecutionLeases(runtime.control, {
      target: 'opencode', workspace: runtime.service.payload(registered.task_id).request.workspace,
      ownerNonce: 'blocking-worker', ttlMs: 5_000,
    });
    const adapter = new FakeAdapter();
    try {
      const queued = await runTask({ service: runtime.service, taskId: registered.task_id, adapter,
        leaseOptions: { maxLeaseWaitMs: 0 } });
      assert.equal(queued.status, 'queued');
      assert.equal(adapter.sendCount, 0);
    } finally { releaseLeases(runtime.control, held); }

    let child;
    let closed;
    let result;
    const ready = new Promise(resolve => { result = resolve; });
    const instance = scheduler({ intervalMs: 10, launchTask: taskId => {
      child = spawn(process.execPath, [workerFixture, runtime.stateRoot, taskId], {
        windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      child.once('message', result);
      closed = new Promise(resolve => child.once('close', resolve));
      return child;
    } });
    instance.start();
    try {
      const message = await withTimeout(ready, 10_000);
      assert.equal(message.type, 'result');
      assert.equal(message.status, 'succeeded');
      assert.equal(message.send_count, 1);
      assert.equal(message.attempt_id, registered.attempt.attempt_id);
      await withTimeout(closed, 5_000);
      assert.equal(runtime.status(registered.task_id).attempt.attempt_id, registered.attempt.attempt_id);
      assert.equal(runtime.control.raw.prepare('SELECT count(*) AS count FROM attempts WHERE task_id = ?').get(registered.task_id).count, 1);
      assert.equal(instance.snapshot().counts.launched, 1);
      assert.equal(instance.snapshot().in_flight, 0);
    } finally {
      instance.stop();
      if (child && child.exitCode === null) child.kill();
      if (closed) await withTimeout(closed, 5_000);
    }
  });
});

test('two scheduler connections compete for one fenced lease without duplicate launch', async () => {
  await fixture('singleton', async ({ runtime, scheduler }) => {
    queued(runtime);
    const other = new UnifiedRuntime({ stateRoot: runtime.stateRoot, spawnWorker: () => fakeChild() });
    const children = [];
    const launchTask = () => { const child = fakeChild(); children.push(child); return child; };
    const first = scheduler({ launchTask });
    const second = scheduler({ runtime: other, launchTask });
    try {
      await Promise.all([first.tick(), second.tick()]);
      const lease = runtime.control.raw.prepare("SELECT * FROM leases WHERE resource_key = 'service:scheduler'").get();
      for (let index = 0; index < 3; index++) await Promise.all([first.tick(), second.tick()]);
      const renewed = runtime.control.raw.prepare("SELECT * FROM leases WHERE resource_key = 'service:scheduler'").get();
      assert.equal(children.length, 1);
      assert.equal(renewed.owner_nonce, lease.owner_nonce);
      assert.equal(renewed.fencing_token, lease.fencing_token);
      assert.equal(renewed.epoch, lease.epoch);
      assert.equal(first.snapshot().in_flight + second.snapshot().in_flight, 1);
      assert.ok(first.snapshot().counts.lease_conflicts + second.snapshot().counts.lease_conflicts > 0);
    } finally { first.stop(); second.stop(); other.close(); }
  });
});

test('fencing loss between filtering and launching suppresses launch and stale stop preserves new owner', async () => {
  await fixture('fencing', async ({ runtime, scheduler }) => {
    queued(runtime);
    let now = 100;
    let launches = 0;
    let newer;
    const instance = scheduler({ clock: () => now, leaseTtlMs: 10,
      acceptsTask: () => {
        now = 111;
        newer = runtime.control.transaction(database => acquireLeaseRow(database,
          'service:scheduler', 'service_scheduler', 'replacement', 100, now, {}));
        return true;
      }, launchTask: () => { launches++; return fakeChild(); },
    });
    await instance.tick();
    assert.equal(launches, 0);
    assert.equal(instance.snapshot().lease_held, false);
    instance.stop();
    const current = runtime.control.raw.prepare("SELECT * FROM leases WHERE resource_key = 'service:scheduler'").get();
    assert.equal(current.owner_nonce, 'replacement');
    assert.equal(current.fencing_token, newer.fencing_token);
  });
});

test('Core blocks active task/attempt leases, native sessions and durable processes; sent and active states are not scanned', async () => {
  await fixture('safety', async ({ runtime, scheduler }) => {
    const taskOwned = queued(runtime);
    acquireTaskLease(runtime.control, { taskId: taskOwned.task_id, ownerNonce: 'live-task', now: 100, ttlMs: 1000 });
    const attemptOwned = queued(runtime);
    const execution = acquireExecutionLeases(runtime.control, { target: 'opencode', ownerNonce: 'live-attempt', now: 100, ttlMs: 1000 });
    assert.equal(runtime.service.claimAttempt(attemptOwned.task_id, attemptOwned.attempt.attempt_id, execution[0], { now: 100 }).claimed, true);
    const possible = queued(runtime);
    const sent = queued(runtime);
    runtime.control.raw.prepare('UPDATE attempts SET submission = ? WHERE attempt_id = ?').run('may_have_been_sent', possible.attempt.attempt_id);
    runtime.control.raw.prepare('UPDATE attempts SET submission = ? WHERE attempt_id = ?').run('sent', sent.attempt.attempt_id);
    const native = queued(runtime);
    runtime.control.raw.prepare('INSERT INTO native_sessions(attempt_id, target, native_session_id) VALUES (?, ?, ?)')
      .run(native.attempt.attempt_id, 'opencode', 'existing-native-session');
    const processTask = queued(runtime);
    createProvisionalProcess(runtime.control, {
      attemptId: processTask.attempt.attempt_id, target: 'opencode',
      executablePath: path.resolve(base, 'opencode.exe'), launchFingerprint: 'a'.repeat(64),
      stdoutRelpath: 'native/stdout.log', stderrRelpath: 'native/stderr.log',
    }, { now: 100 });
    const starting = queued(runtime);
    const running = queued(runtime);
    runtime.control.raw.prepare('UPDATE tasks SET status = ? WHERE task_id = ?').run('starting', starting.task_id);
    runtime.control.raw.prepare('UPDATE tasks SET status = ? WHERE task_id = ?').run('running', running.task_id);
    const visited = [];
    const recover = runtime.service.recoverUnsent.bind(runtime.service);
    runtime.service.recoverUnsent = (...args) => { visited.push(args[0]); return recover(...args); };
    const instance = scheduler({ clock: () => 101, launchTask: () => { assert.fail('unsafe task launched'); } });
    await instance.tick();
    assert.equal(instance.snapshot().counts.launched, 0);
    assert.deepEqual(new Set(visited), new Set([taskOwned.task_id, attemptOwned.task_id, native.task_id, processTask.task_id]));
    assert.equal(runtime.status(possible.task_id).attempt.submission, 'may_have_been_sent');
    assert.equal(runtime.status(sent.task_id).attempt.submission, 'sent');
  });
});

test('a stale unsent attempt is recovered in place and an expired scheduler reacquires a new identity', async () => {
  await fixture('stale', async ({ runtime, scheduler }) => {
    const task = queued(runtime);
    const execution = acquireExecutionLeases(runtime.control, { target: 'opencode', ownerNonce: 'stale-worker', now: 100, ttlMs: 10 });
    runtime.service.claimAttempt(task.task_id, task.attempt.attempt_id, execution[0], { now: 100 });
    let now = 111;
    const children = [];
    const instance = scheduler({ clock: () => now, leaseTtlMs: 10, intervalMs: 1,
      launchTask: () => { const child = fakeChild(); children.push(child); return child; } });
    await instance.tick();
    assert.equal(instance.snapshot().counts.recovered, 1);
    assert.equal(runtime.status(task.task_id).attempt.attempt_id, task.attempt.attempt_id);
    const old = runtime.control.raw.prepare("SELECT * FROM leases WHERE resource_key = 'service:scheduler'").get();
    now = 122;
    await instance.tick();
    const current = runtime.control.raw.prepare("SELECT * FROM leases WHERE resource_key = 'service:scheduler'").get();
    assert.notEqual(current.fencing_token, old.fencing_token);
    assert.equal(current.epoch, old.epoch + 1);
    assert.equal(children.length, 1);
  });
});

test('queued cancellation is completed without launching, including while capacity is full', async () => {
  await fixture('cancel', async ({ runtime, scheduler }) => {
    const busy = queued(runtime);
    runtime.control.raw.prepare('UPDATE tasks SET created_at_ms = 1 WHERE task_id = ?').run(busy.task_id);
    const cancelled = queued(runtime);
    runtime.cancel(cancelled.task_id);
    const instance = scheduler({ maxInFlight: 1, launchTask: () => fakeChild() });
    await instance.tick();
    assert.equal(instance.snapshot().counts.launched, 1);
    assert.equal(instance.snapshot().counts.cancelled, 1);
    assert.equal(runtime.status(cancelled.task_id).status, 'cancelled');
    assert.equal(runtime.status(cancelled.task_id).attempt.submission, 'not_sent');
  });
});

test('acceptsTask keeps launch and cancellation within the configured scope', async () => {
  await fixture('scope', async ({ runtime, scheduler }) => {
    const outside = queued(runtime);
    runtime.cancel(outside.task_id);
    const inside = queued(runtime);
    const launched = [];
    const instance = scheduler({ acceptsTask: status => status.task_id === inside.task_id,
      launchTask: taskId => { launched.push(taskId); return fakeChild(); } });
    await instance.tick();
    assert.deepEqual(launched, [inside.task_id]);
    assert.equal(runtime.status(outside.task_id).status, 'queued');
  });
});

test('synchronous launch failure retains the same queued attempt and retries after backoff', async () => {
  await fixture('sync-failure', async ({ runtime, scheduler }) => {
    const task = queued(runtime);
    let now = 1000;
    let calls = 0;
    const instance = scheduler({ clock: () => now, intervalMs: 10, launchTask: () => {
      calls++;
      if (calls === 1) throw new Error('secret-native-launch-detail');
      return fakeChild();
    } });
    await instance.tick();
    assert.equal(instance.snapshot().in_flight, 0);
    assert.equal(instance.snapshot().counts.launch_failed, 1);
    assert.equal(runtime.status(task.task_id).status, 'queued');
    assert.equal(runtime.status(task.task_id).attempt.attempt_id, task.attempt.attempt_id);
    assert.equal(runtime.status(task.task_id).error.code, 'worker_launch_failed');
    await instance.tick();
    assert.equal(calls, 1);
    now += 10;
    await instance.tick();
    assert.equal(calls, 2);
    assert.equal(instance.snapshot().in_flight, 1);
    assert.equal(JSON.stringify(runtime.service.events(task.task_id)).includes('secret-native-launch-detail'), false);
  });
});

test('child error and exit/close accounting are idempotent and do not leak native text', async () => {
  await fixture('async-failure', async ({ runtime, scheduler }) => {
    const task = queued(runtime);
    const child = fakeChild();
    const events = [];
    const instance = scheduler({ launchTask: () => child, onEvent: event => events.push(event) });
    await instance.tick();
    child.emit('error', new Error('credential=secret-native-launch-detail'));
    child.emit('exit', 1);
    child.emit('close', 1);
    const snapshot = instance.snapshot();
    assert.equal(snapshot.in_flight, 0);
    assert.equal(snapshot.counts.launch_failed, 1);
    assert.equal(snapshot.counts.completed, 0);
    assert.equal(runtime.status(task.task_id).status, 'queued');
    assert.equal(JSON.stringify([snapshot, events, runtime.service.events(task.task_id)]).includes('secret-native-launch-detail'), false);
  });
});

test('a worker error after submission never requeues or relaunches a sent attempt', async () => {
  await fixture('error-after-sent', async ({ runtime, scheduler }) => {
    const task = queued(runtime);
    const child = fakeChild();
    let now = Date.now();
    let launches = 0;
    const instance = scheduler({ clock: () => now, intervalMs: 10,
      launchTask: () => { launches++; return child; } });
    await instance.tick();
    const adapter = new FakeAdapter();
    const completed = await runTask({ service: runtime.service, taskId: task.task_id, adapter });
    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.attempt.submission, 'sent');
    child.emit('error', new Error('secret-native-error-after-send'));
    now += 100;
    await instance.tick();
    assert.equal(launches, 1);
    assert.equal(adapter.sendCount, 1);
    assert.equal(runtime.status(task.task_id).status, 'succeeded');
    assert.equal(runtime.status(task.task_id).attempt.attempt_id, task.attempt.attempt_id);
    assert.equal(runtime.status(task.task_id).error, null);
  });
});

test('bounded keyset batches reach tasks beyond a blocked first batch and wrap fairly', async () => {
  await fixture('fairness', async ({ runtime, scheduler }) => {
    const blocked = [];
    for (let index = 0; index < 5; index++) {
      const task = queued(runtime);
      runtime.control.raw.prepare('UPDATE tasks SET created_at_ms = ? WHERE task_id = ?').run(index + 1, task.task_id);
      acquireTaskLease(runtime.control, { taskId: task.task_id, ownerNonce: `holder-${index}`, now: 100, ttlMs: 1000 });
      blocked.push(task.task_id);
    }
    const later = queued(runtime);
    runtime.control.raw.prepare('UPDATE tasks SET created_at_ms = 6 WHERE task_id = ?').run(later.task_id);
    const launched = [];
    const instance = scheduler({ batchSize: 2, maxInFlight: 6, clock: () => 101,
      launchTask: taskId => { launched.push(taskId); return fakeChild(); } });
    for (let index = 0; index < 3; index++) {
      const before = instance.snapshot().counts.scanned;
      await instance.tick();
      assert.equal(instance.snapshot().counts.scanned - before, 2);
    }
    assert.deepEqual(launched, [later.task_id]);
    await instance.tick(); // Exhausted cursor resets without a second unbounded query.
    const before = instance.snapshot().counts.scanned;
    await instance.tick();
    assert.equal(instance.snapshot().counts.scanned - before, 2);
    assert.equal(launched.length, 1);
  });
});

test('in-flight limits and pre-claim suppression prevent repeated workers until exit and cooldown', async () => {
  await fixture('in-flight', async ({ runtime, scheduler }) => {
    for (let index = 0; index < 3; index++) queued(runtime);
    let now = 100;
    const children = [];
    const instance = scheduler({ maxInFlight: 1, clock: () => now, intervalMs: 10,
      launchTask: taskId => { const child = fakeChild(); child.taskId = taskId; children.push(child); return child; } });
    await instance.tick();
    now += 500;
    await instance.tick();
    assert.equal(children.length, 1);
    children[0].emit('exit', 0);
    children[0].emit('close', 0);
    assert.equal(instance.snapshot().counts.completed, 1);
    await instance.tick();
    assert.equal(children.length, 2);
    assert.notEqual(children[1].taskId, children[0].taskId);
    assert.equal(instance.snapshot().in_flight, 1);
  });
});

test('a restarted scheduler counts surviving detached worker leases across database connections', async () => {
  await fixture('restart-capacity', async ({ runtime, scheduler }) => {
    const oldTask = queued(runtime);
    const child = fakeChild();
    let workerLease;
    const oldScheduler = scheduler({ maxInFlight: 1, clock: () => 100,
      launchTask: taskId => {
        workerLease = acquireTaskLease(runtime.control, { taskId, ownerNonce: 'detached-worker', now: 100, ttlMs: 1000 });
        return child;
      } });
    await oldScheduler.tick();
    assert.equal(oldScheduler.snapshot().counts.launched, 1);
    runtime.control.raw.prepare('UPDATE tasks SET status = ? WHERE task_id = ?').run('running', oldTask.task_id);
    oldScheduler.stop();

    const restartedRuntime = new UnifiedRuntime({ stateRoot: runtime.stateRoot, spawnWorker: () => fakeChild() });
    let newScheduler;
    try {
      const next = queued(restartedRuntime);
      const launches = [];
      newScheduler = scheduler({ runtime: restartedRuntime, maxInFlight: 1, clock: () => 101,
        launchTask: taskId => { launches.push(taskId); return fakeChild(); } });
      await newScheduler.tick();
      assert.equal(newScheduler.snapshot().in_flight, 0);
      assert.equal(newScheduler.snapshot().counts.launched, 0);
      assert.equal(restartedRuntime.status(next.task_id).status, 'queued');
      assert.deepEqual(launches, []);
      releaseLeases(restartedRuntime.control, [workerLease]);
      child.emit('exit', 0);
      await newScheduler.tick();
      assert.deepEqual(launches, [next.task_id]);
      assert.equal(newScheduler.snapshot().in_flight, 1);
    } finally { newScheduler?.stop(); restartedRuntime.close(); }
  });
});

test('shared CLI worker leases outside the configured scope consume capacity only while unexpired', async () => {
  await fixture('shared-capacity-expiry', async ({ runtime, scheduler }) => {
    const cliTask = queued(runtime);
    acquireTaskLease(runtime.control, { taskId: cliTask.task_id, ownerNonce: 'shared-cli-worker', now: 100, ttlMs: 10 });
    const next = queued(runtime);
    let now = 109;
    const launches = [];
    const instance = scheduler({ maxInFlight: 1, clock: () => now,
      acceptsTask: status => status.task_id === next.task_id,
      launchTask: taskId => { launches.push(taskId); return fakeChild(); } });
    await instance.tick();
    assert.deepEqual(launches, []);
    now = 110;
    await instance.tick();
    assert.deepEqual(launches, [next.task_id]);
    assert.equal(runtime.status(cliTask.task_id).status, 'queued');
  });
});

test('local in-flight workers holding task leases count once and allow the remaining slot', async () => {
  await fixture('capacity-deduplication', async ({ runtime, scheduler }) => {
    for (let index = 0; index < 3; index++) queued(runtime);
    const launches = [];
    const instance = scheduler({ maxInFlight: 2, clock: () => 101,
      launchTask: taskId => {
        acquireTaskLease(runtime.control, { taskId, ownerNonce: `worker-${taskId}`, now: 100, ttlMs: 1000 });
        launches.push(taskId);
        return fakeChild();
      } });
    await instance.tick();
    assert.equal(launches.length, 2);
    assert.equal(instance.snapshot().in_flight, 2);
    await instance.tick();
    assert.equal(launches.length, 2);
  });
});

test('every launch combines current shared lease capacity with local unclaimed workers', async () => {
  await fixture('capacity-refresh', async ({ runtime, scheduler }) => {
    const first = queued(runtime);
    const second = queued(runtime);
    const cliTask = queued(runtime);
    const allowed = new Set([first.task_id, second.task_id]);
    const launches = [];
    const instance = scheduler({ maxInFlight: 2, clock: () => 101,
      acceptsTask: status => allowed.has(status.task_id),
      launchTask: taskId => { launches.push(taskId); return fakeChild(); },
      onEvent: event => {
        if (event.type === 'scheduler.launched' && launches.length === 1) {
          acquireTaskLease(runtime.control, { taskId: cliTask.task_id, ownerNonce: 'new-cli-worker', now: 100, ttlMs: 1000 });
        }
      } });
    await instance.tick();
    assert.equal(launches.length, 1);
    assert.equal(instance.snapshot().in_flight, 1);
  });
});

test('stop releases only the scheduler lease, leaves workers alive and blocks pending timer work', async () => {
  await fixture('stop', async ({ runtime, scheduler }) => {
    const task = queued(runtime);
    const child = fakeChild();
    let kills = 0;
    child.kill = () => { kills++; };
    const instance = scheduler({ launchTask: () => child });
    instance.start();
    await instance.tick();
    acquireTaskLease(runtime.control, { taskId: task.task_id, ownerNonce: 'existing-worker' });
    const before = runtime.status(task.task_id);
    instance.stop();
    await instance.tick();
    assert.equal(kills, 0);
    assert.equal(instance.snapshot().running, false);
    assert.equal(instance.snapshot().in_flight, 1);
    assert.equal(instance.snapshot().counts.launched, 1);
    assert.equal(runtime.control.raw.prepare("SELECT 1 FROM leases WHERE resource_key = 'service:scheduler'").get(), undefined);
    assert.ok(runtime.control.raw.prepare('SELECT 1 FROM leases WHERE resource_key = ?').get(`task:${task.task_id}`));
    assert.deepEqual(runtime.status(task.task_id), before);
    child.emit('close', 0);
    assert.equal(instance.snapshot().in_flight, 0);
  });
});

test('snapshot copies health counters and reports fixed callback error codes', async () => {
  await fixture('health', async ({ runtime, scheduler }) => {
    queued(runtime);
    const instance = scheduler({ clock: () => 1234, launchTask: () => fakeChild(),
      onEvent: () => { throw new Error('secret-callback-detail'); } });
    await instance.tick();
    const health = instance.snapshot();
    assert.equal(health.last_scan_at_ms, 1234);
    assert.equal(health.last_progress_at_ms, 1234);
    assert.equal(health.errors.last_code, 'scheduler_event_failed');
    health.counts.launched = 500;
    health.errors.by_code.scheduler_event_failed = 500;
    assert.equal(instance.snapshot().counts.launched, 1);
    assert.equal(instance.snapshot().errors.by_code.scheduler_event_failed, 1);
    assert.equal(JSON.stringify(instance.snapshot()).includes('secret-callback-detail'), false);
  });
});

function fakeChild() { return Object.assign(new EventEmitter(), { pid: 123 }); }

function queued(runtime) {
  const task = runtime.submit(request());
  return runtime.service.recordLeaseWait(task.task_id, task.attempt.attempt_id);
}

async function fixture(name, operation) {
  const runtime = new UnifiedRuntime({ stateRoot: path.join(base, `${name}-${randomUUID()}`),
    spawnWorker: () => fakeChild() });
  const schedulers = [];
  const scheduler = options => {
    const instance = new TaskScheduler({ runtime, launchTask: () => fakeChild(), ...options });
    schedulers.push(instance);
    return instance;
  };
  try { await operation({ runtime, scheduler }); }
  finally { for (const instance of schedulers) instance.stop(); runtime.close(); }
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Scheduler fixture timed out.')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
