import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildAgyArgs, invokeAgy } from '../plugins/uagents/src/transports/agy-process.mjs';
import { AgyAdapter } from '../plugins/uagents/src/adapters/agy/adapter.mjs';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { runTask } from '../plugins/uagents/src/runtime/worker.mjs';
import { diagnosticMessage, sanitizeNativeDiagnostics } from '../plugins/uagents/src/transports/native-diagnostics.mjs';

test('agy uses native auto-approval without forcing sandbox initialization in either task mode', () => {
  const workspace = path.resolve('.local', 'review workspace');
  for (const mode of ['analysis', 'implementation']) {
    const args = buildAgyArgs(workspace, { mode, model: 'gemini-3.8-flash-medium', timeout_ms: 30_000 });
    assert.equal(args.filter(arg => arg === '--dangerously-skip-permissions').length, 1);
    assert.equal(args.includes('--sandbox'), false);
    assert.equal(args[args.indexOf('--add-dir') + 1], workspace);
    assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.8-flash-medium');
    assert.equal(args.includes('accept-edits'), mode === 'implementation');
  }
});

test('agy forwards explicit effort and preserves native default when omitted', () => {
  for (const effort of ['low', 'medium', 'high']) {
    const args = buildAgyArgs('.', { model: 'fixture', timeout_ms: 5000, effort });
    assert.equal(args[args.indexOf('--effort') + 1], effort);
  }
  assert.equal(buildAgyArgs('.', { model: 'fixture', timeout_ms: 5000 }).includes('--effort'), false);
});

test('diagnostic redaction covers quoted headers, bearer tokens, URL credentials and actual stderr tail', () => {
  for (const value of [
    'Authorization: Bearer fixture-secret', 'Bearer fixture-secret',
    '{"authorization":"Bearer fixture-secret","token":"fixture-secret"}',
    "{'password':'fixture-secret'}", 'https://user:fixture-secret@host/path?token=fixture-secret',
  ]) assert.doesNotMatch(diagnosticMessage(value), /fixture-secret/);
  const basic = Buffer.from('fixture-user:fixture-secret').toString('base64');
  assert.equal(diagnosticMessage(`Authorization: Basic ${basic}`).includes(basic), false);
  assert.equal(diagnosticMessage(`Basic ${basic}`).includes(basic), false);
  const echoed = diagnosticMessage('Invalid write arguments: content must be string\nArguments provided:\n{"content":"fixture-private-message"}');
  assert.match(echoed, /content must be string/);
  assert.doesNotMatch(echoed, /fixture-private-message|Arguments provided/);
  assert.match(diagnosticMessage('x'.repeat(1500) + ' FINAL_EOF_CAUSE', { tail: true }), /FINAL_EOF_CAUSE$/);
  const safe = sanitizeNativeDiagnostics({ stdout: 'fixture-secret', native_exit_code: 0,
    tool_errors: [{ tool: 'webfetch', message: 'Bearer fixture-secret', input: 'fixture-secret' }] });
  assert.doesNotMatch(JSON.stringify(safe), /fixture-secret|stdout|input/);
});

test('agy failures preserve a redacted reason or explicitly report missing native detail', async () => {
  for (const scenario of ['error-zero', 'error-exit-one', 'error-string', 'error-object', 'empty-success']) {
    const directory = path.resolve('.local/test-runs', randomUUID());
    fs.mkdirSync(directory, { recursive: true });
    const attemptId = randomUUID();
    const outcome = await invokeAgy(directory, directory, {
      kind: 'run', model: `gemini-fixture-${scenario}`, timeout_ms: 5000, effort: 'high',
      prompt: 'fixture', expected_outputs: [],
    }, () => {}, { command: process.execPath, args: [path.resolve('tests/fixtures/fake-agy.mjs'), scenario] }, { attemptId });
    assert.equal(outcome.status, scenario === 'empty-success' ? 'unknown' : 'failed');
    assert.equal(outcome.native_exit_code, scenario === 'error-exit-one' ? 1 : 0);
    assert.equal(outcome.retry_safe, false);
    if (scenario === 'empty-success') assert.equal(outcome.error, 'native_completion_unconfirmed');
    else {
      assert.equal(outcome.error.code, 'native_error');
      assert.equal(outcome.error.details.reason_available, ['error-string', 'error-object'].includes(scenario));
      if (['error-string', 'error-object'].includes(scenario)) assert.match(outcome.error.message, /EOF/);
    }
    const persisted = fs.readFileSync(path.join(directory, 'native', attemptId, 'diagnostics.json'), 'utf8');
    assert.doesNotMatch(JSON.stringify(outcome) + persisted, /fixture-secret/);
    assert.equal(JSON.parse(persisted).effort_requested, 'high');
  }
});

