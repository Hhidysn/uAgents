import { fail } from '../protocol/errors.mjs';
import { canonicalWorkspacesOverlap } from './workspace-key.mjs';

export function assertWorkspaceExecutionAdmission(database, { workspaceCanonical, attemptId = null } = {}) {
  if (!workspaceCanonical) return true;
  const rows = database.prepare(`SELECT id, attempt_id, workspace_key, process_state, workspace_guard_state, pid
    FROM native_processes
    WHERE workspace_guard_state != 'released' AND workspace_key IS NOT NULL
    ORDER BY id`).all();
  const conflict = rows.find(row => row.attempt_id !== attemptId && canonicalWorkspacesOverlap(row.workspace_key, workspaceCanonical));
  if (!conflict) return true;

  const unknown = conflict.workspace_guard_state === 'unknown' || conflict.process_state === 'unknown' || conflict.process_state === 'starting';
  const code = unknown ? 'workspace_execution_unknown' : 'workspace_execution_active';
  fail(code, unknown
    ? 'An overlapping workspace may still be owned by an unresolved native execution.'
    : 'An overlapping workspace is still owned by a native execution.', {
    category: 'conflict', retryable: true, submission: 'not_sent',
    details: {
      guard_attempt_id: conflict.attempt_id,
      process_state: conflict.process_state,
      workspace_guard_state: conflict.workspace_guard_state,
    },
  });
}
