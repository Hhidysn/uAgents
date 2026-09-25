import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ClaudeCodeAdapter } from '../plugins/uagents/src/adapters/claude-code/adapter.mjs';
import { adapterFor } from '../plugins/uagents/src/adapters/index.mjs';
import { createClaudeCodeDriver, createClaudeCodeParser } from '../plugins/uagents/src/transports/claude-code-driver.mjs';
import { invokeCli } from '../plugins/uagents/src/transports/cli-process.mjs';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { runTask } from '../plugins/uagents/src/runtime/worker.mjs';
import { evaluateRequest } from '../plugins/uagents/src/policy/evaluate.mjs';

const root = path.resolve('.local', 'test-runs', randomUUID(), 'claude-code');
fs.mkdirSync(root, { recursive: true });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const model = 'claude-sonnet-4-6';
const request = patch => ({ schema_version: '1.0', request_id: randomUUID(), target: 'claudeCode',
  model, mode: 'analysis', prompt: 'Reply with the fixture answer.', workspace,
  execution: { observation_timeout_ms: 5000, effort: 'medium', permission: 'native' },
  policy: { fallback: 'none', max_cost_usd: null }, ...patch });

function fakeSpawn({ reportedModel = model, denied = false, hang = false } = {}) {
  let sent = '';
  return { get sent() { return sent; }, spawn(_command, _args, options) {
    assert.equal(options.cwd, workspace);
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', null)); } });
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', chunk => { sent += chunk; });
    child.stdin.on('finish', () => {
      if (hang) return;
      const session = randomUUID();
      for (const event of [
        { type: 'system', subtype: 'init', session_id: session, cwd: workspace, model: reportedModel },
        { type: 'result', subtype: 'success', session_id: session, is_error: false,
          result: 'fixture 中文', usage: { input_tokens: 4, output_tokens: 2 },
          permission_denials: denied ? [{ tool_name: 'Write' }] : [] },
      ]) child.stdout.write(JSON.stringify(event) + '\n');
      child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', 0));
    });
    setImmediate(() => child.emit('spawn'));
    return child;
  } };
}

test('Claude Code route is explicit and native continuation/fork and attachments stay closed', () => {
  assert.ok(adapterFor('claudeCode') instanceof ClaudeCodeAdapter);
  const evaluated = evaluateRequest(request());
  assert.equal(evaluated.request.model_resolved, model);
  assert.equal(evaluated.request.route_id, `claudeCode/${model}`);
  assert.equal(evaluated.request.provider, 'claudeCode'); // The upstream behind native settings is not independently known.
  for (const id of ['deepseek-v4-pro[1m]', 'deepseek-v4-pro', 'deepseek-v4-flash']) {
    const route = `claudeCode/${id}`;
    const selected = evaluateRequest(request({ model: route })).request;
    assert.equal(selected.model_resolved, id);
    assert.equal(selected.route_id, route);
    assert.equal(selected.provider, 'deepseek');
  }
  for (const patch of [
    { model: 'default' }, { model: 'sonnet' },
    { inputs: [{ type: 'file', path: 'a.txt' }] },
    { session: { continue_from_task_id: randomUUID() } },
    { session: { fork_from_task_id: randomUUID() } },
  ]) assert.throws(() => evaluateRequest(request(patch)), { submission: 'not_sent' });
});

test('Claude Code driver passes raw prompt on stdin and leaves native permissions inherited', () => {
  const driver = createClaudeCodeDriver({ kind: 'run', model, prompt: 'exact prompt' }, workspace, 'claude.exe');
  assert.deepEqual(driver.args, ['--print', '--output-format', 'stream-json', '--verbose', '--model', model]);
  assert.equal(driver.stdinPayload, 'exact prompt');
  assert.equal(driver.initialObservation.native_edit_mode, 'inherited');
  assert.equal(driver.args.some(arg => arg.includes('permission') || arg.includes('allowedTools')), false);
  const gateway = createClaudeCodeDriver({ kind: 'run', model: 'deepseek-v4-pro[1m]', prompt: 'gateway' }, workspace, 'claude.exe');
  assert.deepEqual(gateway.args.slice(-2), ['--model', 'deepseek-v4-pro[1m]']);
});

