import path from 'node:path';
import { canonicalHash } from '../protocol/canonical-json.mjs';
import { fail } from '../protocol/errors.mjs';
import { assertFencing } from './leases.mjs';

const SHA256 = /^[0-9a-f]{64}$/i;

export function nativeLaunchFingerprint({ target, attemptId, workspaceKey = null, executablePath, executableSha256 = null, argv = [], coreVersion = null, adapterVersion = null }) {
  nonempty(target, 'target');
  nonempty(attemptId, 'attemptId');
  absoluteFilePath(executablePath, 'executablePath');
  if (executableSha256 !== null && !SHA256.test(executableSha256)) fail('invalid_request', 'executableSha256 must be a SHA-256 hex digest.');
  if (!Array.isArray(argv) || argv.some(argument => typeof argument !== 'string')) fail('invalid_request', 'argv must contain only strings.');
  return canonicalHash({
    target,
    attempt_id: attemptId,
    workspace_key: workspaceKey,
    executable_path: executablePath,
    executable_sha256: executableSha256,
    argv: [...argv],
    core_version: coreVersion,
    adapter_version: adapterVersion,
  });
}

export function createProvisionalProcess(control, record, { lease = null, now = Date.now() } = {}) {
  const attemptId = nonempty(record?.attemptId, 'attemptId');
  const target = nonempty(record?.target, 'target');
  const executablePath = absoluteFilePath(record?.executablePath, 'executablePath');
  const launchFingerprint = digest(record?.launchFingerprint, 'launchFingerprint');
  const executableSha256 = record?.executableSha256 === null || record?.executableSha256 === undefined
    ? null : digest(record.executableSha256, 'executableSha256');
  const stdoutRelpath = transcriptRelpath(record?.stdoutRelpath, 'stdoutRelpath');
  const stderrRelpath = transcriptRelpath(record?.stderrRelpath, 'stderrRelpath');
  const workspaceKey = record?.workspaceKey === null || record?.workspaceKey === undefined ? null : nonempty(record.workspaceKey, 'workspaceKey');
  const timestamp = epoch(now, 'now');

  return control.transaction(database => {
    assertOptionalFencing(database, lease, timestamp);
    const attempt = database.prepare('SELECT 1 FROM attempts WHERE attempt_id = ?').get(attemptId);
    if (!attempt) fail('task_not_found', `Unknown attempt: ${attemptId}`);
    if (database.prepare('SELECT 1 FROM native_processes WHERE attempt_id = ?').get(attemptId)) {
      fail('invalid_state_transition', 'This Attempt has already consumed its native process launch slot.', { category: 'conflict', submission: 'not_sent' });
    }
    database.prepare(`INSERT INTO native_processes(
      attempt_id, target, workspace_key, executable_path, executable_sha256, launch_fingerprint,
      pid, process_started_at_ms, process_state, exit_code, stdout_relpath, stderr_relpath,
      stdout_cursor_bytes, stderr_cursor_bytes, workspace_guard_state, observed_at_ms, exited_at_ms,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'starting', NULL, ?, ?, 0, 0, 'held', ?, NULL, ?, ?)`)
      .run(attemptId, target, workspaceKey, executablePath, executableSha256, launchFingerprint,
        stdoutRelpath, stderrRelpath, timestamp, timestamp, timestamp);
    return getNativeProcessWith(database, attemptId);
  });
}

export function bindProcessIdentity(control, attemptId, identity, { lease = null, now = Date.now() } = {}) {
  nonempty(attemptId, 'attemptId');
  const pid = positiveInteger(identity?.pid, 'pid');
  const startedAt = positiveInteger(identity?.startedAtMs, 'startedAtMs');
  const executablePath = absoluteFilePath(identity?.executablePath, 'executablePath');
  const timestamp = epoch(now, 'now');
  return control.transaction(database => {
    assertOptionalFencing(database, lease, timestamp);
    const current = requireProcess(database, attemptId);
    if (current.process_state !== 'starting') fail('invalid_state_transition', `Native process identity cannot be bound from ${current.process_state}.`);
    if (!sameExecutable(current.executable_path, executablePath)) {
      fail('native_process_identity_mismatch', 'Observed native executable does not match the verified launch executable.', {
        category: 'transport', submission: 'not_sent',
      });
    }
    database.prepare(`UPDATE native_processes SET pid = ?, process_started_at_ms = ?, process_state = 'running',
      observed_at_ms = ?, updated_at_ms = ? WHERE attempt_id = ?`)
      .run(pid, startedAt, timestamp, timestamp, attemptId);
    return getNativeProcessWith(database, attemptId);
  });
}

