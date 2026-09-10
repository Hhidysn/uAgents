import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { runTask } from '../plugins/uagents/src/runtime/worker.mjs';
import { reconcileTask } from '../plugins/uagents/src/runtime/reconcile.mjs';
import { getNativeProcess } from '../plugins/uagents/src/runtime/native-processes.mjs';
import {
  executionTimeoutEvidence,
  executionTimeoutGuardianReadySlots,
} from '../plugins/uagents/src/runtime/execution-timeout.mjs';
import { createProcessInspector } from '../plugins/uagents/src/host/process-inspector.mjs';
import { OpenCodeAdapter } from '../plugins/uagents/src/adapters/opencode/adapter.mjs';

const base = path.resolve('.local', 'test-runs', randomUUID(), 'opencode durable recovery');
const fakeCli = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
const workerRunner = fileURLToPath(new URL('./fixtures/opencode-durable-worker-runner.mjs', import.meta.url));
fs.mkdirSync(base, { recursive: true });

const request = patch => ({
  schema_version: '1.0',
  request_id: randomUUID(),
  target: 'opencode',
  model: 'commandcode-goat/deepseek/deepseek-v4-flash',
  mode: 'implementation',
  prompt: 'provider-free durable recovery fixture',
  execution: { observation_timeout_ms: 3_000, effort: 'medium', permission: 'native' },
  policy: { fallback: 'none', max_cost_usd: null },
  ...patch,
});

test('OpenCode recovery discovers a delayed session without replaying the prompt', { skip: process.platform !== 'win32' }, async () => {
  const root = path.join(base, `pre-session-${randomUUID()}`);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const control = new ControlDatabase(root);
  let runner = null;
  let nativePid = null;
  try {
    const service = new TaskService(control);
    const input = request({ workspace });
    const registered = service.submit(input, { adapterVersion: 'opencode-durable-fixture-1' });
    runner = spawn(process.execPath, [workerRunner, root, registered.task_id, fakeCli, 'delayed-session'], {
      cwd: path.resolve('.'), windowsHide: true, stdio: 'ignore',
    });
    await waitFor(() => fs.existsSync(path.join(workspace, 'received.txt')));
    await waitFor(() => {
      const status = service.status(registered.task_id);
      const processRecord = getNativeProcess(control, status.attempt.attempt_id);
      if (processRecord?.pid) nativePid = processRecord.pid;
      return status.attempt.submission === 'may_have_been_sent' && processRecord?.process_state === 'running' && status.native === null;
    });
    runner.kill();
    await waitForExit(runner);
    await delay(220);
    assert.equal(service.status(registered.task_id).native, null);

    const resumed = service.resume(registered.task_id);
    assert.equal(resumed.mode, 'reconcile');
    assert.equal(resumed.durable_process, true);
    const spawnCalls = [];
    const recoveryAdapter = new OpenCodeAdapter({ testDriver: {
      command: process.execPath,
      args: [fakeCli, 'opencode', registered.task_id, 'delayed-session'],
      spawn() { spawnCalls.push(true); throw new Error('reconcile must not spawn'); },
    } });
    const result = await reconcileTask({
      service,
      taskId: registered.task_id,
      adapter: recoveryAdapter,
      leaseOptions: { processInspector: createProcessInspector(), ttlMs: 1_000, heartbeatIntervalMs: 100 },
    });
    assert.equal(spawnCalls.length, 0);
    assert.equal(result.native?.session_id, 'ses_fixture');
    assert.equal(result.attempt.submission, 'sent');
    assert.equal(lines(path.join(workspace, 'received.txt')), 1);
  } finally {
    if (runner && runner.exitCode === null) try { runner.kill(); } catch {}
    if (nativePid) try { process.kill(nativePid); } catch {}
    control.close();
  }
});

