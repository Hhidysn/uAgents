import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { invokeCodexAppServerTurn, readCodexAppServerTurn } from '../plugins/uagents/src/transports/codex-app-server.mjs';
import { CodexAdapter } from '../plugins/uagents/src/adapters/codex/adapter.mjs';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { UnifiedRuntime } from '../plugins/uagents/src/runtime/api.mjs';
import { runTask } from '../plugins/uagents/src/runtime/worker.mjs';
import { runRegisteredTask } from '../plugins/uagents/src/runtime/worker-factory.mjs';
import { reconcileTask } from '../plugins/uagents/src/runtime/reconcile.mjs';
import { getNativeProcess } from '../plugins/uagents/src/runtime/native-processes.mjs';
import { taskDirectory } from '../plugins/uagents/src/store/task-files.mjs';
import { refreshWorkspaceExecutionGuard } from '../plugins/uagents/src/runtime/workspace-execution-guard.mjs';
import { createRegistry } from '../plugins/uagents/src/registry/registry.mjs';

const entry = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
const execEntry = fileURLToPath(new URL('./fixtures/fake-codex-session-cli.mjs', import.meta.url));
const crashWorkerEntry = fileURLToPath(new URL('./fixtures/codex-app-server-crash-worker.mjs', import.meta.url));
const root = path.resolve('.local', 'test-runs', randomUUID(), 'codex-app-server');
const request = (prompt, workspace) => ({
  prompt, workspace, mode: 'analysis', model_resolved: 'gpt-5.6-luna', expected_outputs: [],
  execution: { observation_timeout_ms: 2_000 },
});
function directory() {
  const workspace = path.join(root, randomUUID());
  fs.mkdirSync(workspace, { recursive: true });
  return workspace;
}
function calls(workspace) {
  return JSON.parse(fs.readFileSync(path.join(workspace, '.codex-app-server-fixture.json'), 'utf8')).calls;
}

test('Codex app-server fixture completes one turn with checkpoint before prompt and both native IDs', async () => {
  const workspace = directory();
  const order = [];
  const result = await invokeCodexAppServerTurn({ entry, workspace, request: request('fixture-success', workspace),
    beforeSend(threadId) { assert.match(threadId, /^[0-9a-f-]{36}$/); order.push('possibly_sent'); },
    onAccepted(handle) { assert.match(handle.task_id, /^[0-9a-f-]{36}$/); order.push('accepted'); },
  });
  assert.deepEqual(order, ['possibly_sent', 'accepted']);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.submission, 'sent');
  assert.equal(result.response, 'fixture app-server answer');
  assert.equal(result.native_status, 'completed');
  assert.equal(result.launcher_close_confirmed, true);
  assert.deepEqual(calls(workspace).map(call => call.method), ['initialize', 'initialized', 'thread/start', 'turn/start']);
  const turn = calls(workspace).at(-1);
  assert.equal(turn.params.threadId, result.native_session_id);
  assert.equal(turn.params.model, 'gpt-5.6-luna');
  assert.match(turn.params.input[0].text, /fixture-success/);
});

test('Codex app-server sends localImage inputs in the native turn', async () => {
  const workspace = directory();
  const imagePath = path.join(workspace, 'sample.png');
  fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/2uoAAAAASUVORK5CYII=', 'base64'));
  const result = await invokeCodexAppServerTurn({ entry, workspace,
    request: request('fixture-success', workspace), imagePaths: [imagePath] });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls(workspace).at(-1).params.input[1], { type: 'localImage', path: imagePath });
});

test('Codex app-server checkpoint failure prevents turn/start bytes', async () => {
  const workspace = directory();
  const result = await invokeCodexAppServerTurn({ entry, workspace, request: request('fixture-checkpoint', workspace),
    beforeSend() { throw Error('fixture checkpoint failure'); },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.submission, 'not_sent');
  assert.equal(result.error, 'checkpoint_failed');
  assert.deepEqual(calls(workspace).map(call => call.method), ['initialize', 'initialized', 'thread/start']);
});

test('Codex app-server buffers native notifications that precede the turn/start response', async () => {
  const workspace = directory();
  const result = await invokeCodexAppServerTurn({ entry, workspace,
    request: request('fixture-early-events', workspace) });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.response, 'fixture app-server answer');
});

test('Codex app-server missing terminal, wrong thread and approval request remain uncertain', async () => {
  for (const [prompt, expected] of [
    ['fixture-missing-terminal', 'native_terminal_missing'],
    ['fixture-wrong-thread', 'native_session_mismatch'],
    ['fixture-approval', 'native_approval_required'],
  ]) {
    const workspace = directory();
    const result = await invokeCodexAppServerTurn({ entry, workspace, request: request(prompt, workspace) });
    assert.equal(result.status, 'unknown', prompt);
    assert.equal(result.error, expected, prompt);
    assert.notEqual(result.submission, 'not_sent', prompt);
    assert.equal(calls(workspace).filter(call => call.method === 'turn/start').length, 1);
  }
});

test('Codex app-server never answers native approval requests', async () => {
  for (const prompt of ['fixture-approval-command-early', 'fixture-approval-file']) {
    const workspace = directory();
    const result = await invokeCodexAppServerTurn({ entry, workspace,
      request: request(prompt, workspace) });
    assert.equal(result.status, 'unknown');
    assert.equal(result.error, 'native_approval_required');
    assert.notEqual(result.submission, 'not_sent');
    assert.equal(calls(workspace).filter(call => call.method === 'turn/start').length, 1);
    assert.equal(calls(workspace).filter(call => call.id === 99 && call.result).length, 0);
  }
});

test('Codex app-server records a native approval requirement without replay', async () => {
  for (const prompt of ['fixture-approval-command', 'fixture-approval-command-early']) {
    const workspace = directory();
    const stateRoot = path.join(root, randomUUID(), 'state');
    const control = new ControlDatabase(stateRoot);
    try {
      const service = new TaskService(control);
      const input = { schema_version: '1.0', request_id: randomUUID(), target: 'codex',
        model: 'gpt-5.6-luna', mode: 'analysis', prompt, workspace,
        execution: { observation_timeout_ms: 4_000, effort: 'low', permission: 'native' },
        policy: { fallback: 'none', max_cost_usd: null } };
      service.submit(input, { adapterVersion: 'codex-app-server-prototype', dispatchTransport: 'app-server' });
      const adapter = new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: entry }) });
      const result = await runTask({ service, taskId: input.request_id, adapter });
      assert.equal(result.status, 'indeterminate');
      assert.notEqual(result.attempt.submission, 'not_sent');
      assert.equal(result.error?.code, 'native_approval_required');
      assert.equal(calls(workspace).filter(call => call.method === 'turn/start').length, 1);
      assert.equal(calls(workspace).filter(call => call.id === 99 && call.result).length, 0);
      assert.equal(control.raw.prepare("SELECT count(*) AS total FROM events WHERE task_id = ? AND type LIKE 'approval.%'")
        .get(input.request_id).total, 0);
    } finally { control.close(); }
  }
});
test('Codex app-server cancelled before dispatch does not spawn', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await invokeCodexAppServerTurn({ entry, workspace: directory(),
    request: request('fixture-cancel', root), signal: controller.signal,
    spawnImpl() { throw Error('must not spawn'); },
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.submission, 'not_sent');
});

