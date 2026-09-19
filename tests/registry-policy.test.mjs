import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HealthCache } from '../plugins/uagents/src/registry/health-cache.mjs';
import { createRegistry } from '../plugins/uagents/src/registry/registry.mjs';
import { evaluateRequest } from '../plugins/uagents/src/policy/evaluate.mjs';

const route = 'commandcode-goat/deepseek/deepseek-v4-flash';
const request = patch => ({
  schema_version: '1.0', request_id: randomUUID(), target: 'opencode', model: route,
  mode: 'analysis', prompt: 'bounded',
  execution: { observation_timeout_ms: 10_000, effort: 'medium', permission: 'native' },
  policy: { fallback: 'none', max_cost_usd: null },
  ...patch,
});

test('registry exposes static capability without dynamic availability', () => {
  const registry = createRegistry();
  assert.equal('available' in registry.targets.opencode, false);
  assert.deepEqual(registry.targets.opencode.modes, ['analysis', 'implementation']);
  assert.deepEqual(registry.targets.opencode.inputs, { text: true, files: true, images: true, workspace_readable: true });
  assert.deepEqual(registry.targets.agy.inputs, { text: true, files: false, images: false, workspace_readable: true });
  assert.deepEqual(registry.targets.workbuddy.inputs, { text: true, files: false, images: true, workspace_readable: true });
  assert.deepEqual(registry.targets.dsh.inputs, { text: true, files: false, images: false, workspace_readable: true });
  assert.equal(registry.targets.workbuddy.model_selection, 'mixed');
  assert.equal(registry.models['gemini-3.8-flash-medium'].route_id, 'agy/gemini-3.8-flash-medium');
  assert.equal(registry.models['workbuddy-default'].inputs.images, false);
  assert.equal(registry.models['deepseek-v4.1-flash'].inputs.images, true);
  assert.deepEqual(registry.targets.opencode.outputs, { text: true, files: true, images: false });
  assert.equal(registry.targets.workbuddy.resume, true);
  assert.equal(registry.targets.opencode.resume, true);
  assert.equal(registry.targets.agy.resume, false);
  assert.equal(registry.targets.workbuddy.fork, true);
  assert.equal(registry.targets.opencode.fork, true);
  assert.equal(registry.targets.agy.fork, false);
  assert.deepEqual(Object.keys(registry.models).filter(key => key.startsWith('commandcode-goat/')).sort(), [
    'commandcode-goat/deepseek/deepseek-v4-flash', 'commandcode-goat/z-ai/glm-5.3-flash',
  ]);
});

test('user registry configuration can only tighten built-in capability', () => {
  const registry = createRegistry({ targets: { agy: { modes: ['analysis'], permissions: { workspace_write: true, native: false } } } });
  assert.deepEqual(registry.targets.agy.modes, ['analysis']);
  assert.equal(registry.targets.agy.permissions.workspace_write, false);
  assert.equal(registry.targets.agy.permissions.native, false);
  assert.throws(() => createRegistry({ models: { 'unknown/model': { enabled: true } } }), { code: 'invalid_model' });
  const noAgyVerifiedRoute = createRegistry({ models: { 'gemini-3.8-flash-medium': { enabled: false } } });
  assert.equal(noAgyVerifiedRoute.models['gemini-3.8-flash-medium'].enabled, false);
});

test('health cache expires to unknown rather than retaining availability', () => {
  let now = Date.parse('2026-09-04T00:00:00Z');
  const cache = new HealthCache({ clock: () => now });
  cache.set(route, { availability: 'available', source: 'fixture', observed_at: '2026-09-04T00:00:00Z', expires_at: '2026-09-04T00:01:00Z' });
  assert.equal(cache.get(route).availability, 'available');
  now += 60_001;
  assert.equal(cache.get(route).availability, 'unknown');
  assert.equal(cache.get(route).stale, true);
});

test('policy resolves an explicit route and emits model evidence placeholders', () => {
  const outcome = evaluateRequest(request());
  assert.equal(outcome.allowed, true);
  assert.equal(outcome.request.model_requested, route);
  assert.equal(outcome.request.model_resolved, 'deepseek-v4-flash');
  assert.equal(outcome.request.model_reported, null);
  assert.equal(outcome.request.model_verified, false);
  assert.equal(outcome.request.route_id, route);
  assert.deepEqual(outcome.decision.warnings, ['model_availability_unconfirmed']);
});

