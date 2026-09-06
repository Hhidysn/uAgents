import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { acquireExecutionLeases, assertFencing, releaseLeases } from '../plugins/uagents/src/runtime/leases.mjs';
import { canonicalWorkspace, workspacesOverlap } from '../plugins/uagents/src/runtime/workspace-key.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { bindProcessIdentity, compareAndSetProcessRefresh, createProvisionalProcess, getNativeProcess, markProcessExited, markProcessUnknown, updateTranscriptCursor } from '../plugins/uagents/src/runtime/native-processes.mjs';
import { refreshWorkspaceExecutionGuard } from '../plugins/uagents/src/runtime/workspace-execution-guard.mjs';

const root = path.resolve('.local', 'test-runs', randomUUID(), 'lease store');
const parent = path.join(root, 'Repo');
const child = path.join(parent, 'src');
fs.mkdirSync(child, { recursive: true });

test('parent and child workspaces conflict across owners', () => {
  assert.equal(workspacesOverlap(parent, child), true);
  const control = new ControlDatabase(path.join(root, 'control'));
  try {
    const first = acquireExecutionLeases(control, { target: 'agy', workspace: parent, ownerNonce: 'owner-a', now: 1000 });
    assert.deepEqual(first.map(lease => lease.resource_type), ['global', 'target', 'workspace']);
    assert.throws(() => acquireExecutionLeases(control, { target: 'agy', workspace: child, ownerNonce: 'owner-b', now: 1001 }), { code: 'lease_conflict' });
    releaseLeases(control, first);
    const second = acquireExecutionLeases(control, { target: 'agy', workspace: child, ownerNonce: 'owner-b', now: 1002 });
    releaseLeases(control, second);
  } finally { control.close(); }
});

test('expired lease takeover fences the old owner', () => {
  const control = new ControlDatabase(path.join(root, 'fencing'));
  try {
    const oldLeases = acquireExecutionLeases(control, { target: 'opencode', workspace: parent, ownerNonce: 'old', ttlMs: 10, now: 1000 });
    const newer = acquireExecutionLeases(control, { target: 'opencode', workspace: parent, ownerNonce: 'new', ttlMs: 1000, now: 1011 });
    assert.throws(() => assertFencing(control.raw, oldLeases[0], 1011), { code: 'lease_conflict' });
    assert.equal(assertFencing(control.raw, newer[0], 1011), true);
    releaseLeases(control, newer);
  } finally { control.close(); }
});

test('expired Worker lease does not admit a second writer while a foreign durable process is alive', () => {
  const control = new ControlDatabase(path.join(root, 'durable-active'));
  try {
    const attemptA = createRunningGuard(control, parent, 'active-a');
    acquireExecutionLeases(control, { target: 'opencode', workspace: parent, attemptId: attemptA, ownerNonce: 'old', ttlMs: 10, now: 1000 });
    assert.throws(() => acquireExecutionLeases(control, {
      target: 'opencode', workspace: child, attemptId: 'attempt-b', ownerNonce: 'new', ttlMs: 1000, now: 1011,
    }), error => error.code === 'workspace_execution_active' && error.submission === 'not_sent');
  } finally { control.close(); }
});

test('foreign unknown durable process blocks overlapping workspace conservatively', () => {
  const control = new ControlDatabase(path.join(root, 'durable-unknown'));
  try {
    const attemptA = createRunningGuard(control, parent, 'unknown-a');
    markProcessUnknown(control, attemptA, { now: 2000 });
    assert.throws(() => acquireExecutionLeases(control, {
      target: 'opencode', workspace: child, attemptId: 'attempt-b', ownerNonce: 'new', now: 2001,
    }), { code: 'workspace_execution_unknown' });
  } finally { control.close(); }
});

test('same Attempt can reacquire execution leases for observation despite its own durable guard', () => {
  const control = new ControlDatabase(path.join(root, 'same-attempt'));
  try {
    const attemptA = createRunningGuard(control, parent, 'same-a');
    const leases = acquireExecutionLeases(control, {
      target: 'opencode', workspace: parent, attemptId: attemptA, ownerNonce: 'observer', now: 3000,
    });
    assert.equal(leases.some(lease => lease.resource_type === 'workspace'), true);
    releaseLeases(control, leases);
  } finally { control.close(); }
});

test('confirmed dead root plus quiescent tree releases guard and admits overlapping workspace', async () => {
  const control = new ControlDatabase(path.join(root, 'dead-quiescent'));
  try {
    const attemptA = createRunningGuard(control, parent, 'dead-a');
    const inspector = {
      inspectProcess: async () => ({ kind: 'absent', pid: 77 }),
      inspectProcessTree: async () => ({ kind: 'quiescent', descendants: [] }),
    };
    const refreshed = await refreshWorkspaceExecutionGuard(control, attemptA, { inspector, now: 4000 });
    assert.equal(refreshed.process_state, 'exited');
    assert.equal(refreshed.workspace_guard_state, 'released');
    const leases = acquireExecutionLeases(control, {
      target: 'opencode', workspace: child, attemptId: 'attempt-b', ownerNonce: 'new', now: 4002,
    });
    releaseLeases(control, leases);
  } finally { control.close(); }
});

