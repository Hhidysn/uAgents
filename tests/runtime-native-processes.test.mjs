import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import {
  bindProcessIdentity,
  createProvisionalProcess,
  getNativeProcess,
  listGuardedProcesses,
  markProcessExited,
  markProcessUnknown,
  nativeLaunchFingerprint,
  releaseWorkspaceGuard,
  updateTranscriptCursor,
} from '../plugins/uagents/src/runtime/native-processes.mjs';

const base = path.resolve('.local', 'test-runs', randomUUID(), 'native process ledger');
fs.mkdirSync(base, { recursive: true });

test('launch fingerprint is deterministic and sensitive to dispatcher argv', () => {
  const input = {
    target: 'opencode', attemptId: 'attempt-fingerprint', workspaceKey: 'c:/repo',
    executablePath: path.resolve('fixture', 'opencode.exe'), executableSha256: 'a'.repeat(64),
    argv: ['run', '--format', 'json'], coreVersion: 'core-1', adapterVersion: 'adapter-1',
  };
  assert.equal(nativeLaunchFingerprint(input), nativeLaunchFingerprint(structuredClone(input)));
  assert.notEqual(nativeLaunchFingerprint(input), nativeLaunchFingerprint({ ...input, argv: [...input.argv, '--auto'] }));
});

test('provisional process consumes one launch slot and stores only task-relative transcript paths', () => {
  fixture('provisional', ({ control, attemptId, record }) => {
    const created = createProvisionalProcess(control, {
      ...record, stdoutRelpath: `native\\${attemptId}\\stdout.log`, stderrRelpath: `native/${attemptId}/stderr.log`,
    }, { now: 100 });
    assert.equal(created.attempt_id, attemptId);
    assert.equal(created.process_state, 'starting');
    assert.equal(created.pid, null);
    assert.equal(created.process_started_at_ms, null);
    assert.equal(created.workspace_guard_state, 'held');
    assert.equal(created.stdout_relpath, `native/${attemptId}/stdout.log`);
    assert.equal(created.stderr_relpath, `native/${attemptId}/stderr.log`);
    assert.throws(() => createProvisionalProcess(control, record), { code: 'invalid_state_transition' });
  });
});

test('provisional process rejects absolute or escaping transcript paths', () => {
  fixture('paths', ({ control, record }) => {
    assert.throws(() => createProvisionalProcess(control, { ...record, stdoutRelpath: 'C:\\temp\\stdout.log' }), { code: 'invalid_request' });
    assert.throws(() => createProvisionalProcess(control, { ...record, stderrRelpath: '../stderr.log' }), { code: 'invalid_request' });
  });
});

test('schema and bind helper require verified process identity before running', () => {
  fixture('bind', ({ control, attemptId, record }) => {
    createProvisionalProcess(control, record, { now: 100 });
    assert.throws(() => control.raw.prepare("UPDATE native_processes SET process_state = 'running' WHERE attempt_id = ?").run(attemptId), /constraint/i);
    assert.throws(() => bindProcessIdentity(control, attemptId, {
      pid: 42, startedAtMs: 1234, executablePath: path.resolve('different', 'opencode.exe'),
    }, { now: 110 }), { code: 'native_process_identity_mismatch' });
    const running = bindProcessIdentity(control, attemptId, {
      pid: 42, startedAtMs: 1234, executablePath: record.executablePath,
    }, { now: 111 });
    assert.equal(running.process_state, 'running');
    assert.equal(running.pid, 42);
    assert.equal(running.process_started_at_ms, 1234);
    assert.throws(() => bindProcessIdentity(control, attemptId, {
      pid: 42, startedAtMs: 1234, executablePath: record.executablePath,
    }), { code: 'invalid_state_transition' });
  });
});