test('Codex app-server confirms cancellation only from the matching interrupted Turn', async () => {
  for (const prompt of ['fixture-interrupt', 'fixture-interrupt-lost-ack']) {
    const workspace = directory();
    const controller = new AbortController();
    const result = await invokeCodexAppServerTurn({ entry, workspace, request: request(prompt, workspace),
      signal: controller.signal, onAccepted() { controller.abort(); } });
    assert.equal(result.status, 'cancelled', prompt);
    assert.equal(result.native_status, 'interrupted', prompt);
    assert.equal(result.launcher_close_confirmed, true, prompt);
    assert.equal(result.submission, 'sent', prompt);
    const interrupt = calls(workspace).find(call => call.method === 'turn/interrupt');
    assert.deepEqual(interrupt.params, { threadId: result.native_session_id, turnId: result.native_turn_id });
    const read = await readCodexAppServerTurn({ entry, workspace,
      threadId: result.native_session_id, turnId: result.native_turn_id });
    assert.equal(read.type, 'cancelled', prompt);
    assert.equal(read.native_status, 'interrupted', prompt);
  }
});

test('Codex app-server interrupt acknowledgement without terminal stays uncertain', async () => {
  const workspace = directory();
  const controller = new AbortController();
  const input = request('fixture-interrupt-no-terminal', workspace);
  input.execution.observation_timeout_ms = 300;
  const result = await invokeCodexAppServerTurn({ entry, workspace, request: input,
    signal: controller.signal, onAccepted() { controller.abort(); }, closeGraceMs: 50 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.error, 'native_process_forced_stop');
  assert.equal(result.forced_termination, true);
  assert.equal(calls(workspace).filter(call => call.method === 'turn/interrupt').length, 1);
});

test('Codex app-server rejected interrupt keeps the Turn uncertain and exposes the RPC failure', async () => {
  const workspace = directory();
  const controller = new AbortController();
  const result = await invokeCodexAppServerTurn({ entry, workspace,
    request: request('fixture-interrupt-rpc-error', workspace),
    signal: controller.signal, onAccepted() { controller.abort(); }, closeGraceMs: 50 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.error, 'native_rpc_error');
  assert.equal(result.native_status, 'unknown');
  assert.equal(calls(workspace).filter(call => call.method === 'turn/interrupt').length, 1);
});

test('Codex app-server reports a completed Turn even when cancellation raced with completion', async () => {
  const workspace = directory();
  const controller = new AbortController();
  const result = await invokeCodexAppServerTurn({ entry, workspace,
    request: request('fixture-interrupt-completes', workspace),
    signal: controller.signal, onAccepted() { controller.abort(); } });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.native_status, 'completed');
  assert.equal(result.response, 'fixture completed before interrupt');
  assert.equal(calls(workspace).filter(call => call.method === 'turn/interrupt').length, 1);
});

test('Codex app-server cancellation before turn/start acknowledgement cannot assume an interrupt target', async () => {
  const workspace = directory();
  const controller = new AbortController();
  const input = request('fixture-interrupt-before-turn-ack', workspace);
  input.execution.observation_timeout_ms = 300;
  const result = await invokeCodexAppServerTurn({ entry, workspace, request: input,
    signal: controller.signal, closeGraceMs: 50,
    beforeSend() { setTimeout(() => controller.abort(), 50); } });
  assert.equal(result.status, 'unknown');
  assert.equal(result.submission, 'may_have_been_sent');
  assert.equal(calls(workspace).filter(call => call.method === 'turn/interrupt').length, 0);
});

test('Codex adapters reject unverified exec/app-server cross-transport continuation', async () => {
  const workspace = directory();
  const fromTask = randomUUID();
  const nativeThread = randomUUID();
  const input = { ...request('fixture-cross-transport', workspace),
    session: { continue_from_task_id: fromTask } };
  const appServer = new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: entry }) });
  await assert.rejects(() => appServer.prepare(input, { session: {
    action: 'continue', from_task_id: fromTask, native_session_id: nativeThread,
  } }), { code: 'invalid_native_session', submission: 'not_sent' });
  const exec = new CodexAdapter({ entryResolver: async () => ({ canonical_path: entry }) });
  await assert.rejects(() => exec.prepare(input, { session: {
    action: 'continue', from_task_id: fromTask, native_session_id: nativeThread,
    native_turn_id: randomUUID(), native_transport: 'app-server',
  } }), { code: 'invalid_native_session', submission: 'not_sent' });
});

test('Codex app-server prototype persists native Thread and Turn through TaskService', async () => {
  const workspace = directory();
  const control = new ControlDatabase(path.join(root, randomUUID(), 'state'));
  try {
    const service = new TaskService(control);
    const input = { schema_version: '1.0', request_id: randomUUID(), target: 'codex',
      model: 'gpt-5.6-luna', mode: 'analysis', prompt: 'fixture-runtime', workspace,
      execution: { observation_timeout_ms: 2_000, effort: 'low', permission: 'native' },
      policy: { fallback: 'none', max_cost_usd: null } };
    const registered = service.submit(input, { adapterVersion: 'codex-app-server-prototype' });
    const adapter = new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: entry }) });
    const result = await runTask({ service, taskId: registered.task_id, adapter });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.attempt.submission, 'sent');
    assert.match(result.native.session_id, /^[0-9a-f-]{36}$/);
    assert.match(result.native.task_id, /^[0-9a-f-]{36}$/);
    assert.equal(result.native.status, 'completed');
    assert.equal(result.native.evidence_ref, 'codex:app-server-thread-turn');
    const nativeProcess = getNativeProcess(control, result.attempt.attempt_id);
    assert.equal(nativeProcess.process_state, 'exited');
    assert.equal(nativeProcess.workspace_guard_state, 'released');
    assert.ok(nativeProcess.pid > 0);
    assert.ok(nativeProcess.process_started_at_ms > 0);
    assert.equal(service.result(result.task_id).response.text, 'fixture app-server answer');
    assert.deepEqual(service.events(result.task_id).filter(event => event.type.startsWith('dispatch.'))
      .map(event => event.type), ['dispatch.possibly_sent', 'dispatch.accepted']);
    assert.equal(calls(workspace).find(call => call.method === 'turn/start').params.clientUserMessageId,
      input.request_id);
  } finally { control.close(); }
});

