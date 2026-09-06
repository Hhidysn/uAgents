import { randomUUID } from 'node:crypto';
import { advisoryPrompt } from '../policy/advisory.mjs';
import { fail } from '../protocol/errors.mjs';
import { captureArtifacts } from '../artifacts/capture.mjs';
import { taskDirectory } from '../store/task-files.mjs';
import { persistCheckpoint } from './checkpoints.mjs';
import { verifyInputSnapshots } from './effective-request.mjs';
import { acquireExecutionLeases, acquireTaskLease, releaseLeases, renewLeases } from './leases.mjs';
import { refreshOverlappingWorkspaceGuards } from './workspace-execution-guard.mjs';
import { getNativeProcess } from './native-processes.mjs';
import { statusFromNativeEvent, TERMINAL_STATES } from './state-machine.mjs';

export async function runTask({ service, taskId, adapter, leaseOptions = {}, supervisor = null }) {
  let status = service.status(taskId);
  if (status.status !== 'registered' && status.status !== 'queued') {
    // A duplicate worker may observe the owner after it has moved the task to
    // starting, or may start after the task reached a terminal state.  Both
    // cases are safe no-ops; only waiting_user/indeterminate are rejected so
    // callers cannot accidentally turn an observation state into dispatch.
    if ((status.status === 'starting' && status.attempt?.submission === 'not_sent' && !status.native) || TERMINAL_STATES.has(status.status)) return status;
    fail('invalid_state_transition', `Task cannot be dispatched from ${status.status}.`);
  }
  const attemptId = status.attempt.attempt_id;
  if (getNativeProcess(service.control, attemptId)) {
    fail('invalid_state_transition', 'This Attempt already has a durable native process record and cannot enter fresh dispatch.', {
      category: 'conflict', submission: status.attempt.submission ?? 'not_sent',
    });
  }
  if (status.status === 'registered') status = service.transition(taskId, 'queued', { attemptId });
  const stored = service.payload(taskId);
  const originalRequest = { ...stored.request, prompt: stored.payload.prompt };
  const request = { ...originalRequest, prompt: advisoryPrompt(originalRequest) };
  const ownerNonce = leaseOptions.ownerNonce ?? randomUUID();
  const leaseTtlMs = leaseOptions.ttlMs ?? 30_000;
  const taskLeaseTtlMs = leaseOptions.taskLeaseTtlMs ?? leaseTtlMs;
  const maxLeaseWaitMs = boundedNumber(
    leaseOptions.maxLeaseWaitMs,
    30_000,
  );
  const initialRetryMs = boundedNumber(
    leaseOptions.leaseRetryIntervalMs,
    50,
  );
  const maxRetryMs = Math.max(initialRetryMs, boundedNumber(leaseOptions.maxLeaseRetryIntervalMs, 1_000));
  const waitStartedAt = Date.now();
  const leases = [];
  let taskLease = null;
  const releaseAcquiredLeases = () => {
    if (leases.length) {
      try { releaseLeases(service.control, leases.splice(0, leases.length)); } catch {}
    }
    if (taskLease) {
      try { releaseLeases(service.control, [taskLease]); } catch {}
      taskLease = null;
    }
  };

  // Keep a task-scoped fenced claim while waiting for global/target/workspace
  // resources.  A bounded wait leaves the attempt queued, and the persisted
  // state can be picked up by a later duplicate submit or restart.
  let retryMs = initialRetryMs;
  let lastLeaseConflict = null;
  while (!leases.length) {
    const current = service.status(taskId);
    if (current.status !== 'registered' && current.status !== 'queued') {
      releaseAcquiredLeases();
      return current;
    }
    if (current.cancel_requested) {
      const cancelled = service.cancelUnsent(taskId, attemptId);
      if (cancelled.cancelled || TERMINAL_STATES.has(cancelled.status.status)) {
        releaseAcquiredLeases();
        return cancelled.status;
      }
    }
    try {
      if (!taskLease) taskLease = acquireTaskLease(service.control, {
        taskId,
        ownerNonce,
        ttlMs: taskLeaseTtlMs,
        now: service.clock(),
      });
      const acquired = acquireExecutionLeases(service.control, {
        target: request.target,
        workspace: request.workspace,
        ...leaseOptions,
        attemptId,
        ownerNonce,
        now: service.clock(),
      });
      leases.push(...acquired);
      break;
    } catch (error) {
      if (!isUnsentResourceConflict(error)) {
        releaseAcquiredLeases();
        throw error;
      }
      lastLeaseConflict = error;
      if (isWorkspaceExecutionConflict(error) && request.workspace) {
        await refreshOverlappingWorkspaceGuards(service.control, {
          workspace: request.workspace,
          attemptId,
          inspector: leaseOptions.processInspector ?? null,
          now: service.clock(),
        });
      }
      const elapsed = Date.now() - waitStartedAt;
      if (elapsed >= maxLeaseWaitMs) {
        const queued = service.recordLeaseWait(taskId, attemptId, {
          waitMs: elapsed,
          error,
          reason: error?.code ?? 'lease_conflict',
          now: service.clock(),
        });
        releaseAcquiredLeases();
        return queued;
      }
      // Renew the task claim before sleeping so a long resource wait cannot
      // look like an abandoned worker to duplicate-submit recovery.
      if (taskLease) {
        try {
          taskLease = renewLeases(service.control, [taskLease], { ttlMs: taskLeaseTtlMs, now: service.clock() })[0];
        } catch (renewError) {
          if (!isUnsentResourceConflict(renewError)) {
            releaseAcquiredLeases();
            throw renewError;
          }
          taskLease = null;
        }
      }
      const remaining = Math.max(0, maxLeaseWaitMs - (Date.now() - waitStartedAt));
      const slept = await waitForLease(retryMs > remaining ? remaining : retryMs, leaseOptions.signal);
      if (!slept) {
        const queued = service.recordLeaseWait(taskId, attemptId, {
          waitMs: Date.now() - waitStartedAt,
          error: lastLeaseConflict,
          reason: leaseOptions.signal?.aborted ? 'lease_wait_aborted' : (lastLeaseConflict?.code ?? 'lease_conflict'),
          now: service.clock(),
        });
        releaseAcquiredLeases();
        return queued;
      }
      retryMs = Math.min(maxRetryMs, Math.max(1, retryMs * 2));
    }
  }

  const fencingLease = leases[0];
  const heartbeatIntervalMs = leaseOptions.heartbeatIntervalMs ?? Math.max(10, Math.min(1_000, Math.floor(Math.min(leaseTtlMs, taskLeaseTtlMs) / 3)));
  let heartbeatError = null;
  let heartbeat;
  let hostLease = null;

  try {
    const claim = service.claimAttempt(taskId, attemptId, fencingLease);
    if (!claim.claimed) {
      const cancelled = service.cancelUnsent(taskId, attemptId);
      return cancelled.cancelled ? cancelled.status : claim.status;
    }
    service.heartbeat(attemptId, fencingLease);
    heartbeat = setInterval(() => {
      if (heartbeatError) return;
      try {
        const renewed = renewLeases(service.control, leases, { ttlMs: leaseTtlMs });
        leases.splice(0, leases.length, ...renewed);
        taskLease = renewLeases(service.control, [taskLease], { ttlMs: taskLeaseTtlMs })[0];
        if (hostLease && supervisor) hostLease = supervisor.renewInstanceLease(hostLease, { ttlMs: leaseTtlMs });
        service.heartbeat(attemptId, leases[0]);
      } catch (error) { heartbeatError = error; }
    }, heartbeatIntervalMs);
    heartbeat.unref?.();

    service.transition(taskId, 'starting', { attemptId, lease: fencingLease });
    verifyInputSnapshots(request.workspace, stored.payload.input_snapshots);
    // Managed lifecycle: after `starting`, before any adapter work. Desktop
    // targets hold the Host instance lease for the whole dispatch/observe
    // cycle; CLI targets only resolve and cache a verified entry.
    let verifiedEntry = null;
    let managed = null;
    let managedLifecycle = null;
    if (supervisor) {
      const ensured = await supervisor.ensure(request.target, { workspace: request.workspace });
      if (ensured && ensured.mode !== 'cli' && ensured.lease) hostLease = ensured.lease;
      if (ensured?.installation) verifiedEntry = ensured.installation;
      if (ensured?.managed) {
        managed = ensured.managed;
      } else if (ensured?.instance) {
        managed = {
          port: ensured.instance.port ?? null,
          instance_id: ensured.instance.instance_id ?? null,
          profile_generation: ensured.instance.generation ?? null,
        };
      }
      if (ensured?.lifecycle) {
        // Non-sensitive managed-lifecycle summary persisted with events so
        // status/result can expose it (design §15). Never contains prompts.
        const { interaction_phase: phase, ...summary } = ensured.lifecycle;
        managedLifecycle = { ...summary, ...(phase ? { interaction_phase: phase } : {}) };
      }
      // Preflight login wait: the managed instance is up but surfaces a
      // login/setup screen. Persist the sanitized waiting event and stop
      // before any adapter work; the same attempt resumes via resume/submit.
      if (ensured?.lifecycle?.state === 'waiting_user') {
        const cancelled = service.cancelUnsent(taskId, attemptId);
        if (cancelled.cancelled) return cancelled.status;
        service.transition(taskId, 'waiting_user', {
          attemptId,
          lease: fencingLease,
          event: {
            interaction: { phase: ensured.lifecycle.interaction_phase ?? 'preflight_login' },
            native_status: 'preflight_login',
            lifecycle: managedLifecycle,
          },
        });
        return service.status(taskId);
      }
    }
    const adapterContext = {
      taskId,
      attemptId,
      signal: leaseOptions.signal,
      taskDirectory: taskDirectory(service.control.root, taskId),
      control: service.control,
      lease: fencingLease,
      processInspector: leaseOptions.processInspector ?? null,
      timeoutGuardianLauncher: leaseOptions.timeoutGuardianLauncher ?? null,
      coreVersion: service.coreVersion,
      adapterVersion: status.attempt?.adapter_version ?? null,
      isCancelRequested: () => service.status(taskId).cancel_requested,
      verifiedEntry,
      managed,
    };
    const checkpoint = (kind, payload = {}) => persistCheckpoint(service.control, {
      taskId, attemptId, lease: fencingLease, kind, payload: { target: request.target, ...(managedLifecycle ? { lifecycle: managedLifecycle } : {}), ...payload },
    });
    const cancelledBeforePrepare = service.cancelUnsent(taskId, attemptId);
    if (cancelledBeforePrepare.cancelled) return cancelledBeforePrepare.status;
    const prepared = await adapter.prepare(request, adapterContext);
    const cancelledBeforeDispatch = service.cancelUnsent(taskId, attemptId);
    if (cancelledBeforeDispatch.cancelled) return cancelledBeforeDispatch.status;
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
    for await (const event of adapter.observe(submission.handle ?? submission, { ...adapterContext, checkpoint, prepared })) {
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
      if (TERMINAL_STATES.has(next) || next === 'waiting_user' || next === 'indeterminate') return service.status(taskId);
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
    releaseAcquiredLeases();
    if (hostLease && supervisor) {
      try { supervisor.releaseInstanceLease(hostLease); } catch {}
    }
  }
}

function isUnsentResourceConflict(error) {
  return ['lease_conflict', 'workspace_execution_active', 'workspace_execution_unknown'].includes(error?.code) &&
    (error?.submission ?? 'not_sent') === 'not_sent';
}

function isWorkspaceExecutionConflict(error) {
  return error?.code === 'workspace_execution_active' || error?.code === 'workspace_execution_unknown';
}

function boundedNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return Math.max(0, Number(fallback));
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : Math.max(0, Number(fallback));
}

function waitForLease(ms, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  const delay = Math.max(0, Number(ms) || 0);
  if (!delay) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), delay);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
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
