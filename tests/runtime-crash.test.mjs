import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FakeAdapter } from '../plugins/uagents/src/adapters/fake/adapter.mjs';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { acquireExecutionLeases } from '../plugins/uagents/src/runtime/leases.mjs';
import { UnifiedRuntime } from '../plugins/uagents/src/runtime/api.mjs';
import { reconcileTask } from '../plugins/uagents/src/runtime/reconcile.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { runTask } from '../plugins/uagents/src/runtime/worker.mjs';

const base = path.resolve('.local', 'test-runs', randomUUID(), 'runtime crash');
fs.mkdirSync(base, { recursive: true });
const request = patch => ({
  schema_version: '1.0', request_id: randomUUID(), target: 'opencode',
  model: 'commandcode-goat/deepseek/deepseek-v4-flash', mode: 'analysis', prompt: 'bounded',
  execution: { observation_timeout_ms: 10_000, effort: 'medium', permission: 'native' },
  policy: { fallback: 'none', max_cost_usd: null }, ...patch,
});

describe('preflight waiting_user and resume', () => {
  test('explicit resume returns an unsent waiting attempt to queued without a new attempt', async () => {
    await fixture('resume-preflight', async ({ service }) => {
      const input = request();
      const registered = service.submit(input, { adapterVersion: 'fake-1' });
      const attemptId = registered.attempt.attempt_id;
      markPreflightWaiting(service, registered.task_id, attemptId);

      const resumed = service.resume(registered.task_id);
      assert.equal(resumed.mode, 'preflight');
      assert.equal(resumed.attempt.attempt_id, attemptId);
      assert.equal(resumed.status, 'queued');
      assert.equal(resumed.attempt.submission, 'not_sent');
      assert.equal(countAttempts(service.control, registered.task_id), 1);
      const resumedEvent = service.events(registered.task_id).at(-1);
      assert.equal(resumedEvent.type, 'task.queued');
      assert.equal(resumedEvent.payload.resumed, true);
      assert.equal(JSON.stringify(resumedEvent.payload).includes('bounded'), false);
      const waitingEvent = service.events(registered.task_id).find(event => event.type === 'task.waiting_user');
      assert.deepEqual(waitingEvent.payload.interaction, { phase: 'preflight_login' });
    });
  });

  test('duplicate submit with the same effective hash implicitly resumes and spawns one worker', async () => {
    await fixture('resume-submit', async ({ control, service }) => {
      const input = request();
      const spawns = [];
      const runtime = runtimeWith({ control, service, spawn: (root, taskId) => spawns.push([root, taskId]) });
      const registered = await runtime.submit(input);
      assert.equal(registered.duplicate, false);
      markPreflightWaiting(service, registered.task_id, registered.attempt.attempt_id);

      spawns.length = 0;
      const resumed = await runtime.submit(input);
      assert.equal(resumed.duplicate, true);
      assert.equal(resumed.resumed, true);
      assert.equal(resumed.task_id, registered.task_id);
      assert.equal(resumed.attempt.attempt_id, registered.attempt.attempt_id);
      assert.equal(resumed.status, 'queued');
      assert.deepEqual(spawns, [[runtime.stateRoot, registered.task_id]]);
    });
  });

  test('duplicate submit with a changed effective hash conflicts without spawning or transitioning', async () => {
    await fixture('resume-conflict', async ({ control, service }) => {
      const input = request();
      const spawns = [];
      const runtime = runtimeWith({ control, service, spawn: (root, taskId) => spawns.push([root, taskId]) });
      const registered = await runtime.submit(input);
      markPreflightWaiting(service, registered.task_id, registered.attempt.attempt_id);

      spawns.length = 0;
      const eventsBefore = service.events(registered.task_id).length;
      assert.throws(() => runtime.submit({ ...input, prompt: 'changed' }), { code: 'request_conflict' });
      assert.equal(spawns.length, 0);
      assert.equal(service.status(registered.task_id).status, 'waiting_user');
      assert.equal(service.events(registered.task_id).length, eventsBefore);
    });
  });

  test('duplicate submit for a possibly-sent task only reports duplicate', async () => {
    await fixture('resume-sent-duplicate', async ({ control, service }) => {
      const input = request();
      const spawns = [];
      const runtime = runtimeWith({ control, service, spawn: (root, taskId) => spawns.push([root, taskId]) });
      const registered = await runtime.submit(input);
      const adapter = new FakeAdapter({ events: [{ type: 'waiting_user', native_status: 'approval_required' }] });
      await runTask({ service, taskId: registered.task_id, adapter });
      const waiting = service.status(registered.task_id);
      assert.equal(waiting.status, 'waiting_user');
      assert.equal(waiting.attempt.submission, 'sent');

      spawns.length = 0;
      const duplicate = await runtime.submit(input);
      assert.equal(duplicate.duplicate, true);
      assert.equal(Boolean(duplicate.resumed), false);
      assert.equal(spawns.length, 0);
      assert.equal(service.status(registered.task_id).status, 'waiting_user');
    });
  });

  test('resume of a native-identity waiting task reconciles without dispatching', async () => {
    await fixture('resume-reconcile', async ({ service }) => {
      const registered = service.submit(request(), { adapterVersion: 'fake-1' });
      const adapter = new FakeAdapter({ events: [{ type: 'waiting_user', native_status: 'approval_required' }] });
      const waiting = await runTask({ service, taskId: registered.task_id, adapter });
      assert.equal(waiting.status, 'waiting_user');

      const resumed = service.resume(registered.task_id);
      assert.equal(resumed.mode, 'reconcile');
      assert.equal(resumed.native_identity, waiting.native.session_id);
      assert.equal(adapter.sendCount, 1);
      assert.equal(service.status(registered.task_id).status, 'waiting_user');
      const reconciled = await reconcileTask({ service, taskId: registered.task_id, adapter });
      assert.equal(reconciled.status, 'succeeded');
      assert.equal(adapter.sendCount, 1);
    });
  });

  for (const [fault, expectedStatus] of [
    ['after_checkpoint', 'indeterminate'],
    ['after_send', 'indeterminate'],
    ['before_accepted', 'indeterminate'],
  ]) test(`resume of a ${expectedStatus} task is rejected with resume_not_allowed`, async () => {
    await fixture(`resume-not-allowed-${fault}`, async ({ service }) => {
      const registered = service.submit(request(), { adapterVersion: 'fake-1' });
      const result = await runTask({ service, taskId: registered.task_id, adapter: new FakeAdapter({ fault }) });
      assert.equal(result.status, expectedStatus);
      assert.throws(() => service.resume(registered.task_id), error => {
        assert.equal(error.code, 'resume_not_allowed');
        assert.equal(error.submission, 'not_sent');
        return true;
      });
    });
  });

  test('resume rejects terminal and running tasks with resume_not_allowed', async () => {
    await fixture('resume-terminal', async ({ service }) => {
      const succeeded = service.submit(request(), { adapterVersion: 'fake-1' });
      await runTask({ service, taskId: succeeded.task_id, adapter: new FakeAdapter() });
      assert.throws(() => service.resume(succeeded.task_id), { code: 'resume_not_allowed', submission: 'not_sent' });

      const cancelled = service.submit(request(), { adapterVersion: 'fake-1' });
      await runTask({ service, taskId: cancelled.task_id, adapter: new FakeAdapter({ fault: 'before_checkpoint' }) });
      assert.equal(service.status(cancelled.task_id).status, 'failed');
      assert.throws(() => service.resume(cancelled.task_id), { code: 'resume_not_allowed' });

      const registered = service.submit(request(), { adapterVersion: 'fake-1' });
      const resumed = service.resume(registered.task_id);
      assert.equal(resumed.mode, 'dispatch');
      assert.equal(resumed.attempt.attempt_id, registered.attempt.attempt_id);
    });
  });
});

