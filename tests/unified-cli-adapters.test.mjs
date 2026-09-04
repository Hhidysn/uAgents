import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AgyAdapter } from '../plugins/uagents/src/adapters/agy/adapter.mjs';
import { OpenCodeAdapter } from '../plugins/uagents/src/adapters/opencode/adapter.mjs';
import { WorkBuddyAdapter } from '../plugins/uagents/src/adapters/workbuddy/adapter.mjs';
import { validateAdapter } from '../plugins/uagents/src/adapters/contract.mjs';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { runTask } from '../plugins/uagents/src/runtime/worker.mjs';

const root = path.resolve('.local', 'test-runs', randomUUID(), 'unified adapters');
fs.mkdirSync(root, { recursive: true });
const fakeCli = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
const fakeAgy = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));
const baseRequest = patch => ({
  schema_version: '1.0', request_id: randomUUID(), target: 'opencode', model: 'commandcode-goat/deepseek/deepseek-v4-flash',
  mode: 'analysis', prompt: 'bounded', execution: { observation_timeout_ms: 5000, effort: 'medium', permission: 'native' },
  policy: { fallback: 'none', max_cost_usd: null }, ...patch,
});

for (const target of ['agy', 'workbuddy', 'opencode']) test(`${target} adapter completes through shared runtime`, async () => {
  const control = new ControlDatabase(path.join(root, `${target}-${randomUUID()}`));
  try {
    const service = new TaskService(control);
    const input = target === 'agy'
      ? baseRequest({ target, model: 'gemini-fixture-success' })
      : target === 'workbuddy'
        ? baseRequest({ target, model: 'default', mode: 'implementation', expected_outputs: [{ path: 'artifact.txt', type: 'file', required: true, max_bytes: 1024 }] })
        : baseRequest({ target });
    const driver = target === 'agy'
      ? { command: process.execPath, args: [fakeAgy, 'success'] }
      : { command: process.execPath, args: [fakeCli, target, input.request_id, 'success'] };
    const adapter = target === 'agy' ? new AgyAdapter({ testDriver: driver })
      : target === 'workbuddy' ? new WorkBuddyAdapter({ testDriver: driver }) : new OpenCodeAdapter({ testDriver: driver });
    validateAdapter(adapter);
    const registered = service.submit(input, { adapterVersion: 'unified-fixture-1' });
    const result = await runTask({ service, taskId: registered.task_id, adapter });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.attempt.submission, 'sent');
    assert.equal(service.result(result.task_id).response.text.includes('中文'), true);
    if (target === 'agy') {
      assert.equal(result.model_reported, 'gemini-fixture-success');
      assert.equal(result.model_verified, true);
    } else if (target === 'opencode') {
      assert.equal(result.model_reported, null);
      assert.equal(result.model_verified, false);
    } else {
      assert.equal(service.result(result.task_id).artifacts[0].verified, true);
    }
  } finally { control.close(); }
});

test('OpenCode implementation is rejected before adapter execution', () => {
  const control = new ControlDatabase(path.join(root, `rejected-${randomUUID()}`));
  try {
    const service = new TaskService(control);
    assert.throws(() => service.submit(baseRequest({ mode: 'implementation' })), { code: 'unsupported_capability' });
    assert.equal(control.raw.prepare('SELECT count(*) AS count FROM tasks').get().count, 0);
  } finally { control.close(); }
});

test('persisted cancel intent interrupts a live CLI process without claiming remote cancellation', async () => {
  const control = new ControlDatabase(path.join(root, `cancel-live-${randomUUID()}`));
  try {
    const service = new TaskService(control);
    const input = baseRequest({ target: 'workbuddy', model: 'default', mode: 'analysis', execution: { observation_timeout_ms: 10_000, effort: 'medium', permission: 'native' } });
    const driver = { command: process.execPath, args: [fakeCli, 'workbuddy', input.request_id, 'hang'] };
    const adapter = new WorkBuddyAdapter({ testDriver: driver });
    const registered = service.submit(input, { adapterVersion: 'unified-fixture-1' });
    const running = runTask({ service, taskId: registered.task_id, adapter });
    const marker = path.join(service.payload(registered.task_id).request.workspace, 'received.txt');
    for (let attempt = 0; attempt < 100 && !fs.existsSync(marker); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fs.existsSync(marker), true);
    service.requestCancel(registered.task_id);
    const result = await running;
    assert.equal(result.status, 'indeterminate');
    assert.equal(result.cancel_requested, true);
    assert.equal(result.attempt.submission, 'sent');
  } finally { control.close(); }
});
