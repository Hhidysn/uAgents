import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DoubaoAdapter } from '../plugins/uagents/src/adapters/doubao/adapter.mjs';
import { TraeAdapter } from '../plugins/uagents/src/adapters/trae/adapter.mjs';
import { validateAdapter } from '../plugins/uagents/src/adapters/contract.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { runTask } from '../plugins/uagents/src/runtime/worker.mjs';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';

const root = path.resolve('.local', 'test-runs', randomUUID(), 'desktop adapters');
fs.mkdirSync(root, { recursive: true });
const baseRequest = patch => ({
  schema_version: '1.0', request_id: randomUUID(), target: 'doubao', model: 'default', mode: 'analysis', prompt: 'bounded',
  execution: { observation_timeout_ms: 5_000, effort: 'medium', permission: 'native' },
  policy: { fallback: 'none', max_cost_usd: null }, ...patch,
});

class DoubaoBridge {
  constructor() { this.sends = 0; this.observations = [{ status: 'running' }, { status: 'succeeded', response: '豆包完成', evidence: { stable_ms: 300 } }]; }
  async probe() { return { status: 'available', submission: 'not_sent' }; }
  async prepareAndSubmit(prompt, publish) {
    await publish({ submission: 'may_have_been_sent' });
    this.sends++;
    this.prompt = prompt;
    return { target_id: 'page-1', native_conversation_id: 'conversation-1', user_message_index: 0 };
  }
  async inspect() { return this.observations.shift(); }
}

class TraeClient {
  constructor() { this.sends = 0; this.observations = [{ status: 'executing' }, { status: 'done', result: { text: 'TRAE 完成', stable: true } }]; }
  async status() { return { version: 'fixture', status: 'connected', cdpReachable: true, traeRunning: true, surface: { kind: 'workspace', url: 'file:///workbench/workbench.html' } }; }
  async submit(body, requestId) { this.sends++; this.body = body; this.requestId = requestId; return { taskId: 'trae-task-1', status: 'accepted' }; }
  async task() { return this.observations.shift(); }
}

for (const target of ['doubao', 'trae']) test(`${target} adapter completes through the shared runtime`, async () => {
  const control = new ControlDatabase(path.join(root, `${target}-${randomUUID()}`));
  try {
    const service = new TaskService(control);
    const transport = target === 'doubao' ? new DoubaoBridge() : new TraeClient();
    const adapter = target === 'doubao'
      ? new DoubaoAdapter({ bridge: transport, pollIntervalMs: 0 })
      : new TraeAdapter({ client: transport, pollIntervalMs: 0 });
    validateAdapter(adapter);
    const registered = service.submit(baseRequest({ target }), { adapterVersion: 'desktop-fixture-1' });
    const result = await runTask({ service, taskId: registered.task_id, adapter });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.attempt.submission, 'sent');
    assert.equal(transport.sends, 1);
    assert.equal(result.model_reported, null);
    assert.equal(result.model_verified, false);
    assert.match(service.result(result.task_id).response.text, /完成/);
    assert.deepEqual(service.events(result.task_id).map(event => event.type), [
      'task.registered', 'task.queued', 'task.starting', 'dispatch.possibly_sent', 'dispatch.accepted', 'task.running', 'task.succeeded',
    ]);
  } finally { control.close(); }
});

test('TRAE identity failure happens before the possibly-sent checkpoint', async () => {
  const client = new TraeClient();
  client.status = async () => ({ traeRunning: false, surface: { kind: 'unknown', url: 'doubaowork://chat' } });
  const adapter = new TraeAdapter({ client, pollIntervalMs: 0 });
  await assert.rejects(adapter.prepare(baseRequest({ target: 'trae' })), { code: 'trae_identity_unconfirmed', submission: 'not_sent' });
  assert.equal(client.sends, 0);
});

test('TRAE quota errors are normalized after the possibly-sent checkpoint', async () => {
  const client = new TraeClient();
  client.submit = async () => { throw Object.assign(new Error('insufficient credits'), { code: 'balance_insufficient' }); };
  const adapter = new TraeAdapter({ client, pollIntervalMs: 0 });
  const checkpoints = [];
  await assert.rejects(adapter.dispatch(await adapter.prepare(baseRequest({ target: 'trae' })), {
    checkpoint: kind => checkpoints.push(kind),
  }), { code: 'quota_exhausted', submission: 'may_have_been_sent' });
  assert.deepEqual(checkpoints, ['possibly_sent']);
});

test('desktop sends happen only after the durable possibly-sent checkpoint', async () => {
  const order = [];
  const bridge = new DoubaoBridge();
  const original = bridge.prepareAndSubmit.bind(bridge);
  bridge.prepareAndSubmit = (prompt, publish) => original(prompt, async patch => { await publish(patch); order.push('checkpoint'); });
  const adapter = new DoubaoAdapter({ bridge, pollIntervalMs: 0 });
  await adapter.dispatch(await adapter.prepare(baseRequest()), {
    checkpoint: async kind => { if (kind === 'possibly_sent') assert.equal(bridge.sends, 0); order.push(kind); },
  });
  assert.deepEqual(order, ['possibly_sent', 'checkpoint', 'accepted']);

  const client = new TraeClient();
  const trae = new TraeAdapter({ client, pollIntervalMs: 0 });
  await trae.dispatch(await trae.prepare(baseRequest({ target: 'trae' })), {
    checkpoint: async kind => { if (kind === 'possibly_sent') assert.equal(client.sends, 0); },
  });
  assert.equal(client.sends, 1);
});