test('Claude Code parser checks session, workspace, model and native terminal evidence', () => {
  const input = { model };
  const parser = createClaudeCodeParser(input, workspace);
  const session = randomUUID();
  parser.event({ type: 'system', subtype: 'init', session_id: session, cwd: workspace, model });
  parser.event({ type: 'result', subtype: 'success', session_id: session, is_error: false, result: 'done' });
  assert.equal(parser.finish(0).status, 'succeeded');
  assert.throws(() => parser.event({ type: 'system', session_id: randomUUID() }), { code: 'native_session_mismatch' });
  const mismatch = createClaudeCodeParser(input, workspace);
  mismatch.event({ type: 'system', subtype: 'init', session_id: session, cwd: workspace, model: 'other-model' });
  mismatch.event({ type: 'result', subtype: 'success', session_id: session, is_error: false, result: 'done' });
  assert.equal(mismatch.finish(0).error, 'model_identity_mismatch');
  const denied = createClaudeCodeParser(input, workspace);
  denied.event({ type: 'system', subtype: 'init', session_id: session, cwd: workspace, model });
  denied.event({ type: 'result', subtype: 'success', session_id: session, is_error: false, result: 'partial', permission_denials: [{}] });
  assert.equal(denied.finish(0).status, 'needs_user');
  assert.throws(() => createClaudeCodeParser(input, workspace).event({ type: 'result', session_id: session, subtype: 'success', is_error: false }), { code: 'invalid_result' });
});

test('Claude Code task reaches persisted status and result with model evidence', async () => {
  const control = new ControlDatabase(path.join(root, 'state'));
  try {
    const input = request({ mode: 'implementation' });
    const fixture = fakeSpawn();
    const driver = { ...createClaudeCodeDriver({ kind: 'run', model, prompt: input.prompt }, workspace, 'claude.exe'), spawn: fixture.spawn };
    const adapter = new ClaudeCodeAdapter({ testDriver: driver });
    const service = new TaskService(control);
    const submitted = service.submit(input, { adapterVersion: 'claude-fixture-1' });
    assert.equal(service.submit(input, { adapterVersion: 'claude-fixture-1' }).duplicate, true);
    const status = await runTask({ service, taskId: submitted.task_id, adapter });
    assert.equal(status.status, 'succeeded');
    assert.equal(status.attempt.submission, 'sent');
    assert.equal(status.model_reported, model);
    assert.equal(status.model_verified, true);
    assert.equal(fixture.sent, input.prompt);
    const result = service.result(submitted.task_id);
    assert.equal(result.response.text, 'fixture 中文');
    assert.deepEqual(result.usage, { input_tokens: 4, output_tokens: 2 });
  } finally { control.close(); }
});

test('Claude Code transport retains uncertain status after a sent timeout', async () => {
  const fixture = fakeSpawn({ hang: true });
  const legacy = { kind: 'run', target: 'claudeCode', model, mode: 'analysis', prompt: 'timeout', timeout_ms: 30 };
  const driver = { ...createClaudeCodeDriver(legacy, workspace, 'claude.exe'), spawn: fixture.spawn };
  const outcome = await invokeCli(root, workspace, legacy, () => {}, driver);
  assert.equal(outcome.status, 'unknown');
  assert.equal(outcome.error, 'deadline_remote_state_unknown');
  assert.equal(fixture.sent, 'timeout');
});

test('Claude Code cancellation after stdin send stays uncertain', async () => {
  const directory = path.join(root, 'cancel-case');
  fs.mkdirSync(directory, { recursive: true });
  const fixture = fakeSpawn({ hang: true });
  const legacy = { kind: 'run', target: 'claudeCode', model, mode: 'analysis', prompt: 'cancel', timeout_ms: 1000 };
  const driver = { ...createClaudeCodeDriver(legacy, workspace, 'claude.exe'), spawn: fixture.spawn };
  const pending = invokeCli(directory, workspace, legacy, () => {}, driver);
  await new Promise(resolve => setTimeout(resolve, 20));
  fs.writeFileSync(path.join(directory, 'cancel.json'), '{}');
  const outcome = await pending;
  assert.equal(outcome.status, 'unknown');
  assert.equal(outcome.error, 'cancel_remote_state_unknown');
  assert.equal(fixture.sent, 'cancel');
});