test('dead root with surviving descendant keeps workspace guarded', async () => {
  const control = new ControlDatabase(path.join(root, 'dead-descendant'));
  try {
    const attemptA = createRunningGuard(control, parent, 'desc-a');
    const inspector = {
      inspectProcess: async () => ({ kind: 'absent', pid: 77 }),
      inspectProcessTree: async () => ({ kind: 'active_descendants', descendants: [{ pid: 78, parent_pid: 77, started_at_ms: 2100 }] }),
    };
    const refreshed = await refreshWorkspaceExecutionGuard(control, attemptA, { inspector, now: 5000 });
    assert.equal(refreshed.process_state, 'exited');
    assert.equal(refreshed.workspace_guard_state, 'held');
    assert.throws(() => acquireExecutionLeases(control, {
      target: 'opencode', workspace: child, attemptId: 'attempt-b', ownerNonce: 'new', now: 5002,
    }), { code: 'workspace_execution_active' });
  } finally { control.close(); }
});

test('inspection failure changes guard to unknown and never releases it', async () => {
  const control = new ControlDatabase(path.join(root, 'inspect-failed'));
  try {
    const attemptA = createRunningGuard(control, parent, 'inspect-a');
    const inspector = {
      inspectProcess: async () => ({ kind: 'inspection_failed', code: 'process_inspection_failed' }),
      inspectProcessTree: async () => { throw new Error('must not inspect tree'); },
    };
    const refreshed = await refreshWorkspaceExecutionGuard(control, attemptA, { inspector, now: 6000 });
    assert.equal(refreshed.process_state, 'unknown');
    assert.equal(refreshed.workspace_guard_state, 'unknown');
    assert.throws(() => acquireExecutionLeases(control, {
      target: 'opencode', workspace: child, attemptId: 'attempt-b', ownerNonce: 'new', now: 6001,
    }), { code: 'workspace_execution_unknown' });
  } finally { control.close(); }
});

test('stale dead-process inspection cannot release a row changed after inspection began', async () => {
  const control = new ControlDatabase(path.join(root, 'stale-refresh'));
  try {
    const attemptA = createRunningGuard(control, parent, 'stale-a');
    let treeCalls = 0;
    const inspector = {
      inspectProcess: async () => {
        updateTranscriptCursor(control, attemptA, { stdoutBytes: 1 }, { now: 7001 });
        return { kind: 'absent', pid: 77 };
      },
      inspectProcessTree: async () => { treeCalls += 1; return { kind: 'quiescent', descendants: [] }; },
    };
    const refreshed = await refreshWorkspaceExecutionGuard(control, attemptA, { inspector, now: 7000 });
    assert.equal(refreshed.process_state, 'running');
    assert.equal(refreshed.workspace_guard_state, 'held');
    assert.equal(refreshed.stdout_cursor_bytes, 1);
    assert.equal(treeCalls, 0);
  } finally { control.close(); }
});

test('an exited root is never resurrected even if the PID later looks alive', async () => {
  const control = new ControlDatabase(path.join(root, 'no-resurrection'));
  try {
    const attemptA = createRunningGuard(control, parent, 'no-resurrection-a');
    markProcessExited(control, attemptA, { exitedAtMs: 8000 }, { now: 8001 });
    const before = getNativeProcess(control, attemptA);
    assert.throws(() => compareAndSetProcessRefresh(control, before, {
      processState: 'running', workspaceGuardState: 'held', exitedAtMs: null,
    }, { now: 8002 }), { code: 'invalid_state_transition' });

    let processCalls = 0;
    const inspector = {
      inspectProcess: async () => { processCalls += 1; return { kind: 'alive', pid: 77, started_at_ms: 2000, executable_path: before.executable_path }; },
      inspectProcessTree: async () => ({ kind: 'quiescent', descendants: [] }),
    };
    const refreshed = await refreshWorkspaceExecutionGuard(control, attemptA, { inspector, now: 8003 });
    assert.equal(processCalls, 0);
    assert.equal(refreshed.process_state, 'exited');
    assert.equal(refreshed.workspace_guard_state, 'released');
  } finally { control.close(); }
});

function createRunningGuard(control, workspace, suffix) {
  const service = new TaskService(control);
  const requestId = randomUUID();
  const registered = service.submit({
    schema_version: '1.0', request_id: requestId, target: 'opencode',
    model: 'commandcode-goat/deepseek/deepseek-v4-flash', mode: 'analysis', prompt: `fixture-${suffix}`,
    workspace,
    execution: { observation_timeout_ms: 10_000, effort: 'medium', permission: 'native' },
    policy: { fallback: 'none', max_cost_usd: null },
  }, { adapterVersion: 'fixture-adapter' });
  const attemptId = registered.attempt.attempt_id;
  const executablePath = path.resolve(root, `${suffix}-opencode.exe`);
  createProvisionalProcess(control, {
    attemptId,
    target: 'opencode',
    workspaceKey: canonicalWorkspace(workspace),
    executablePath,
    executableSha256: 'b'.repeat(64),
    launchFingerprint: 'c'.repeat(64),
    stdoutRelpath: `native/${attemptId}/stdout.log`,
    stderrRelpath: `native/${attemptId}/stderr.log`,
  }, { now: 1500 });
  bindProcessIdentity(control, attemptId, { pid: 77, startedAtMs: 2000, executablePath }, { now: 1501 });
  assert.equal(getNativeProcess(control, attemptId).workspace_guard_state, 'held');
  return attemptId;
}