test('accepted OpenCode survives Worker death and keeps a second workspace writer out after lease expiry', { skip: process.platform !== 'win32' }, async () => {
  const root = path.join(base, `dual-writer-${randomUUID()}`);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const control = new ControlDatabase(root);
  let runner = null;
  let nativePid = null;
  try {
    const service = new TaskService(control);
    const first = request({ workspace });
    const registered = service.submit(first, { adapterVersion: 'opencode-durable-fixture-1' });
    runner = spawn(process.execPath, [workerRunner, root, registered.task_id, fakeCli, 'gated-success'], {
      cwd: path.resolve('.'), windowsHide: true, stdio: 'ignore',
    });
    await waitFor(() => {
      const status = service.status(registered.task_id);
      const processRecord = getNativeProcess(control, status.attempt.attempt_id);
      if (processRecord?.pid) nativePid = processRecord.pid;
      return status.status === 'running' && status.attempt.submission === 'sent' && status.native?.session_id === 'ses_fixture';
    });
    assert.equal(lines(path.join(workspace, 'received.txt')), 1);
    runner.kill();
    await waitForExit(runner);
    await delay(250);

    const second = request({ workspace, request_id: randomUUID() });
    const secondRegistered = service.submit(second, { adapterVersion: 'opencode-durable-fixture-1' });
    const secondAdapter = new OpenCodeAdapter({ testDriver: {
      command: process.execPath,
      args: [fakeCli, 'opencode', second.request_id, 'success'],
    } });
    const blocked = await runTask({
      service,
      taskId: secondRegistered.task_id,
      adapter: secondAdapter,
      leaseOptions: { maxLeaseWaitMs: 150, leaseRetryIntervalMs: 20, ttlMs: 300, taskLeaseTtlMs: 300 },
    });
    assert.equal(blocked.status, 'queued');
    assert.equal(blocked.attempt.submission, 'not_sent');
    assert.equal(getNativeProcess(control, blocked.attempt.attempt_id), null);
    assert.equal(lines(path.join(workspace, 'received.txt')), 1);

    fs.writeFileSync(path.join(workspace, 'release-success'), 'go');

    const resumed = service.resume(registered.task_id);
    assert.equal(resumed.mode, 'reconcile');
    const spawnCalls = [];
    const recoveryAdapter = new OpenCodeAdapter({ testDriver: {
      command: process.execPath,
      args: [fakeCli, 'opencode', registered.task_id, 'gated-success'],
      spawn() { spawnCalls.push(true); throw new Error('reconcile must not spawn'); },
    } });
    const reconciled = await reconcileTask({
      service,
      taskId: registered.task_id,
      adapter: recoveryAdapter,
      leaseOptions: { processInspector: createProcessInspector(), ttlMs: 1_000, heartbeatIntervalMs: 100 },
    });
    assert.equal(spawnCalls.length, 0);
    assert.equal(reconciled.native?.session_id, 'ses_fixture');
    assert.equal(lines(path.join(workspace, 'received.txt')), 1);
    await waitFor(() => getNativeProcess(control, registered.attempt.attempt_id)?.workspace_guard_state === 'released');
  } finally {
    if (runner && runner.exitCode === null) try { runner.kill(); } catch {}
    if (nativePid) try { process.kill(nativePid); } catch {}
    control.close();
  }
});

test('OpenCode execution timeout terminates the verified native tree and reports indeterminate timeout', { skip: process.platform !== 'win32' }, async () => {
  const root = path.join(base, `execution-timeout-${randomUUID()}`);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const control = new ControlDatabase(root);
  let nativePid = null;
  try {
    const service = new TaskService(control);
    const input = request({
      workspace,
      execution: { observation_timeout_ms: 5_000, execution_timeout_ms: 1_000, effort: 'medium', permission: 'native' },
    });
    const registered = service.submit(input, { adapterVersion: 'opencode-timeout-fixture-1' });
    const adapter = new OpenCodeAdapter({ testDriver: {
      command: process.execPath,
      args: [fakeCli, 'opencode', registered.task_id, 'hang'],
    } });
    const result = await runTask({
      service,
      taskId: registered.task_id,
      adapter,
      leaseOptions: { ttlMs: 500, taskLeaseTtlMs: 500, heartbeatIntervalMs: 100 },
    });
    const processRecord = getNativeProcess(control, registered.attempt.attempt_id);
    nativePid = processRecord?.pid ?? null;
    assert.equal(result.status, 'indeterminate');
    assert.equal(result.error?.code, 'execution_timeout');
    assert.equal(result.attempt.submission, 'sent');
    assert.equal(executionTimeoutEvidence(control, registered.attempt.attempt_id)?.termination_confirmed, true);
    assert.equal(processRecord.process_state, 'exited');
    assert.equal(processRecord.workspace_guard_state, 'released');
    assert.equal(lines(path.join(workspace, 'received.txt')), 1);
    const inspected = await createProcessInspector().inspectProcess({ pid: nativePid });
    assert.equal(inspected.kind, 'absent');
  } finally {
    if (nativePid) try { process.kill(nativePid); } catch {}
    control.close();
  }
});

