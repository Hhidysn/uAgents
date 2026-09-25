import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createParser, invokeCli, locateCli, nativeDriver } from '../plugins/uagents/src/transports/cli-process.mjs';
import { buildOpenCodeArgs } from '../plugins/uagents/src/transports/opencode-driver.mjs';
import { buildWorkBuddyArgs, buildWorkBuddyInput } from '../plugins/uagents/src/transports/workbuddy-driver.mjs';
import { WorkBuddyAdapter } from '../plugins/uagents/src/adapters/workbuddy/adapter.mjs';
import { evaluateRequest } from '../plugins/uagents/src/policy/evaluate.mjs';
import { advisoryPrompt } from '../plugins/uagents/src/policy/advisory.mjs';
import { childEnvironment } from '../plugins/uagents/src/runtime/child-environment.mjs';
import { snapshotInputs } from '../plugins/uagents/src/artifacts/inputs.mjs';

const root = path.resolve('.local', 'test-runs', randomUUID(), 'CLI transport');
fs.mkdirSync(root, { recursive: true });
const request = (target, patch = {}) => ({
  request_id: randomUUID(), target, model: target === 'workbuddy' ? 'workbuddy-default' : 'commandcode-goat/deepseek/deepseek-v4-flash',
  mode: 'analysis', prompt: 'success', timeout_ms: 5_000, kind: 'run', expected_outputs: [], ...patch,
});
const wbResult = (id, patch = {}) => ({ type: 'result', session_id: id, subtype: 'success', is_error: false, result: 'answer', ...patch });
const ocEvent = (type, id, message = 'final', extra = {}) => ({ type, sessionID: 'ses_test', part: { id, messageID: message, sessionID: 'ses_test', ...extra } });

function wbParser() {
  const input = request('workbuddy');
  const parser = createParser(input, root, () => {});
  parser.event({ type: 'system', subtype: 'init', session_id: input.request_id, cwd: root, model: 'native-default' });
  return { parser, input };
}

test('Windows discovery finds native npm executable without invoking a shell', { skip: process.platform !== 'win32' }, () => {
  const shim = path.join(root, 'npm path/opencode');
  const binary = path.join(root, 'npm path/node_modules/opencode-ai/bin/opencode.exe');
  const laterBinary = path.join(root, 'later path/opencode.exe');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.mkdirSync(path.dirname(laterBinary), { recursive: true });
  fs.writeFileSync(shim, 'npm shim fixture');
  fs.writeFileSync(binary, 'fixture only');
  fs.writeFileSync(laterBinary, 'later PATH candidate');
  assert.equal(locateCli('opencode', { PATH: [path.join(root, 'npm path'), path.join(root, 'later path')].join(path.delimiter) }), binary);
  assert.throws(() => locateCli('opencode', { UAGENTS_OPENCODE_BIN: 'relative.cmd' }), { code: 'invalid_cli_path' });
});

test('WorkBuddy validates session/cwd and preserves approval/background-task evidence', () => {
  const { parser, input } = wbParser();
  assert.throws(() => parser.event(wbResult(randomUUID())), { code: 'native_session_mismatch' });
  parser.event(wbResult(input.request_id, { permission_denials: [{ tool_name: 'Write' }] }));
  assert.equal(parser.finish(0).status, 'needs_user');

  const { parser: active, input: activeInput } = wbParser();
  active.event({ type: 'system', subtype: 'task_started', session_id: activeInput.request_id, task_id: 'bg' });
  active.event(wbResult(activeInput.request_id));
  assert.equal(active.finish(0).status, 'unknown');
  active.event({ type: 'system', subtype: 'task_updated', session_id: activeInput.request_id, task_id: 'bg', patch: { status: 'completed' } });
  assert.equal(active.finish(0).status, 'succeeded');
});

test('WorkBuddy accepts repeated equivalent init events but rejects changed init identity', () => {
  const input = request('workbuddy');
  const parser = createParser(input, root, () => {});
  const init = { type: 'system', subtype: 'init', session_id: input.request_id, cwd: root, model: 'native-default' };
  parser.event(init);
  parser.event({ ...init });
  parser.event(wbResult(input.request_id));
  assert.equal(parser.finish(0).status, 'succeeded');

  const changedModel = createParser(input, root, () => {});
  changedModel.event(init);
  assert.throws(() => changedModel.event({ ...init, model: 'other-model' }), { code: 'duplicate_init' });

  const changedCwd = createParser(input, root, () => {});
  changedCwd.event(init);
  assert.throws(() => changedCwd.event({ ...init, cwd: path.join(root, 'other') }), { code: 'native_session_mismatch' });
});