test('transcript cursors are monotonic and non-negative', () => {
  fixture('cursor', ({ control, attemptId, record }) => {
    createProvisionalProcess(control, record, { now: 100 });
    let process = updateTranscriptCursor(control, attemptId, { stdoutBytes: 12, stderrBytes: 3 }, { now: 101 });
    assert.equal(process.stdout_cursor_bytes, 12);
    assert.equal(process.stderr_cursor_bytes, 3);
    process = updateTranscriptCursor(control, attemptId, { stdoutBytes: 12 }, { now: 102 });
    assert.equal(process.stdout_cursor_bytes, 12);
    assert.throws(() => updateTranscriptCursor(control, attemptId, { stdoutBytes: 11 }), { code: 'invalid_state_transition' });
    assert.throws(() => updateTranscriptCursor(control, attemptId, { stderrBytes: -1 }), { code: 'invalid_request' });
  });
});

test('unknown process state stays guarded and cannot be explicitly released', () => {
  fixture('unknown', ({ control, attemptId, record }) => {
    createProvisionalProcess(control, record, { now: 100 });
    const unknown = markProcessUnknown(control, attemptId, { now: 110 });
    assert.equal(unknown.process_state, 'unknown');
    assert.equal(unknown.workspace_guard_state, 'unknown');
    assert.equal(listGuardedProcesses(control).length, 1);
    assert.throws(() => releaseWorkspaceGuard(control, attemptId), { code: 'invalid_state_transition' });
  });
});

test('process exit does not release workspace guard until an explicit release operation', () => {
  fixture('exit', ({ control, attemptId, record }) => {
    createProvisionalProcess(control, record, { now: 100 });
    bindProcessIdentity(control, attemptId, { pid: 77, startedAtMs: 200, executablePath: record.executablePath }, { now: 110 });
    const exited = markProcessExited(control, attemptId, { exitCode: 0, exitedAtMs: 300 }, { now: 301 });
    assert.equal(exited.process_state, 'exited');
    assert.equal(exited.exit_code, 0);
    assert.equal(exited.exited_at_ms, 300);
    assert.equal(exited.workspace_guard_state, 'held');
    assert.equal(listGuardedProcesses(control).length, 1);

    const released = releaseWorkspaceGuard(control, attemptId, { now: 310 });
    assert.equal(released.workspace_guard_state, 'released');
    assert.equal(listGuardedProcesses(control).length, 0);
    assert.equal(getNativeProcess(control, attemptId).workspace_guard_state, 'released');
    assert.throws(() => markProcessUnknown(control, attemptId), { code: 'invalid_state_transition' });
  });
});

function fixture(name, operation) {
  const root = path.join(base, `${name}-${randomUUID()}`);
  const control = new ControlDatabase(root);
  try {
    const service = new TaskService(control);
    const requestId = randomUUID();
    const registered = service.submit({
      schema_version: '1.0', request_id: requestId, target: 'opencode',
      model: 'commandcode-goat/deepseek/deepseek-v4-flash', mode: 'implementation', prompt: 'fixture',
      execution: { observation_timeout_ms: 10_000, effort: 'medium', permission: 'native' },
      policy: { fallback: 'none', max_cost_usd: null },
    }, { adapterVersion: 'fixture-adapter' });
    const attemptId = registered.attempt.attempt_id;
    const executablePath = path.resolve(root, 'opencode.exe');
    const record = {
      attemptId,
      target: 'opencode',
      workspaceKey: path.resolve(root, 'workspace').toLowerCase(),
      executablePath,
      executableSha256: 'b'.repeat(64),
      launchFingerprint: nativeLaunchFingerprint({
        target: 'opencode', attemptId, workspaceKey: path.resolve(root, 'workspace').toLowerCase(),
        executablePath, executableSha256: 'b'.repeat(64), argv: ['run', '--format', 'json'],
        coreVersion: 'fixture-core', adapterVersion: 'fixture-adapter',
      }),
      stdoutRelpath: `native/${attemptId}/stdout.log`,
      stderrRelpath: `native/${attemptId}/stderr.log`,
    };
    operation({ control, service, registered, attemptId, record });
  } finally { control.close(); }
}