test('redundant timeout guardian survives one guardian death plus Worker death without prompt replay', { skip: process.platform !== 'win32' }, async () => {
  const root = path.join(base, `guardian-worker-death-${randomUUID()}`);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const control = new ControlDatabase(root);
  let runner = null;
  let nativePid = null;
  let killedGuardianPid = null;
  let survivorGuardianPid = null;
  try {
    const service = new TaskService(control);
    const first = request({
      workspace,
      execution: { observation_timeout_ms: 5_000, execution_timeout_ms: 1_500, effort: 'medium', permission: 'native' },
    });
    const registered = service.submit(first, { adapterVersion: 'opencode-timeout-fixture-1' });
    runner = spawn(process.execPath, [workerRunner, root, registered.task_id, fakeCli, 'hang'], {
      cwd: path.resolve('.'), windowsHide: true, stdio: 'ignore',
    });
    await waitFor(() => {
      const status = service.status(registered.task_id);
      const processRecord = getNativeProcess(control, status.attempt.attempt_id);
      if (processRecord?.pid) nativePid = processRecord.pid;
      const guardians = executionTimeoutGuardianReadySlots(control, registered.attempt.attempt_id);
      if (guardians.length >= 2) {
        killedGuardianPid = guardians[0].pid;
        survivorGuardianPid = guardians[1].pid;
      }
      return status.status === 'running' && status.attempt.submission === 'sent' && status.native?.session_id === 'ses_fixture' && guardians.length >= 2;
    });
    assert.equal(lines(path.join(workspace, 'received.txt')), 1);

    assert.ok(Number.isSafeInteger(killedGuardianPid) && killedGuardianPid > 0);
    assert.ok(Number.isSafeInteger(survivorGuardianPid) && survivorGuardianPid > 0);
    assert.notEqual(killedGuardianPid, survivorGuardianPid);
    process.kill(killedGuardianPid);
    await waitFor(async () => (await createProcessInspector().inspectProcess({ pid: killedGuardianPid })).kind === 'absent');

    runner.kill();
    await waitForExit(runner);

    await waitFor(() => executionTimeoutEvidence(control, registered.attempt.attempt_id)?.termination_confirmed === true, 7_000);
    await waitFor(() => getNativeProcess(control, registered.attempt.attempt_id)?.workspace_guard_state === 'released', 7_000);
    const dead = await createProcessInspector().inspectProcess({ pid: nativePid });
    assert.equal(dead.kind, 'absent');
    assert.equal(lines(path.join(workspace, 'received.txt')), 1);

    const resumed = service.resume(registered.task_id);
    assert.equal(resumed.mode, 'reconcile');
    const recoveryAdapter = new OpenCodeAdapter({ testDriver: {
      command: process.execPath,
      args: [fakeCli, 'opencode', registered.task_id, 'hang'],
      spawn() { throw new Error('timeout reconcile must never spawn'); },
    } });
    const reconciled = await reconcileTask({
      service,
      taskId: registered.task_id,
      adapter: recoveryAdapter,
      leaseOptions: { processInspector: createProcessInspector(), ttlMs: 1_000, heartbeatIntervalMs: 100 },
    });
    assert.equal(reconciled.status, 'indeterminate');
    assert.equal(reconciled.error?.code, 'execution_timeout');
    assert.equal(lines(path.join(workspace, 'received.txt')), 1);

    const second = request({ workspace, request_id: randomUUID() });
    const secondRegistered = service.submit(second, { adapterVersion: 'opencode-durable-fixture-1' });
    const secondAdapter = new OpenCodeAdapter({ testDriver: {
      command: process.execPath,
      args: [fakeCli, 'opencode', second.request_id, 'success'],
    } });
    const secondResult = await runTask({
      service,
      taskId: secondRegistered.task_id,
      adapter: secondAdapter,
      leaseOptions: { maxLeaseWaitMs: 500, leaseRetryIntervalMs: 20, ttlMs: 500, taskLeaseTtlMs: 500 },
    });
    assert.equal(secondResult.status, 'succeeded');
    assert.equal(lines(path.join(workspace, 'received.txt')), 2);
    assert.equal(lines(path.join(workspace, 'received.txt')), 2);
  } finally {
    if (runner && runner.exitCode === null) try { runner.kill(); } catch {}
    if (nativePid) try { process.kill(nativePid); } catch {}
    if (killedGuardianPid) try { process.kill(killedGuardianPid); } catch {}
    if (survivorGuardianPid) try { process.kill(survivorGuardianPid); } catch {}
    control.close();
  }
});

function lines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length : 0;
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail(`Timed out waiting for OpenCode durable fixture after ${timeoutMs}ms`);
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', resolve));
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