test('successful fake dispatch persists checkpoints, identity and terminal state', async () => {
  await fixture('success', async ({ service }) => {
    const input = request();
    const registered = service.submit(input, { adapterVersion: 'fake-1' });
    const adapter = new FakeAdapter();
    const result = await runTask({ service, taskId: registered.task_id, adapter });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.attempt.submission, 'sent');
    assert.match(result.native.session_id, /^fake-session-/);
    assert.equal(adapter.sendCount, 1);
    assert.deepEqual(service.events(result.task_id).map(event => event.type), [
      'task.registered', 'task.queued', 'task.starting', 'dispatch.possibly_sent', 'dispatch.accepted', 'task.succeeded',
    ]);
  });
});

for (const [fault, submission, sent] of [
  ['before_checkpoint', 'not_sent', 0],
  ['after_checkpoint', 'may_have_been_sent', 0],
  ['after_send', 'may_have_been_sent', 1],
  ['before_accepted', 'may_have_been_sent', 1],
]) test(`dispatch fault ${fault} preserves conservative send semantics`, async () => {
  await fixture(fault, async ({ service }) => {
    const input = request();
    const registered = service.submit(input, { adapterVersion: 'fake-1' });
    const adapter = new FakeAdapter({ fault });
    const result = await runTask({ service, taskId: registered.task_id, adapter });
    assert.equal(result.attempt.submission, submission);
    assert.equal(result.status, submission === 'not_sent' ? 'failed' : 'indeterminate');
    assert.equal(adapter.sendCount, sent);
    assert.equal(service.submit(input, { adapterVersion: 'fake-1' }).duplicate, true);
  });
});

