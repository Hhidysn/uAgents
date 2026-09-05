import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DoubaoAdapter } from '../plugins/uagents/src/adapters/doubao/adapter.mjs';
import { TraeAdapter } from '../plugins/uagents/src/adapters/trae/adapter.mjs';
import { TraeGatewayClient } from '../plugins/uagents/mcp/trae/src/client.mjs';
import { validateAdapter } from '../plugins/uagents/src/adapters/contract.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { runTask } from '../plugins/uagents/src/runtime/worker.mjs';
import { reconcileTask } from '../plugins/uagents/src/runtime/reconcile.mjs';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';

const root = path.resolve('.local', 'test-runs', randomUUID(), 'desktop adapters');
fs.mkdirSync(root, { recursive: true });
const baseRequest = patch => ({
  schema_version: '1.0', request_id: randomUUID(), target: 'doubao', model: 'default', mode: 'analysis', prompt: 'bounded',
  execution: { observation_timeout_ms: 5_000, effort: 'medium', permission: 'native' },
  policy: { fallback: 'none', max_cost_usd: null }, ...patch,
});

class DoubaoBridge {
  constructor() { this.sends = 0; this.observations = [{ status: 'running' }, { status: 'succeeded', response: '豆包完成', evidence: { stable_ms: 300 } }]; }
  async probe() { return { status: 'available', submission: 'not_sent' }; }
  async prepareAndSubmit(prompt, publish) {
    await publish({ submission: 'may_have_been_sent' });
    this.sends++;
    this.prompt = prompt;
    return { target_id: 'page-1', native_conversation_id: 'conversation-1', user_message_index: 0 };
  }
  async inspect() { return this.observations.shift(); }
}

class TraeClient {
  constructor() { this.sends = 0; this.observations = [{ status: 'executing' }, { status: 'done', result: { text: 'TRAE 完成', stable: true } }]; }
  async status() { return { version: 'fixture', status: 'connected', cdpReachable: true, traeRunning: true, surface: { kind: 'workspace', url: 'file:///workbench/workbench.html' } }; }
  async submit(body, requestId) { this.sends++; this.body = body; this.requestId = requestId; return { taskId: 'trae-task-1', status: 'accepted' }; }
  async task() { return this.observations.shift(); }
}

for (const target of ['doubao', 'trae']) test(`${target} adapter completes through the shared runtime`, async () => {
  const control = new ControlDatabase(path.join(root, `${target}-${randomUUID()}`));
  try {
    const service = new TaskService(control);
    const transport = target === 'doubao' ? new DoubaoBridge() : new TraeClient();
    const adapter = target === 'doubao'
      ? new DoubaoAdapter({ bridge: transport, pollIntervalMs: 0 })
      : new TraeAdapter({ client: transport, pollIntervalMs: 0 });
    validateAdapter(adapter);
    const registered = service.submit(baseRequest({ target }), { adapterVersion: 'desktop-fixture-1' });
    const result = await runTask({ service, taskId: registered.task_id, adapter });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.attempt.submission, 'sent');
    assert.equal(transport.sends, 1);
    assert.equal(result.model_reported, null);
    assert.equal(result.model_verified, false);
    assert.match(service.result(result.task_id).response.text, /完成/);
    assert.deepEqual(service.events(result.task_id).map(event => event.type), [
      'task.registered', 'task.queued', 'task.starting', 'dispatch.possibly_sent', 'dispatch.accepted', 'task.running', 'task.succeeded',
    ]);
  } finally { control.close(); }
});

test('TRAE identity failure happens before the possibly-sent checkpoint', async () => {
  const client = new TraeClient();
  client.status = async () => ({ traeRunning: false, surface: { kind: 'unknown', url: 'doubaowork://chat' } });
  const adapter = new TraeAdapter({ client, pollIntervalMs: 0 });
  await assert.rejects(adapter.prepare(baseRequest({ target: 'trae' })), { code: 'trae_identity_unconfirmed', submission: 'not_sent' });
  assert.equal(client.sends, 0);
});

test('TRAE quota errors are normalized after the possibly-sent checkpoint', async () => {
  const client = new TraeClient();
  client.submit = async () => { throw Object.assign(new Error('insufficient credits'), { code: 'balance_insufficient' }); };
  const adapter = new TraeAdapter({ client, pollIntervalMs: 0 });
  const checkpoints = [];
  await assert.rejects(adapter.dispatch(await adapter.prepare(baseRequest({ target: 'trae' })), {
    checkpoint: kind => checkpoints.push(kind),
  }), { code: 'quota_exhausted', submission: 'may_have_been_sent' });
  assert.deepEqual(checkpoints, ['possibly_sent']);
});