test('backend defaults do not masquerade as concrete resolved models', () => {
  const outcome = evaluateRequest(request({ target: 'workbuddy', model: 'default' }));
  assert.equal(outcome.request.model_resolved, null);
  assert.equal(outcome.request.route_id, 'workbuddy-default');
  assert.equal(outcome.request.model_resolution.kind, 'backend_default');
});

test('WorkBuddy explicit deepseek route resolves concretely', () => {
  const outcome = evaluateRequest(request({ target: 'workbuddy', model: 'deepseek-v4.1-flash' }));
  assert.equal(outcome.request.model_resolved, 'deepseek-v4.1-flash');
  assert.equal(outcome.request.route_id, 'workbuddy/deepseek-v4.1-flash');
  assert.equal(outcome.request.model_resolution.kind, 'exact');
});

test('DeepSeek Harness route is explicit and keeps attachments closed in v1', () => {
  const workspace = process.cwd();
  const outcome = evaluateRequest(request({
    target: 'dsh', model: 'deepseek-official/deepseek-flash', workspace,
  }));
  assert.equal(outcome.allowed, true);
  assert.equal(outcome.request.model_resolved, 'deepseek-flash');
  assert.equal(outcome.request.provider, 'deepseek-official');
  assert.equal(outcome.request.route_id, 'deepseek-official/deepseek-flash');
  assert.throws(() => evaluateRequest(request({
    target: 'dsh', model: 'deepseek-official/deepseek-v4.1-flash', workspace,
  })), error => error.code === 'model_unavailable' && error.submission === 'not_sent');
  assert.throws(() => evaluateRequest(request({
    target: 'dsh', model: 'deepseek-official/deepseek-flash', workspace,
    inputs: [{ type: 'file', path: 'requirements.md' }],
  })), error => error.code === 'unsupported_capability' && error.submission === 'not_sent');
  assert.throws(() => evaluateRequest(request({
    target: 'dsh', model: 'deepseek-official/deepseek-flash', workspace,
    inputs: [{ type: 'image', path: 'screen.png' }],
  })), error => error.code === 'unsupported_capability' && error.submission === 'not_sent');
});

test('policy fails closed before worker launch', () => {
  assert.throws(() => evaluateRequest(request({ model: 'opencode-go/deepseek-v4-flash' })), error => error.code === 'model_unavailable' && error.submission === 'not_sent');
  assert.throws(() => evaluateRequest(request({ policy: { fallback: 'paid', max_cost_usd: null } })), { code: 'unsupported_capability' });
  assert.throws(() => evaluateRequest(request({ policy: { fallback: 'none', max_cost_usd: 1 } })), { code: 'unsupported_capability' });
  for (const permission of ['native', 'advisory-read-only', 'enforced-read-only', 'workspace-write', 'full-access']) {
    assert.equal(evaluateRequest(request({ execution: { observation_timeout_ms: 10_000, effort: 'medium', permission } })).allowed, true);
  }
  const timeoutRequest = request({ execution: { observation_timeout_ms: 10_000, execution_timeout_ms: 20_000, effort: 'medium', permission: 'native' } });
  if (process.platform === 'win32') assert.equal(evaluateRequest(timeoutRequest).allowed, true);
  else assert.throws(() => evaluateRequest(timeoutRequest), { code: 'unsupported_capability' });
  assert.throws(() => evaluateRequest(request({
    target: 'workbuddy', model: 'default',
    execution: { observation_timeout_ms: 10_000, execution_timeout_ms: 20_000, effort: 'medium', permission: 'native' },
  })), { code: 'unsupported_capability' });
});

