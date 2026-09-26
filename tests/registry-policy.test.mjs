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
  assert.deepEqual(registry.targets.codex.inputs, { text: true, files: false, images: true, workspace_readable: true });
  assert.deepEqual(registry.targets.claudeCode.inputs, { text: true, files: true, images: true, workspace_readable: true });
  assert.equal(registry.models['gpt-6-astra'].route_id, 'codex/gpt-6-astra');
  assert.equal(registry.models['gpt-5.6-luna'].route_id, 'codex/gpt-5.6-luna');
  assert.deepEqual(registry.targets.workbuddy.inputs, { text: true, files: false, images: true, workspace_readable: true });
  assert.deepEqual(registry.targets.dsh.inputs, { text: true, files: false, images: true, workspace_readable: true });
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

test('explicit user route can be a target default and each Task can override it', () => {
  const selector = 'workbuddy/glm-5.3-flash';
  const registry = createRegistry({
    routes: { [selector]: { target: 'workbuddy', model: 'glm-5.3-flash', provider: 'workbuddy', route_id: selector } },
    defaults: { workbuddy: selector },
  });
  const { model: omitted, ...withoutModel } = request({ target: 'workbuddy' });
  const selected = evaluateRequest(withoutModel, { registry }).request;
  assert.equal(selected.model_requested, 'default');
  assert.equal(selected.model_resolved, 'glm-5.3-flash');
  assert.equal(selected.route_id, selector);
  assert.equal(selected.model_resolution.kind, 'alias');
  assert.equal(evaluateRequest(request({ target: 'workbuddy', model: 'deepseek-v4.1-flash' }), { registry }).request.model_resolved,
    'deepseek-v4.1-flash');
  assert.throws(() => evaluateRequest(request({ target: 'workbuddy', model: selector,
    inputs: [{ type: 'image', path: 'screen.png' }], workspace: process.cwd() }), { registry }),
  { code: 'unsupported_capability' });
});

test('configured native routes inherit target attachment transport without a model allowlist', () => {
  const registry = createRegistry({ routes: {
    'codex/future-image-model': { target: 'codex', model: 'future-image-model', provider: 'codex', route_id: 'codex/future-image-model' },
    'claudeCode/future-image-model': { target: 'claudeCode', model: 'future-image-model', provider: 'claudeCode', route_id: 'claudeCode/future-image-model' },
    'dsh/deepseek-official/future-image-model': { target: 'dsh', model: 'future-image-model', provider: 'deepseek-official', route_id: 'deepseek-official/future-image-model' },
  } });
  for (const [target, model] of [
    ['codex', 'codex/future-image-model'],
    ['claudeCode', 'claudeCode/future-image-model'],
    ['dsh', 'dsh/deepseek-official/future-image-model'],
  ]) {
    assert.equal(evaluateRequest(request({ target, model, workspace: process.cwd(),
      inputs: [{ type: 'image', path: 'sample.png' }] }), { registry }).allowed, true);
  }
});

test('user routes and defaults validate identity and cannot enable default-only targets', () => {
  const route = { target: 'workbuddy', model: 'glm-5.3-flash', provider: 'workbuddy', route_id: 'workbuddy/glm-5.3-flash' };
  assert.throws(() => createRegistry({ routes: { 'other/glm-5.3-flash': route } }), { code: 'invalid_model' });
  assert.throws(() => createRegistry({ routes: { 'workbuddy/glm-5.3-flash': { ...route, opt_in: true } } }), { code: 'unsupported_field' });
  assert.throws(() => createRegistry({ routes: { 'workbuddy/unsafe': { ...route, model: '--permission-mode' } } }), { code: 'invalid_model' });
  assert.throws(() => createRegistry({ routes: { 'doubao/foo': { ...route, target: 'doubao' } } }), { code: 'invalid_target' });
  assert.throws(() => createRegistry({ routes: null }), { code: 'invalid_request' });
  assert.throws(() => createRegistry(JSON.parse('{"models":{"__proto__":{"enabled":false}}}')), { code: 'invalid_model' });
  assert.throws(() => createRegistry({ defaults: { codex: 'workbuddy-default' } }), { code: 'invalid_model' });
  assert.throws(() => createRegistry({ defaults: { workbuddy: 'workbuddy-default' },
    models: { 'workbuddy-default': { enabled: false } } }), { code: 'invalid_model' });
  assert.equal(createRegistry({ models: { 'workbuddy-default': { enabled: false } } }).defaults.workbuddy, undefined);
});