test('desktop sends happen only after the durable possibly-sent checkpoint', async () => {
  const order = [];
  const bridge = new DoubaoBridge();
  const original = bridge.prepareAndSubmit.bind(bridge);
  bridge.prepareAndSubmit = (prompt, publish) => original(prompt, async patch => { await publish(patch); order.push('checkpoint'); });
  const adapter = new DoubaoAdapter({ bridge, pollIntervalMs: 0 });
  await adapter.dispatch(await adapter.prepare(baseRequest()), {
    checkpoint: async kind => { if (kind === 'possibly_sent') assert.equal(bridge.sends, 0); order.push(kind); },
  });
  assert.deepEqual(order, ['possibly_sent', 'checkpoint', 'accepted']);

  const client = new TraeClient();
  const trae = new TraeAdapter({ client, pollIntervalMs: 0 });
  await trae.dispatch(await trae.prepare(baseRequest({ target: 'trae' })), {
    checkpoint: async kind => { if (kind === 'possibly_sent') assert.equal(client.sends, 0); },
  });
  assert.equal(client.sends, 1);
});

test('desktop probe and prepare map whitelisted transport codes to target_not_ready', async () => {
  const bridge = new DoubaoBridge();
  bridge.probe = async () => { throw Object.assign(new Error('cdp socket closed'), { code: 'cdp_unavailable' }); };
  const doubao = new DoubaoAdapter({ bridge, pollIntervalMs: 0 });
  await assert.rejects(doubao.probe(), { code: 'target_not_ready', submission: 'not_sent', details: { cause_code: 'cdp_unavailable' } });
  await assert.rejects(doubao.prepare(baseRequest()), { code: 'target_not_ready', submission: 'not_sent', details: { cause_code: 'cdp_unavailable' } });

  const client = new TraeClient();
  client.status = async () => { throw Object.assign(new Error('gateway offline'), { code: 'gateway_unavailable' }); };
  const trae = new TraeAdapter({ client, pollIntervalMs: 0 });
  await assert.rejects(trae.probe(), { code: 'target_not_ready', submission: 'not_sent', details: { cause_code: 'gateway_unavailable' } });
  await assert.rejects(trae.prepare(baseRequest({ target: 'trae' })), { code: 'target_not_ready', submission: 'not_sent', details: { cause_code: 'gateway_unavailable' } });
});

test('desktop probe and prepare keep unknown transport codes internal without leaking cause_code', async () => {
  const bridge = new DoubaoBridge();
  bridge.probe = async () => { throw Object.assign(new Error('pipeline detonated'), { code: 'pipeline_detonated' }); };
  const doubao = new DoubaoAdapter({ bridge, pollIntervalMs: 0 });
  await assert.rejects(doubao.probe(), error => {
    assert.equal(error.code, 'internal_error');
    assert.equal(error.submission, 'not_sent');
    assert.notEqual(error.details?.cause_code, 'pipeline_detonated');
    return true;
  });
  bridge.probe = async () => { throw new Error('no code at all'); };
  await assert.rejects(doubao.prepare(baseRequest()), { code: 'internal_error', submission: 'not_sent' });

  const client = new TraeClient();
  client.status = async () => { throw Object.assign(new Error('gateway detonated'), { code: 'gateway_detonated' }); };
  const trae = new TraeAdapter({ client, pollIntervalMs: 0 });
  await assert.rejects(trae.probe(), error => {
    assert.equal(error.code, 'internal_error');
    assert.equal(error.submission, 'not_sent');
    assert.notEqual(error.details?.cause_code, 'gateway_detonated');
    return true;
  });
  await assert.rejects(trae.prepare(baseRequest({ target: 'trae' })), { code: 'internal_error', submission: 'not_sent' });
});

