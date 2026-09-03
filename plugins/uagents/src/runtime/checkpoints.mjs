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
      if (attempt.submission !== 'may_have_been_sent') fail('invalid_state_transition', 'accepted requires a persisted possibly_sent checkpoint.');
      const handle = payload.handle ?? {};
      database.prepare('UPDATE attempts SET submission = ?, status = ? WHERE attempt_id = ?').run('sent', 'running', attemptId);
      database.prepare(`INSERT INTO native_sessions(attempt_id, target, native_session_id, native_task_id, native_status, evidence_ref)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(attemptId, payload.target, handle.session_id ?? null, handle.task_id ?? null, handle.status ?? 'accepted', payload.evidence_ref ?? null);
      database.prepare('UPDATE tasks SET status = ?, updated_at_ms = ? WHERE task_id = ?').run('running', now, taskId);
    } else {
      fail('invalid_checkpoint', `Unsupported dispatch checkpoint: ${kind}`);
    }
    const sequence = appendEvent(database, { taskId, attemptId, type: `dispatch.${kind}`, payload, now });
    return { kind, sequence };
  });
}
