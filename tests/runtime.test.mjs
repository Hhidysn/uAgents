import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { submit, cancel, result } from '../plugins/uagents/skills/agent-dispatch/scripts/task.mjs';
import { atomicJson, digest, inspectOutputs, normalizeRequest, pluginRoot, stateRoot, status, terminalStates } from '../plugins/uagents/skills/agent-dispatch/scripts/store.mjs';

const root = path.resolve('.local/test-runs', randomUUID(), '任务 state');
fs.mkdirSync(root, { recursive: true });
const worker = fileURLToPath(new URL('./fixtures/test-worker.mjs', import.meta.url));
const request = (scenario, patch = {}) => ({ request_id: randomUUID(), target: 'agy', model: `gemini-fixture-${scenario}`, mode: 'analysis', prompt: '只处理给定的测试文本。', timeout_ms: 5000, ...patch });
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function wait(id, predicate = value => terminalStates.has(value.status)) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = status(root, id);
    if (predicate(value)) return value;
    await sleep(40);
  }
  assert.fail(`Task did not reach expected state: ${id}`);
}
const received = id => path.join(root, id, 'workspace', 'received.txt');

test('atomic state replacement tolerates a short Windows reader lock', { skip: process.platform !== 'win32' }, async () => {
  const file = path.join(root, 'locked-state.json'); atomicJson(file, { version: 1 });
  const locker = spawn('powershell.exe', ['-NoProfile', '-File', fileURLToPath(new URL('./fixtures/hold-file.ps1', import.meta.url)), '-Path', file], { windowsHide: true });
  await new Promise((resolve, reject) => {
    locker.once('error', reject);
    locker.stdout.once('data', data => { if (data.toString().includes('ready')) resolve(); else reject(new Error('No lock confirmation')); });
    locker.once('exit', code => { if (code !== 0) reject(new Error('Lock helper failed')); });
  });
  atomicJson(file, { version: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 2 });
});

test('background completion, stable task ID and concurrent duplicate suppression', async () => {
  const input = request('success');
  const results = await Promise.all([submit(root, input, { worker }), submit(root, input, { worker })]);
  assert.equal(results[0].task_id, results[1].task_id);
  assert.equal(results[1].duplicate, true);
  assert.equal((await wait(input.request_id)).status, 'succeeded');
  assert.equal(fs.readFileSync(received(input.request_id), 'utf8'), 'submitted\n');
  assert.equal(result(root, input.request_id).result.native_session_id, 'fixture-session');
  assert.equal(fs.existsSync(path.join(root, input.request_id, 'inbox.json')), false);
  assert.equal(JSON.stringify(status(root, input.request_id)).includes(input.prompt), false);
  await assert.rejects(submit(root, { ...input, prompt: 'changed' }, { worker }), { code: 'request_conflict' });
  await assert.rejects(submit(root, { ...input, timeout_ms: 6000 }, { worker }), { code: 'request_conflict' });
});

test('invalid paths and unsupported permission requests fail before launch', () => {
  assert.throws(() => normalizeRequest(request('success', { request_id: '../outside' })), { code: 'invalid_request_id' });
  assert.throws(() => normalizeRequest(request('success', { owned_paths: ['src'] })), { code: 'unsupported_field' });
  assert.throws(() => normalizeRequest(request('success', { mode: 'invalid' })), { code: 'unsupported_capability' });
  assert.throws(() => normalizeRequest(request('success', { permission_policy: 'readonly' })), { code: 'unsupported_permission_policy' });
  assert.throws(() => stateRoot(path.join(pluginRoot, 'forbidden-state'), true), { code: 'invalid_state_dir' });
  assert.equal(fs.existsSync(path.join(pluginRoot, 'forbidden-state')), false);
  if (process.platform === 'win32') {
    const alias = path.join(root, 'plugin-junction'); fs.symlinkSync(pluginRoot, alias, 'junction');
    assert.throws(() => stateRoot(path.join(alias, 'forbidden-state'), true), { code: 'invalid_state_dir' });
    assert.equal(fs.existsSync(path.join(pluginRoot, 'forbidden-state')), false);
  }
});

