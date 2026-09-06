import { fail } from '../protocol/errors.mjs';
import { appendEvent } from '../store/database.mjs';
import { assertFencing } from './leases.mjs';

export function persistCheckpoint(control, { taskId, attemptId, lease, kind, payload = {}, now = Date.now() }) {
  return control.transaction(database => {
    if (lease) assertFencing(database, lease, now);
    const attempt = database.prepare('SELECT * FROM attempts WHERE attempt_id = ? AND task_id = ?').get(attemptId, taskId);
    if (!attempt) fail('task_not_found', 'Attempt does not belong to the task.');
    if (kind === 'possibly_sent') {
      if (attempt.submission !== 'not_sent') fail('invalid_state_transition', 'possibly_sent checkpoint can only be recorded once.');
      database.prepare('UPDATE attempts SET submission = ?, status = ?, started_at_ms = coalesce(started_at_ms, ?) WHERE attempt_id = ?')
        .run('may_have_been_sent', 'dispatching', now, attemptId);
    } else if (kind === 'accepted') {
      const handle = payload.handle ?? {};
      const identity = acceptedIdentity(payload.target, handle);
      const task = database.prepare('SELECT target, status FROM tasks WHERE task_id = ?').get(taskId);
      if (!task) fail('task_not_found', `Unknown task: ${taskId}`);
      if (identity.target !== task.target) {
        fail('native_session_mismatch', 'Accepted native target does not match the Task target.', {
          category: 'transport', submission: attempt.submission,
        });
      }
      const existingRows = database.prepare(`SELECT * FROM native_sessions
        WHERE attempt_id = ? ORDER BY id ASC`).all(attemptId);
      const existing = existingRows[0] ?? null;

      if (attempt.submission === 'sent') {
        if (existingRows.length !== 1 || !existing || !sameAcceptedIdentity(existing, identity)) {
          fail('native_session_mismatch', 'Replayed accepted checkpoint does not match the persisted native identity.', {
            category: 'transport', submission: 'sent',
          });
        }
        const acceptedEvent = database.prepare(`SELECT sequence FROM events
          WHERE task_id = ? AND attempt_id = ? AND type = 'dispatch.accepted'
          ORDER BY sequence ASC LIMIT 1`).get(taskId, attemptId);
        if (!acceptedEvent) fail('invalid_state_transition', 'Persisted native identity has no accepted checkpoint event.');
        return { kind, sequence: Number(acceptedEvent.sequence), replayed: true };
      }

      if (attempt.submission !== 'may_have_been_sent') {
        fail('invalid_state_transition', 'accepted requires a persisted possibly_sent checkpoint.');
      }
      if (existing) {
        fail('native_session_mismatch', 'A native identity already exists before the first accepted checkpoint.', {
          category: 'transport', submission: 'may_have_been_sent',
        });
      }

      database.prepare('UPDATE attempts SET submission = ?, status = ? WHERE attempt_id = ?').run('sent', 'running', attemptId);
      database.prepare(`INSERT INTO native_sessions(attempt_id, target, native_session_id, native_task_id, native_status, evidence_ref)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(attemptId, identity.target, identity.sessionId, identity.taskId, handle.status ?? 'accepted', payload.evidence_ref ?? null);
      if (task?.status === 'starting') {
        database.prepare('UPDATE tasks SET status = ?, updated_at_ms = ? WHERE task_id = ?').run('running', now, taskId);
      }
    } else {
      fail('invalid_checkpoint', `Unsupported dispatch checkpoint: ${kind}`);
    }
    const sequence = appendEvent(database, { taskId, attemptId, type: `dispatch.${kind}`, payload, now });
    return { kind, sequence };
  });
}

function acceptedIdentity(target, handle) {
  if (typeof target !== 'string' || !target) {
    fail('invalid_checkpoint', 'accepted checkpoint requires a target.');
  }
  const sessionId = handle?.session_id ?? null;
  const taskId = handle?.task_id ?? null;
  if (sessionId !== null && (typeof sessionId !== 'string' || !sessionId)) {
    fail('invalid_checkpoint', 'accepted native session_id must be a non-empty string or null.');
  }
  if (taskId !== null && (typeof taskId !== 'string' || !taskId)) {
    fail('invalid_checkpoint', 'accepted native task_id must be a non-empty string or null.');
  }
  if (sessionId === null && taskId === null) {
    fail('invalid_checkpoint', 'accepted checkpoint requires a native session_id or task_id.');
  }
  return { target, sessionId, taskId };
}

function sameAcceptedIdentity(row, identity) {
  return row.target === identity.target &&
    (row.native_session_id ?? null) === identity.sessionId &&
    (row.native_task_id ?? null) === identity.taskId;
}
