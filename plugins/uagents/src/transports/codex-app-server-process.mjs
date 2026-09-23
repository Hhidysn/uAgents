import fs from 'node:fs';
import path from 'node:path';
import { createProcessInspector } from '../host/process-inspector.mjs';
import { terminateOwnedProcessTree } from '../host/process-terminator.mjs';
import {
  createBoundProcess,
  getNativeProcess,
  markProcessExited,
  markProcessUnknown,
  nativeLaunchFingerprint,
  releaseWorkspaceGuard,
} from '../runtime/native-processes.mjs';
import { canonicalWorkspace } from '../runtime/workspace-key.mjs';

// One Task owns one app-server launcher. The existing native-process table
// holds its launch slot and workspace guard across Worker crashes.
export function createCodexAppServerProcessEvidence({ control, attemptId, lease, workspace,
  taskDirectory, entry, argv = [entry, 'app-server', '--stdio'],
  coreVersion = null, adapterVersion = null, inspector = null } = {}) {
  if (!control || !attemptId || !taskDirectory) return null; // Direct protocol probes have no TaskService.
  const resolvedInspector = inspector ?? (process.platform === 'win32' ? createProcessInspector() : null);
  if (!resolvedInspector) throw Error('native_process_inspection_unavailable');
  const executablePath = path.resolve(process.execPath);
  const relativeDirectory = `native/${attemptId}`;
  const nativeDirectory = path.join(taskDirectory, relativeDirectory);
  fs.mkdirSync(nativeDirectory, { recursive: true });
  for (const name of ['stdout.log', 'stderr.log']) fs.closeSync(fs.openSync(path.join(nativeDirectory, name), 'a'));
  const record = {
    attemptId, target: 'codex', workspaceKey: canonicalWorkspace(workspace),
    executablePath, executableSha256: null,
    launchFingerprint: nativeLaunchFingerprint({ target: 'codex', attemptId,
      workspaceKey: canonicalWorkspace(workspace), executablePath, executableSha256: null,
      argv, coreVersion, adapterVersion }),
    stdoutRelpath: `${relativeDirectory}/stdout.log`,
    stderrRelpath: `${relativeDirectory}/stderr.log`,
  };
  let observedIdentity = null;
  let bound = false;
  let settled = false;
  const sameExecutable = observed => process.platform === 'win32'
    ? path.win32.normalize(observed).toLowerCase() === path.win32.normalize(executablePath).toLowerCase()
    : path.resolve(observed) === executablePath;
  return {
    async inspect(child) {
      if (settled || !Number.isSafeInteger(child?.pid) || child.pid <= 0) throw Error('native_process_identity_mismatch');
      const observed = await resolvedInspector.inspectProcess({ pid: child.pid });
      if (observed?.kind !== 'alive' || observed.pid !== child.pid ||
          !sameExecutable(observed.executable_path) || !Number.isSafeInteger(observed.started_at_ms)) {
        throw Error('native_process_identity_mismatch');
      }
      observedIdentity = { pid: child.pid, startedAtMs: observed.started_at_ms,
        executablePath: observed.executable_path };
    },
    persist() {
      if (settled || !observedIdentity || bound) throw Error('native_process_identity_mismatch');
      createBoundProcess(control, record, observedIdentity, { lease });
      bound = true;
    },
    noSpawn() {
      if (settled) return true;
      settled = true;
      return true;
    },
    async closed(exitCode) {
      if (settled) return false;
      settled = true;
      if (!bound) return false;
      markProcessExited(control, attemptId, { exitCode: Number.isInteger(exitCode) ? exitCode : null }, { lease });
      const record = control.raw.prepare('SELECT pid, process_started_at_ms FROM native_processes WHERE attempt_id = ?')
        .get(attemptId);
      const tree = await resolvedInspector.inspectProcessTree({ rootPid: Number(record.pid),
        rootStartedAtMs: Number(record.process_started_at_ms) });
      if (tree?.kind !== 'quiescent') return false;
      releaseWorkspaceGuard(control, attemptId, { lease, quiescenceProven: true });
      return true;
    },
    async terminate() {
      if (!bound || settled) return { kind: 'unconfirmed', reason: 'persisted_identity_incomplete' };
      return terminateOwnedProcessTree(getNativeProcess(control, attemptId), { inspector: resolvedInspector });
    },
    unknown() {
      if (settled) return;
      settled = true;
      if (bound) markProcessUnknown(control, attemptId, { lease });
    },
  };
}
