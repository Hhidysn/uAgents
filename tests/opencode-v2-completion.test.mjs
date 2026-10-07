import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createOpenCodeParser, buildOpenCodeArgs } from '../plugins/uagents/src/transports/opencode-driver.mjs';
import { readOpenCodeSession } from '../plugins/uagents/src/transports/opencode-session.mjs';
import { invokeCli } from '../plugins/uagents/src/transports/cli-process.mjs';
import { OpenCodeAdapter } from '../plugins/uagents/src/adapters/opencode/adapter.mjs';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { runTask } from '../plugins/uagents/src/runtime/worker.mjs';
import { reconcileTask } from '../plugins/uagents/src/runtime/reconcile.mjs';

const workspace = path.resolve('.local/test-runs', randomUUID(), 'OpenCode V2');
fs.mkdirSync(workspace, { recursive: true });
const request = { target: 'opencode', request_id: randomUUID(), kind: 'run', model: 'opencode-go/glm-5.3-flash',
  mode: 'analysis', prompt: 'fixture', expected_outputs: [], timeout_ms: 5_000 };
const snapshot = () => ({ info: { id: 'ses_fixture', outcome: 'succeeded', location: { directory: workspace }, tokens: { input: 10 } },
  messages: [{ id: 'answer', type: 'assistant', model: { providerID: 'opencode-go', id: 'glm-5.3-flash' },
    time: { completed: 100 }, content: [{ type: 'text', text: '中文结果 ✓' }] },
  { id: 'idle', type: 'idle', time: { created: 101 } }] });
const event = (type, extra = {}) => ({ type, sessionID: 'ses_fixture', part: { id: type, sessionID: 'ses_fixture', messageID: 'answer', ...extra } });
function parser(reader, nativeRequest = request) {
  const result = createOpenCodeParser(nativeRequest, workspace, () => {}, { sessionReader: reader });
  result.event(event('step_start')); result.event(event('text', { text: '中文结果 ✓' }));
  return result;
}

test('V2 verifies an existing completed session instead of treating text plus zero exit as proof', async () => {
  const queried = [];
  const result = await parser(async session => { queried.push(session); return snapshot(); }).finish(0);
  assert.deepEqual(queried, ['ses_fixture']);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.response, '中文结果 ✓');
  assert.equal(result.model_reported, 'glm-5.3-flash');
  assert.equal(result.result.usage.input, 10);
});

test('V2 verifies and reports the exact requested model variant', async () => {
  const selected = { ...request, model: `${request.model}#high` };
  const evidence = snapshot(); evidence.messages[0].model.variant = 'high';
  const result = await parser(async () => evidence, selected).finish(0);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.model_reported, 'glm-5.3-flash#high');
  for (const variant of [undefined, 'low']) {
    const mismatched = snapshot(); mismatched.messages[0].model.variant = variant;
    assert.equal((await parser(async () => mismatched, selected).finish(0)).status, 'unknown');
  }
});

test('V2 rejects foreign, stale, incomplete and mismatched terminal evidence without losing partial text', async () => {
  const changes = [
    s => { s.info.id = 'ses_other'; }, s => { s.info.outcome = 'running'; },
    s => { s.info.location.directory = path.join(workspace, 'other'); },
    s => { s.messages[0].id = 'old-answer'; }, s => { delete s.messages[0].time.completed; },
    s => { s.messages[0].model.providerID = 'other'; }, s => { s.messages[0].model.id = 'other'; },
    s => { s.messages[0].content[0].text = 'different'; }, s => { s.messages[0].error = { type: 'provider.quota' }; },
    s => { s.messages[1].time.created = 99; }, s => { s.messages.push({ type: 'user' }); },
    s => { s.messages[0].content.push({ type: 'tool', state: { status: 'running' } }); },
  ];
  for (const change of changes) {
    const s = snapshot(); change(s);
    const result = await parser(async () => s).finish(0);
    assert.equal(result.status, 'unknown'); assert.equal(result.result.response, '中文结果 ✓');
  }
  const failedRead = await parser(async () => { throw new Error('secret token'); }).finish(0);
  assert.equal(failedRead.status, 'unknown'); assert.doesNotMatch(JSON.stringify(failedRead), /secret token/);
  let queries = 0;
  assert.equal((await parser(async () => { queries++; return snapshot(); }).finish(1)).status, 'unknown');
  assert.equal(queries, 0);
});

