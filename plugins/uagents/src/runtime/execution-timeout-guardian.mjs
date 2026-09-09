import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ControlDatabase } from '../store/database.mjs';
import { createProcessInspector } from '../host/process-inspector.mjs';
import { createProcessTerminator } from '../host/process-terminator.mjs';
import { getNativeProcess } from './native-processes.mjs';
import { refreshWorkspaceExecutionGuard } from './workspace-execution-guard.mjs';
import {
  enforceExecutionTimeout,
  executionDeadlineAt,
  executionTimeoutGuardianReadySlots,
  executionTimeoutEvidence,
  recordExecutionTimeoutGuardianReady,
  recordExecutionTimeoutStarted,
  releaseExecutionTimeoutClaim,
  renewExecutionTimeoutClaim,
  tryAcquireExecutionTimeoutClaim,
} from './execution-timeout.mjs';

const SOURCE_FILE = fileURLToPath(import.meta.url);
const DEFAULT_GUARDIAN_POLL_MS = 250;
const DEFAULT_GUARDIAN_SEND_GRACE_MS = 30_000;
const DEFAULT_GUARDIAN_READY_TIMEOUT_MS = 5_000;
const DEFAULT_GUARDIAN_CLAIM_TTL_MS = 5_000;
const DEFAULT_GUARDIAN_CLAIM_HEARTBEAT_MS = 1_000;
const EXECUTION_TIMEOUT_GUARDIAN_SLOTS = Object.freeze(['primary', 'secondary']);

export async function launchExecutionTimeoutGuardian({
  control,
  attemptId,
  executionTimeoutMs,
  spawnImpl = spawn,
  sourceFile = SOURCE_FILE,
  readyTimeoutMs = DEFAULT_GUARDIAN_READY_TIMEOUT_MS,
  readyPollMs = 20,
} = {}) {
  const timeoutMs = Number(executionTimeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw guardianLaunchError(new Error('execution timeout is invalid'));
  }
  const launched = [];
  try {
    for (const slot of EXECUTION_TIMEOUT_GUARDIAN_SLOTS) {
      launched.push(await launchExecutionTimeoutGuardianSlot({
        control,
        attemptId,
        executionTimeoutMs: timeoutMs,
        slot,
        spawnImpl,
        sourceFile,
        readyTimeoutMs,
        readyPollMs,
      }));
    }
    return {
      ready: true,
      pids: launched.map(entry => entry.pid).filter(pid => Number.isSafeInteger(pid)),
      slots: launched.map(entry => entry.slot),
    };
  } catch (error) {
    for (const entry of launched) {
      try { entry.child?.kill?.(); } catch {}
    }
    throw error;
  }
}

function launchExecutionTimeoutGuardianSlot({
  control,
  attemptId,
  executionTimeoutMs,
  slot,
  spawnImpl,
  sourceFile,
  readyTimeoutMs,
  readyPollMs,
}) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let readyTimer = null;
    let readyPoll = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (readyTimer) clearTimeout(readyTimer);
      if (readyPoll) clearInterval(readyPoll);
      child?.removeListener?.('error', onError);
      child?.removeListener?.('exit', onExit);
      child?.removeListener?.('close', onExit);
      fn(value);
    };
    const onError = error => finish(reject, guardianLaunchError(error));
    const onExit = () => finish(reject, guardianLaunchError(new Error('guardian exited before ready')));
    const checkReady = () => {
      try {
        const ready = executionTimeoutGuardianReadySlots(control, attemptId).find(entry => entry.slot === slot);
        if (!ready || Number(ready.pid) !== Number(child.pid)) return;
        child.unref?.();
        finish(resolve, {
          pid: Number.isSafeInteger(child.pid) ? child.pid : null,
          ready: true,
          slot,
          child,
        });
      } catch (error) {
        finish(reject, guardianLaunchError(error));
      }
    };
    try {
      child = spawnImpl(process.execPath, [sourceFile, control.root, attemptId, slot, String(executionTimeoutMs)], {
        detached: true,
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
        env: guardianEnvironment(process.env),
      });
    } catch (error) {
      reject(guardianLaunchError(error));
      return;
    }
    child.once?.('error', onError);
    child.once?.('exit', onExit);
    child.once?.('close', onExit);
    child.once?.('spawn', () => {
      if (settled) return;
      readyPoll = setInterval(checkReady, Math.max(1, Number(readyPollMs) || 20));
      readyPoll.unref?.();
      readyTimer = setTimeout(() => {
        try { child.kill?.(); } catch {}
        finish(reject, guardianLaunchError(new Error('guardian ready handshake timed out')));
      }, Math.max(1, Number(readyTimeoutMs) || DEFAULT_GUARDIAN_READY_TIMEOUT_MS));
      readyTimer.unref?.();
      checkReady();
    });
  });
}

