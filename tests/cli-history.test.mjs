import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execute } from '../plugins/uagents/src/cli/main.mjs';
import { UnifiedRuntime } from '../plugins/uagents/src/runtime/api.mjs';
import { runRegisteredTask } from '../plugins/uagents/src/runtime/worker-factory.mjs';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';

const root = path.resolve('.local', 'test-runs', randomUUID(), 'cli history');
// Registration is observed on disk; the detached worker is never launched.
const noWorker = () => ({ unref() {} });

// The test picks the native session ID, the answer text and the outcome, so
// session grouping can be asserted exactly instead of inferred.
class HistoryAdapter {
  constructor({ sessionId, response = null, target = 'opencode' }) {
    this.sessionId = sessionId;
    this.response = response;
    this.target = target;
  }

  descriptor() {
    return { target: this.target, modes: ['analysis', 'implementation'], permissions: { native: true }, model_identity: { reported: true, verification: 'runtime_self_report' } };
  }

  async prepare(request) { return { request }; }
  async dispatch(prepared, context) {
    const handle = { session_id: this.sessionId, task_id: null, status: 'accepted' };
    await context.checkpoint('possibly_sent');
    await context.checkpoint('accepted', { handle, evidence_ref: 'history:accepted' });
    return { handle, prepared };
  }
  async *observe() {
    yield { same_native_identity: true, type: 'succeeded', evidence_strength: 2, ...(this.response ? { response: this.response } : {}) };
  }
  async cancel() { return { confirmed: false }; }
  async reconcile() { return { same_native_identity: true, evidence_strength: 3, type: 'succeeded' }; }
}

async function register(stateRoot, { target = 'opencode', prompt = 'history', session = null } = {}) {
  const runtime = new UnifiedRuntime({ stateRoot, spawnWorker: noWorker });
  try {
    return runtime.submit({ schema_version: '1.0', request_id: randomUUID(), target, model: 'commandcode-goat/deepseek/deepseek-v4-flash',
      mode: 'analysis', workspace: path.join(root, 'workspace'), prompt, ...(session ? { session } : {}) });
  } finally { runtime.close(); }
}

function run(stateRoot, taskId, adapter) {
  return runRegisteredTask(stateRoot, taskId, { adapterFactory: () => adapter, supervisorFactory: async () => null });
}

// One target, two native sessions, three answered tasks and one never-dispatched task.
async function buildState() {
  const stateRoot = path.join(root, randomUUID(), 'state');
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  const first = await register(stateRoot, { prompt: 'first' });
  await run(stateRoot, first.task_id, new HistoryAdapter({ sessionId: 'native-thread-1', response: 'answer one' }));
  const continued = await register(stateRoot, { prompt: 'second', session: { continue_from_task_id: first.task_id } });
  await run(stateRoot, continued.task_id, new HistoryAdapter({ sessionId: 'native-thread-1', response: 'answer two' }));
  const forked = await register(stateRoot, { prompt: 'branch', session: { fork_from_task_id: continued.task_id } });
  await run(stateRoot, forked.task_id, new HistoryAdapter({ sessionId: 'native-thread-2', response: 'answer three' }));
  const pending = await register(stateRoot, { prompt: 'never dispatched' });
  return { stateRoot, first, continued, forked, pending };
}

test('list filters by target and by a persisted response without skipping rows', async () => {
  const { stateRoot, first, continued, forked, pending } = await buildState();

  const all = await execute(['list', '--limit', '50', '--state-dir', stateRoot], { env: {} });
  assert.deepEqual(new Set(all.data.tasks.map(task => task.task_id)), new Set([first.task_id, continued.task_id, forked.task_id, pending.task_id]));

  const answered = await execute(['list', '--has-response', '--limit', '50', '--state-dir', stateRoot], { env: {} });
  assert.deepEqual(new Set(answered.data.tasks.map(task => task.task_id)), new Set([first.task_id, continued.task_id, forked.task_id]));

  const filtered = await execute(['list', '--target', 'opencode', '--limit', '50', '--state-dir', stateRoot], { env: {} });
  assert.equal(filtered.data.tasks.length, 4);
  const empty = await execute(['list', '--target', 'codex', '--limit', '50', '--state-dir', stateRoot], { env: {} });
  assert.deepEqual(empty.data.tasks, []);

  // A filtered page may return fewer rows than the limit; the cursor still
  // follows the last scanned row, so paging never skips or duplicates a task.
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const result = await execute(['list', '--has-response', '--limit', '2', '--state-dir', stateRoot, ...(cursor ? ['--cursor', cursor] : [])], { env: {} });
    seen.push(...result.data.tasks.map(task => task.task_id));
    cursor = result.data.next_cursor;
    if (!cursor) break;
  }
  assert.deepEqual(new Set(seen), new Set([first.task_id, continued.task_id, forked.task_id]));
  assert.equal(seen.length, 3);
});

