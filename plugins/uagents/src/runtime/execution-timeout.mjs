import { createProcessTerminator } from '../host/process-terminator.mjs';
import { appendEvent } from '../store/database.mjs';
import {
  getNativeProcess,
  markProcessExited,
  markProcessUnknown,
  releaseWorkspaceGuard,
} from './native-processes.mjs';

export function executionDeadlineAt(control, attemptId, executionTimeoutMs) {
  if (executionTimeoutMs === null || executionTimeoutMs === undefined) return null;
  const timeout = Number(executionTimeoutMs);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) return null;
  const row = control?.raw?.prepare?.(`SELECT created_at_ms FROM events
    WHERE attempt_id = ? AND type = 'dispatch.possibly_sent'
    ORDER BY sequence ASC LIMIT 1`).get(attemptId);
  if (!row || !Number.isSafeInteger(Number(row.created_at_ms))) return null;
  return Number(row.created_at_ms) + timeout;
}

export function executionTimeoutEvidence(control, attemptId) {
  const row = control?.raw?.prepare?.(`SELECT payload_json, created_at_ms FROM events
    WHERE attempt_id = ? AND type = 'execution.timeout'
    ORDER BY sequence DESC LIMIT 1`).get(attemptId);
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload_json);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return { ...payload, created_at_ms: Number(row.created_at_ms) };
  } catch {
    return null;
  }
}

export function executionTimeoutStartedEvidence(control, attemptId) {
  return eventEvidence(control, attemptId, 'execution.timeout_started');
}

export function executionTimeoutGuardianReadyEvidence(control, attemptId) {
  return eventEvidence(control, attemptId, 'execution.timeout_guardian_ready');
}

export function executionTimeoutClearedEvidence(control, attemptId) {
  return eventEvidence(control, attemptId, 'execution.timeout_cleared');
}

export function executionTimeoutPending(control, attemptId) {
  const started = executionTimeoutStartedEvidence(control, attemptId);
  if (!started) return null;
  if (executionTimeoutEvidence(control, attemptId) || executionTimeoutClearedEvidence(control, attemptId)) return null;
  return started;
}

export function recordExecutionTimeoutStarted(control, attemptId, { now = Date.now() } = {}) {
  return recordControlEvidence(control, attemptId, 'execution.timeout_started', { phase: 'termination_started' }, Number(now));
}

export function recordExecutionTimeoutGuardianReady(control, attemptId, { now = Date.now() } = {}) {
  return recordControlEvidence(control, attemptId, 'execution.timeout_guardian_ready', { phase: 'ready' }, Number(now));
}

export function recordExecutionTimeoutCleared(control, attemptId, { reason = 'process_already_exited', now = Date.now() } = {}) {
  return recordControlEvidence(control, attemptId, 'execution.timeout_cleared', { reason }, Number(now));
}

export function recordExecutionTimeoutEvidence(control, attemptId, {
  terminationConfirmed,
  reason = null,
  now = Date.now(),
} = {}) {
  const timestamp = Number(now);
  return control.transaction(database => {
    const attempt = database.prepare('SELECT task_id FROM attempts WHERE attempt_id = ?').get(attemptId);
    if (!attempt) return null;
    const existing = database.prepare(`SELECT payload_json, created_at_ms FROM events
      WHERE attempt_id = ? AND type = 'execution.timeout'
      ORDER BY sequence ASC LIMIT 1`).get(attemptId);
    if (existing) {
      try { return { ...JSON.parse(existing.payload_json), created_at_ms: Number(existing.created_at_ms), replayed: true }; }
      catch { return null; }
    }
    const payload = {
      termination_confirmed: terminationConfirmed === true,
      reason: typeof reason === 'string' && reason ? reason : null,
    };
    appendEvent(database, {
      taskId: attempt.task_id,
      attemptId,
      type: 'execution.timeout',
      payload,
      now: timestamp,
    });
    return { ...payload, created_at_ms: timestamp, replayed: false };
  });
}

function eventEvidence(control, attemptId, type) {
  const row = control?.raw?.prepare?.(`SELECT payload_json, created_at_ms FROM events
    WHERE attempt_id = ? AND type = ? ORDER BY sequence DESC LIMIT 1`).get(attemptId, type);
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload_json);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return { ...payload, created_at_ms: Number(row.created_at_ms) };
  } catch { return null; }
}

function recordControlEvidence(control, attemptId, type, payload, now) {
  return control.transaction(database => {
    const attempt = database.prepare('SELECT task_id FROM attempts WHERE attempt_id = ?').get(attemptId);
    if (!attempt) return null;
    const existing = database.prepare(`SELECT payload_json, created_at_ms FROM events
      WHERE attempt_id = ? AND type = ? ORDER BY sequence ASC LIMIT 1`).get(attemptId, type);
    if (existing) {
      try { return { ...JSON.parse(existing.payload_json), created_at_ms: Number(existing.created_at_ms), replayed: true }; }
      catch { return null; }
    }
    appendEvent(database, { taskId: attempt.task_id, attemptId, type, payload, now });
    return { ...payload, created_at_ms: now, replayed: false };
  });
}

export async function enforceExecutionTimeout({
  control,
  attemptId,
  inspector,
  terminator = null,
  lease = null,
  now = Date.now,
} = {}) {
  const record = getNativeProcess(control, attemptId);
  const resolved = terminator ?? createProcessTerminator({ inspector });
  const result = await resolved.terminateOwnedProcessTree(record);
  const timestamp = Number(now());

  if (result?.kind === 'already_exited') {
    markProcessExited(control, attemptId, { exitCode: record.exit_code, exitedAtMs: timestamp }, { lease, now: timestamp });
    releaseWorkspaceGuard(control, attemptId, { lease, quiescenceProven: true, now: timestamp + 1 });
    return {
      timed_out: false,
      already_exited: true,
      termination_confirmed: true,
      reason: result.reason,
      process: getNativeProcess(control, attemptId),
    };
  }

  if (result?.kind === 'terminated') {
    recordExecutionTimeoutEvidence(control, attemptId, {
      terminationConfirmed: true,
      reason: result.reason ?? 'owned_process_tree_quiescent',
      now: timestamp,
    });
    markProcessExited(control, attemptId, { exitCode: null, exitedAtMs: timestamp }, { lease, now: timestamp });
    releaseWorkspaceGuard(control, attemptId, { lease, quiescenceProven: true, now: timestamp + 1 });
    return {
      timed_out: true,
      termination_confirmed: true,
      error: 'execution_timeout',
      reason: result.reason,
      process: getNativeProcess(control, attemptId),
    };
  }

  recordExecutionTimeoutEvidence(control, attemptId, {
    terminationConfirmed: false,
    reason: result?.reason ?? 'termination_not_confirmed',
    now: timestamp,
  });
  try {
    const current = getNativeProcess(control, attemptId);
    if (current.process_state !== 'exited' && current.workspace_guard_state !== 'released') {
      markProcessUnknown(control, attemptId, { lease, now: timestamp });
    }
  } catch {}
  return {
    timed_out: true,
    termination_confirmed: false,
    error: 'execution_timeout_termination_unconfirmed',
    reason: result?.reason ?? 'termination_not_confirmed',
    process: getNativeProcess(control, attemptId),
  };
}