export async function runExecutionTimeoutGuardian(root, attemptId, {
  slot = 'primary',
  executionTimeoutMs = null,
  inspector = null,
  terminator = null,
  pollMs = DEFAULT_GUARDIAN_POLL_MS,
  sendGraceMs = DEFAULT_GUARDIAN_SEND_GRACE_MS,
  claimTtlMs = DEFAULT_GUARDIAN_CLAIM_TTL_MS,
  claimHeartbeatMs = DEFAULT_GUARDIAN_CLAIM_HEARTBEAT_MS,
  now = Date.now,
  sleep = delay,
} = {}) {
  const control = new ControlDatabase(path.resolve(root), { create: false });
  const resolvedInspector = inspector ?? (process.platform === 'win32' ? createProcessInspector() : null);
  const resolvedTerminator = terminator ?? createProcessTerminator({ inspector: resolvedInspector });
  const startedAt = Number(now());
  try {
    const attempt = control.raw.prepare('SELECT task_id FROM attempts WHERE attempt_id = ?').get(attemptId);
    if (!attempt) return { mode: 'missing_attempt' };
    const timeoutMs = Number(executionTimeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return { mode: 'disabled' };
    const initialProcess = getNativeProcess(control, attemptId);
    if (!initialProcess || initialProcess.workspace_guard_state === 'released' ||
        !Number.isSafeInteger(Number(initialProcess.pid)) || Number(initialProcess.pid) <= 0 ||
        !Number.isSafeInteger(Number(initialProcess.process_started_at_ms)) || Number(initialProcess.process_started_at_ms) <= 0 ||
        typeof initialProcess.executable_path !== 'string' || !initialProcess.executable_path) {
      return { mode: 'process_identity_unavailable' };
    }
    recordExecutionTimeoutGuardianReady(control, attemptId, {
      slot,
      pid: process.pid,
      now: Number(now()),
    });

    for (;;) {
      if (executionTimeoutEvidence(control, attemptId)) return { mode: 'evidence_exists' };
      const currentAttempt = control.raw.prepare('SELECT submission FROM attempts WHERE attempt_id = ?').get(attemptId);
      const task = control.raw.prepare('SELECT status FROM tasks WHERE task_id = ?').get(attempt.task_id);
      if (!currentAttempt || !task) return { mode: 'missing_state' };
      if (['succeeded', 'failed', 'cancelled'].includes(task.status)) return { mode: 'task_terminal' };

      let processRecord = getNativeProcess(control, attemptId);
      if (!processRecord || processRecord.workspace_guard_state === 'released') return { mode: 'process_complete' };
      if (resolvedInspector) {
        processRecord = await refreshWorkspaceExecutionGuard(control, attemptId, { inspector: resolvedInspector, now: Number(now()) });
        if (!processRecord || processRecord.workspace_guard_state === 'released') return { mode: 'process_complete' };
      }

      const deadline = executionDeadlineAt(control, attemptId, Number(timeoutMs));
      if (deadline === null) {
        if (currentAttempt.submission !== 'not_sent') return { mode: 'deadline_evidence_missing' };
        if (Number(now()) - startedAt >= Math.max(1, Number(sendGraceMs) || DEFAULT_GUARDIAN_SEND_GRACE_MS)) {
          return { mode: 'send_checkpoint_missing' };
        }
        await sleep(Math.max(1, Number(pollMs) || DEFAULT_GUARDIAN_POLL_MS));
        continue;
      }

      const remaining = deadline - Number(now());
      if (remaining > 0) {
        await sleep(Math.max(1, Math.min(remaining, Number(pollMs) || DEFAULT_GUARDIAN_POLL_MS)));
        continue;
      }

      recordExecutionTimeoutStarted(control, attemptId, { now: Number(now()) });
      const ownerNonce = `execution-timeout:${attemptId}:${slot}:${process.pid}:${randomUUID()}`;
      let claim = tryAcquireExecutionTimeoutClaim(control, attemptId, {
        ownerNonce,
        ttlMs: claimTtlMs,
        now: Number(now()),
      });
      if (!claim) {
        await sleep(Math.max(1, Number(pollMs) || DEFAULT_GUARDIAN_POLL_MS));
        continue;
      }

      let claimLost = false;
      const heartbeat = setInterval(() => {
        if (claimLost) return;
        try {
          claim = renewExecutionTimeoutClaim(control, claim, {
            ttlMs: claimTtlMs,
            now: Number(now()),
          });
        } catch {
          claimLost = true;
        }
      }, Math.max(1, Number(claimHeartbeatMs) || DEFAULT_GUARDIAN_CLAIM_HEARTBEAT_MS));
      heartbeat.unref?.();

      try {
        if (executionTimeoutEvidence(control, attemptId)) return { mode: 'evidence_exists' };
        const result = await enforceExecutionTimeout({
          control,
          attemptId,
          inspector: resolvedInspector,
          terminator: resolvedTerminator,
          lease: claim,
          now,
        });
        return {
          mode: result.termination_confirmed ? 'timeout_terminated' : 'timeout_unconfirmed',
          termination_confirmed: result.termination_confirmed === true,
          claim_lost: claimLost,
        };
      } finally {
        clearInterval(heartbeat);
        try { releaseExecutionTimeoutClaim(control, claim); } catch {}
      }
    }
  } finally {
    control.close();
  }
}

function guardianEnvironment(env) {
  const output = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'ComSpec', 'TEMP', 'TMP']) {
    if (typeof env?.[key] === 'string' && env[key]) output[key] = env[key];
  }
  return output;
}

function guardianLaunchError(cause) {
  const error = new Error('The execution-timeout guardian could not be started.');
  error.code = 'execution_timeout_guardian_unavailable';
  error.submission = 'not_sent';
  error.cause = cause;
  return error;
}

if (process.argv[1] && samePath(process.argv[1], SOURCE_FILE)) {
  runExecutionTimeoutGuardian(process.argv[2], process.argv[3], {
    slot: process.argv[4],
    executionTimeoutMs: Number(process.argv[5]),
  })
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