test('sessions groups tasks by native session and describes the branch', async () => {
  const { stateRoot, first, continued, forked, pending } = await buildState();
  const result = await execute(['sessions', '--limit', '50', '--state-dir', stateRoot], { env: {} });
  assert.equal(result.ok, true);
  assert.equal(result.data.sessions.length, 2);
  assert.equal(result.data.next_cursor, null);

  const thread1 = result.data.sessions.find(session => session.native_session_id === 'native-thread-1');
  assert.equal(thread1.target, 'opencode');
  assert.equal(thread1.task_count, 2);
  assert.equal(thread1.latest_status, 'succeeded');
  assert.equal(thread1.latest_task_id, continued.task_id);
  assert.equal(thread1.first_task_id, first.task_id);
  assert.equal(thread1.lineage, null);
  assert.equal(thread1.tasks_truncated, false);
  assert.deepEqual(new Set(thread1.tasks.map(task => task.task_id)), new Set([first.task_id, continued.task_id]));
  assert.deepEqual(thread1.tasks.map(task => task.status), ['succeeded', 'succeeded']);
  assert.ok(thread1.started_at_ms <= thread1.updated_at_ms);
  // Oldest to newest, so a continued conversation reads in order.
  assert.ok(thread1.tasks[0].created_at_ms <= thread1.tasks[1].created_at_ms);

  const thread2 = result.data.sessions.find(session => session.native_session_id === 'native-thread-2');
  assert.equal(thread2.task_count, 1);
  assert.deepEqual(thread2.lineage, { action: 'fork', from_task_id: continued.task_id });

  // A registered task with no native session is not part of any conversation.
  assert.equal(result.data.sessions.some(session => session.tasks.some(task => task.task_id === pending.task_id)), false);
});

test('sessions filters by target and pages by session', async () => {
  const { stateRoot, first, continued, forked } = await buildState();
  const filtered = await execute(['sessions', '--target', 'codex', '--state-dir', stateRoot], { env: {} });
  assert.deepEqual(filtered.data.sessions, []);

  const page1 = await execute(['sessions', '--limit', '1', '--state-dir', stateRoot], { env: {} });
  assert.equal(page1.data.sessions.length, 1);
  assert.ok(page1.data.next_cursor);
  const page2 = await execute(['sessions', '--limit', '1', '--cursor', page1.data.next_cursor, '--state-dir', stateRoot], { env: {} });
  assert.equal(page2.data.sessions.length, 1);
  assert.equal(page2.data.next_cursor, null);
  assert.notEqual(page1.data.sessions[0].native_session_id, page2.data.sessions[0].native_session_id);
  assert.deepEqual(new Set([...page1.data.sessions, ...page2.data.sessions].flatMap(session => session.tasks.map(task => task.task_id))),
    new Set([first.task_id, continued.task_id, forked.task_id]));
});

test('sessions and the list filters reject an unknown target and a bad cursor', async () => {
  const { stateRoot } = await buildState();
  await assert.rejects(() => execute(['sessions', '--target', 'nope', '--state-dir', stateRoot], { env: {} }), { code: 'invalid_target' });
  await assert.rejects(() => execute(['list', '--target', 'nope', '--state-dir', stateRoot], { env: {} }), { code: 'invalid_target' });
  await assert.rejects(() => execute(['sessions', '--cursor', 'not-a-cursor', '--state-dir', stateRoot], { env: {} }), { code: 'invalid_request' });
  await assert.rejects(() => execute(['list', '--has-response', '--cursor', 'not-a-cursor', '--state-dir', stateRoot], { env: {} }), { code: 'invalid_request' });
});

test('sessions report the latest member activity and order by it', async () => {
  const { stateRoot, continued } = await buildState();
  // Simulate a later resume/observe on a finished task: the session's updated
  // time must follow the member instead of staying at the newest creation time.
  const control = new ControlDatabase(stateRoot);
  control.raw.prepare('UPDATE tasks SET updated_at_ms = ? WHERE task_id = ?').run(9_000_000_000_000, continued.task_id);
  control.close();

  const result = await execute(['sessions', '--state-dir', stateRoot], { env: {} });
  const thread = result.data.sessions.find(session => session.native_session_id === 'native-thread-1');
  assert.equal(thread.updated_at_ms, 9_000_000_000_000);
  assert.equal(thread.tasks.at(-1).updated_at_ms, 9_000_000_000_000);
  assert.equal(thread.started_at_ms, thread.tasks[0].created_at_ms);
  assert.equal(result.data.sessions[0].native_session_id, 'native-thread-1');
});

test('sessions page every group when session IDs collide across targets', async () => {
  const stateRoot = path.join(root, randomUUID(), 'state');
  const opencodeTask = await register(stateRoot, { target: 'opencode', prompt: 'collision' });
  await run(stateRoot, opencodeTask.task_id, new HistoryAdapter({ target: 'opencode', sessionId: 'shared-id' }));
  const agyTask = await register(stateRoot, { target: 'agy', prompt: 'collision' });
  await run(stateRoot, agyTask.task_id, new HistoryAdapter({ target: 'agy', sessionId: 'shared-id' }));

  // Pin both tasks to one instant so the page boundary has to compare target.
  const control = new ControlDatabase(stateRoot);
  control.raw.prepare('UPDATE tasks SET created_at_ms = ?, updated_at_ms = ?').run(1_000, 1_000);
  control.close();

  const seen = [];
  let cursor = null;
  for (let page = 0; page < 5; page++) {
    const result = await execute(['sessions', '--limit', '1', '--state-dir', stateRoot, ...(cursor ? ['--cursor', cursor] : [])], { env: {} });
    seen.push(...result.data.sessions.map(session => `${session.target}/${session.native_session_id}`));
    cursor = result.data.next_cursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen.sort(), ['agy/shared-id', 'opencode/shared-id']);
});

test('history commands self-describe as read-only local queries', async () => {
  const described = await execute(['describe', 'sessions'], { env: {} });
  assert.deepEqual(described.data.options.map(option => option.name), ['--target', '--cursor', '--limit', '--state-dir']);
  assert.equal(described.data.effect, 'local_only');
  const list = await execute(['describe', 'list'], { env: {} });
  assert.deepEqual(list.data.options.map(option => option.name), ['--target', '--has-response', '--cursor', '--limit', '--state-dir']);
});