test('V2 native errors keep HTTP status and type but discard provider bodies', () => {
  for (const [status, type, code] of [[400, 'provider.invalid-request', 'native_error'], [429, 'provider.quota', 'quota_exhausted'], [401, 'provider.auth', 'authentication_required']]) {
    const p = createOpenCodeParser(request, workspace, () => {});
    p.event({ type: 'error', sessionID: 'ses_fixture', error: { type, status, message: 'Bearer secret', response: { body: 'secret' } } });
    const outcome = p.finish(1);
    assert.equal(outcome.status, 'failed'); assert.equal(outcome.error.code, code);
    assert.equal(outcome.error.details.native_http_status, status);
    assert.equal(outcome.error.details.native_error_name, type);
    assert.doesNotMatch(JSON.stringify(outcome), /secret/);
  }
});

test('V2 native success retains failed web tool diagnostics for separate source acceptance', async () => {
  const p = parser(async () => snapshot());
  p.event(event('tool_use', { tool: 'webfetch', state: { status: 'error', error: 'certificate verification error; token=fixture-secret', input: { secret: 'fixture-secret' } } }));
  const outcome = await p.finish(0);
  assert.equal(outcome.status, 'succeeded');
  assert.equal(outcome.diagnostics.tool_errors.length, 1);
  assert.match(outcome.diagnostics.tool_errors[0].message, /certificate/);
  assert.doesNotMatch(JSON.stringify(outcome), /fixture-secret/);
});

test('waiting-user persistence retains sanitized OpenCode tool failure and exit evidence', async () => {
  const control = new ControlDatabase(path.join(workspace, 'approval-state'));
  try {
    const service = new TaskService(control);
    const task = service.submit({ schema_version: '1.0', request_id: randomUUID(), target: 'opencode', model: request.model,
      workspace, mode: 'analysis', prompt: 'fixture' });
    const p = parser(null);
    p.event(event('tool_use', { tool: 'webfetch', state: { status: 'error', error: 'Permission denied: requires approval; Bearer fixture-secret' } }));
    const outcome = p.finish(0);
    assert.equal(outcome.status, 'needs_user');
    service.transition(task.task_id, 'queued', { attemptId: task.attempt.attempt_id });
    service.transition(task.task_id, 'starting', { attemptId: task.attempt.attempt_id });
    service.transition(task.task_id, 'waiting_user', { attemptId: task.attempt.attempt_id,
      event: { ...outcome, diagnostics: { ...outcome.diagnostics, input: 'fixture-secret' } } });
    const result = service.result(task.task_id);
    assert.equal(result.diagnostics.native_exit_code, 0);
    assert.equal(result.diagnostics.tool_errors.length, 1);
    assert.match(result.diagnostics.tool_errors[0].message, /Permission denied/);
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
  } finally { control.close(); }
});

function recoveredParser(reader) {
  const p = createOpenCodeParser(request, workspace, () => {}, { sessionReader: reader });
  p.event(event('step_start', { messageID: 'interrupted' }));
  p.event({ type: 'error', sessionID: 'ses_fixture', error: {
    type: 'provider.invalid-output', status: 200, message: 'OpenAI Chat stream ended without finish_reason',
  } });
  p.event(event('step_start'));
  p.event(event('text', { text: '中文结果 ✓' }));
  return p;
}

test('V2 recovered provider errors require exact final session proof despite CLI exit one', async () => {
  const queried = [];
  const outcome = await recoveredParser(async session => { queried.push(session); return snapshot(); }).finish(1);
  assert.deepEqual(queried, ['ses_fixture']);
  assert.equal(outcome.status, 'succeeded');
  assert.equal(outcome.error, null);
  assert.equal(outcome.native_exit_code, 1);
  assert.equal(outcome.model_reported, 'glm-5.3-flash');
  assert.equal(outcome.result.response, '中文结果 ✓');
});