test('public Codex app-server opt-in retains transport through standard Worker continuation and fork', { skip: process.platform !== 'win32' }, async () => {
  const workspace = directory();
  const stateRoot = path.join(root, randomUUID(), 'state');
  const control = new ControlDatabase(stateRoot);
  try {
    const service = new TaskService(control);
    const selected = [];
    const workerOptions = {
      adapterFactory(target, options) {
        selected.push({ target, transport: options?.transport ?? 'exec' });
        return new CodexAdapter({ transport: options?.transport ?? 'exec',
          entryResolver: async () => ({ canonical_path: entry }) });
      },
      supervisorFactory: async () => null,
    };
    const turn = async (prompt, session = null) => {
      const input = { schema_version: '1.0', request_id: randomUUID(), target: 'codex',
        model: 'gpt-6-astra', mode: 'analysis', prompt, workspace,
        execution: { observation_timeout_ms: 2_000, effort: 'low', permission: 'native', codex_transport: 'app-server' },
        policy: { fallback: 'none', max_cost_usd: null }, ...(session ? { session } : {}) };
      service.submit(input);
      assert.equal(service.payload(input.request_id).payload.dispatch_transport, 'app-server');
      if (!session) {
        assert.throws(() => service.submit({ ...input, execution: { ...input.execution, codex_transport: undefined } }),
          { code: 'request_conflict', submission: 'not_sent' });
      }
      const result = await runRegisteredTask(stateRoot, input.request_id, workerOptions);
      assert.equal(result.status, 'succeeded');
      return result;
    };
    const first = await turn('fixture-standard-worker-start');
    const continued = await turn('fixture-standard-worker-continue', { continue_from_task_id: first.task_id });
    assert.equal(continued.native.session_id, first.native.session_id);
    const forked = await turn('fixture-standard-worker-fork', { fork_from_task_id: continued.task_id });
    assert.notEqual(forked.native.session_id, continued.native.session_id);
    const branch = await turn('fixture-standard-worker-branch', { continue_from_task_id: forked.task_id });
    assert.equal(branch.native.session_id, forked.native.session_id);
    assert.deepEqual(selected, Array.from({ length: 4 }, () => ({ target: 'codex', transport: 'app-server' })));
    assert.equal(calls(workspace).filter(call => call.method === 'turn/start').length, 4);
  } finally { control.close(); }
});

test('standard Worker defaults to Codex exec and rejects a changed transport payload', async () => {
  const workspace = directory();
  const stateRoot = path.join(root, randomUUID(), 'state');
  const control = new ControlDatabase(stateRoot);
  try {
    const service = new TaskService(control);
    const base = { schema_version: '1.0', target: 'codex', model: 'gpt-5.6-luna',
      mode: 'analysis', workspace,
      execution: { observation_timeout_ms: 2_000, effort: 'low', permission: 'native' },
      policy: { fallback: 'none', max_cost_usd: null } };
    const input = { ...base, request_id: randomUUID(), prompt: 'fixture-turn-default' };
    service.submit(input);
    const selections = [];
    const workerOptions = { adapterFactory(target, options) {
      selections.push({ target, options });
      return new CodexAdapter({ transport: options?.transport ?? 'exec',
        entryResolver: async () => ({ canonical_path: execEntry }) });
    }, supervisorFactory: async () => null };
    const result = await runRegisteredTask(stateRoot, input.request_id, workerOptions);
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(selections, [{ target: 'codex', options: undefined }]);
    if (process.platform === 'win32') {
      assert.throws(() => service.submit({ ...base, request_id: randomUUID(), model: 'gpt-6-astra',
        prompt: 'fixture-cross-transport-source',
        execution: { ...base.execution, codex_transport: 'app-server' },
        session: { continue_from_task_id: result.task_id } }),
      { code: 'invalid_native_session', submission: 'not_sent' });
    }

    const altered = { ...base, request_id: randomUUID(), prompt: 'fixture-turn-tampered' };
    service.submit(altered);
    const payloadFile = path.join(taskDirectory(stateRoot, altered.request_id), 'payload.json');
    const payload = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
    fs.writeFileSync(payloadFile, JSON.stringify({ ...payload, dispatch_transport: 'app-server' }));
    await assert.rejects(() => runRegisteredTask(stateRoot, altered.request_id, workerOptions),
      { code: 'invalid_request', submission: 'not_sent' });
    assert.equal(selections.length, 1);
  } finally { control.close(); }
});

test('Codex app-server keeps the workspace guard until descendant quiescence is proven', async () => {
  const workspace = directory();
  const control = new ControlDatabase(path.join(root, randomUUID(), 'state'));
  try {
    const service = new TaskService(control);
    const input = { schema_version: '1.0', request_id: randomUUID(), target: 'codex',
      model: 'gpt-5.6-luna', mode: 'analysis', prompt: 'fixture-process-tree', workspace,
      execution: { observation_timeout_ms: 2_000, effort: 'low', permission: 'native' },
      policy: { fallback: 'none', max_cost_usd: null } };
    service.submit(input, { adapterVersion: 'codex-app-server-prototype' });
    const inspector = {
      inspectProcess: async ({ pid }) => ({ kind: 'alive', pid,
        started_at_ms: Date.now(), executable_path: process.execPath }),
      inspectProcessTree: async () => ({ kind: 'active_descendants', descendants: [
        { pid: 987654, parent_pid: 123456, started_at_ms: Date.now() },
      ] }),
    };
    const adapter = new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: entry }) });
    const result = await runTask({ service, taskId: input.request_id, adapter,
      leaseOptions: { processInspector: inspector } });
    assert.equal(result.status, 'indeterminate');
    assert.equal(result.error?.code, 'process_tree_unconfirmed');
    const guarded = getNativeProcess(control, result.attempt.attempt_id);
    assert.equal(guarded.process_state, 'exited');
    assert.equal(guarded.workspace_guard_state, 'held');
    const readCount = calls(workspace).filter(call => call.method === 'thread/read').length;
    const pending = await reconcileTask({ service, taskId: input.request_id, adapter,
      leaseOptions: { processInspector: inspector } });
    assert.equal(pending.status, 'indeterminate');
    assert.equal(calls(workspace).filter(call => call.method === 'thread/read').length, readCount);
    const refreshed = await refreshWorkspaceExecutionGuard(control, result.attempt.attempt_id, {
      inspector: { ...inspector, inspectProcessTree: async () => ({ kind: 'quiescent', descendants: [] }) },
    });
    assert.equal(refreshed.workspace_guard_state, 'released');
  } finally { control.close(); }
});

