import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TraeTaskService } from '../src/service.mjs';
import { TaskStore } from '../src/store.mjs';

const base = path.resolve('../../../../.local/test-runs');
function fixture() {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'trae-'));
  return { root, store: new TaskStore(root), dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function validStatus() {
  return {
    version: '0.6.0', status: 'connected', cdpReachable: true, traeRunning: true,
    surface: { kind: 'workspace', url: 'file:///resources/app/out/vs/code/electron-sandbox/workbench/workbench.html', title: 'project' },
    traeAdapter: { adapter: 'traecn-unknown' },
    durability: { durabilityDegraded: false },
  };
}
class Client {
  constructor() { this.submits = 0; this.native = []; this.probe = validStatus(); }
  async status() { return this.probe; }
  async submit(body, id) { this.submits++; this.body = body; this.id = id; return { taskId: 'task-native-1', status: 'accepted' }; }
  async task() { return this.native.shift() ?? { taskId: 'task-native-1', status: 'executing' }; }
}

test('probe confirms a TRAE workbench but rejects another Electron app', async () => {
  const f = fixture();
  try {
    const client = new Client();
    const service = new TraeTaskService({ store: f.store, client });
    const confirmed = await service.probe();
    assert.equal(confirmed.identity_confirmed, true);
    assert.equal(confirmed.adapter_id, 'traecn-unknown');
    client.probe = { ...validStatus(), traeRunning: false, surface: { kind: 'unknown', url: 'doubaowork://doubaowork-chat/chat' } };
    const rejected = await service.probe();
    assert.equal(rejected.status, 'unavailable');
    assert.equal(rejected.submission, 'not_sent');
  } finally { f.dispose(); }
});

test('submit refuses an unconfirmed app identity before sending', async () => {
  const f = fixture();
  try {
    const client = new Client(); client.probe = { ...validStatus(), traeRunning: false };
    const service = new TraeTaskService({ store: f.store, client });
    const result = await service.submit({ request_id: randomUUID(), prompt: 'bounded task' });
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'trae_identity_unconfirmed');
    assert.equal(client.submits, 0);
  } finally { f.dispose(); }
});

test('submit stores native identity and duplicate UUID never sends twice', async () => {
  const f = fixture();
  try {
    const client = new Client(); const service = new TraeTaskService({ store: f.store, client });
    const input = { request_id: randomUUID(), prompt: 'do one task', timeout_ms: 20000 };
    const first = await service.submit(input);
    assert.equal(first.native_task_id, 'task-native-1');
    assert.equal(first.status, 'running');
    assert.equal(client.body.autoContinue, false);
    assert.equal(client.body.autoApproveDialog, false);
    const duplicate = await service.submit(input);
    assert.equal(duplicate.duplicate, true);
    assert.equal(client.submits, 1);
    assert.equal(fs.readFileSync(f.store.stateFile(input.request_id), 'utf8').includes('do one task'), false);
  } finally { f.dispose(); }
});

test('same UUID with changed input is rejected', async () => {
  const f = fixture();
  try {
    const service = new TraeTaskService({ store: f.store, client: new Client() }); const id = randomUUID();
    await service.submit({ request_id: id, prompt: 'one' });
    await assert.rejects(() => service.submit({ request_id: id, prompt: 'two' }), error => error.code === 'request_conflict');
  } finally { f.dispose(); }
});

test('status maps running, approval and stable completion without replay', async () => {
  const f = fixture();
  try {
    const client = new Client(); const service = new TraeTaskService({ store: f.store, client }); const id = randomUUID();
    await service.submit({ request_id: id, prompt: 'answer' });
    client.native.push(
      { status: 'executing' },
      { status: 'approval_required', result: { question: 'Allow?', buttons: ['允许', '拒绝'], command: 'npm test' } },
      { status: 'done', result: { text: 'finished', stable: true, elapsedMs: 1234 } },
    );
    assert.equal((await service.status(id)).status, 'running');
    const approval = await service.status(id);
    assert.equal(approval.status, 'needs_user');
    assert.equal(approval.interaction.command, 'npm test');
    const done = await service.result(id);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.result.response, 'finished');
    assert.equal(client.submits, 1);
  } finally { f.dispose(); }
});

test('cancelled and unstable native outcomes remain unknown', async () => {
  const f = fixture();
  try {
    const client = new Client(); const service = new TraeTaskService({ store: f.store, client });
    const cancelledId = randomUUID(); await service.submit({ request_id: cancelledId, prompt: 'cancelled elsewhere' });
    client.native.push({ status: 'cancelled' });
    assert.equal((await service.status(cancelledId)).error, 'native_cancel_not_confirmed');
    const unstableId = randomUUID(); await service.submit({ request_id: unstableId, prompt: 'unstable' });
    client.native.push({ status: 'done', result: { text: 'partial', stable: false } });
    assert.equal((await service.status(unstableId)).status, 'unknown');
  } finally { f.dispose(); }
});
