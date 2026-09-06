import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { runTask } from '../plugins/uagents/src/runtime/worker.mjs';

const root = path.resolve('.local', 'test-runs', randomUUID(), 'advisory permission');
fs.mkdirSync(root, { recursive: true });

const targets = [
  ['agy', 'gemini-fixture-advisory'],
  ['workbuddy', 'default'],
  ['opencode', 'commandcode-goat/deepseek/deepseek-v4-flash'],
  ['doubao', 'default'],
  ['trae', 'default'],
];

test('worker adds advisory guidance at dispatch for every target without mutating stored request identity', async () => {
  for (const [target, model] of targets) {
    const control = new ControlDatabase(path.join(root, `${target}-${randomUUID()}`));
    try {
      const service = new TaskService(control);
      const input = request(target, model, 'advisory-read-only');
      const adapter = new CaptureAdapter(target);
      const registered = service.submit(input, { adapterVersion: 'capture-1' });
      const beforePayload = service.payload(registered.task_id);
      const beforeHashes = taskHashes(control, registered.task_id);

      assert.equal(beforePayload.payload.prompt, input.prompt);
      assert.equal(beforePayload.request.prompt, null);
      const result = await runTask({ service, taskId: registered.task_id, adapter });

      assert.equal(result.status, 'succeeded');
      assert.equal(adapter.prepared.length, 1);
      assert.equal(adapter.dispatched.length, 1);
      assert.equal(adapter.prepared[0].prompt, adapter.dispatched[0].prompt);
      assert.equal(adapter.dispatched[0].prompt.startsWith(input.prompt), true);
      assert.match(adapter.dispatched[0].prompt, /Permission policy: advisory-read-only/);
      assert.match(adapter.dispatched[0].prompt, /Do not edit, create, delete, rename, or overwrite files\./);

      const afterPayload = service.payload(registered.task_id);
      assert.equal(afterPayload.payload.prompt, input.prompt);
      assert.equal(afterPayload.request.prompt, null);
      assert.deepEqual(taskHashes(control, registered.task_id), beforeHashes);

      const duplicate = service.submit(input, { adapterVersion: 'capture-1' });
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.task_id, registered.task_id);
      assert.deepEqual(taskHashes(control, registered.task_id), beforeHashes);
    } finally {
      control.close();
    }
  }
});

test('worker forwards native prompts byte-for-byte for every target', async () => {
  for (const [target, model] of targets) {
    const control = new ControlDatabase(path.join(root, `native-${target}-${randomUUID()}`));
    try {
      const service = new TaskService(control);
      const input = request(target, model, 'native');
      const adapter = new CaptureAdapter(target);
      const registered = service.submit(input, { adapterVersion: 'capture-1' });
      const result = await runTask({ service, taskId: registered.task_id, adapter });

      assert.equal(result.status, 'succeeded');
      assert.equal(adapter.prepared[0].prompt, input.prompt);
      assert.equal(adapter.dispatched[0].prompt, input.prompt);
      assert.equal(service.payload(registered.task_id).payload.prompt, input.prompt);
    } finally {
      control.close();
    }
  }
});

function request(target, model, permission) {
  const workspace = path.join(root, 'workspaces', target, randomUUID());
  fs.mkdirSync(workspace, { recursive: true });
  return {
    schema_version: '1.0',
    request_id: randomUUID(),
    target,
    model,
    mode: 'analysis',
    prompt: 'Keep this prompt exact.\n中文\tmarker.',
    workspace,
    execution: { observation_timeout_ms: 5_000, effort: 'medium', permission },
    policy: { fallback: 'none', max_cost_usd: null },
  };
}

function taskHashes(control, taskId) {
  return control.raw.prepare('SELECT raw_hash, effective_hash FROM tasks WHERE task_id = ?').get(taskId);
}

class CaptureAdapter {
  constructor(target) {
    this.target = target;
    this.prepared = [];
    this.dispatched = [];
  }

  descriptor() {
    return {
      target: this.target,
      modes: ['analysis'],
      permissions: { native: true, advisory_read_only: true },
      model_identity: { reported: false, verification: 'unsupported' },
    };
  }

  async prepare(request) {
    this.prepared.push(structuredClone(request));
    return { request };
  }

  async dispatch(prepared, context) {
    this.dispatched.push(structuredClone(prepared.request));
    await context.checkpoint('possibly_sent');
    const handle = { session_id: `capture-${this.target}-${prepared.request.request_id}`, task_id: null, status: 'accepted' };
    await context.checkpoint('accepted', { handle, evidence_ref: `${this.target}:capture` });
    return { handle };
  }

  async *observe() {
    yield { type: 'succeeded', same_native_identity: true, evidence_strength: 2, response: 'captured' };
  }
}
