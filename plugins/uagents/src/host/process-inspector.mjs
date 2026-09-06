import path from 'node:path';
import { createDefaultRunner } from './agent-locator.mjs';

export const PROCESS_START_TOLERANCE_MS = 1000;

export function createProcessInspector({ runPowerShell = null } = {}) {
  const runner = runPowerShell ?? createDefaultRunner();
  return {
    inspectProcess: input => inspectProcessWithRunner(runner, input),
    inspectProcessTree: input => inspectProcessTreeWithRunner(runner, input),
  };
}

export async function inspectProcessWithRunner(runner, { pid } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: 'inspection_failed', code: 'invalid_input' };
  let result;
  try {
    result = await runner('inspect-process', { pid, include_command_line: false });
  } catch (error) {
    return { kind: 'inspection_failed', code: stableCode(error, 'host_script_failed') };
  }
  if (!plainObject(result) || result.ok !== true) {
    return { kind: 'inspection_failed', code: stableCode(result?.error, 'process_inspection_failed') };
  }
  if (result.exists === false) return { kind: 'absent', pid };
  if (result.exists !== true) return { kind: 'inspection_failed', code: 'process_inspection_invalid' };
  const startedAtMs = Number(result.started_at_ms);
  const executablePath = typeof result.executable_path === 'string' ? result.executable_path : '';
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0 || !executablePath) {
    return { kind: 'inspection_failed', code: 'process_identity_incomplete' };
  }
  return { kind: 'alive', pid, started_at_ms: startedAtMs, executable_path: executablePath };
}

export async function inspectProcessTreeWithRunner(runner, { rootPid, rootStartedAtMs = null } = {}) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return { kind: 'inspection_failed', code: 'invalid_input' };
  let result;
  try {
    result = await runner('inspect-process-tree', { root_pid: rootPid, root_started_at_ms: rootStartedAtMs });
  } catch (error) {
    return { kind: 'inspection_failed', code: stableCode(error, 'host_script_failed') };
  }
  if (!plainObject(result) || result.ok !== true || !Array.isArray(result.descendants)) {
    return { kind: 'inspection_failed', code: stableCode(result?.error, 'process_tree_inspection_failed') };
  }
  const descendants = [];
  for (const entry of result.descendants) {
    if (!plainObject(entry)) return { kind: 'inspection_failed', code: 'process_tree_invalid' };
    const childPid = Number(entry.pid);
    const parentPid = Number(entry.parent_pid);
    const startedAtMs = entry.started_at_ms === null || entry.started_at_ms === undefined ? null : Number(entry.started_at_ms);
    if (!Number.isSafeInteger(childPid) || childPid <= 0 || !Number.isSafeInteger(parentPid) || parentPid < 0 ||
      (startedAtMs !== null && (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0))) {
      return { kind: 'inspection_failed', code: 'process_tree_invalid' };
    }
    descendants.push({ pid: childPid, parent_pid: parentPid, started_at_ms: startedAtMs });
  }
  return descendants.length
    ? { kind: 'active_descendants', descendants }
    : { kind: 'quiescent', descendants: [] };
}

export function classifyPersistedProcess(record, inspection) {
  if (!record || !Number.isSafeInteger(Number(record.pid)) || Number(record.pid) <= 0 ||
      !Number.isSafeInteger(Number(record.process_started_at_ms)) || Number(record.process_started_at_ms) < 0) {
    return { kind: 'inspection_unknown', code: 'persisted_identity_incomplete' };
  }
  if (inspection?.kind === 'inspection_failed') return { kind: 'inspection_unknown', code: inspection.code ?? 'process_inspection_failed' };
  if (inspection?.kind === 'absent') return { kind: 'dead' };
  if (inspection?.kind !== 'alive') return { kind: 'inspection_unknown', code: 'process_inspection_invalid' };
  if (Math.abs(Number(inspection.started_at_ms) - Number(record.process_started_at_ms)) > PROCESS_START_TOLERANCE_MS) {
    return { kind: 'old_identity_dead_pid_reused' };
  }
  if (!sameWindowsPath(inspection.executable_path, record.executable_path)) return { kind: 'identity_mismatch_unknown' };
  return { kind: 'alive_same_identity' };
}

function stableCode(error, fallback) {
  return typeof error?.code === 'string' && error.code ? error.code : fallback;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameWindowsPath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}