test('WorkBuddy continuation resumes the persisted native session instead of creating a new one', () => {
  const sourceSession = 'session_parent_123';
  const input = request('workbuddy', { continue_session_id: sourceSession });
  const args = buildWorkBuddyArgs(input);
  assert.equal(args.includes('--session-id'), false);
  const resumeIndex = args.indexOf('--resume');
  assert.deepEqual(args.slice(resumeIndex, resumeIndex + 2), ['--resume', sourceSession]);
  const parser = createParser(input, root, () => {});
  parser.event({ type: 'system', subtype: 'init', session_id: sourceSession, cwd: root, model: 'native-default' });
  parser.event(wbResult(sourceSession));
  assert.equal(parser.finish(0).result.native_session_id, sourceSession);
  assert.throws(() => createParser(input, root, () => {}).event({
    type: 'system', subtype: 'init', session_id: input.request_id, cwd: root, model: 'native-default',
  }), { code: 'native_session_mismatch' });
});

test('WorkBuddy explicit model route is forwarded through native --model', () => {
  const input = request('workbuddy', { model_resolved: 'deepseek-v4.1-flash' });
  const args = buildWorkBuddyArgs(input);
  const modelIndex = args.indexOf('--model');
  assert.deepEqual(args.slice(modelIndex, modelIndex + 2), ['--model', 'deepseek-v4.1-flash']);
  assert.equal(buildWorkBuddyArgs(request('workbuddy')).includes('--model'), false);
});

test('WorkBuddy adapter carries the resolved Task model into the native driver', async () => {
  const selected = evaluateRequest({ schema_version: '1.0', request_id: randomUUID(), target: 'workbuddy',
    model: 'deepseek-v4.1-flash', mode: 'analysis', prompt: 'check', workspace: root }).request;
  const prepared = await new WorkBuddyAdapter().prepare(selected, { verifiedEntry: process.execPath });
  const modelIndex = prepared.driver.args.indexOf('--model');
  assert.deepEqual(prepared.driver.args.slice(modelIndex, modelIndex + 2), ['--model', 'deepseek-v4.1-flash']);
});

test('WorkBuddy fork resumes the source session but requires a new native session identity', () => {
  const sourceSession = 'session_parent_123';
  const input = request('workbuddy', { fork_session_id: sourceSession });
  const args = buildWorkBuddyArgs(input);
  assert.equal(args.includes('--session-id'), false);
  const resumeIndex = args.indexOf('--resume');
  assert.deepEqual(args.slice(resumeIndex, resumeIndex + 3), ['--resume', sourceSession, '--fork-session']);
  const parser = createParser(input, root, () => {});
  parser.event({ type: 'system', subtype: 'init', session_id: 'session_branch_456', cwd: root, model: 'native-default' });
  parser.event(wbResult('session_branch_456'));
  assert.equal(parser.finish(0).result.native_session_id, 'session_branch_456');
  assert.throws(() => createParser(input, root, () => {}).event({
    type: 'system', subtype: 'init', session_id: sourceSession, cwd: root, model: 'native-default',
  }), { code: 'native_session_mismatch' });
});

test('OpenCode returns only the final completed message and rejects mixed identity', () => {
  const parser = createParser(request('opencode'), root, () => {});
  parser.event(ocEvent('step_start', 'old-start', 'previous'));
  parser.event(ocEvent('text', 'old', 'previous', { text: 'planning' }));
  parser.event(ocEvent('step_finish', 'old-end', 'previous', { reason: 'tool-calls' }));
  parser.event(ocEvent('step_start', 'start'));
  parser.event(ocEvent('text', 'text', 'final', { text: 'partial' }));
  parser.event(ocEvent('text', 'text', 'final', { text: 'complete' }));
  parser.event(ocEvent('step_finish', 'end', 'final', { reason: 'stop' }));
  assert.equal(parser.finish(0).result.response, 'complete');
  assert.equal(parser.finish(0).status, 'succeeded');
  assert.throws(() => parser.event({ ...ocEvent('text', 'more', 'final', { text: 'other' }), sessionID: 'ses_other' }), { code: 'native_session_mismatch' });
});

