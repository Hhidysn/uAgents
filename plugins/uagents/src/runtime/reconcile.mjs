import { fail } from '../protocol/errors.mjs';
import { captureArtifacts } from '../artifacts/capture.mjs';
import { taskDirectory } from '../store/task-files.mjs';
import { persistCheckpoint } from './checkpoints.mjs';
import { acquireExecutionLeases, releaseLeases, renewLeases } from './leases.mjs';
import { getNativeProcess } from './native-processes.mjs';
import { statusFromNativeEvent, transitionState } from './state-machine.mjs';

// The TaskService status projection intentionally bounds its lifecycle scan.
// Reconcile must use the exact accepted checkpoint for this Attempt so an old
// lifecycle event cannot accidentally select a newer managed generation.
function acceptedCheckpoint(service, taskId, attemptId) {
  const row = service.control.raw.prepare(`
    SELECT payload_json
    FROM events
    WHERE task_id = ? AND attempt_id = ? AND type = 'dispatch.accepted'
    ORDER BY sequence DESC
    LIMIT 1
  `).get(taskId, attemptId);
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload_json);
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function managedLifecycleFromCheckpoint(checkpoint) {
  if (!checkpoint || !Object.prototype.hasOwnProperty.call(checkpoint, 'lifecycle')) return null;
  const lifecycle = checkpoint.lifecycle;
  if (!lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle)) {
    fail('managed_instance_identity_mismatch', 'The accepted checkpoint has an invalid managed lifecycle identity.', {
      category: 'target', retryable: true, submission: 'may_have_been_sent',
      details: { cause_code: 'lifecycle_identity_invalid' },
    });
  }
  return lifecycle;
}

function currentEvidence(service, taskId) {
  return Number(service.control.raw.prepare(`
    SELECT coalesce(max(json_extract(payload_json, '$.evidence_strength')), 0) AS strength
    FROM events WHERE task_id = ?
  `).get(taskId).strength);
}

