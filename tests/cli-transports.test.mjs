import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createParser, invokeCli, locateCli } from '../plugins/uagents/src/transports/cli-process.mjs';
import { childEnvironment } from '../plugins/uagents/src/runtime/child-environment.mjs';

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
  const binary = path.join(root, 'npm path/node_modules/opencode-ai/bin/opencode.exe');
  fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, 'fixture only');
  assert.equal(locateCli('opencode', { PATH: path.join(root, 'npm path') }), binary);
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

test('child environment uses an explicit allowlist', () => {
  const filtered = childEnvironment({ PATH: 'fixture-bin', LOCALAPPDATA: 'fixture-data', OPENAI_API_KEY: 'secret', RANDOM_UNRELATED: 'value' });
  assert.deepEqual(filtered, { PATH: 'fixture-bin', LOCALAPPDATA: 'fixture-data' });
  assert.equal(JSON.stringify(filtered).includes('secret'), false);
});