test('Codex app-server does not persist a PID-less guard or send RPC when launcher identity fails', async () => {
  const workspace = directory();
  const control = new ControlDatabase(path.join(root, randomUUID(), 'state'));
  try {
    const service = new TaskService(control);
    const input = { schema_version: '1.0', request_id: randomUUID(), target: 'codex',
      model: 'gpt-5.6-luna', mode: 'analysis', prompt: 'fixture-identity-failure', workspace,
      execution: { observation_timeout_ms: 2_000, effort: 'low', permission: 'native' },
      policy: { fallback: 'none', max_cost_usd: null } };
    service.submit(input, { adapterVersion: 'codex-app-server-prototype' });
    const adapter = new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: entry }) });
    const result = await runTask({ service, taskId: input.request_id, adapter, leaseOptions: {
      processInspector: { inspectProcess: async () => ({ kind: 'inspection_failed' }),
        inspectProcessTree: async () => ({ kind: 'quiescent', descendants: [] }) },
    } });
    assert.equal(result.status, 'failed');
    assert.equal(result.attempt.submission, 'not_sent');
    assert.equal(result.error?.code, 'native_process_identity_mismatch');
    assert.equal(getNativeProcess(control, result.attempt.attempt_id), null);
    assert.equal(fs.existsSync(path.join(workspace, '.codex-app-server-fixture.json')), false);
  } finally { control.close(); }
});

test('Codex app-server TaskService cancellation follows the observed native terminal', async () => {
  for (const [prompt, expectedStatus, nativeStatus] of [
    ['fixture-interrupt', 'cancelled', 'interrupted'],
    ['fixture-interrupt-completes', 'succeeded', 'completed'],
  ]) {
    const workspace = directory();
    const control = new ControlDatabase(path.join(root, randomUUID(), 'state'));
    try {
      const service = new TaskService(control);
      const input = { schema_version: '1.0', request_id: randomUUID(), target: 'codex',
        model: 'gpt-5.6-luna', mode: 'analysis', prompt, workspace,
        execution: { observation_timeout_ms: 4_000, effort: 'low', permission: 'native' },
        policy: { fallback: 'none', max_cost_usd: null } };
      service.submit(input, { adapterVersion: 'codex-app-server-prototype' });
      const adapter = new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: entry }) });
      const running = runTask({ service, taskId: input.request_id, adapter });
      try {
        let accepted = false;
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          if (service.events(input.request_id).some(event => event.type === 'dispatch.accepted')) {
            accepted = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(accepted, true);
        assert.equal(service.requestCancel(input.request_id).cancel_accepted, true);
        const result = await running;
        assert.equal(result.status, expectedStatus, prompt);
        assert.equal(result.native_outcome, expectedStatus, prompt);
        assert.equal(result.objective_verdict, expectedStatus, prompt);
        assert.equal(result.native.status, nativeStatus, prompt);
        assert.equal(result.attempt.submission, 'sent', prompt);
        assert.equal(calls(workspace).filter(call => call.method === 'turn/interrupt').length, 1, prompt);
      } finally {
        await running.catch(() => {});
      }
    } finally { control.close(); }
  }
});

test('Codex app-server TaskService preserves cancellation failure reason when no terminal arrives', async () => {
  const workspace = directory();
  const control = new ControlDatabase(path.join(root, randomUUID(), 'state'));
  try {
    const service = new TaskService(control);
    const input = { schema_version: '1.0', request_id: randomUUID(), target: 'codex',
      model: 'gpt-5.6-luna', mode: 'analysis', prompt: 'fixture-interrupt-no-terminal', workspace,
      execution: { observation_timeout_ms: 1_000, effort: 'low', permission: 'native' },
      policy: { fallback: 'none', max_cost_usd: null } };
    service.submit(input, { adapterVersion: 'codex-app-server-prototype' });
    const adapter = new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: entry }) });
    const running = runTask({ service, taskId: input.request_id, adapter });
    for (let i = 0; i < 100; i++) {
      if (service.events(input.request_id).some(event => event.type === 'dispatch.accepted')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(service.requestCancel(input.request_id).cancel_accepted, true);
    const result = await running;
    assert.equal(result.status, 'indeterminate');
    assert.equal(result.native.status, 'unknown');
    assert.ok(result.error?.code);
    assert.equal(result.native_outcome, null);
  } finally { control.close(); }
});

test('Codex app-server recovers a cancelled Turn when the terminal notification was lost', async () => {
  const workspace = directory();
  const control = new ControlDatabase(path.join(root, randomUUID(), 'state'));
  try {
    const service = new TaskService(control);
    const input = { schema_version: '1.0', request_id: randomUUID(), target: 'codex',
      model: 'gpt-5.6-luna', mode: 'analysis', prompt: 'fixture-interrupt-missing-terminal-saved', workspace,
      execution: { observation_timeout_ms: 2_000, effort: 'low', permission: 'native' },
      policy: { fallback: 'none', max_cost_usd: null } };
    service.submit(input, { adapterVersion: 'codex-app-server-prototype' });
    const adapter = new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: entry }) });
    const running = runTask({ service, taskId: input.request_id, adapter });
    for (let i = 0; i < 100; i++) {
      if (service.events(input.request_id).some(event => event.type === 'dispatch.accepted')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(service.requestCancel(input.request_id).cancel_accepted, true);
    const unknown = await running;
    assert.equal(unknown.status, 'indeterminate');
    assert.equal(getNativeProcess(control, unknown.attempt.attempt_id).workspace_guard_state, 'released');
    const recovered = await reconcileTask({ service, taskId: input.request_id, adapter });
    assert.equal(recovered.status, 'cancelled');
    assert.equal(recovered.native.status, 'interrupted');
    assert.equal(recovered.native_outcome, 'cancelled');
    assert.equal(calls(workspace).filter(call => call.method === 'turn/start').length, 1);
  } finally { control.close(); }
});

