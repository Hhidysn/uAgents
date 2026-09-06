import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { DoubaoDesktopBridge } from '../plugins/uagents/mcp/doubao/src/cdp.mjs';
import { DoubaoAdapter } from '../plugins/uagents/src/adapters/doubao/adapter.mjs';
import { TraeAdapter } from '../plugins/uagents/src/adapters/trae/adapter.mjs';
import { TraeGatewayClient } from '../plugins/uagents/mcp/trae/src/client.mjs';
import { createTargetSupervisor } from '../plugins/uagents/src/host/target-supervisor.mjs';
import { HostStore } from '../plugins/uagents/src/host/host-store.mjs';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { persistCheckpoint } from '../plugins/uagents/src/runtime/checkpoints.mjs';
import { reconcileTask } from '../plugins/uagents/src/runtime/reconcile.mjs';

function jsonResponse(value, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: () => null },
    json: async () => value,
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(value)).buffer,
  };
}

class FakeCdpSocket extends EventEmitter {
  readyState = WebSocket.OPEN;

  addEventListener(type, listener) {
    if (type === 'open') {
      this.once(type, listener);
      setImmediate(() => this.emit('open'));
    } else {
      this.on(type, listener);
    }
  }

  send(raw) {
    const message = JSON.parse(raw);
    if (message.method !== 'Runtime.evaluate') return;
    const value = { replies: ['Doubao answer'], active: false, finished: true, approval: false, total: 2 };
    setImmediate(() => this.emit('message', {
      data: JSON.stringify({ id: message.id, result: { result: { value } } }),
    }));
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

test('Doubao reconcile routes an actual DesktopBridge to the persisted managed port', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return jsonResponse([{
      type: 'page',
      id: 'page-1',
      url: 'doubaowork://doubaowork-chat/chat/conversation-1',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page-1',
    }]);
  };
  const bridge = new DoubaoDesktopBridge({ port: 9222, fetchImpl, websocketFactory: () => new FakeCdpSocket() });
  const adapter = new DoubaoAdapter({ bridge, pollIntervalMs: 0 });
  const result = await adapter.reconcile({
    task_id: 'page-1', session_id: 'conversation-1', user_message_index: 0,
  }, { managed: { port: 19222, instance_id: 'managed-doubao-1', profile_generation: 1 } });

  assert.equal(result.type, 'succeeded');
  assert.ok(requests.length > 0);
  assert.ok(requests.every((url) => url.startsWith('http://127.0.0.1:19222/')));
  assert.equal(requests.some((url) => url.startsWith('http://127.0.0.1:9222/')), false);
});

test('TRAE reconcile injects the managed gateway context, verifies nonce, and never submits', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, authorization: options.headers?.Authorization ?? null });
    if (url.endsWith('/api/status')) return jsonResponse({ instance_nonce: 'nonce-1' });
    if (url.endsWith('/api/tasks/submit')) return jsonResponse({ taskId: 'unexpected' });
    if (url.endsWith('/api/task/trae-task-1')) return jsonResponse({ status: 'done', result: { text: 'TRAE answer', stable: true } });
    return jsonResponse({ error: 'not_found' }, false, 404);
  };
  const adapter = new TraeAdapter({ client: new TraeGatewayClient({ port: 8788, fetchImpl }), pollIntervalMs: 0 });
  const result = await adapter.reconcile({ task_id: 'trae-task-1' }, {
    managed: {
      gateway_port: 19422,
      instance_nonce: 'nonce-1',
      capability_token: 'memory-only-token',
      instance_id: 'managed-trae-1',
      profile_generation: 1,
    },
  });

  assert.equal(result.type, 'succeeded');
  assert.equal(requests.some((request) => request.url.endsWith('/api/tasks/submit')), false);
  assert.ok(requests.every((request) => request.url.startsWith('http://127.0.0.1:19422/')));
  assert.ok(requests.some((request) => request.url.endsWith('/api/status') && request.authorization === 'Bearer memory-only-token'));

  const rejected = await adapter.reconcile({ task_id: 'trae-task-1' }, {
    managed: { gateway_port: 19422, instance_nonce: 'wrong-nonce', capability_token: 'memory-only-token' },
  });
  assert.equal(rejected.type, 'indeterminate');
  assert.equal(rejected.error, 'gateway_identity_mismatch');
});

