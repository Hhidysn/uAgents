import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FakeAdapter } from '../plugins/uagents/src/adapters/fake/adapter.mjs';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
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

async function fixture(name, operation) {
  const control = new ControlDatabase(path.join(base, `${name}-${randomUUID()}`));
  try { await operation({ control, service: new TaskService(control) }); }
  finally { control.close(); }
}
