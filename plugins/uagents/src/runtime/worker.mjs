import { fail } from '../protocol/errors.mjs';
import { persistCheckpoint } from './checkpoints.mjs';
import { verifyInputSnapshots } from './effective-request.mjs';
import { acquireExecutionLeases, releaseLeases } from './leases.mjs';
import { statusFromNativeEvent, TERMINAL_STATES } from './state-machine.mjs';

export async function runTask({ service, taskId, adapter, leaseOptions = {} }) {
  let status = service.status(taskId);
  if (status.status !== 'registered' && status.status !== 'queued') fail('invalid_state_transition', `Task cannot be dispatched from ${status.status}.`);
  const attemptId = status.attempt.attempt_id;
  if (status.status === 'registered') status = service.transition(taskId, 'queued', { attemptId });
  const stored = service.payload(taskId);
  const request = { ...stored.request, prompt: stored.payload.prompt };
  const leases = acquireExecutionLeases(service.control, { target: request.target, workspace: request.workspace, ...leaseOptions });
  const fencingLease = leases[0];
  service.control.transaction(database => {
    database.prepare('UPDATE attempts SET owner_nonce = ?, fencing_token = ? WHERE attempt_id = ?')
      .run(fencingLease.owner_nonce, fencingLease.fencing_token, attemptId);
  });

  try {
    service.transition(taskId, 'starting', { attemptId, lease: fencingLease });
    verifyInputSnapshots(request.workspace, stored.payload.input_snapshots);
    const prepared = await adapter.prepare(request, { taskId, attemptId, signal: leaseOptions.signal });
    const checkpoint = async (kind, payload = {}) => persistCheckpoint(service.control, {
      taskId, attemptId, lease: fencingLease, kind, payload: { target: request.target, ...payload },
    });
    let submission;
    try {
      submission = await adapter.dispatch(prepared, { taskId, attemptId, signal: leaseOptions.signal, checkpoint });
    } catch (error) {
      const latest = service.status(taskId);
      const next = latest.attempt.submission === 'not_sent' ? 'failed' : 'indeterminate';
      service.transition(taskId, next, { attemptId, lease: fencingLease, event: { error: error.code ?? 'dispatch_failed' } });
      return service.status(taskId);
    }
    const afterDispatch = service.status(taskId);
    if (afterDispatch.attempt.submission !== 'sent' || !afterDispatch.native) {
      service.transition(taskId, 'indeterminate', { attemptId, lease: fencingLease, event: { error: 'native_acceptance_unconfirmed' } });
      return service.status(taskId);
    }

    let sawEvent = false;
    for await (const event of adapter.observe(submission.handle ?? submission, { taskId, attemptId, signal: leaseOptions.signal })) {
      sawEvent = true;
      const current = service.status(taskId);
      if (current.cancel_requested) return await finishCancellation({ service, adapter, taskId, attemptId, lease: fencingLease, handle: submission.handle ?? submission });
      const next = statusFromNativeEvent(event);
      service.transition(taskId, next, { attemptId, lease: fencingLease, evidenceStrength: event.evidence_strength ?? 1, sameNativeIdentity: event.same_native_identity === true, event });
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
    releaseLeases(service.control, leases);
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
