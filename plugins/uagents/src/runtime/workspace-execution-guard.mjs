import { createProcessInspector, classifyPersistedProcess } from '../host/process-inspector.mjs';
import { canonicalWorkspace, canonicalWorkspacesOverlap } from './workspace-key.mjs';
import { compareAndSetProcessRefresh, getNativeProcess, listGuardedProcesses } from './native-processes.mjs';

function listOverlappingWorkspaceGuards(control, { workspace, attemptId = null } = {}) {
  if (!workspace) return [];
  const canonical = canonicalWorkspace(workspace);
  return listGuardedProcesses(control).filter(row =>
    row.attempt_id !== attemptId && row.workspace_key && canonicalWorkspacesOverlap(row.workspace_key, canonical));
}

export async function refreshOverlappingWorkspaceGuards(control, {
  workspace,
  attemptId = null,
  inspector = null,
  now = Date.now(),
} = {}) {
  const rows = listOverlappingWorkspaceGuards(control, { workspace, attemptId });
  if (!rows.length) return [];
  const resolvedInspector = inspector ?? (process.platform === 'win32' ? createProcessInspector() : null);
  if (!resolvedInspector) return rows;
  const results = [];
  for (const row of rows) results.push(await refreshWorkspaceExecutionGuard(control, row.attempt_id, { inspector: resolvedInspector, now }));
  return results;
}

export async function refreshWorkspaceExecutionGuard(control, attemptId, { inspector, now = Date.now() } = {}) {
  let current = getNativeProcess(control, attemptId);
  if (!current || current.workspace_guard_state === 'released') return current;

  const resolvedInspector = inspector ?? (process.platform === 'win32' ? createProcessInspector() : null);

  if (current.process_state === 'exited') {
    if (!resolvedInspector || current.pid === null || current.process_started_at_ms === null) {
      return compareAndSetProcessRefresh(control, current, {
        processState: 'exited', workspaceGuardState: 'unknown', exitedAtMs: current.exited_at_ms,
      }, { now }) ?? getNativeProcess(control, attemptId);
    }
    return refreshExitedRootGuard(control, current, resolvedInspector, now);
  }

  if (current.pid === null || current.process_started_at_ms === null) {
    return compareAndSetProcessRefresh(control, current, {
      processState: 'unknown', workspaceGuardState: 'unknown',
    }, { now }) ?? getNativeProcess(control, attemptId);
  }

  if (!resolvedInspector) {
    return compareAndSetProcessRefresh(control, current, {
      processState: 'unknown', workspaceGuardState: 'unknown',
    }, { now }) ?? getNativeProcess(control, attemptId);
  }

  const inspection = await resolvedInspector.inspectProcess({ pid: current.pid });
  const classification = classifyPersistedProcess(current, inspection);
  if (classification.kind === 'alive_same_identity') {
    if (current.process_state === 'running' && current.workspace_guard_state === 'held') return current;
    return compareAndSetProcessRefresh(control, current, {
      processState: 'running', workspaceGuardState: 'held', exitedAtMs: null,
    }, { now }) ?? getNativeProcess(control, attemptId);
  }
  if (classification.kind === 'identity_mismatch_unknown' || classification.kind === 'inspection_unknown') {
    return compareAndSetProcessRefresh(control, current, {
      processState: 'unknown', workspaceGuardState: 'unknown',
    }, { now }) ?? getNativeProcess(control, attemptId);
  }

  if (classification.kind !== 'dead' && classification.kind !== 'old_identity_dead_pid_reused') return current;
  const exitedAtMs = Math.max(Number(now), Number(current.observed_at_ms));
  current = compareAndSetProcessRefresh(control, current, {
    processState: 'exited', workspaceGuardState: 'held', exitedAtMs,
  }, { now }) ?? getNativeProcess(control, attemptId);
  if (!current || current.workspace_guard_state === 'released' || current.process_state !== 'exited') return current;

  return refreshExitedRootGuard(control, current, resolvedInspector, Number(now) + 1);
}

async function refreshExitedRootGuard(control, current, inspector, now) {
  const tree = await inspector.inspectProcessTree({ rootPid: current.pid, rootStartedAtMs: current.process_started_at_ms });
  if (tree.kind === 'quiescent') {
    return compareAndSetProcessRefresh(control, current, {
      processState: 'exited', workspaceGuardState: 'released', exitedAtMs: current.exited_at_ms,
    }, { now }) ?? getNativeProcess(control, current.attempt_id);
  }
  if (tree.kind === 'inspection_failed') {
    return compareAndSetProcessRefresh(control, current, {
      processState: 'exited', workspaceGuardState: 'unknown', exitedAtMs: current.exited_at_ms,
    }, { now }) ?? getNativeProcess(control, current.attempt_id);
  }
  return current;
}
