import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { classifyPersistedProcess, createProcessInspector } from './process-inspector.mjs';

export const DEFAULT_TERMINATION_BUDGET_MS = 10_000;
export const DEFAULT_TERMINATION_POLL_MS = 50;

export function createProcessTerminator({ inspector = null, spawnImpl = spawn, env = process.env } = {}) {
  const resolvedInspector = inspector ?? (process.platform === 'win32' ? createProcessInspector() : null);
  return {
    terminateOwnedProcessTree: record => terminateOwnedProcessTree(record, {
      inspector: resolvedInspector,
      spawnImpl,
      env,
    }),
  };
}

export async function terminateOwnedProcessTree(record, {
  inspector,
  spawnImpl = spawn,
  env = process.env,
  budgetMs = DEFAULT_TERMINATION_BUDGET_MS,
  pollMs = DEFAULT_TERMINATION_POLL_MS,
} = {}) {
  if (!record || !inspector || typeof inspector.inspectProcess !== 'function' || typeof inspector.inspectProcessTree !== 'function') {
    return { kind: 'unconfirmed', reason: 'termination_evidence_unavailable', taskkill_started: false };
  }
  if (!Number.isSafeInteger(Number(record.pid)) || Number(record.pid) <= 0 ||
      !Number.isSafeInteger(Number(record.process_started_at_ms)) || Number(record.process_started_at_ms) <= 0 ||
      typeof record.executable_path !== 'string' || !record.executable_path) {
    return { kind: 'unconfirmed', reason: 'persisted_identity_incomplete', taskkill_started: false };
  }

  const before = await inspector.inspectProcess({ pid: Number(record.pid) });
  const classification = classifyPersistedProcess(record, before);
  if (classification.kind === 'dead' || classification.kind === 'old_identity_dead_pid_reused') {
    return classifyAlreadyExitedTree(record, inspector);
  }
  if (classification.kind !== 'alive_same_identity') {
    return {
      kind: 'unconfirmed',
      reason: classification.kind === 'identity_mismatch_unknown'
        ? 'native_process_identity_mismatch'
        : classification.code ?? 'native_process_inspection_failed',
      taskkill_started: false,
    };
  }

  const taskkill = windowsTaskkillPath(env);
  if (!taskkill) return { kind: 'unconfirmed', reason: 'taskkill_unavailable', taskkill_started: false };
  const invocation = await invokeTaskkill(taskkill, Number(record.pid), { spawnImpl, budgetMs });
  if (!invocation.started) {
    return { kind: 'unconfirmed', reason: invocation.reason, taskkill_started: false };
  }

  const deadline = Date.now() + Math.max(1, Number(budgetMs) || DEFAULT_TERMINATION_BUDGET_MS);
  let lastReason = invocation.reason ?? 'termination_not_confirmed';
  for (;;) {
    const root = await inspector.inspectProcess({ pid: Number(record.pid) });
    const current = classifyPersistedProcess(record, root);
    if (current.kind === 'dead' || current.kind === 'old_identity_dead_pid_reused') {
      const tree = await inspector.inspectProcessTree({
        rootPid: Number(record.pid),
        rootStartedAtMs: Number(record.process_started_at_ms),
      });
      if (tree?.kind === 'quiescent') {
        return {
          kind: 'terminated',
          reason: 'owned_process_tree_quiescent',
          taskkill_started: true,
          taskkill_exit_code: invocation.exitCode,
        };
      }
      if (tree?.kind === 'inspection_failed') lastReason = tree.code ?? 'process_tree_inspection_failed';
      else if (tree?.kind === 'active_descendants') lastReason = 'process_tree_still_active';
      else lastReason = 'process_tree_inspection_invalid';
    } else if (current.kind === 'alive_same_identity') {
      lastReason = 'owned_process_still_alive';
    } else if (current.kind === 'identity_mismatch_unknown') {
      return {
        kind: 'unconfirmed', reason: 'native_process_identity_mismatch', taskkill_started: true,
        taskkill_exit_code: invocation.exitCode,
      };
    } else {
      lastReason = current.code ?? 'native_process_inspection_failed';
    }

    if (Date.now() >= deadline) {
      return {
        kind: 'unconfirmed', reason: lastReason, taskkill_started: true,
        taskkill_exit_code: invocation.exitCode,
      };
    }
    await delay(Math.max(1, Number(pollMs) || DEFAULT_TERMINATION_POLL_MS));
  }
}

async function classifyAlreadyExitedTree(record, inspector) {
  const tree = await inspector.inspectProcessTree({
    rootPid: Number(record.pid),
    rootStartedAtMs: Number(record.process_started_at_ms),
  });
  if (tree?.kind === 'quiescent') {
    return { kind: 'already_exited', reason: 'owned_process_tree_quiescent', taskkill_started: false };
  }
  if (tree?.kind === 'active_descendants') {
    return { kind: 'unconfirmed', reason: 'process_tree_still_active', taskkill_started: false };
  }
  return {
    kind: 'unconfirmed',
    reason: tree?.code ?? 'process_tree_inspection_failed',
    taskkill_started: false,
  };
}

function windowsTaskkillPath(env) {
  if (process.platform !== 'win32') return null;
  const root = typeof env?.SystemRoot === 'string' && env.SystemRoot ? env.SystemRoot
    : typeof env?.WINDIR === 'string' && env.WINDIR ? env.WINDIR : null;
  if (!root || !path.win32.isAbsolute(root)) return null;
  const candidate = path.win32.join(root, 'System32', 'taskkill.exe');
  try {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  } catch {
    return null;
  }
  return candidate;
}

function invokeTaskkill(command, pid, { spawnImpl, budgetMs }) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ started: true, exitCode: null, reason: 'taskkill_wait_timeout' }),
      Math.max(1, Number(budgetMs) || DEFAULT_TERMINATION_BUDGET_MS));
    try {
      const child = spawnImpl(command, ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
      });
      child.once?.('error', () => finish({ started: false, exitCode: null, reason: 'taskkill_spawn_failed' }));
      child.once?.('close', code => finish({
        started: true,
        exitCode: Number.isInteger(code) ? code : null,
        reason: Number.isInteger(code) && code !== 0 ? 'taskkill_nonzero' : null,
      }));
      child.once?.('exit', code => finish({
        started: true,
        exitCode: Number.isInteger(code) ? code : null,
        reason: Number.isInteger(code) && code !== 0 ? 'taskkill_nonzero' : null,
      }));
    } catch {
      finish({ started: false, exitCode: null, reason: 'taskkill_spawn_failed' });
    }
  });
}