test('Codex app-server reconciles a Turn after the Worker crashes at accepted without replay', async () => {
  const workspace = directory();
  const stateRoot = path.join(root, randomUUID(), 'state');
  const taskId = randomUUID();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [crashWorkerEntry, stateRoot, workspace, taskId], {
      cwd: path.resolve('.'), windowsHide: true, stdio: 'ignore',
    });
    const timeout = setTimeout(() => { child.kill(); reject(Error('Crash Worker timed out.')); }, 15_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(exitCode, 42);
  const control = new ControlDatabase(stateRoot);
  try {
    const service = new TaskService(control);
    const crashed = service.status(taskId);
    assert.equal(crashed.attempt.submission, 'sent');
    assert.match(crashed.native.session_id, /^[0-9a-f-]{36}$/);
    assert.match(crashed.native.task_id, /^[0-9a-f-]{36}$/);
    let processRecord;
    for (let i = 0; i < 50; i++) {
      processRecord = await refreshWorkspaceExecutionGuard(control, crashed.attempt.attempt_id);
      if (processRecord?.workspace_guard_state === 'released') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(processRecord?.workspace_guard_state, 'released');
    const expiry = Number(control.raw.prepare('SELECT max(expires_at_ms) AS value FROM leases').get()?.value ?? 0);
    if (expiry >= Date.now()) await new Promise(resolve => setTimeout(resolve, expiry - Date.now() + 10));
    const runtime = new UnifiedRuntime({ stateRoot,
      adapterFactory: (target, options) => {
        assert.equal(target, 'codex');
        assert.equal(options?.transport, 'app-server');
        return new CodexAdapter({ ...options, entryResolver: async () => ({ canonical_path: entry }) });
      } });
    let recovered;
    try { recovered = await runtime.reconcile(taskId); }
    finally { runtime.close(); }
    assert.equal(recovered.status, 'succeeded');
    assert.equal(recovered.native.status, 'completed');
    assert.equal(service.result(taskId).response.text, 'fixture crash recovery answer');
    assert.equal(calls(workspace).filter(call => call.method === 'turn/start').length, 1);
  } finally { control.close(); }
});

test('Codex app-server crash after possibly-sent checkpoint never replays the unsent Turn', async () => {
  const workspace = directory();
  const stateRoot = path.join(root, randomUUID(), 'state');
  const taskId = randomUUID();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [crashWorkerEntry, stateRoot, workspace, taskId, 'possibly-sent'], {
      cwd: path.resolve('.'), windowsHide: true, stdio: 'ignore',
    });
    const timeout = setTimeout(() => { child.kill(); reject(Error('Crash Worker timed out.')); }, 15_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(exitCode, 43);
  const control = new ControlDatabase(stateRoot);
  try {
    const service = new TaskService(control);
    const crashed = service.status(taskId);
    assert.equal(crashed.attempt.submission, 'may_have_been_sent');
    assert.equal(crashed.native, null);
    assert.equal(getNativeProcess(control, crashed.attempt.attempt_id), null);
    assert.equal(service.resume(taskId).mode, 'reconcile');
    const expiry = Number(control.raw.prepare('SELECT max(expires_at_ms) AS value FROM leases').get()?.value ?? 0);
    if (expiry >= Date.now()) await new Promise(resolve => setTimeout(resolve, expiry - Date.now() + 10));
    const runtime = new UnifiedRuntime({ stateRoot,
      adapterFactory: (target, options) => {
        assert.equal(target, 'codex');
        assert.equal(options?.transport, 'app-server');
        return new CodexAdapter({ ...options, entryResolver: async () => ({ canonical_path: entry }) });
      } });
    let recovered;
    try { recovered = await runtime.resume(taskId); }
    finally { runtime.close(); }
    assert.equal(recovered.status, 'indeterminate');
    assert.equal(recovered.native, null);
    assert.equal(calls(workspace).filter(call => call.method === 'turn/start').length, 0);
  } finally { control.close(); }
});

test('Codex app-server recovers a Worker crash after native turn/start but before its acknowledgement', async () => {
  const workspace = directory();
  const stateRoot = path.join(root, randomUUID(), 'state');
  const taskId = randomUUID();
  const child = spawn(process.execPath, [crashWorkerEntry, stateRoot, workspace, taskId, 'after-send-before-ack'], {
    cwd: path.resolve('.'), windowsHide: true, stdio: 'ignore',
  });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  let saved = false;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const file = path.join(workspace, '.codex-app-server-fixture.json');
    if (fs.existsSync(file)) {
      const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
      saved = journal.calls.some(call => call.method === 'turn/start' &&
        call.params?.clientUserMessageId === taskId) && Object.values(journal.threads).some(turns =>
        turns.some(turn => turn.items?.some(item => item.type === 'userMessage' && item.clientId === taskId)));
      if (saved) break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill();
  await closed;
  assert.equal(saved, true, 'The fixture must durably save the Turn before the Worker crash.');
  const control = new ControlDatabase(stateRoot);
  try {
    const service = new TaskService(control);
    const crashed = service.status(taskId);
    assert.equal(crashed.attempt.submission, 'may_have_been_sent');
    assert.equal(crashed.native, null);
    let processRecord;
    for (let index = 0; index < 50; index++) {
      processRecord = await refreshWorkspaceExecutionGuard(control, crashed.attempt.attempt_id);
      if (processRecord?.workspace_guard_state === 'released') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(processRecord?.workspace_guard_state, 'released');
    const expiry = Number(control.raw.prepare('SELECT max(expires_at_ms) AS value FROM leases').get()?.value ?? 0);
    if (expiry >= Date.now()) await new Promise(resolve => setTimeout(resolve, expiry - Date.now() + 10));
    const runtime = new UnifiedRuntime({ stateRoot,
      adapterFactory: (target, options) => {
        assert.equal(target, 'codex');
        assert.equal(options?.transport, 'app-server');
        return new CodexAdapter({ ...options, entryResolver: async () => ({ canonical_path: entry }) });
      } });
    let recovered;
    try { recovered = await runtime.resume(taskId); }
    finally { runtime.close(); }
    assert.equal(recovered.status, 'succeeded');
    assert.equal(recovered.attempt.submission, 'sent');
    assert.match(recovered.native.task_id, /^[0-9a-f-]{36}$/);
    assert.equal(service.result(taskId).response.text, 'fixture crash after send answer');
    assert.equal(calls(workspace).filter(call => call.method === 'turn/start').length, 1);
  } finally { control.close(); }
});

test('Codex app-server reconciles a lost completion notification using the accepted native Turn', async () => {
  const workspace = directory();
  const control = new ControlDatabase(path.join(root, randomUUID(), 'state'));
  try {
    const service = new TaskService(control);
    const input = { schema_version: '1.0', request_id: randomUUID(), target: 'codex',
      model: 'gpt-5.6-luna', mode: 'analysis', prompt: 'fixture-missing-terminal-saved', workspace,
      execution: { observation_timeout_ms: 2_000, effort: 'low', permission: 'native' },
      policy: { fallback: 'none', max_cost_usd: null } };
    service.submit(input, { adapterVersion: 'codex-app-server-prototype' });
    const adapter = new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: entry }) });
    const uncertain = await runTask({ service, taskId: input.request_id, adapter });
    assert.equal(uncertain.status, 'indeterminate');
    assert.equal(uncertain.attempt.submission, 'sent');
    assert.match(uncertain.native.session_id, /^[0-9a-f-]{36}$/);
    assert.match(uncertain.native.task_id, /^[0-9a-f-]{36}$/);
    const wrongTurn = await readCodexAppServerTurn({ entry, workspace,
      threadId: uncertain.native.session_id, turnId: randomUUID() });
    assert.equal(wrongTurn.type, 'indeterminate');
    const reconciled = await reconcileTask({ service, taskId: input.request_id, adapter });
    assert.equal(reconciled.status, 'succeeded');
    assert.equal(reconciled.native.status, 'completed');
    assert.equal(service.result(input.request_id).response.text, 'fixture app-server answer');
  } finally { control.close(); }
});