test('OpenCode driver keeps native flags caller-controlled and maps file inputs to absolute paths', () => {
  const input = request('opencode', {
    native_args: ['--pure', '--auto', '--agent', 'build', '--variant=fast'],
    inputs: [{ type: 'file', path: 'requirements/one.md' }, { type: 'file', path: 'src/two.mjs' }],
  });
  assert.deepEqual(buildOpenCodeArgs(input, root), [
    'run', '--model', input.model, '--format', 'json', '--dir', root, '--title', `uAgents ${input.request_id}`,
    '--file', path.resolve(root, 'requirements/one.md'), '--file', path.resolve(root, 'src/two.mjs'),
    '--pure', '--auto', '--agent', 'build', '--variant=fast',
  ]);
  assert.equal(buildOpenCodeArgs(request('opencode'), root).includes('--pure'), false);
});

test('OpenCode maps image attachments through the same native --file channel', () => {
  const input = request('opencode', { inputs: [{ type: 'image', path: 'assets/screenshot.png', media_type: 'image/png' }] });
  const args = buildOpenCodeArgs(input, root);
  assert.deepEqual(args.slice(-2), ['--file', path.resolve(root, 'assets/screenshot.png')]);
});

test('OpenCode continuation selects the persisted session explicitly', () => {
  const input = request('opencode', { continue_session_id: 'ses_parent' });
  assert.deepEqual(buildOpenCodeArgs(input, root), [
    'run', '--session', 'ses_parent', '--model', input.model, '--format', 'json', '--dir', root,
  ]);
  assert.throws(() => buildOpenCodeArgs({ ...input, native_args: ['--session', 'other'] }, root), { code: 'invalid_request' });
  assert.throws(() => buildOpenCodeArgs({ ...input, native_args: ['--continue'] }, root), { code: 'invalid_request' });
  const parser = createParser(input, root, () => {});
  parser.event({ type: 'step_start', sessionID: 'ses_parent', part: { id: 'start', messageID: 'answer', sessionID: 'ses_parent' } });
  assert.throws(() => parser.event({ type: 'text', sessionID: 'ses_other', part: {
    id: 'text', messageID: 'answer', sessionID: 'ses_other', text: 'wrong session',
  } }), { code: 'native_session_mismatch' });
});

test('OpenCode fork selects the source session, requests --fork, and binds a new session identity', () => {
  const input = request('opencode', { fork_session_id: 'ses_parent' });
  assert.deepEqual(buildOpenCodeArgs(input, root), [
    'run', '--session', 'ses_parent', '--fork', '--model', input.model, '--format', 'json', '--dir', root,
  ]);
  assert.throws(() => buildOpenCodeArgs({ ...input, native_args: ['--session', 'other'] }, root), { code: 'invalid_request' });
  assert.throws(() => buildOpenCodeArgs({ ...input, native_args: ['--fork'] }, root), { code: 'invalid_request' });
  const parser = createParser(input, root, () => {});
  parser.event({ type: 'step_start', sessionID: 'ses_branch', part: { id: 'start', messageID: 'answer', sessionID: 'ses_branch' } });
  parser.event({ type: 'text', sessionID: 'ses_branch', part: { id: 'text', messageID: 'answer', sessionID: 'ses_branch', text: 'branch' } });
  parser.event({ type: 'step_finish', sessionID: 'ses_branch', part: { id: 'finish', messageID: 'answer', sessionID: 'ses_branch', reason: 'stop' } });
  assert.equal(parser.finish(0).result.native_session_id, 'ses_branch');
  assert.throws(() => createParser(input, root, () => {}).event({
    type: 'step_start', sessionID: 'ses_parent', part: { id: 'start', messageID: 'answer', sessionID: 'ses_parent' },
  }), { code: 'native_session_mismatch' });
});

