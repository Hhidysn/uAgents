import { fail } from '../protocol/errors.mjs';
import { captureArtifacts } from '../artifacts/capture.mjs';
import { taskDirectory } from '../store/task-files.mjs';
import { persistCheckpoint } from './checkpoints.mjs';
import { verifyInputSnapshots } from './effective-request.mjs';
import { acquireExecutionLeases, releaseLeases, renewLeases } from './leases.mjs';
import { statusFromNativeEvent, TERMINAL_STATES } from './state-machine.mjs';

export async function runTask({ service, taskId, adapter, leaseOptions = {}, supervisor = null }) {
  let status = service.status(taskId);
  if (status.status !== 'registered' && status.status !== 'queued') fail('invalid_state_transition', `Task cannot be dispatched from ${status.status}.`);
  const attemptId = status.attempt.attempt_id;
  if (status.status === 'registered') status = service.transition(taskId, 'queued', { attemptId });
  const stored = service.payload(taskId);
  const request = { ...stored.request, prompt: stored.payload.prompt };
  const leases = acquireExecutionLeases(service.control, { target: request.target, workspace: request.workspace, ...leaseOptions });
  const fencingLease = leases[0];
  const leaseTtlMs = leaseOptions.ttlMs ?? 30_000;
  const heartbeatIntervalMs = leaseOptions.heartbeatIntervalMs ?? Math.max(100, Math.floor(leaseTtlMs / 3));
  let heartbeatError = null;
  let heartbeat;
  let hostLease = null;
  service.control.transaction(database => {
    database.prepare('UPDATE attempts SET owner_nonce = ?, fencing_token = ? WHERE attempt_id = ?')
      .run(fencingLease.owner_nonce, fencingLease.fencing_token, attemptId);
  });
  service.heartbeat(attemptId, fencingLease);
  heartbeat = setInterval(() => {
    if (heartbeatError) return;
    try {
      const renewed = renewLeases(service.control, leases, { ttlMs: leaseTtlMs });
      leases.splice(0, leases.length, ...renewed);
      if (hostLease && supervisor) hostLease = supervisor.renewInstanceLease(hostLease, { ttlMs: leaseTtlMs });
      service.heartbeat(attemptId, leases[0]);
    } catch (error) { heartbeatError = error; }
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  try {
    service.transition(taskId, 'starting', { attemptId, lease: fencingLease });
    verifyInputSnapshots(request.workspace, stored.payload.input_snapshots);
    // Managed lifecycle: after `starting`, before any adapter work. Desktop
    // targets hold the Host instance lease for the whole dispatch/observe
    // cycle; CLI targets only resolve and cache a verified entry.
    let verifiedEntry = null;
    if (supervisor) {
      const ensured = await supervisor.ensure(request.target, { workspace: request.workspace });
      if (ensured && ensured.mode !== 'cli' && ensured.lease) hostLease = ensured.lease;
      if (ensured?.installation) verifiedEntry = ensured.installation;
    }
    const adapterContext = {
      taskId,
      attemptId,
      signal: leaseOptions.signal,
      taskDirectory: taskDirectory(service.control.root, taskId),
      isCancelRequested: () => service.status(taskId).cancel_requested,
      verifiedEntry,
    };
    const prepared = await adapter.prepare(request, adapterContext);
    const checkpoint = (kind, payload = {}) => persistCheckpoint(service.control, {
      taskId, attemptId, lease: fencingLease, kind, payload: { target: request.target, ...payload },
    });
    let submission;
    try {
      submission = await adapter.dispatch(prepared, { ...adapterContext, checkpoint });
    } catch (error) {
      const latest = service.status(taskId);
      const next = latest.cancel_requested && latest.attempt.submission === 'not_sent' ? 'cancelled'
        : latest.attempt.submission === 'not_sent' ? 'failed' : 'indeterminate';
      service.transition(taskId, next, { attemptId, lease: fencingLease, event: { error: error.code ?? 'dispatch_failed' } });
      return service.status(taskId);
    }
    const afterDispatch = service.status(taskId);
    if (afterDispatch.attempt.submission !== 'sent' || !afterDispatch.native) {
      service.transition(taskId, 'indeterminate', { attemptId, lease: fencingLease, event: { error: 'native_acceptance_unconfirmed' } });
      return service.status(taskId);
    }

    let sawEvent = false;
    for await (const event of adapter.observe(submission.handle ?? submission, adapterContext)) {
      if (heartbeatError) throw heartbeatError;
      sawEvent = true;
      const current = service.status(taskId);
      if (current.cancel_requested) return await finishCancellation({ service, adapter, taskId, attemptId, lease: fencingLease, handle: submission.handle ?? submission });
      let next = statusFromNativeEvent(event);
      let recordedEvent = event;
      if (event.model_reported !== undefined || event.model_verification !== undefined) service.recordOutcome(taskId, {
        modelReported: event.model_reported,
        modelVerified: event.model_verified,
        modelVerification: event.model_verification,
        lease: fencingLease,
      });
      if (typeof event.response === 'string') service.recordResponse(taskId, event.response, event.usage ?? null, fencingLease);
      if (next === 'succeeded') {
        const manifest = request.expected_outputs.length ? captureArtifacts({
          workspace: request.workspace,
          expectedOutputs: request.expected_outputs,
          taskDirectory: taskDirectory(service.control.root, taskId),
        }) : { verified: true, artifacts: [] };
        if (!manifest.verified) {
          service.recordOutcome(taskId, { nativeOutcome: 'succeeded', objectiveVerdict: 'failed', lease: fencingLease });
          next = 'failed';
          recordedEvent = { ...event, error: 'output_verification_failed', artifacts: manifest.artifacts };
        } else service.recordOutcome(taskId, { nativeOutcome: 'succeeded', objectiveVerdict: 'succeeded', lease: fencingLease });
      } else if (next === 'failed' || next === 'cancelled') service.recordOutcome(taskId, { nativeOutcome: next, objectiveVerdict: next, lease: fencingLease });
      service.transition(taskId, next, { attemptId, lease: fencingLease, evidenceStrength: event.evidence_strength ?? 1, sameNativeIdentity: event.same_native_identity === true, event: recordedEvent });
      if (TERMINAL_STATES.has(next) || next === 'waiting_user') return service.status(taskId);
    }
    const latest = service.status(taskId);
    if (!TERMINAL_STATES.has(latest.status) && latest.status !== 'waiting_user') {
      service.transition(taskId, 'indeterminate', { attemptId, lease: fencingLease, event: { error: sawEvent ? 'native_terminal_missing' : 'native_stream_empty' } });
    }
    return service.status(taskId);
  } catch (error) {
    const latest = service.status(taskId);
    if (!TERMINAL_STATES.has(latest.status)) {
      const next = latest.attempt.submission === 'not_sent' ? 'failed' : 'indeterminate';
      try { service.transition(taskId, next, { attemptId, lease: fencingLease, event: { error: error.code ?? 'worker_failed' } }); } catch {}
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    releaseLeases(service.control, leases);
    if (hostLease && supervisor) {
      try { supervisor.releaseInstanceLease(hostLease); } catch {}
    }
  }
}

async function finishCancellation({ service, adapter, taskId, attemptId, lease, handle }) {
  if (typeof adapter.cancel !== 'function') {
    service.transition(taskId, 'indeterminate', { attemptId, lease, event: { error: 'cancel_remote_state_unknown' } });
    return service.status(taskId);
  }
  const result = await adapter.cancel(handle, { taskId, attemptId });
  const next = result?.confirmed === true ? 'cancelled' : 'indeterminate';
  service.transition(taskId, next, { attemptId, lease, event: { cancel: result ?? null } });
  return service.status(taskId);
}