test('supervisor reconciles only the persisted managed generation and never launches a replacement', async () => {
  const root = resolve('.local', 'test-runs', `managed-reconcile-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const env = { LOCALAPPDATA: root };
  const installation = {
    installation_id: 'inst-doubao', target: 'doubao', artifact_kind: 'desktop-exe',
    canonical_path: 'C:\\fake\\DoubaoWork.exe',
  };
  const hostStore = new HostStore({ env });
  hostStore.upsertInstallation('installation:doubao', installation);
  const calls = [];
  const runPowerShell = async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'inspect-process') return { exists: true, started_at_ms: 1111, executable_path: installation.canonical_path };
    if (action === 'inspect-listener') return { listening: true, listener_pid: 4242 };
    throw new Error(`unexpected action: ${action}`);
  };
  const launches = [];
  const launcher = async () => {
    launches.push(true);
    return { process: { pid: 4242, started_at_ms: 1111 }, port: 19222 };
  };
  const supervisor = createTargetSupervisor({
    hostStore,
    locator: { resolve: async () => installation },
    runPowerShell,
    env,
    launchers: { doubao: launcher },
    now: () => 1700000001000,
  });
  try {
    const ensured = await supervisor.ensure('doubao');
    supervisor.releaseInstanceLease(ensured.lease);
    const reconciled = await supervisor.reconcile('doubao', ensured.lifecycle);
    assert.equal(reconciled.mode, 'reconcile');
    assert.equal(reconciled.instance.instance_id, ensured.instance.instance_id);
    assert.equal(reconciled.managed.port, 19222);
    supervisor.releaseInstanceLease(reconciled.lease);
    assert.equal(launches.length, 1);

    await assert.rejects(
      () => supervisor.reconcile('doubao', { instance_id: 'managed-doubao-foreign', profile_generation: 1 }),
      { code: 'managed_instance_identity_mismatch' },
    );
    assert.equal(launches.length, 1);
    assert.equal(calls.some(({ action }) => action === 'taskkill'), false);
  } finally {
    hostStore.close();
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
  }
});

function acceptedTask(service, control, { target, lifecycle, handle }) {
  const registered = service.submit({
    schema_version: '1.0', request_id: randomUUID(), target, model: 'default', mode: 'analysis', prompt: 'reconcile only',
    execution: { observation_timeout_ms: 5_000, effort: 'low', permission: 'native' },
    policy: { fallback: 'none', max_cost_usd: null },
  });
  const attemptId = registered.attempt.attempt_id;
  service.transition(registered.task_id, 'queued', { attemptId });
  service.transition(registered.task_id, 'starting', { attemptId });
  persistCheckpoint(control, {
    taskId: registered.task_id, attemptId, kind: 'possibly_sent',
    payload: { target, lifecycle },
  });
  persistCheckpoint(control, {
    taskId: registered.task_id, attemptId, kind: 'accepted',
    payload: { target, lifecycle, handle, evidence_ref: `${target}:accepted` },
  });
  return registered;
}

test('rejected reconcile evidence cannot overwrite the last trusted response', async () => {
  const root = resolve('.local', 'test-runs', `rejected-reconcile-${randomUUID()}`);
  const control = new ControlDatabase(root);
  try {
    const service = new TaskService(control);
    const task = acceptedTask(service, control, {
      target: 'doubao', handle: { session_id: 'original-session', task_id: 'original-page' },
    });
    const attemptId = task.attempt.attempt_id;
    service.transition(task.task_id, 'waiting_user', { attemptId, evidenceStrength: 2 });
    service.transition(task.task_id, 'indeterminate', { attemptId, evidenceStrength: 1 });
    service.recordResponse(task.task_id, 'previous trusted response');
    for (const [sameIdentity, evidenceStrength, code] of [
      [false, 3, 'native_session_mismatch'],
      [true, 1, 'insufficient_evidence'],
    ]) {
      const adapter = { reconcile: async () => ({
        type: 'succeeded', same_native_identity: sameIdentity, evidence_strength: evidenceStrength,
        response: 'untrusted replacement',
      }) };
      await assert.rejects(() => reconcileTask({ service, taskId: task.task_id, adapter }), { code });
      assert.equal(service.result(task.task_id).response.text, 'previous trusted response');
      assert.equal(service.status(task.task_id).status, 'indeterminate');
      assert.equal(control.raw.prepare('SELECT count(*) AS count FROM leases').get().count, 0);
    }
  } finally { control.close(); }
});

test('runtime reconcile passes the exact accepted managed context and performs no dispatch or ensure', async () => {
  const root = resolve('.local', 'test-runs', `runtime-managed-reconcile-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const control = new ControlDatabase(root);
  try {
    const service = new TaskService(control);
    const lifecycle = {
      state: 'ready', instance_id: 'managed-doubao-1', installation_id: 'inst-doubao',
      profile_generation: 1, started_by_uagents: true, reused: true,
    };
    const registered = acceptedTask(service, control, {
      target: 'doubao', lifecycle,
      handle: { session_id: 'conversation-1', task_id: 'page-1', user_message_index: 2, status: 'accepted' },
    });
    const seen = {};
    const adapter = {
      reconcile: async (native, context) => {
        seen.native = native;
        seen.context = context;
        return { type: 'succeeded', same_native_identity: true, evidence_strength: 3, response: 'reconciled' };
      },
      dispatch: async () => { throw new Error('dispatch must not run during reconcile'); },
    };
    const lease = { resource_key: 'instance:doubao', owner_nonce: 'supervisor', epoch: 1, fencing_token: 'fence' };
    let ensureCalled = false;
    const supervisor = {
      reconcile: async (target, identity) => {
        assert.equal(target, 'doubao');
        assert.deepEqual(identity, lifecycle);
        return { lease, managed: { port: 19222, instance_id: identity.instance_id, profile_generation: 1 } };
      },
      renewInstanceLease: value => value,
      releaseInstanceLease: () => {},
      ensure: async () => { ensureCalled = true; throw new Error('ensure must not run during reconcile'); },
    };
    const result = await reconcileTask({ service, taskId: registered.task_id, adapter, supervisor });
    assert.equal(result.status, 'succeeded');
    assert.equal(ensureCalled, false);
    assert.equal(seen.native.user_message_index, 2);
    assert.equal(seen.context.managed.port, 19222);
  } finally {
    control.close();
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
  }
});

test('a failed reconcile read keeps waiting-user evidence weak enough for later same-identity success', async () => {
  const root = resolve('.local', 'test-runs', `reconcile-evidence-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const control = new ControlDatabase(root);
  try {
    const service = new TaskService(control);
    const registered = acceptedTask(service, control, {
      target: 'doubao',
      lifecycle: undefined,
      handle: { session_id: 'conversation-1', task_id: 'page-1', status: 'accepted' },
    });
    service.transition(registered.task_id, 'waiting_user', {
      attemptId: registered.attempt.attempt_id,
      sameNativeIdentity: true,
      evidenceStrength: 2,
      event: { native_status: 'needs_user', interaction: { phase: 'approval' } },
    });
    let calls = 0;
    const adapter = {
      reconcile: async () => {
        calls += 1;
        return calls === 1
          ? { type: 'indeterminate', same_native_identity: true, evidence_strength: 1, error: 'cdp_unavailable' }
          : { type: 'succeeded', same_native_identity: true, evidence_strength: 2, response: 'stable result' };
      },
    };
    const first = await reconcileTask({ service, taskId: registered.task_id, adapter });
    assert.equal(first.status, 'indeterminate');
    const second = await reconcileTask({ service, taskId: registered.task_id, adapter });
    assert.equal(second.status, 'succeeded');
  } finally {
    control.close();
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
  }
});