test('changed input fails before possibly-sent checkpoint', async () => {
  await fixture('input-change', async ({ service }) => {
    const workspace = path.join(base, 'input workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'input.txt'), 'one');
    const input = request({ target: 'agy', model: 'gemini-fixture-low', workspace, inputs: [{ type: 'file', path: 'input.txt' }] });
    const registered = service.submit(input, { adapterVersion: 'fake-1' });
    fs.writeFileSync(path.join(workspace, 'input.txt'), 'two');
    await assert.rejects(runTask({ service, taskId: registered.task_id, adapter: new FakeAdapter() }), { code: 'input_changed' });
    const result = service.status(registered.task_id);
    assert.equal(result.status, 'failed');
    assert.equal(result.attempt.submission, 'not_sent');
  });
});

test('indeterminate task reconciles only through persisted native identity', async () => {
  await fixture('reconcile', async ({ service }) => {
    const registered = service.submit(request(), { adapterVersion: 'fake-1' });
    const adapter = new FakeAdapter({ events: [{ type: 'indeterminate', evidence_strength: 1 }], reconcile: { type: 'succeeded' } });
    const uncertain = await runTask({ service, taskId: registered.task_id, adapter });
    assert.equal(uncertain.status, 'indeterminate');
    const completed = await reconcileTask({ service, taskId: registered.task_id, adapter });
    assert.equal(completed.status, 'succeeded');
    assert.equal(adapter.sendCount, 1);
  });
});

test('explicit indeterminate observation is the observation terminal reason and is not overwritten by stream-empty fallback', async () => {
  await fixture('explicit-indeterminate-terminal', async ({ service }) => {
    const registered = service.submit(request(), { adapterVersion: 'fake-1' });
    const taskId = registered.task_id;
    const adapter = new FakeAdapter({ events: [{ type: 'indeterminate', evidence_strength: 1, error: 'fixture_indeterminate' }] });
    const result = await runTask({ service, taskId, adapter });
    assert.equal(result.status, 'indeterminate');
    assert.equal(result.error?.code, 'fixture_indeterminate');
    const indeterminateEvents = service.events(taskId).filter(event => event.type === 'task.indeterminate');
    assert.equal(indeterminateEvents.length, 1);
    assert.equal(indeterminateEvents[0].payload.error, 'fixture_indeterminate');
  });
});

test('worker heartbeat renews short leases until a long observation completes', async () => {
  await fixture('heartbeat', async ({ control, service }) => {
    const registered = service.submit(request(), { adapterVersion: 'fake-1' });
    const adapter = new FakeAdapter();
    adapter.observe = async function* () {
      await new Promise(resolve => setTimeout(resolve, 180));
      yield { type: 'succeeded', same_native_identity: true, evidence_strength: 2 };
    };
    const running = runTask({ service, taskId: registered.task_id, adapter, leaseOptions: { ttlMs: 90, heartbeatIntervalMs: 20 } });
    await new Promise(resolve => setTimeout(resolve, 130));
    assert.throws(() => acquireExecutionLeases(control, {
      target: 'opencode', workspace: service.payload(registered.task_id).request.workspace, ownerNonce: 'takeover', ttlMs: 1_000,
    }), { code: 'lease_conflict' });
    const result = await running;
    assert.equal(result.status, 'succeeded');
    assert.ok(result.attempt.heartbeat_at_ms >= result.created_at_ms);
  });
});

async function fixture(name, operation) {
  const control = new ControlDatabase(path.join(base, `${name}-${randomUUID()}`));
  try { await operation({ control, service: new TaskService(control) }); }
  finally { control.close(); }
}

function countAttempts(control, taskId) {
  return Number(control.raw.prepare('SELECT count(*) AS count FROM attempts WHERE task_id = ?').get(taskId).count);
}

function markPreflightWaiting(service, taskId, attemptId) {
  service.transition(taskId, 'queued', { attemptId });
  service.transition(taskId, 'starting', { attemptId });
  service.transition(taskId, 'waiting_user', {
    attemptId,
    event: { interaction: { phase: 'preflight_login' }, error: 'target_login_required' },
  });
  const waiting = service.status(taskId);
  assert.equal(waiting.status, 'waiting_user');
  assert.equal(waiting.attempt.submission, 'not_sent');
}

function runtimeWith({ control, service, spawn }) {
  const runtime = new UnifiedRuntime({ stateRoot: control.root, spawnWorker: spawn });
  runtime.control = control;
  runtime.service = service;
  return runtime;
}