export async function reconcileTask({ service, taskId, adapter, leaseOptions = {}, supervisor = null }) {
  const current = service.status(taskId);
  const durableProcess = current.attempt ? getNativeProcess(service.control, current.attempt.attempt_id) : null;
  if (!current.native && !durableProcess) fail('reconcile_unsupported', 'Task has no persisted native identity or durable process.', { submission: current.attempt.submission });
  if (typeof adapter.reconcile !== 'function') fail('reconcile_unsupported', 'Adapter does not support native reconciliation.', { submission: current.attempt.submission });
  const stored = service.payload(taskId);
  const leases = acquireExecutionLeases(service.control, {
    target: current.target,
    workspace: stored.request.workspace,
    ...leaseOptions,
    attemptId: current.attempt.attempt_id,
  });
  let hostLease = null;
  let managed = null;
  let renewTimer = null;
  let renewalError = null;
  try {
    const checkpoint = acceptedCheckpoint(service, taskId, current.attempt.attempt_id);
    const lifecycle = managedLifecycleFromCheckpoint(checkpoint);
    if (lifecycle) {
      if (checkpoint.target !== undefined && checkpoint.target !== current.target) {
        fail('managed_instance_identity_mismatch', 'The accepted checkpoint target does not match the task target.', {
          category: 'target', retryable: true, submission: 'may_have_been_sent',
          details: { cause_code: 'checkpoint_target_mismatch' },
        });
      }
      if (!supervisor || typeof supervisor.reconcile !== 'function') {
        fail('unsupported_capability', 'Managed reconciliation requires the host supervisor.', {
          category: 'policy', retryable: true, submission: 'may_have_been_sent',
          details: { cause_code: 'supervisor_unavailable' },
        });
      }
      const resolved = await supervisor.reconcile(current.target, lifecycle);
      // Capture the lease before validating the complete response. A
      // malformed supervisor response must not strand an acquired host lease.
      hostLease = resolved?.lease ?? null;
      if (!resolved || !resolved.lease || !resolved.managed) {
        fail('managed_instance_identity_mismatch', 'The host supervisor returned no verified managed context.', {
          category: 'target', retryable: true, submission: 'may_have_been_sent',
          details: { cause_code: 'managed_context_missing' },
        });
      }
      managed = resolved.managed;
    }

    const leaseTtlMs = leaseOptions.ttlMs ?? 30_000;
    const heartbeatIntervalMs = leaseOptions.heartbeatIntervalMs ?? Math.max(100, Math.floor(leaseTtlMs / 3));
    renewTimer = setInterval(() => {
      if (renewalError) return;
      try {
        const renewed = renewLeases(service.control, leases, { ttlMs: leaseTtlMs });
        leases.splice(0, leases.length, ...renewed);
        if (hostLease && supervisor && typeof supervisor.renewInstanceLease === 'function') {
          hostLease = supervisor.renewInstanceLease(hostLease, { ttlMs: leaseTtlMs });
        }
      } catch (error) {
        renewalError = error;
      }
    }, heartbeatIntervalMs);
    renewTimer.unref?.();

    // Preserve the native identity from the database. The accepted handle is
    // only used for Doubao's message cursor, which is not a secret and was not
    // part of the native_sessions schema in older stores.
    const acceptedHandle = checkpoint?.handle;
    const native = Number.isInteger(acceptedHandle?.user_message_index)
      ? { ...current.native, user_message_index: acceptedHandle.user_message_index }
      : current.native;
    const dispatchCheckpoint = (kind, payload = {}) => persistCheckpoint(service.control, {
      taskId,
      attemptId: current.attempt.attempt_id,
      lease: leases[0],
      kind,
      payload: { target: current.target, ...payload },
    });
    const request = { ...stored.request, prompt: stored.payload.prompt };
    const snapshot = await adapter.reconcile(native, {
      taskId,
      attemptId: current.attempt.attempt_id,
      control: service.control,
      lease: leases[0],
      taskDirectory: taskDirectory(service.control.root, taskId),
      request,
      session: stored.payload.session ?? stored.payload.continuation ?? null,
      checkpoint: dispatchCheckpoint,
      nativeProcess: durableProcess,
      processInspector: leaseOptions.processInspector ?? null,
      signal: leaseOptions.signal ?? null,
      isCancelRequested: () => service.status(taskId).cancel_requested,
      submission: current.attempt.submission,
      ...(managed ? { managed } : {}),
    });
    if (renewalError) throw renewalError;
    // Durable transcript replay can discover the first native identity and
    // persist accepted while reconcile is in flight. Re-read the Task before
    // validating the resulting transition so starting -> accepted(running) ->
    // terminal is checked against the actual persisted state.
    const observedCurrent = service.status(taskId);
    let next = statusFromNativeEvent(snapshot);
    let event = snapshot;
    const previousEvidence = currentEvidence(service, taskId);
    const observedEvidence = snapshot.evidence_strength ?? 1;
    // A confirmed terminal observation is stronger than an earlier unknown
    // result or approval wait. Unverified/foreign observations cannot acquire
    // that strength merely by being returned from reconcile.
    const transitionEvidence = observedCurrent.status === 'indeterminate' &&
      snapshot.same_native_identity === true && observedEvidence >= 2 &&
      ['succeeded', 'failed', 'cancelled'].includes(next)
      ? Math.max(observedEvidence, previousEvidence + 1)
      : observedEvidence;
    // Validate before writing response/model files: a rejected observation
    // must not overwrite the last trusted result.
    transitionState({ status: observedCurrent.status, evidence_strength: previousEvidence }, next, {
      same_native_identity: snapshot.same_native_identity === true,
      evidence_strength: transitionEvidence,
    });
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
      evidenceStrength: transitionEvidence,
      event,
    });
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    if (hostLease && supervisor && typeof supervisor.releaseInstanceLease === 'function') {
      try { supervisor.releaseInstanceLease(hostLease); } catch {}
    }
    releaseLeases(service.control, leases);
  }
}