test('agy rejects foreign result diagnostics as well as the foreign outcome', async () => {
  const directory = path.resolve('.local/test-runs', randomUUID()); fs.mkdirSync(directory, { recursive: true });
  const outcome = await invokeAgy(directory, directory, { kind: 'run', model: 'gemini-fixture-wrong-session-error',
    timeout_ms: 5000, prompt: 'fixture', expected_outputs: [] }, () => {},
  { command: process.execPath, args: [path.resolve('tests/fixtures/fake-agy.mjs'), 'wrong-session-error'] });
  assert.equal(outcome.status, 'unknown');
  assert.equal(outcome.error, 'missing_or_mismatched_result');
  assert.equal(outcome.diagnostics.native_status, null);
  assert.doesNotMatch(JSON.stringify(outcome.diagnostics), /foreign-provider-failure/);
});

test('agy bounds stderr before truncation and redacts payloads and credentials across chunks', async () => {
  for (const scenario of ['stderr-echo', 'stderr-oversize', 'stderr-token']) {
    const directory = path.resolve('.local/test-runs', randomUUID()); fs.mkdirSync(directory, { recursive: true });
    const attemptId = randomUUID();
    const outcome = await invokeAgy(directory, directory, { kind: 'run', model: `gemini-fixture-${scenario}`,
      timeout_ms: 5000, prompt: 'fixture', expected_outputs: [] }, () => {},
    { command: process.execPath, args: [path.resolve('tests/fixtures/fake-agy.mjs'), scenario] }, { attemptId });
    assert.equal(outcome.status, 'succeeded');
    const persisted = fs.readFileSync(path.join(directory, 'native', attemptId, 'diagnostics.json'), 'utf8');
    assert.doesNotMatch(JSON.stringify(outcome.diagnostics) + persisted, /fixture-private-message|fixture-secret/);
    if (scenario === 'stderr-oversize') {
      assert.equal(outcome.diagnostics.stderr_truncated, true);
      assert.equal(outcome.diagnostics.stderr_tail, null);
    }
  }
});

test('worker result exposes error, exit evidence and bounded tool diagnostics without replay', async () => {
  const directory = path.resolve('.local/test-runs', randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  const control = new ControlDatabase(path.join(directory, 'state'));
  try {
    const service = new TaskService(control);
    const input = { schema_version: '1.0', request_id: randomUUID(), target: 'agy', model: 'gemini-fixture-error-zero',
      workspace: directory, mode: 'analysis', prompt: 'fixture', execution: { observation_timeout_ms: 5000, effort: 'high' } };
    const task = service.submit(input);
    await runTask({ service, taskId: task.task_id, adapter: new AgyAdapter({ testDriver: {
      command: process.execPath, args: [path.resolve('tests/fixtures/fake-agy.mjs'), 'error-zero'],
    } }) });
    const result = service.result(task.task_id);
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'native_error');
    assert.equal(result.diagnostics.native_exit_code, 0);
    assert.equal(result.diagnostics.effort_requested, 'high');
    assert.equal(fs.existsSync(result.evidence.diagnostics), true);
    assert.equal(fs.existsSync(result.evidence.request), true);
    assert.equal(result.evidence.stdout, null);
    assert.equal(result.attempt.ordinal, 1);
    assert.equal(fs.readFileSync(path.join(directory, 'received.txt'), 'utf8'), 'submitted\n');
    // Old events lacked error payloads. Read-only reporting supplies an honest
    // generic fallback without mutating history or inventing a provider cause.
    control.raw.prepare("UPDATE events SET payload_json = json_remove(payload_json, '$.error') WHERE task_id = ? AND type = 'task.failed'").run(task.task_id);
    assert.equal(service.result(task.task_id).error.details.reason_available, false);
    control.raw.prepare("UPDATE events SET payload_json = json_remove(payload_json, '$.diagnostics', '$.native_exit_code') WHERE task_id = ? AND type = 'task.failed'").run(task.task_id);
    for (const exitCode of ['zero', { provider_body: 'fixture-secret' }]) {
      fs.writeFileSync(result.evidence.diagnostics, JSON.stringify({ native_exit_code: exitCode }));
      const malformed = service.result(task.task_id);
      assert.equal(malformed.diagnostics.native_exit_code, null);
      assert.doesNotMatch(JSON.stringify(malformed), /fixture-secret/);
    }
  } finally { control.close(); }
});

test('a native permission denial still records needs_user and cannot become a success or safe retry', async () => {
  const directory = path.resolve('.local', 'test-runs', randomUUID(), 'agy-denial');
  fs.mkdirSync(directory, { recursive: true });
  const result = await invokeAgy(directory, directory, {
    mode: 'analysis', model: 'gemini-fixture-tool-denied', timeout_ms: 5_000,
    prompt: 'Review without editing.', expected_outputs: [], permission_policy: 'advisory-read-only',
  }, () => {}, { command: process.execPath, args: [path.resolve('tests/fixtures/fake-agy.mjs'), 'tool-denied'] });
  assert.equal(result.status, 'needs_user');
  assert.equal(result.error, 'native_approval_required');
  assert.equal(result.retry_safe, false);
  assert.equal(result.diagnostics.tool_errors.length, 1);
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /sensitive|do not persist tool arguments/);
  assert.equal(fs.readFileSync(path.join(directory, 'received.txt'), 'utf8'), 'submitted\n');
});