for (const [scenario, expected, error] of [
  ['tool-denied', 'needs_user', undefined], ['wrong-model', 'blocked', 'identity_unverified'],
  ['wrong-session', 'unknown', 'missing_or_mismatched_result'], ['error-zero', 'failed', undefined],
  ['truncated', 'unknown', 'missing_or_mismatched_result'], ['malformed', 'unknown', 'malformed_stream'],
  ['large', 'unknown', 'output_limit'], ['waiting', 'needs_user', undefined],
  ['null', 'unknown', 'invalid_event'], ['missing-fields', 'unknown', 'invalid_result'],
  ['duplicate-result', 'unknown', 'duplicate_result'], ['object-error-before', 'failed', 'native_preflight_failed'],
]) test(`native ${scenario} is classified conservatively`, async () => {
  const input = request(scenario);
  await submit(root, input, { worker });
  const done = await wait(input.request_id);
  assert.equal(done.status, expected);
  if (error) assert.equal(done.error, error);
  if (expected === 'blocked') assert.equal(fs.existsSync(received(input.request_id)), false);
});

test('probe checks native identity and reports permissions without sending a prompt', async () => {
  const input = request('success'); delete input.prompt;
  await submit(root, input, { worker, kind: 'probe' });
  const done = await wait(input.request_id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.scope, 'preflight_only');
  assert.equal(done.tool_count, 2);
  assert.equal(done.permission_policy, 'native');
  assert.equal(fs.existsSync(received(input.request_id)), false);
});

test('implementation accepts native tools and retrieves the final result without logging arguments', async () => {
  const input = request('tool', { mode: 'implementation', expected_outputs: ['artifact.txt'] });
  await submit(root, input, { worker });
  const done = await wait(input.request_id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.last_tool, 'write_to_file');
  assert.equal(done.native_permission_mode, 'request-review');
  assert.equal(done.artifact_check, 'passed');
  assert.match(result(root, input.request_id).result.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(path.join(root, input.request_id, 'workspace', 'artifact.txt'), 'utf8'), 'created with native permissions');
  assert.equal(JSON.stringify(result(root, input.request_id)).includes('do not persist tool arguments'), false);
  assert.equal(fs.existsSync(path.join(root, input.request_id, 'workspace', '.agents')), false);
});

test('native success with a missing promised artifact fails acceptance', async () => {
  const input = request('success', { mode: 'implementation', expected_outputs: ['missing.html'] });
  await submit(root, input, { worker });
  const done = await wait(input.request_id);
  assert.equal(done.native_status, 'SUCCESS');
  assert.equal(done.status, 'failed');
  assert.equal(done.error, 'expected_output_validation_failed');
  assert.equal(result(root, input.request_id).result.artifacts[0].error, 'missing');
});

test('artifact paths cannot escape through traversal, absolute paths or a junction', () => {
  for (const name of ['../outside', '/absolute', 'C:/absolute', 'x\\y', 'NUL', 'x:stream', 'folder/..', 'file.']) {
    assert.throws(() => normalizeRequest(request('success', { expected_outputs: [name] })), { code: 'invalid_outputs' });
  }
  assert.throws(() => normalizeRequest(request('success', { mode: 'implementation' })), { code: 'invalid_outputs' });
  if (process.platform === 'win32') {
    const directory = path.join(root, 'artifact-check'); fs.mkdirSync(directory);
    fs.symlinkSync(pluginRoot, path.join(directory, 'linked'), 'junction');
    assert.equal(inspectOutputs(directory, ['linked/.codex-plugin/plugin.json'])[0].error, 'outside_workspace');
  }
});

test('probe does not ignore a native error during shutdown', async () => {
  const input = request('probe-error'); delete input.prompt;
  await submit(root, input, { worker, kind: 'probe' });
  const done = await wait(input.request_id);
  assert.equal(done.status, 'failed');
  assert.equal(fs.existsSync(received(input.request_id)), false);
});

test('split UTF-8 stream preserves response text', async () => {
  const input = request('unicode');
  await submit(root, input, { worker }); await wait(input.request_id);
  assert.equal(result(root, input.request_id).result.response, '可归属的中文结果 ✓');
});