test('V2 recovered-looking text cannot erase errors without matching successful terminal evidence', async () => {
  const changes = [
    s => { s.info.outcome = 'failed'; }, s => { s.info.id = 'ses_other'; },
    s => { s.info.location.directory = path.join(workspace, 'other'); },
    s => { s.messages[0].id = 'interrupted'; }, s => { delete s.messages[0].time.completed; },
    s => { s.messages[0].error = { type: 'provider.invalid-output' }; },
    s => { s.messages[0].model.id = 'other'; }, s => { s.messages[0].content[0].text = 'different'; },
    s => { s.messages[1].time.created = 99; },
  ];
  for (const change of changes) {
    const s = snapshot(); change(s);
    const outcome = await recoveredParser(async () => s).finish(1);
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.error.details.native_error_name, 'provider.invalid-output');
  }
  const failedRead = await recoveredParser(async () => { throw new Error('Bearer secret'); }).finish(1);
  assert.equal(failedRead.status, 'failed');
  assert.doesNotMatch(JSON.stringify(failedRead), /Bearer secret/);
  assert.equal(recoveredParser(null).finish(1).status, 'failed');
});

test('V2 final errors, process failures and approval waits cannot be overridden by an export', async () => {
  let queries = 0;
  const reader = async () => { queries++; return snapshot(); };
  const finalError = parser(reader);
  finalError.event({ type: 'error', sessionID: 'ses_fixture', error: { type: 'provider.invalid-output', status: 200 } });
  assert.equal((await finalError.finish(1)).status, 'failed');
  assert.equal((await recoveredParser(reader).finish(2)).status, 'failed');
  const approval = recoveredParser(reader);
  approval.stderr('permission requires approval');
  assert.equal((await approval.finish(1)).status, 'needs_user');
  assert.equal(queries, 0);
});

test('V2 deadlines own a private server and reject a conflicting shared server', () => {
  const deadline = { ...request, execution_timeout_ms: 1_000 };
  assert.ok(buildOpenCodeArgs(deadline, workspace, { majorVersion: 2 }).includes('--standalone'));
  assert.equal(buildOpenCodeArgs({ ...deadline, native_args: ['--standalone'] }, workspace, { majorVersion: 2 }).filter(x => x === '--standalone').length, 1);
  assert.throws(() => buildOpenCodeArgs({ ...deadline, native_args: ['--server=http://localhost:1234'] }, workspace, { majorVersion: 2 }), { code: 'unsupported_capability' });
  assert.throws(() => buildOpenCodeArgs({ ...deadline, native_args: ['--standalone=false'] }, workspace, { majorVersion: 2 }), { code: 'unsupported_capability' });
  assert.equal(buildOpenCodeArgs(request, workspace, { majorVersion: 2 }).includes('--standalone'), false);
  assert.equal(buildOpenCodeArgs(deadline, workspace).includes('--standalone'), false);
});

test('session reads are bounded, use no prompt, and discard failed/invalid native output', async () => {
  const queries = [];
  const result = await readOpenCodeSession('fixture.exe', workspace, 'ses_fixture', { runner: async (...args) => {
    queries.push(args); return { status: 0, stdout: JSON.stringify(snapshot()) };
  } });
  assert.equal(result.info.id, 'ses_fixture');
  assert.deepEqual(queries[0][1], ['session', 'export', 'ses_fixture']);
  assert.equal(queries[0][2].cwd, workspace); assert.equal(queries[0][2].timeout, 5_000);
  assert.equal(await readOpenCodeSession('fixture.exe', workspace, '--prompt', { runner: () => { throw new Error('must not run'); } }), null);
  assert.equal(await readOpenCodeSession('fixture.exe', workspace, 'ses_fixture', { runner: async () => ({ status: 1, stdout: 'secret' }) }), null);
});

const fakeCli = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
const driver = (reader, scenario = 'v2-success') => ({ command: process.execPath, args: [fakeCli, 'opencode', request.request_id, scenario],
  createParser: publish => createOpenCodeParser(request, workspace, publish, { sessionReader: reader }) });