test('attachment capability distinguishes native mapping from workspace readability', () => {
  const workspace = process.cwd();
  assert.equal(evaluateRequest(request({ workspace, inputs: [{ type: 'image', path: 'image.png' }] })).allowed, true);
  assert.throws(() => evaluateRequest(request({ target: 'workbuddy', model: 'default', workspace,
    inputs: [{ type: 'file', path: 'input.txt' }] })), error => (
    error.code === 'unsupported_capability' && /native file attachments/.test(error.message) && error.submission === 'not_sent'
  ));
  assert.throws(() => evaluateRequest(request({ target: 'workbuddy', model: 'default', workspace,
    inputs: [{ type: 'image', path: 'image.png' }] })), error => (
    error.code === 'unsupported_capability' && /native image attachments/.test(error.message) && error.submission === 'not_sent'
  ));
  assert.equal(evaluateRequest(request({ target: 'workbuddy', model: 'deepseek-v4.1-flash', workspace,
    inputs: [{ type: 'image', path: 'image.png' }] })).allowed, true);
  assert.throws(() => evaluateRequest(request({ target: 'workbuddy', model: 'deepseek-v4.1-flash', workspace,
    inputs: [{ type: 'file', path: 'input.txt' }] })), error => (
    error.code === 'unsupported_capability' && /native file attachments/.test(error.message) && error.submission === 'not_sent'
  ));
  assert.throws(() => evaluateRequest(request({ target: 'agy', model: 'gemini-fixture-low', workspace,
    inputs: [{ type: 'file', path: 'input.txt' }] })), error => (
    error.code === 'unsupported_capability' && /native file attachments/.test(error.message)
  ));
});

test('session continuation is admitted only for targets with a native continuation mapping', () => {
  const workspace = process.cwd();
  const parent = randomUUID();
  assert.equal(evaluateRequest(request({ workspace, session: { continue_from_task_id: parent } })).allowed, true);
  assert.equal(evaluateRequest(request({ target: 'workbuddy', model: 'default', workspace,
    session: { continue_from_task_id: parent } })).allowed, true);
  assert.throws(() => evaluateRequest(request({ target: 'agy', model: 'gemini-fixture-low', workspace,
    session: { continue_from_task_id: parent } })), { code: 'unsupported_capability' });
  assert.throws(() => evaluateRequest(request({ session: { continue_from_task_id: parent } })), { code: 'invalid_workspace' });
});

test('session fork is admitted only for targets with a native fork mapping', () => {
  const workspace = process.cwd();
  const parent = randomUUID();
  assert.equal(evaluateRequest(request({ workspace, session: { fork_from_task_id: parent } })).allowed, true);
  assert.equal(evaluateRequest(request({ target: 'workbuddy', model: 'default', workspace,
    session: { fork_from_task_id: parent } })).allowed, true);
  assert.throws(() => evaluateRequest(request({ target: 'agy', model: 'gemini-fixture-low', workspace,
    session: { fork_from_task_id: parent } })), { code: 'unsupported_capability' });
  assert.throws(() => evaluateRequest(request({ session: { fork_from_task_id: parent } })), { code: 'invalid_workspace' });
});

test('OpenCode native args cannot replace dispatcher-owned protocol arguments', () => {
  const baseExecution = { observation_timeout_ms: 10_000, effort: 'medium', permission: 'native' };
  for (const argument of ['--model', '--model=other', '--format', '--format=json', '--dir', '--dir=other', '--title', '--title=other']) {
    assert.throws(() => evaluateRequest(request({ execution: { ...baseExecution, native_args: [argument] } })), error => (
      error.code === 'invalid_request' && error.submission === 'not_sent' && error.message.includes('dispatcher-owned OpenCode flag')
    ));
  }
  assert.throws(() => evaluateRequest(request({ execution: { ...baseExecution, native_args: ['run'] } })), { code: 'invalid_request' });
  assert.equal(evaluateRequest(request({ execution: {
    ...baseExecution, native_args: ['--pure', '--auto', '--agent', 'build', '--variant=fast'],
  } })).allowed, true);
});

test('native args fail explicitly on targets without a native-arg mapping', () => {
  assert.throws(() => evaluateRequest(request({
    target: 'workbuddy', model: 'default', execution: {
      observation_timeout_ms: 10_000, effort: 'medium', permission: 'native', native_args: ['--example'],
    },
  })), { code: 'unsupported_capability' });
});

test('fresh authoritative unavailability rejects while stale health does not', () => {
  let now = Date.parse('2026-09-04T00:00:00Z');
  const cache = new HealthCache({ clock: () => now });
  cache.set(route, { availability: 'unavailable', source: 'fixture', observed_at: '2026-09-04T00:00:00Z', expires_at: '2026-09-04T00:01:00Z' });
  assert.throws(() => evaluateRequest(request(), { health: cache }), { code: 'model_unavailable' });
  now += 60_001;
  assert.equal(evaluateRequest(request(), { health: cache }).allowed, true);
});