test('user OpenCode route keeps its native provider/model identity', () => {
  const selector = 'opencode/commandcode-goat/deepseek/deepseek-v4-pro';
  const registry = createRegistry({ routes: {
    [selector]: { target: 'opencode', model: 'deepseek-v4-pro', provider: 'commandcode-goat/deepseek',
      route_id: 'commandcode-goat/deepseek/deepseek-v4-pro' },
  }, defaults: { opencode: selector } });
  const selected = evaluateRequest(request({ model: 'default' }), { registry }).request;
  assert.equal(selected.model_resolved, 'deepseek-v4-pro');
  assert.equal(selected.route_id, 'commandcode-goat/deepseek/deepseek-v4-pro');
  assert.throws(() => createRegistry({ routes: { [selector]: { target: 'opencode', model: 'deepseek-v4-pro',
    provider: 'commandcode-goat/deepseek', route_id: 'wrong/model' } } }), { code: 'invalid_model' });
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

test('native model selectors bypass static routes while disabled models stay disabled', () => {
  for (const [target, selector, resolved, routeId] of [
    ['agy', 'claude-sonnet-4-6', 'claude-sonnet-4-6', 'agy/claude-sonnet-4-6'],
    ['workbuddy', 'glm-5.3-flash', 'glm-5.3-flash', 'workbuddy/glm-5.3-flash'],
    ['opencode', 'commandcode-goat/deepseek/deepseek-v4-pro', 'deepseek-v4-pro', 'commandcode-goat/deepseek/deepseek-v4-pro'],
    ['claudeCode', 'claude-opus-4-1', 'claude-opus-4-1', 'claudeCode/claude-opus-4-1'],
    ['trae', 'DeepSeek V4 Pro', 'DeepSeek V4 Pro', 'trae/DeepSeek V4 Pro'],
  ]) {
    const selected = evaluateRequest(request({ target, model: selector })).request;
    assert.equal(selected.model_resolved, resolved);
    assert.equal(selected.route_id, routeId);
    assert.equal(selected.model_resolution.kind, 'native_selected');
  }
  const restricted = createRegistry({ models: { 'deepseek-v4.1-flash': { enabled: false } } });
  assert.throws(() => evaluateRequest(request({ target: 'workbuddy', model: 'workbuddy/deepseek-v4.1-flash' }),
    { registry: restricted }), { code: 'model_unavailable' });
  assert.throws(() => evaluateRequest(request({ target: 'opencode', model: '--model' })), { code: 'model_unavailable' });
  assert.throws(() => evaluateRequest(request({ target: 'doubao', model: 'DeepSeek V4 Pro' })), { code: 'model_unavailable' });
});

test('TRAE display-name route can be configured as a default', () => {
  const registry = createRegistry({
    routes: { 'trae/selected': { target: 'trae', model: 'DeepSeek V4 Pro', provider: 'trae', route_id: 'trae/DeepSeek V4 Pro' } },
    defaults: { trae: 'trae/selected' },
  });
  const selected = evaluateRequest(request({ target: 'trae', model: 'default' }), { registry }).request;
  assert.equal(selected.model_resolved, 'DeepSeek V4 Pro');
  assert.equal(selected.route_id, 'trae/DeepSeek V4 Pro');
  assert.equal(selected.model_resolution.kind, 'alias');
});

test('DeepSeek Harness route is explicit, accepts native images and rejects generic files', () => {
  const workspace = process.cwd();
  const outcome = evaluateRequest(request({
    target: 'dsh', model: 'deepseek-official/deepseek-flash', workspace,
  }));
  assert.equal(outcome.allowed, true);
  assert.equal(outcome.request.model_resolved, 'deepseek-flash');
  assert.equal(outcome.request.provider, 'deepseek-official');
  assert.equal(outcome.request.route_id, 'deepseek-official/deepseek-flash');
  const nativeSelected = evaluateRequest(request({
    target: 'dsh', model: 'deepseek-official/deepseek-v4.1-flash', workspace,
  })).request;
  assert.equal(nativeSelected.model_resolved, 'deepseek-v4.1-flash');
  assert.equal(nativeSelected.model_resolution.kind, 'native_selected');
  assert.throws(() => evaluateRequest(request({
    target: 'dsh', model: 'deepseek-official/deepseek-flash', workspace,
    inputs: [{ type: 'file', path: 'requirements.md' }],
  })), error => error.code === 'unsupported_capability' && error.submission === 'not_sent');
  assert.equal(evaluateRequest(request({
    target: 'dsh', model: 'deepseek-official/deepseek-flash', workspace,
    inputs: [{ type: 'image', path: 'screen.png' }],
  })).allowed, true);
});

test('Codex Luna is an explicit concrete route, not a new default', () => {
  const outcome = evaluateRequest(request({ target: 'codex', model: 'gpt-5.6-luna' }));
  assert.equal(outcome.allowed, true);
  assert.equal(outcome.request.model_resolved, 'gpt-5.6-luna');
  assert.equal(outcome.request.route_id, 'codex/gpt-5.6-luna');
  assert.equal(outcome.request.model_verified, false);
  assert.equal(createRegistry().defaults.codex, undefined);
  assert.equal(createRegistry().targets.codex.resume, false);
  assert.equal(createRegistry().targets.codex.fork, false);
  assert.deepEqual(createRegistry().targets.codex.opt_in_transports['app-server'], {
    models: ['gpt-6-astra'], platforms: ['win32'], resume: true, fork: true,
  });
  assert.throws(() => evaluateRequest(request({ target: 'codex', model: 'gpt-5.6-luna',
    workspace: process.cwd(), session: { continue_from_task_id: randomUUID() } })),
  { code: 'unsupported_capability' });
  assert.equal(evaluateRequest(request({ target: 'codex', model: 'gpt-5.6-luna-unknown' })).request.model_resolved,
    'gpt-5.6-luna-unknown');
});

test('Codex app-server opt-in only admits Astra on Windows and enables native sessions', () => {
  const execution = { codex_transport: 'app-server' };
  const selected = request({ target: 'codex', model: 'gpt-6-astra', execution });
  if (process.platform === 'win32') {
    assert.equal(evaluateRequest(selected).request.execution.codex_transport, 'app-server');
    assert.equal(evaluateRequest(request({ ...selected, request_id: randomUUID(), workspace: process.cwd(),
      session: { continue_from_task_id: randomUUID() } })).allowed, true);
    assert.equal(evaluateRequest(request({ ...selected, request_id: randomUUID(), workspace: process.cwd(),
      session: { fork_from_task_id: randomUUID() } })).allowed, true);
  } else {
    assert.throws(() => evaluateRequest(selected), { code: 'unsupported_capability', submission: 'not_sent' });
  }
  assert.throws(() => evaluateRequest(request({ target: 'codex', model: 'gpt-5.6-luna', execution })),
    { code: 'unsupported_capability', submission: 'not_sent' });
  assert.throws(() => evaluateRequest(request({ execution })),
    { code: 'unsupported_capability', submission: 'not_sent' });
  assert.throws(() => evaluateRequest(request({ target: 'codex', model: 'gpt-6-astra',
    workspace: process.cwd(), session: { fork_from_task_id: randomUUID() } })),
    { code: 'unsupported_capability', submission: 'not_sent' });
});

test('policy fails closed before worker launch', () => {
  assert.equal(evaluateRequest(request({ model: 'opencode-go/deepseek-v4-flash' })).request.route_id,
    'opencode-go/deepseek-v4-flash');
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
  for (const model of ['gpt-6-astra', 'gpt-5.6-luna', 'future-codex-model']) {
    assert.equal(evaluateRequest(request({ target: 'codex', model, workspace,
      inputs: [{ type: 'image', path: 'image.png' }] })).allowed, true);
  }
  assert.equal(evaluateRequest(request({ target: 'claudeCode', model: 'claude-sonnet-4-6', workspace,
    inputs: [{ type: 'file', path: 'document.pdf' }, { type: 'image', path: 'image.png' }] })).allowed, true);
  assert.equal(evaluateRequest(request({ target: 'claudeCode', model: 'future-claude-model', workspace,
    inputs: [{ type: 'image', path: 'image.png' }] })).allowed, true);
  assert.equal(evaluateRequest(request({ target: 'dsh', model: 'deepseek-official/deepseek-flash', workspace,
    inputs: [{ type: 'image', path: 'image.png' }] })).allowed, true);
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