test('Codex app-server keeps an accepted Turn indeterminate when native history is unreadable', async () => {
  const workspace = directory();
  const control = new ControlDatabase(path.join(root, randomUUID(), 'state'));
  try {
    const service = new TaskService(control);
    const input = { schema_version: '1.0', request_id: randomUUID(), target: 'codex',
      model: 'gpt-5.6-luna', mode: 'analysis', prompt: 'fixture-empty-rollout-after-accepted', workspace,
      execution: { observation_timeout_ms: 2_000, effort: 'low', permission: 'native' },
      policy: { fallback: 'none', max_cost_usd: null } };
    service.submit(input, { adapterVersion: 'codex-app-server-prototype' });
    const adapter = new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: entry }) });
    const uncertain = await runTask({ service, taskId: input.request_id, adapter });
    assert.equal(uncertain.status, 'indeterminate');
    assert.equal(uncertain.attempt.submission, 'sent');
    assert.match(uncertain.native.task_id, /^[0-9a-f-]{36}$/);
    const reconciled = await reconcileTask({ service, taskId: input.request_id, adapter });
    assert.equal(reconciled.status, 'indeterminate');
    assert.equal(reconciled.attempt.submission, 'sent');
    assert.equal(reconciled.native.task_id, uncertain.native.task_id);
    assert.equal(calls(workspace).filter(call => call.method === 'turn/start').length, 1);
    assert.equal(calls(workspace).filter(call => call.method === 'thread/read').length, 1);
  } finally { control.close(); }
});

test('Codex app-server locates a lost turn/start acknowledgement by persisted client message ID', async () => {
  const workspace = directory();
  const control = new ControlDatabase(path.join(root, randomUUID(), 'state'));
  try {
    const service = new TaskService(control);
    const input = { schema_version: '1.0', request_id: randomUUID(), target: 'codex',
      model: 'gpt-5.6-luna', mode: 'analysis', prompt: 'fixture-no-turn-ack-saved', workspace,
      execution: { observation_timeout_ms: 2_000, effort: 'low', permission: 'native' },
      policy: { fallback: 'none', max_cost_usd: null } };
    service.submit(input, { adapterVersion: 'codex-app-server-prototype' });
    const adapter = new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: entry }) });
    const uncertain = await runTask({ service, taskId: input.request_id, adapter });
    assert.equal(uncertain.status, 'indeterminate');
    assert.equal(uncertain.attempt.submission, 'may_have_been_sent');
    assert.equal(uncertain.native, null);
    const checkpoint = service.events(input.request_id).find(event => event.type === 'dispatch.possibly_sent');
    assert.match(checkpoint.payload.native_session_id, /^[0-9a-f-]{36}$/);
    const file = path.join(workspace, '.codex-app-server-fixture.json');
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (let index = 0; index < 70; index++) journal.threads[checkpoint.payload.native_session_id].push({
      id: randomUUID(), status: 'completed', items: [],
    });
    fs.writeFileSync(file, JSON.stringify(journal));
    const reconciled = await reconcileTask({ service, taskId: input.request_id, adapter });
    assert.equal(reconciled.status, 'succeeded');
    assert.equal(reconciled.attempt.submission, 'sent');
    assert.equal(reconciled.native.session_id, checkpoint.payload.native_session_id);
    assert.match(reconciled.native.task_id, /^[0-9a-f-]{36}$/);
    assert.equal(service.result(input.request_id).response.text, 'fixture app-server answer');
    assert.equal(calls(workspace).filter(call => call.method === 'turn/start').length, 1);
    assert.ok(calls(workspace).filter(call => call.method === 'thread/turns/list').length >= 2);
  } finally { control.close(); }
});

test('Codex app-server falls back to full Turn history when item pagination is unsupported', async () => {
  const workspace = directory();
  const control = new ControlDatabase(path.join(root, randomUUID(), 'state'));
  try {
    const service = new TaskService(control);
    const input = { schema_version: '1.0', request_id: randomUUID(), target: 'codex',
      model: 'gpt-5.6-luna', mode: 'analysis', prompt: 'fixture-no-turn-ack-saved', workspace,
      execution: { observation_timeout_ms: 2_000, effort: 'low', permission: 'native' },
      policy: { fallback: 'none', max_cost_usd: null } };
    service.submit(input, { adapterVersion: 'codex-app-server-prototype' });
    const adapter = new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: entry }) });
    const uncertain = await runTask({ service, taskId: input.request_id, adapter });
    assert.equal(uncertain.status, 'indeterminate');
    const file = path.join(workspace, '.codex-app-server-fixture.json');
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    const threadId = Object.keys(journal.threads)[0];
    const turnId = journal.threads[threadId][0].id;
    journal.fixtureItemsListUnsupported = true;
    for (let index = 0; index < 70; index++) journal.threads[threadId].push({
      id: randomUUID(), status: 'completed', items: [],
    });
    fs.writeFileSync(file, JSON.stringify(journal));
    const known = await readCodexAppServerTurn({ entry, workspace, threadId, turnId });
    assert.equal(known.type, 'succeeded');
    assert.equal(known.native_turn_id, turnId);
    journal.threads[threadId].push({ ...journal.threads[threadId][0], id: randomUUID() });
    fs.writeFileSync(file, JSON.stringify(journal));
    const duplicate = await readCodexAppServerTurn({ entry, workspace, threadId,
      clientRequestId: input.request_id });
    assert.equal(duplicate.type, 'indeterminate');
    journal.threads[threadId].pop();
    fs.writeFileSync(file, JSON.stringify(journal));
    const reconciled = await reconcileTask({ service, taskId: input.request_id, adapter });
    assert.equal(reconciled.status, 'succeeded');
    assert.equal(reconciled.native.task_id, turnId);
    assert.equal(service.result(input.request_id).response.text, 'fixture app-server answer');
    assert.equal(calls(workspace).filter(call => call.method === 'turn/start').length, 1);
    assert.ok(calls(workspace).some(call => call.method === 'thread/turns/list' &&
      call.params.itemsView === 'full' && call.params.cursor !== undefined));
  } finally { control.close(); }
});

test('Codex app-server rejects an incomplete full Turn history fallback', async () => {
  const workspace = directory();
  const control = new ControlDatabase(path.join(root, randomUUID(), 'state'));
  try {
    const service = new TaskService(control);
    const input = { schema_version: '1.0', request_id: randomUUID(), target: 'codex',
      model: 'gpt-5.6-luna', mode: 'analysis', prompt: 'fixture-missing-terminal-saved', workspace,
      execution: { observation_timeout_ms: 2_000, effort: 'low', permission: 'native' },
      policy: { fallback: 'none', max_cost_usd: null } };
    service.submit(input, { adapterVersion: 'codex-app-server-prototype' });
    const adapter = new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: entry }) });
    const uncertain = await runTask({ service, taskId: input.request_id, adapter });
    assert.equal(uncertain.status, 'indeterminate');
    const file = path.join(workspace, '.codex-app-server-fixture.json');
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    journal.fixtureItemsListUnsupported = true;
    journal.fixtureFullItemsIncomplete = true;
    fs.writeFileSync(file, JSON.stringify(journal));
    const reconciled = await reconcileTask({ service, taskId: input.request_id, adapter });
    assert.equal(reconciled.status, 'indeterminate');
    assert.equal(reconciled.attempt.submission, 'sent');
    assert.equal(reconciled.native.task_id, uncertain.native.task_id);
    assert.equal(calls(workspace).filter(call => call.method === 'turn/start').length, 1);
    assert.ok(calls(workspace).some(call => call.method === 'thread/turns/list' &&
      call.params.itemsView === 'full'));
  } finally { control.close(); }
});