export function updateTranscriptCursor(control, attemptId, cursors, { lease = null, now = Date.now() } = {}) {
  nonempty(attemptId, 'attemptId');
  const hasStdout = cursors && Object.prototype.hasOwnProperty.call(cursors, 'stdoutBytes');
  const hasStderr = cursors && Object.prototype.hasOwnProperty.call(cursors, 'stderrBytes');
  if (!hasStdout && !hasStderr) fail('invalid_request', 'At least one transcript cursor is required.');
  const stdout = hasStdout ? nonnegativeInteger(cursors.stdoutBytes, 'stdoutBytes') : null;
  const stderr = hasStderr ? nonnegativeInteger(cursors.stderrBytes, 'stderrBytes') : null;
  const timestamp = epoch(now, 'now');
  return control.transaction(database => {
    assertOptionalFencing(database, lease, timestamp);
    const current = requireProcess(database, attemptId);
    if (stdout !== null && stdout < Number(current.stdout_cursor_bytes)) fail('invalid_state_transition', 'stdout transcript cursor cannot move backwards.');
    if (stderr !== null && stderr < Number(current.stderr_cursor_bytes)) fail('invalid_state_transition', 'stderr transcript cursor cannot move backwards.');
    database.prepare(`UPDATE native_processes SET
      stdout_cursor_bytes = coalesce(?, stdout_cursor_bytes), stderr_cursor_bytes = coalesce(?, stderr_cursor_bytes), updated_at_ms = ?
      WHERE attempt_id = ?`).run(stdout, stderr, timestamp, attemptId);
    return getNativeProcessWith(database, attemptId);
  });
}

export function markProcessExited(control, attemptId, { exitCode = null, exitedAtMs = null } = {}, { lease = null, now = Date.now() } = {}) {
  nonempty(attemptId, 'attemptId');
  if (exitCode !== null && !Number.isInteger(exitCode)) fail('invalid_request', 'exitCode must be an integer or null.');
  const timestamp = epoch(now, 'now');
  const exitedAt = exitedAtMs === null ? timestamp : epoch(exitedAtMs, 'exitedAtMs');
  return control.transaction(database => {
    assertOptionalFencing(database, lease, timestamp);
    const current = requireProcess(database, attemptId);
    if (current.process_state === 'exited') return current;
    database.prepare(`UPDATE native_processes SET process_state = 'exited', exit_code = ?, exited_at_ms = ?,
      observed_at_ms = ?, updated_at_ms = ? WHERE attempt_id = ?`)
      .run(exitCode, exitedAt, timestamp, timestamp, attemptId);
    return getNativeProcessWith(database, attemptId);
  });
}

export function markProcessUnknown(control, attemptId, { lease = null, now = Date.now() } = {}) {
  nonempty(attemptId, 'attemptId');
  const timestamp = epoch(now, 'now');
  return control.transaction(database => {
    assertOptionalFencing(database, lease, timestamp);
    const current = requireProcess(database, attemptId);
    if (current.process_state === 'exited' || current.workspace_guard_state === 'released') {
      fail('invalid_state_transition', 'A completed native process cannot be changed back to unknown.');
    }
    database.prepare(`UPDATE native_processes SET process_state = 'unknown', workspace_guard_state = 'unknown',
      observed_at_ms = ?, updated_at_ms = ? WHERE attempt_id = ?`)
      .run(timestamp, timestamp, attemptId);
    return getNativeProcessWith(database, attemptId);
  });
}

// Guard release is deliberately separate from process exit. Gate B will call
// this only after root-process identity and descendant quiescence are proven.
export function releaseWorkspaceGuard(control, attemptId, { lease = null, quiescenceProven = false, now = Date.now() } = {}) {
  nonempty(attemptId, 'attemptId');
  if (quiescenceProven !== true) {
    fail('invalid_state_transition', 'Workspace guard release requires proven descendant quiescence.');
  }
  const timestamp = epoch(now, 'now');
  return control.transaction(database => {
    assertOptionalFencing(database, lease, timestamp);
    const current = requireProcess(database, attemptId);
    if (current.process_state !== 'exited') fail('invalid_state_transition', 'Workspace guard cannot be released before native process exit is established.');
    if (current.workspace_guard_state === 'released') return current;
    database.prepare("UPDATE native_processes SET workspace_guard_state = 'released', updated_at_ms = ? WHERE attempt_id = ?")
      .run(timestamp, attemptId);
    return getNativeProcessWith(database, attemptId);
  });
}

export function getNativeProcess(control, attemptId) {
  nonempty(attemptId, 'attemptId');
  return getNativeProcessWith(control.raw, attemptId);
}

export function listGuardedProcesses(control) {
  return control.raw.prepare("SELECT * FROM native_processes WHERE workspace_guard_state != 'released' ORDER BY id").all().map(projectProcess);
}