test('managed trae task waits for preflight login and resumes on the same attempt', async () => {
  const control = new ControlDatabase(path.join(root, `managed-trae-${randomUUID()}`));
  try {
    const service = new TaskService(control);
    const installation = {
      installation_id: 'inst-trae', target: 'trae', artifact_kind: 'desktop-exe',
      canonical_path: 'C:\\fake\\Programs\\Trae CN\\Trae CN.exe',
    };
    const instance = { instance_id: 'managed-trae-1', generation: 1, port: 19322, state: 'waiting_user' };
    let loggedIn = false;
    const supervisor = {
      ensure: async (target, context) => {
        assert.equal(target, 'trae');
        assert.equal(context.prompt, undefined, 'supervisor never receives the prompt');
        return {
          mode: loggedIn ? 'reuse' : 'launched',
          installation,
          instance,
          managed: {
            port: instance.port,
            instance_id: instance.instance_id,
            profile_generation: 1,
            gateway_port: 19422,
            instance_nonce: 'nonce-managed-1',
            capability_token: 'tok-managed-1',
          },
          lease: { resource_key: 'instance:trae', owner_nonce: 'worker', epoch: 1, fencing_token: 'fence-1' },
          lifecycle: loggedIn
            ? { state: 'ready', instance_id: instance.instance_id, installation_id: installation.installation_id, profile_generation: 1, started_by_uagents: true, reused: true }
            : { state: 'waiting_user', instance_id: instance.instance_id, installation_id: installation.installation_id, profile_generation: 1, started_by_uagents: true, reused: false, interaction_phase: 'preflight_login' },
        };
      },
      renewInstanceLease: (lease) => lease,
      releaseInstanceLease: () => {},
    };
    // Fake HTTP gateway layer: the adapter builds its managed client from the
    // legacy client's fetchImpl, so every managed request is captured here.
    const http = { requests: [], submits: 0, taskCalls: 0 };
    const respond = (body) => ({
      ok: true, status: 200, headers: { get: () => null },
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
    });
    const gatewayFetch = async (url, options = {}) => {
      http.requests.push({
        url, method: options.method ?? 'GET',
        authorization: options.headers?.Authorization ?? null,
        idempotencyKey: options.headers?.['Idempotency-Key'] ?? null,
      });
      if (url.endsWith('/api/status')) {
        return respond({
          status: 'connected', version: '0.6.0', cdpReachable: true, traeRunning: true,
          surface: loggedIn
            ? { kind: 'workspace', url: 'vscode-file://vscode-app/workbench.html', title: 'Trae CN' }
            : { kind: 'setup', url: 'vscode-file://vscode-app/setup/setup.html' },
          instance_nonce: 'nonce-managed-1',
        });
      }
      if (url.endsWith('/api/tasks/submit')) { http.submits += 1; return respond({ taskId: 'trae-task-1', status: 'accepted' }); }
      if (url.includes('/api/task/trae-task-1')) {
        http.taskCalls += 1;
        return respond(http.taskCalls === 1 ? { status: 'executing' } : { status: 'done', result: { text: 'TRAE 完成', stable: true } });
      }
      return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ error: 'not_found' })).buffer };
    };
    const legacyClient = new TraeGatewayClient({ port: 8788, token: '', fetchImpl: gatewayFetch });
    const adapter = new TraeAdapter({ client: legacyClient, pollIntervalMs: 0 });

    const input = baseRequest({ target: 'trae' });
    const registered = service.submit(input, { adapterVersion: 'desktop-fixture-1' });
    const waiting = await runTask({ service, taskId: registered.task_id, adapter, supervisor });
    assert.equal(waiting.status, 'waiting_user');
    assert.equal(waiting.attempt.submission, 'not_sent');
    assert.equal(http.requests.length, 0, 'no gateway traffic before the user completes first login');

    // Same-UUID submit resumes the same attempt instead of duplicating.
    const resubmitted = service.submit(input, { adapterVersion: 'desktop-fixture-1' });
    assert.equal(resubmitted.duplicate, true);
    assert.equal(resubmitted.resumed, true);

    // The user finished login; the resumed worker reuses the managed instance
    // and dispatches exactly once through the managed gateway endpoint.
    loggedIn = true;
    const completed = await runTask({ service, taskId: registered.task_id, adapter, supervisor });
    assert.equal(completed.status, 'succeeded');
    assert.equal(http.submits, 1, 'exactly one dispatch for the resumed attempt');
    assert.equal(completed.attempt.attempt_id, waiting.attempt.attempt_id);
    // Managed wiring: gateway port, capability token, request UUID idempotency.
    assert.ok(http.requests.every((request) => request.url.startsWith('http://127.0.0.1:19422/')), 'all traffic targets the managed gateway port');
    assert.ok(http.requests.some((request) => request.url.endsWith('/api/status') && request.authorization === 'Bearer tok-managed-1'), 'status carries the capability token');
    assert.ok(http.requests.some((request) => request.url.endsWith('/api/tasks/submit') && request.idempotencyKey === input.request_id), 'submit uses the request UUID as the native idempotency key');
  } finally { control.close(); }
});