test('cancel before sending is confirmed without any model request', async () => {
  const input = request('slow-init');
  await submit(root, input, { worker });
  assert.equal(cancel(root, input.request_id).cancel_accepted, true);
  assert.equal((await wait(input.request_id)).status, 'cancelled');
  assert.equal(fs.existsSync(received(input.request_id)), false);
});

test('cancel after sending does not pretend remote cancellation succeeded', async () => {
  const input = request('hang');
  await submit(root, input, { worker });
  await wait(input.request_id, value => value.status === 'running');
  cancel(root, input.request_id);
  const done = await wait(input.request_id);
  assert.equal(done.status, 'unknown');
  assert.equal(done.error, 'cancel_remote_state_unknown');
  assert.equal((await submit(root, input, { worker })).duplicate, true);
});

test('deadline after sending returns unknown and retains session identity', async () => {
  const input = request('hang', { timeout_ms: 1000 });
  await submit(root, input, { worker });
  const done = await wait(input.request_id);
  assert.equal(done.status, 'unknown');
  assert.equal(done.error, 'deadline_remote_state_unknown');
  assert.equal(done.native_session_id, 'fixture-session');
});

test('deadline remains bounded when the native process has a descendant', async () => {
  const input = request('pipe-held', { timeout_ms: 1000 });
  const started = Date.now();
  await submit(root, input, { worker });
  const done = await wait(input.request_id);
  assert.equal(done.status, 'unknown');
  assert.ok(Date.now() - started < 5000);
});

test('stale worker records and interrupted registration are never replayed', async () => {
  const id = randomUUID(); fs.mkdirSync(path.join(root, id));
  atomicJson(path.join(root, id, 'state.json'), { task_id: id, status: 'running', updated_at_ms: Date.now() - 20000, submission: 'may_have_been_sent' });
  assert.equal(status(root, id).status, 'unknown');
  assert.equal(status(root, id).retry_safe, false);
  assert.equal(cancel(root, id).cancel_accepted, false);
  const interrupted = request('success'); fs.mkdirSync(path.join(root, interrupted.request_id));
  await assert.rejects(submit(root, interrupted, { worker }), { code: 'registration_incomplete' });
  atomicJson(path.join(root, interrupted.request_id, 'state.json'), {
    task_id: interrupted.request_id, digest: digest(normalizeRequest(interrupted)), status: 'starting', updated_at_ms: Date.now(),
  });
  await assert.rejects(submit(root, interrupted, { worker }), { code: 'registration_incomplete' });
});

test('cancellation rereads a terminal state published during marker creation', t => {
  const input = request('success'); const directory = path.join(root, input.request_id); fs.mkdirSync(directory);
  const state = { task_id: input.request_id, status: 'running', updated_at_ms: Date.now() };
  atomicJson(path.join(directory, 'state.json'), state);
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (typeof file === 'string' && file.endsWith('cancel.json')) atomicJson(path.join(directory, 'state.json'), { ...state, status: 'succeeded' });
    return write(file, ...args);
  });
  const outcome = cancel(root, input.request_id);
  assert.equal(outcome.status, 'succeeded');
  assert.equal(outcome.cancel_accepted, false);
  assert.equal(outcome.cancel_requested, false);
  assert.equal(outcome.cancel_recorded, true);
});

test('a partial inbox write failure removes only its owned temporary file', t => {
  const directory = path.join(root, randomUUID()); fs.mkdirSync(directory);
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (typeof file === 'number') {
      write(file, 'private prompt fragment');
      throw Object.assign(new Error('simulated full disk'), { code: 'ENOSPC' });
    }
    return write(file, ...args);
  });
  assert.throws(() => atomicJson(path.join(directory, 'inbox.json'), { prompt: 'private' }), { code: 'ENOSPC' });
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('packaged scripts load from a different working directory without research files', async () => {
  const copied = path.join(root, '独立 plugin'); await fs.promises.cp(pluginRoot, copied, { recursive: true });
  const execution = spawnSync(process.execPath, [path.join(copied, 'skills/agent-dispatch/scripts/agent-call.mjs'), 'capabilities'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(JSON.parse(execution.stdout).maturity, 'native-permissions-preview');
});