test('WorkBuddy maps declared images into native stream-json attachment blocks', () => {
  const workspace = path.join(root, 'workbuddy attachments');
  fs.mkdirSync(workspace, { recursive: true });
  const png = pngFixture(2, 3);
  fs.writeFileSync(path.join(workspace, 'screen.png'), png);
  const input = request('workbuddy', {
    inputs: [{ type: 'image', path: 'screen.png' }],
  });
  const snapshots = snapshotInputs(workspace, input.inputs);
  assert.deepEqual(buildWorkBuddyArgs(input).slice(0, 5), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json']);
  const payload = buildWorkBuddyInput(input, workspace, snapshots);
  const message = JSON.parse(payload);
  assert.equal(message.type, 'user');
  assert.equal(message.message.role, 'user');
  assert.equal(message.message.content[0].type, 'text');
  assert.deepEqual(message.message.content[1], {
    type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') }, original_filename: 'screen.png',
  });
  const entry = path.join(workspace, 'codebuddy.js');
  fs.writeFileSync(entry, '// fixture entry');
  const driver = nativeDriver(input, workspace, entry, snapshots);
  assert.equal(driver.stdinPayload, payload);
  assert.equal(driver.args.includes('--input-format'), true);
  assert.equal(driver.args.includes('stream-json'), true);
  assert.throws(() => buildWorkBuddyInput(input, workspace, []), { code: 'input_changed' });
  fs.writeFileSync(path.join(workspace, 'screen.png'), pngFixture(3, 4));
  assert.throws(() => buildWorkBuddyInput(input, workspace, snapshots), { code: 'input_changed' });
});

test('OpenCode turns provider authentication failures into a redacted structured error', () => {
  const parser = createParser(request('opencode'), root, () => {});
  parser.event({
    type: 'error', sessionID: 'ses_test',
    error: {
      name: 'APIError',
      data: {
        message: "Invalid 'Authorization' header or token.", statusCode: 401,
        responseHeaders: { authorization: 'Bearer fixture-secret' }, responseBody: 'token=fixture-secret',
      },
    },
  });
  const result = parser.finish(1);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.error, {
    code: 'authentication_required',
    category: 'target',
    message: 'OpenCode provider authentication failed (HTTP 401). Re-authenticate the configured provider.',
    retryable: false,
    schema_version: '1.0',
    submission: 'sent',
    details: { native_error_name: 'APIError', native_http_status: 401 },
  });
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
});

test('pre-recorded cancellation needs no installed CLI', async () => {
  const directory = path.join(root, randomUUID()); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'cancel.json'), '{}');
  const driver = { get command() { throw new Error('must not resolve driver'); } };
  assert.equal((await invokeCli(directory, directory, request('workbuddy'), () => {}, driver)).status, 'cancelled');
});

test('deadline after send remains unknown even if process kill emits an error', async () => {
  const child = new EventEmitter();
  Object.assign(child, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref() {},
    kill() { this.emit('error', new Error('kill error')); setImmediate(() => this.emit('close', null)); },
  });
  const driver = { command: 'fixture', args: [], spawn() { setImmediate(() => child.emit('spawn')); return child; } };
  const done = await invokeCli(root, root, request('opencode', { timeout_ms: 1_000 }), () => {}, driver);
  assert.equal(done.status, 'unknown');
  assert.equal(done.error, 'deadline_remote_state_unknown');
});

test('worker and native CLI environments preserve arbitrary provider variables', () => {
  const parent = {
    PATH: 'fixture-bin', LOCALAPPDATA: 'fixture-data',
    COMMANDCODE_API_KEY: 'fixture-command-code-key', FUTURE_SUBSCRIPTION_KEY: 'fixture-future-key',
    NON_STRING_VALUE: 42,
  };
  const worker = childEnvironment(parent, { UAGENTS_TEST_MARKER: 'worker' });
  const nativeCli = childEnvironment(worker, { UAGENTS_TEST_MARKER: 'native-cli' });
  assert.deepEqual(nativeCli, {
    PATH: 'fixture-bin', LOCALAPPDATA: 'fixture-data',
    COMMANDCODE_API_KEY: 'fixture-command-code-key', FUTURE_SUBSCRIPTION_KEY: 'fixture-future-key',
    UAGENTS_TEST_MARKER: 'native-cli',
  });
  assert.equal(parent.UAGENTS_TEST_MARKER, undefined);
});

test('CLI transport forwards the advisory prompt to the native process', async () => {
  const original = { prompt: 'Inspect the workspace.', execution: { permission: 'advisory-read-only' } };
  const prompt = advisoryPrompt(original);
  const input = request('workbuddy', { prompt, permission_policy: 'advisory-read-only' });
  const child = new EventEmitter();
  Object.assign(child, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref() {},
    kill() {},
  });
  let received = '';
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', chunk => { received += chunk; });
  child.stdin.on('finish', () => {
    child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: input.request_id, cwd: root, model: 'fixture-default' }) + '\n');
    child.stdout.write(JSON.stringify(wbResult(input.request_id)) + '\n');
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit('close', 0));
  });
  const result = await invokeCli(root, root, input, () => {}, {
    command: 'fixture', args: [], spawn() { setImmediate(() => child.emit('spawn')); return child; },
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(received.endsWith(prompt), true);
  assert.match(received, /Do not edit, create, delete, rename, or overwrite files\./);
});

test('advisory prompt leaves other permission prompts byte-for-byte unchanged', () => {
  const prompt = '  preserve leading/trailing whitespace\n中文\n';
  for (const permission of ['native', 'enforced-read-only', 'workspace-write', 'full-access']) {
    assert.equal(advisoryPrompt({ prompt, execution: { permission } }), prompt);
  }
});

function pngFixture(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