// Gate B housekeeping deliberately does not use a dead Worker's fencing
// token. Instead it compares every persisted fact that could make previously
// collected process evidence stale before changing process/guard state.
export function compareAndSetProcessRefresh(control, expected, patch, { now = Date.now() } = {}) {
  if (!expected || !Number.isSafeInteger(Number(expected.id)) || Number(expected.id) <= 0) fail('invalid_request', 'expected native process row is required.');
  const processState = patch?.processState ?? expected.process_state;
  const guardState = patch?.workspaceGuardState ?? expected.workspace_guard_state;
  if (!['starting', 'running', 'exited', 'unknown'].includes(processState)) fail('invalid_request', 'processState is invalid.');
  if (!['held', 'released', 'unknown'].includes(guardState)) fail('invalid_request', 'workspaceGuardState is invalid.');
  if (expected.process_state === 'exited' && processState !== 'exited') {
    fail('invalid_state_transition', 'An exited native root process cannot return to a live state.');
  }
  if (expected.workspace_guard_state === 'released' && guardState !== 'released') {
    fail('invalid_state_transition', 'A released workspace guard cannot be reactivated.');
  }
  if (processState === 'running' && (expected.pid === null || expected.process_started_at_ms === null)) {
    fail('invalid_state_transition', 'A running native process requires persisted PID/start-time identity.');
  }
  if (guardState === 'released' && processState !== 'exited') {
    fail('invalid_state_transition', 'Workspace guard release requires an exited root process.');
  }
  const timestamp = Math.max(epoch(now, 'now'), Number(expected.updated_at_ms) + 1);
  const exitedAt = patch && Object.prototype.hasOwnProperty.call(patch, 'exitedAtMs')
    ? (patch.exitedAtMs === null ? null : epoch(patch.exitedAtMs, 'exitedAtMs'))
    : expected.exited_at_ms;

  return control.transaction(database => {
    const result = database.prepare(`UPDATE native_processes SET
      process_state = ?, workspace_guard_state = ?, exited_at_ms = ?, observed_at_ms = ?, updated_at_ms = ?
      WHERE id = ? AND attempt_id = ?
        AND pid IS ? AND process_started_at_ms IS ? AND executable_path = ?
        AND process_state = ? AND workspace_guard_state = ?
        AND observed_at_ms = ? AND exited_at_ms IS ?
        AND stdout_cursor_bytes = ? AND stderr_cursor_bytes = ? AND updated_at_ms = ?`)
      .run(processState, guardState, exitedAt, timestamp, timestamp,
        Number(expected.id), expected.attempt_id,
        expected.pid, expected.process_started_at_ms, expected.executable_path,
        expected.process_state, expected.workspace_guard_state,
        Number(expected.observed_at_ms), expected.exited_at_ms,
        Number(expected.stdout_cursor_bytes), Number(expected.stderr_cursor_bytes), Number(expected.updated_at_ms));
    return Number(result.changes) === 1 ? getNativeProcessWith(database, expected.attempt_id) : null;
  });
}

function requireProcess(database, attemptId) {
  const row = database.prepare('SELECT * FROM native_processes WHERE attempt_id = ?').get(attemptId);
  if (!row) fail('task_not_found', `No native process is recorded for Attempt ${attemptId}.`);
  return projectProcess(row);
}

function getNativeProcessWith(database, attemptId) {
  const row = database.prepare('SELECT * FROM native_processes WHERE attempt_id = ?').get(attemptId);
  return row ? projectProcess(row) : null;
}

function projectProcess(row) {
  return {
    ...row,
    id: Number(row.id),
    pid: row.pid === null ? null : Number(row.pid),
    process_started_at_ms: row.process_started_at_ms === null ? null : Number(row.process_started_at_ms),
    stdout_cursor_bytes: Number(row.stdout_cursor_bytes),
    stderr_cursor_bytes: Number(row.stderr_cursor_bytes),
    observed_at_ms: Number(row.observed_at_ms),
    exited_at_ms: row.exited_at_ms === null ? null : Number(row.exited_at_ms),
    created_at_ms: Number(row.created_at_ms),
    updated_at_ms: Number(row.updated_at_ms),
  };
}

function assertOptionalFencing(database, lease, now) {
  if (lease) assertFencing(database, lease, now);
}

function transcriptRelpath(value, label) {
  const input = nonempty(value, label);
  if (path.isAbsolute(input) || path.win32.isAbsolute(input) || path.posix.isAbsolute(input)) fail('invalid_request', `${label} must be task-relative.`);
  const normalized = path.posix.normalize(input.replaceAll('\\', '/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) fail('invalid_request', `${label} must stay inside the task directory.`);
  return normalized;
}

function absoluteFilePath(value, label) {
  const input = nonempty(value, label);
  if (!path.isAbsolute(input) && !path.win32.isAbsolute(input) && !path.posix.isAbsolute(input)) fail('invalid_request', `${label} must be absolute.`);
  return input;
}

function digest(value, label) {
  const input = nonempty(value, label);
  if (!SHA256.test(input)) fail('invalid_request', `${label} must be a SHA-256 hex digest.`);
  return input.toLowerCase();
}

function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('invalid_request', `${label} must be a non-empty string.`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('invalid_request', `${label} must be a positive safe integer.`);
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail('invalid_request', `${label} must be a non-negative safe integer.`);
  return value;
}

function epoch(value, label) {
  return nonnegativeInteger(value, label);
}

function sameExecutable(left, right) {
  const a = path.normalize(left);
  const b = path.normalize(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
