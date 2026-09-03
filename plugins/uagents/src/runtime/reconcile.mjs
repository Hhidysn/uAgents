import { fail } from '../protocol/errors.mjs';
import { acquireExecutionLeases, releaseLeases } from './leases.mjs';
import { statusFromNativeEvent } from './state-machine.mjs';

export async function reconcileTask({ service, taskId, adapter, leaseOptions = {} }) {
  const current = service.status(taskId);
  if (!current.native) fail('reconcile_unsupported', 'Task has no persisted native identity.', { submission: current.attempt.submission });
  if (typeof adapter.reconcile !== 'function') fail('reconcile_unsupported', 'Adapter does not support native reconciliation.', { submission: current.attempt.submission });
  const stored = service.payload(taskId);
  const leases = acquireExecutionLeases(service.control, { target: current.target, workspace: stored.request.workspace, ...leaseOptions });
  try {
    const snapshot = await adapter.reconcile(current.native, { taskId, attemptId: current.attempt.attempt_id });
    const next = statusFromNativeEvent(snapshot);
    return service.transition(taskId, next, {
      attemptId: current.attempt.attempt_id,
      lease: leases[0],
      sameNativeIdentity: snapshot.same_native_identity === true,
      evidenceStrength: snapshot.evidence_strength ?? 1,
      event: snapshot,
    });
  } finally {
    releaseLeases(service.control, leases);
  }
}