test('Codex app-server does not accept an ambiguous duplicate client message ID', async () => {
  const workspace = directory();
  const control = new ControlDatabase(path.join(root, randomUUID(), 'state'));
  try {
    const service = new TaskService(control);
    const input = { schema_version: '1.0', request_id: randomUUID(), target: 'codex',
      model: 'gpt-5.6-luna', mode: 'analysis', prompt: 'fixture-no-turn-ack-saved', workspace,
      execution: { observation_timeout_ms: 2_000, effort: 'low', permission: 'native' },
      policy: { fallback: 'none', max_cost_usd: null } };
    service.submit(input, { adapterVersion: 'codex-app-server-prototype' });
    const adapter = new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: entry }) });
    const uncertain = await runTask({ service, taskId: input.request_id, adapter });
    assert.equal(uncertain.status, 'indeterminate');
    const file = path.join(workspace, '.codex-app-server-fixture.json');
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    const threadId = Object.keys(journal.threads)[0];
    journal.threads[threadId].push({ ...journal.threads[threadId][0], id: randomUUID() });
    fs.writeFileSync(file, JSON.stringify(journal));
    const after = await reconcileTask({ service, taskId: input.request_id, adapter });
    assert.equal(after.status, 'indeterminate');
    assert.equal(after.native, null);
    assert.equal(after.attempt.submission, 'may_have_been_sent');
  } finally { control.close(); }
});

test('Codex app-server prototype continues and forks at a persisted source Turn boundary', async () => {
  const workspace = directory();
  const control = new ControlDatabase(path.join(root, randomUUID(), 'state'));
  try {
    const registry = structuredClone(createRegistry());
    registry.targets.codex.resume = true;
    registry.targets.codex.fork = true;
    const service = new TaskService(control, { registry });
    const adapter = new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: entry }) });
    const turn = async (prompt, session = null) => {
      const input = { schema_version: '1.0', request_id: randomUUID(), target: 'codex',
        model: 'gpt-5.6-luna', mode: 'analysis', prompt, workspace,
        execution: { observation_timeout_ms: 2_000, effort: 'low', permission: 'native' },
        policy: { fallback: 'none', max_cost_usd: null }, ...(session ? { session } : {}) };
      service.submit(input, { adapterVersion: 'codex-app-server-prototype' });
      const result = await runTask({ service, taskId: input.request_id, adapter });
      assert.equal(result.status, 'succeeded');
      return result;
    };
    const first = await turn('fixture-start');
    const continued = await turn('fixture-continue', { continue_from_task_id: first.task_id });
    assert.equal(continued.native.session_id, first.native.session_id);
    assert.notEqual(continued.native.task_id, first.native.task_id);
    const binding = service.payload(continued.task_id).payload.session;
    assert.match(binding.installation_fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(binding, {
      action: 'continue', from_task_id: first.task_id, native_session_id: first.native.session_id,
      native_turn_id: first.native.task_id, native_transport: 'app-server',
      installation_fingerprint: binding.installation_fingerprint,
    });
    const forked = await turn('fixture-fork', { fork_from_task_id: continued.task_id });
    assert.notEqual(forked.native.session_id, continued.native.session_id);
    const branch = await turn('fixture-branch', { continue_from_task_id: forked.task_id });
    assert.equal(branch.native.session_id, forked.native.session_id);
    const oldFork = await turn('fixture-fork-old-completed-turn', { fork_from_task_id: first.task_id });
    assert.notEqual(oldFork.native.session_id, first.native.session_id);
    assert.notEqual(oldFork.native.session_id, forked.native.session_id);
    const nativeCalls = calls(workspace);
    assert.deepEqual(nativeCalls.filter(call => ['thread/start', 'thread/resume', 'thread/fork'].includes(call.method))
      .map(call => call.method), ['thread/start', 'thread/resume', 'thread/fork', 'thread/resume', 'thread/fork']);
    assert.deepEqual(nativeCalls.filter(call => call.method === 'thread/fork').map(call => call.params.lastTurnId),
      [continued.native.task_id, first.native.task_id]);
    assert.equal(nativeCalls.filter(call => call.method === 'turn/start').length, 5);
    const journal = JSON.parse(fs.readFileSync(path.join(workspace, '.codex-app-server-fixture.json'), 'utf8'));
    assert.deepEqual(journal.threads[oldFork.native.session_id].map(item => item.id),
      [first.native.task_id, oldFork.native.task_id]);
  } finally { control.close(); }
});

test('Codex app-server refuses continuation after its CLI installation identity changes', async () => {
  const workspace = directory();
  const control = new ControlDatabase(path.join(root, randomUUID(), 'state'));
  try {
    const registry = structuredClone(createRegistry());
    registry.targets.codex.resume = true;
    const service = new TaskService(control, { registry });
    const base = { schema_version: '1.0', target: 'codex', model: 'gpt-5.6-luna',
      mode: 'analysis', workspace,
      execution: { observation_timeout_ms: 2_000, effort: 'low', permission: 'native' },
      policy: { fallback: 'none', max_cost_usd: null } };
    const firstId = randomUUID();
    service.submit({ ...base, request_id: firstId, prompt: 'fixture-start' },
      { adapterVersion: 'codex-app-server-prototype' });
    const first = await runTask({ service, taskId: firstId,
      adapter: new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: entry }) }) });
    assert.equal(first.status, 'succeeded');
    const alternateEntry = path.join(workspace, 'alternate-codex-fixture.mjs');
    fs.copyFileSync(entry, alternateEntry);
    const nextId = randomUUID();
    service.submit({ ...base, request_id: nextId, prompt: 'fixture-installation-change',
      session: { continue_from_task_id: firstId } }, { adapterVersion: 'codex-app-server-prototype' });
    await assert.rejects(() => runTask({ service, taskId: nextId,
      adapter: new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: alternateEntry }) }) }),
    { code: 'invalid_native_session', submission: 'not_sent' });
    const next = service.status(nextId);
    assert.equal(next.status, 'failed');
    assert.equal(next.attempt.submission, 'not_sent');
    assert.equal(next.error?.code, 'invalid_native_session');
    assert.equal(calls(workspace).filter(call => call.method === 'turn/start').length, 1);
  } finally { control.close(); }
});