test('desktop waiting-user task reconciles through the same native identity without resubmission', async () => {
  const control = new ControlDatabase(path.join(root, `reconcile-${randomUUID()}`));
  try {
    const service = new TaskService(control);
    const bridge = new DoubaoBridge();
    bridge.observations = [
      { status: 'needs_user', error: 'native_approval_required' },
      { status: 'succeeded', response: '审批后完成', evidence: { stable_ms: 300 } },
    ];
    const adapter = new DoubaoAdapter({ bridge, pollIntervalMs: 0 });
    const registered = service.submit(baseRequest({ target: 'doubao' }), { adapterVersion: 'desktop-fixture-1' });
    const waiting = await runTask({ service, taskId: registered.task_id, adapter });
    assert.equal(waiting.status, 'waiting_user');
    const completed = await reconcileTask({ service, taskId: waiting.task_id, adapter });
    assert.equal(completed.status, 'succeeded');
    assert.equal(bridge.sends, 1);
    assert.equal(service.result(waiting.task_id).response.text, '审批后完成');
  } finally { control.close(); }
});

test('managed doubao task waits for preflight login and resumes on the same attempt', async () => {
  const control = new ControlDatabase(path.join(root, `managed-${randomUUID()}`));
  try {
    const service = new TaskService(control);
    const bridge = new DoubaoBridge();
    const adapter = new DoubaoAdapter({ bridge, pollIntervalMs: 0 });
    const installation = {
      installation_id: 'inst-doubao', target: 'doubao', artifact_kind: 'desktop-exe',
      canonical_path: 'C:\\fake\\DoubaoWork\\Application\\DoubaoWork.exe',
    };
    const instance = { instance_id: 'managed-doubao-1', generation: 1, port: 19222, state: 'waiting_user' };
    let loggedIn = false;
    const supervisor = {
      ensure: async (target, context) => {
        assert.equal(target, 'doubao');
        assert.equal(context.prompt, undefined, 'supervisor never receives the prompt');
        return {
          mode: loggedIn ? 'reuse' : 'launched',
          installation,
          instance,
          lease: { resource_key: 'instance:doubao', owner_nonce: 'worker', epoch: 1, fencing_token: 'fence-1' },
          lifecycle: loggedIn
            ? { state: 'ready', instance_id: instance.instance_id, installation_id: installation.installation_id, profile_generation: 1, started_by_uagents: true, reused: true }
            : { state: 'waiting_user', instance_id: instance.instance_id, installation_id: installation.installation_id, profile_generation: 1, started_by_uagents: true, reused: false, interaction_phase: 'preflight_login' },
        };
      },
      renewInstanceLease: (lease) => lease,
      releaseInstanceLease: () => {},
    };
    const input = baseRequest({ target: 'doubao' });
    const registered = service.submit(input, { adapterVersion: 'desktop-fixture-1' });
    const waiting = await runTask({ service, taskId: registered.task_id, adapter, supervisor });
    assert.equal(waiting.status, 'waiting_user');
    assert.equal(waiting.attempt.submission, 'not_sent');
    assert.equal(bridge.sends, 0, 'no dispatch before the user completes first login');
    assert.equal(service.status(registered.task_id).native, null);

    // Same-UUID submit resumes the same attempt instead of duplicating.
    const resubmitted = service.submit(input, { adapterVersion: 'desktop-fixture-1' });
    assert.equal(resubmitted.duplicate, true);
    assert.equal(resubmitted.resumed, true);
    assert.equal(resubmitted.attempt.attempt_id, waiting.attempt.attempt_id);

    // The user finished login in the dedicated window; the resumed worker
    // reuses the managed instance, dispatches once and completes.
    loggedIn = true;
    const completed = await runTask({ service, taskId: registered.task_id, adapter, supervisor });
    assert.equal(completed.status, 'succeeded');
    assert.equal(bridge.sends, 1);
    assert.equal(completed.attempt.attempt_id, waiting.attempt.attempt_id);
  } finally { control.close(); }
});
