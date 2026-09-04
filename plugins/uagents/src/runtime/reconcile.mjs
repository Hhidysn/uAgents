import { fail } from '../protocol/errors.mjs';
import { captureArtifacts } from '../artifacts/capture.mjs';
import { taskDirectory } from '../store/task-files.mjs';
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
    let next = statusFromNativeEvent(snapshot);
    let event = snapshot;
    if (snapshot.model_reported !== undefined || snapshot.model_verification !== undefined) service.recordOutcome(taskId, {
      modelReported: snapshot.model_reported,
      modelVerified: snapshot.model_verified,
      modelVerification: snapshot.model_verification,
      lease: leases[0],
    });
    if (typeof snapshot.response === 'string') service.recordResponse(taskId, snapshot.response, snapshot.usage ?? null, leases[0]);
    if (next === 'succeeded') {
      const manifest = stored.request.expected_outputs.length ? captureArtifacts({
        workspace: stored.request.workspace,
        expectedOutputs: stored.request.expected_outputs,
        taskDirectory: taskDirectory(service.control.root, taskId),
      }) : { verified: true, artifacts: [] };
      if (!manifest.verified) {
        service.recordOutcome(taskId, { nativeOutcome: 'succeeded', objectiveVerdict: 'failed', lease: leases[0] });
        next = 'failed';
        event = { ...snapshot, error: 'output_verification_failed', artifacts: manifest.artifacts };
      } else service.recordOutcome(taskId, { nativeOutcome: 'succeeded', objectiveVerdict: 'succeeded', lease: leases[0] });
    } else if (next === 'failed' || next === 'cancelled') service.recordOutcome(taskId, { nativeOutcome: next, objectiveVerdict: next, lease: leases[0] });
    return service.transition(taskId, next, {
      attemptId: current.attempt.attempt_id,
      lease: leases[0],
      sameNativeIdentity: snapshot.same_native_identity === true,
      evidenceStrength: snapshot.evidence_strength ?? 1,
      event,
    });
  } finally {
    releaseLeases(service.control, leases);
  }
}