test('Codex app-server installation fingerprint changes when its native executable changes', async () => {
  const workspace = directory();
  const triple = process.platform === 'win32'
    ? process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
    : process.platform === 'darwin'
      ? process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
      : process.arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl';
  const cliDirectory = path.join(workspace, 'cli');
  const cliEntry = path.join(cliDirectory, 'bin', 'codex.js');
  const nativeBinary = path.join(cliDirectory, 'vendor', triple, 'bin',
    process.platform === 'win32' ? 'codex.exe' : 'codex');
  fs.mkdirSync(path.dirname(cliEntry), { recursive: true });
  fs.mkdirSync(path.dirname(nativeBinary), { recursive: true });
  fs.writeFileSync(path.join(cliDirectory, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(entry, cliEntry);
  fs.writeFileSync(nativeBinary, 'first native binary');
  const adapter = new CodexAdapter({ transport: 'app-server',
    entryResolver: async () => ({ canonical_path: cliEntry }) });
  const first = await adapter.prepare(request('fixture-binary-one', workspace));
  fs.writeFileSync(nativeBinary, 'second native binary');
  const second = await adapter.prepare(request('fixture-binary-two', workspace));
  assert.match(first.installationFingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(second.installationFingerprint, first.installationFingerprint);
});

test('Codex app-server refuses a continued thread advanced outside uAgents and forks at the source Turn', async () => {
  const workspace = directory();
  const control = new ControlDatabase(path.join(root, randomUUID(), 'state'));
  try {
    const registry = structuredClone(createRegistry());
    registry.targets.codex.resume = true;
    registry.targets.codex.fork = true;
    const service = new TaskService(control, { registry });
    const adapter = new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: entry }) });
    const submit = (prompt, session = null) => {
      const input = { schema_version: '1.0', request_id: randomUUID(), target: 'codex',
        model: 'gpt-5.6-luna', mode: 'analysis', prompt, workspace,
        execution: { observation_timeout_ms: 2_000, effort: 'low', permission: 'native' },
        policy: { fallback: 'none', max_cost_usd: null }, ...(session ? { session } : {}) };
      service.submit(input, { adapterVersion: 'codex-app-server-prototype' });
      return input.request_id;
    };
    const firstId = submit('fixture-start');
    const first = await runTask({ service, taskId: firstId, adapter });
    assert.equal(first.status, 'succeeded');
    const file = path.join(workspace, '.codex-app-server-fixture.json');
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    const externalTurnId = randomUUID();
    journal.threads[first.native.session_id].push({ id: externalTurnId, status: 'completed', items: [] });
    for (let index = 0; index < 70; index++) journal.threads[first.native.session_id].push({
      id: randomUUID(), status: 'completed', items: [],
    });
    fs.writeFileSync(file, JSON.stringify(journal));
    const continuedId = submit('fixture-stale-continue', { continue_from_task_id: firstId });
    const continued = await runTask({ service, taskId: continuedId, adapter });
    assert.equal(continued.status, 'failed');
    assert.equal(continued.attempt.submission, 'not_sent');
    assert.equal(continued.error?.code, 'native_session_mismatch');
    const forkId = submit('fixture-boundary-fork', { fork_from_task_id: firstId });
    const fork = await runTask({ service, taskId: forkId, adapter });
    assert.equal(fork.status, 'succeeded');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.calls.filter(call => call.method === 'turn/start').length, 2);
    assert.equal(after.calls.find(call => call.method === 'thread/fork').params.lastTurnId, first.native.task_id);
    assert.deepEqual(after.threads[fork.native.session_id].map(turn => turn.id), [first.native.task_id, fork.native.task_id]);
    assert.ok(after.calls.filter(call => call.method === 'thread/turns/list').length >= 2);
  } finally { control.close(); }
});

test('Codex app-server fails closed on a looping native history cursor before fork sends a prompt', async () => {
  const workspace = directory();
  const control = new ControlDatabase(path.join(root, randomUUID(), 'state'));
  try {
    const registry = structuredClone(createRegistry());
    registry.targets.codex.fork = true;
    const service = new TaskService(control, { registry });
    const adapter = new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: entry }) });
    const base = { schema_version: '1.0', target: 'codex', model: 'gpt-5.6-luna',
      mode: 'analysis', workspace,
      execution: { observation_timeout_ms: 4_000, effort: 'low', permission: 'native' },
      policy: { fallback: 'none', max_cost_usd: null } };
    const firstId = randomUUID();
    service.submit({ ...base, request_id: firstId, prompt: 'fixture-start' });
    const first = await runTask({ service, taskId: firstId, adapter });
    assert.equal(first.status, 'succeeded');
    const file = path.join(workspace, '.codex-app-server-fixture.json');
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    journal.threads[first.native.session_id].push({ id: randomUUID(), status: 'completed', items: [] });
    journal.fixtureHistoryPageSize = 1;
    journal.fixtureHistoryCursorLoop = true;
    fs.writeFileSync(file, JSON.stringify(journal));
    const forkId = randomUUID();
    service.submit({ ...base, request_id: forkId, prompt: 'fixture-looping-history',
      session: { fork_from_task_id: firstId } });
    const fork = await runTask({ service, taskId: forkId, adapter });
    assert.equal(fork.status, 'failed');
    assert.equal(fork.attempt.submission, 'not_sent');
    assert.equal(fork.error?.code, 'native_history_incomplete');
    assert.equal(calls(workspace).filter(call => call.method === 'turn/start').length, 1);
  } finally { control.close(); }
});

test('Codex app-server rechecks the resumed thread before sending a continued Turn', async () => {
  const workspace = directory();
  const control = new ControlDatabase(path.join(root, randomUUID(), 'state'));
  try {
    const registry = structuredClone(createRegistry());
    registry.targets.codex.resume = true;
    const service = new TaskService(control, { registry });
    const adapter = new CodexAdapter({ transport: 'app-server', entryResolver: async () => ({ canonical_path: entry }) });
    const base = { schema_version: '1.0', target: 'codex', model: 'gpt-5.6-luna',
      mode: 'analysis', workspace,
      execution: { observation_timeout_ms: 2_000, effort: 'low', permission: 'native' },
      policy: { fallback: 'none', max_cost_usd: null } };
    const firstId = randomUUID();
    service.submit({ ...base, request_id: firstId, prompt: 'fixture-start' });
    const first = await runTask({ service, taskId: firstId, adapter });
    assert.equal(first.status, 'succeeded');
    const file = path.join(workspace, '.codex-app-server-fixture.json');
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    journal.fixtureAdvanceOnResume = true;
    fs.writeFileSync(file, JSON.stringify(journal));
    const continuedId = randomUUID();
    service.submit({ ...base, request_id: continuedId, prompt: 'fixture-continue-after-external-turn',
      session: { continue_from_task_id: firstId } });
    const continued = await runTask({ service, taskId: continuedId, adapter });
    assert.equal(continued.status, 'failed');
    assert.equal(continued.attempt.submission, 'not_sent');
    assert.equal(continued.error?.code, 'native_session_mismatch');
    const nativeCalls = calls(workspace);
    assert.equal(nativeCalls.filter(call => call.method === 'thread/resume').length, 1);
    assert.equal(nativeCalls.filter(call => call.method === 'turn/start').length, 1);
  } finally { control.close(); }
});