test('ordinary transport awaits V2 terminal verification', async () => {
  const result = await invokeCli(workspace, workspace, request, () => {}, driver(async () => snapshot()));
  assert.equal(result.status, 'succeeded'); assert.equal(result.model_reported, 'glm-5.3-flash');
});

test('ordinary transport verifies native recovery after a real CLI exit one', async () => {
  const result = await invokeCli(workspace, workspace, request, () => {}, driver(async () => snapshot(), 'v2-recovered-error'));
  assert.equal(result.status, 'succeeded'); assert.equal(result.native_exit_code, 1);
  assert.equal(result.model_reported, 'glm-5.3-flash');
});

test('ordinary worker preserves the verified V2 model in the Task result', async () => {
  const control = new ControlDatabase(path.join(workspace, 'ordinary-state'));
  try {
    const service = new TaskService(control);
    const input = { schema_version: '1.0', request_id: randomUUID(), target: 'opencode', model: request.model,
      mode: 'analysis', prompt: 'provider-free ordinary V2 fixture', workspace,
      execution: { observation_timeout_ms: 5_000 }, policy: { fallback: 'none' } };
    const adapter = new OpenCodeAdapter({ testDriver: driver(async () => snapshot()) });
    const prepare = adapter.prepare.bind(adapter);
    // Exercise the uninterrupted transport on Windows as well as other platforms.
    adapter.prepare = async (...args) => { const prepared = await prepare(...args); delete prepared.durable; return prepared; };
    const registered = service.submit(input);
    const result = await runTask({ service, taskId: registered.task_id, adapter });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.model_reported, 'glm-5.3-flash');
    assert.equal(result.model_verified, true);
    assert.equal(service.result(registered.task_id).response.text, '中文结果 ✓');
  } finally { control.close(); }
});

test('durable worker persists verified recovery as success with the matching model', { skip: process.platform !== 'win32' }, async () => {
  const control = new ControlDatabase(path.join(workspace, 'recovered-state'));
  try {
    const service = new TaskService(control);
    const input = { schema_version: '1.0', request_id: randomUUID(), target: 'opencode', model: request.model,
      mode: 'analysis', prompt: 'provider-free recovered V2 fixture', workspace,
      execution: { observation_timeout_ms: 5_000 }, policy: { fallback: 'none' } };
    const registered = service.submit(input);
    const result = await runTask({ service, taskId: registered.task_id,
      adapter: new OpenCodeAdapter({ testDriver: driver(async () => snapshot(), 'v2-recovered-error') }) });
    assert.equal(result.status, 'succeeded'); assert.equal(result.model_verified, true);
    assert.equal(service.result(registered.task_id).response.text, '中文结果 ✓');
    assert.equal(result.attempt.ordinal, 1);
  } finally { control.close(); }
});

test('durable observation and reconcile await V2 evidence on the same attempt without replay', { skip: process.platform !== 'win32' }, async () => {
  const control = new ControlDatabase(path.join(workspace, 'state'));
  try {
    const service = new TaskService(control);
    const input = { schema_version: '1.0', request_id: randomUUID(), target: 'opencode', model: request.model,
      mode: 'analysis', prompt: 'provider-free V2 fixture', workspace,
      execution: { observation_timeout_ms: 5_000 }, policy: { fallback: 'none' } };
    const registered = service.submit(input);
    const first = await runTask({ service, taskId: registered.task_id, adapter: new OpenCodeAdapter({ testDriver: driver(async () => null) }) });
    assert.equal(first.status, 'indeterminate');
    const before = fs.readFileSync(path.join(workspace, 'received.txt'), 'utf8');
    const reconciled = await reconcileTask({ service, taskId: registered.task_id, adapter: new OpenCodeAdapter({ testDriver: driver(async () => snapshot()) }) });
    assert.equal(reconciled.status, 'succeeded'); assert.equal(reconciled.model_verified, true);
    assert.equal(service.result(registered.task_id).response.text, '中文结果 ✓');
    assert.equal(fs.readFileSync(path.join(workspace, 'received.txt'), 'utf8'), before);
  } finally { control.close(); }
});
