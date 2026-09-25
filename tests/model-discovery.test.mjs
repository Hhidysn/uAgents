import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCliModelCatalog, parseAgyModelList, parseOpenCodeModelList, parseWorkBuddyModelHelp } from '../plugins/uagents/src/transports/model-discovery.mjs';
import { discoverModelsForTarget, MODEL_DISCOVERY_TTL_MS } from '../plugins/uagents/src/runtime/model-discovery.mjs';
import { createRegistry } from '../plugins/uagents/src/registry/registry.mjs';

class MemoryDiscoveryCache {
  records = new Map();
  getModelDiscovery(key) { return this.records.get(key) ?? null; }
  upsertModelDiscovery(key, record) {
    const current = this.records.get(key);
    if (!current || record.attempt_started_at_ms >= current.attempt_started_at_ms) {
      this.records.set(key, structuredClone(record));
    }
  }
}

const installation = sha256 => ({
  canonical_path: 'F:/agy/agy.exe',
  sha256,
  size: 123,
  mtime: 456,
  file_version: '1.2.5',
  verifier_version: 'fixture',
});

test('agy model parser ignores status text, ANSI and duplicate rows', () => {
  const models = parseAgyModelList([
    'Fetching available models...',
    '\u001b[32mgemini-3.8-flash-medium\u001b[0m\tGemini 3.8 Flash (Medium)',
    'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  ].join('\n'));
  assert.deepEqual(models.map(model => model.id), ['gemini-3.8-flash-medium', 'claude-sonnet-4-6']);
  assert.equal(models[0].route_id, 'agy/gemini-3.8-flash-medium');
});

test('agy native discovery uses its own 30-second catalog budget without sending a prompt', () => {
  let invocation;
  const catalog = discoverCliModelCatalog('agy', {
    entryOverride: process.execPath,
    runner: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: 'Fetching available models...\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n' };
    },
  });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, ['models']);
  assert.equal(invocation.options.timeout, 30_000);
  assert.deepEqual(catalog.models.map(model => model.id), ['gemini-3.8-flash-medium']);
});

test('agy discovery reuses pattern admission without auto-approving non-gemini models', async () => {
  const rows = await discoverModelsForTarget('agy', {
    registry: createRegistry(),
    adapterFactory: () => ({ discoverModels: async () => ({
      status: 'ok', discovery: 'native_cli_catalog', models: [
        { id: 'gemini-3.8-flash-medium', route_id: 'agy/gemini-3.8-flash-medium', provider: 'agy' },
        { id: 'gemini-3.8-flash-high', route_id: 'agy/gemini-3.8-flash-high', provider: 'agy' },
        { id: 'claude-sonnet-4-6', route_id: 'agy/claude-sonnet-4-6', provider: 'agy' },
      ],
    }) }),
  });
  const verified = rows.find(row => row.model === 'gemini-3.8-flash-medium');
  assert.equal(verified.configured, true);
  assert.equal(verified.admission_allowed, true);
  assert.equal(verified.usable, true);
  const pattern = rows.find(row => row.model === 'gemini-3.8-flash-high');
  assert.equal(pattern.configured, false);
  assert.equal(pattern.admission_allowed, true);
  assert.equal(pattern.usable, true);
  const denied = rows.find(row => row.model === 'claude-sonnet-4-6');
  assert.equal(denied.admission_allowed, false);
  assert.equal(denied.usable, false);
});

test('WorkBuddy help parser extracts the native supported model list', () => {
  const models = parseWorkBuddyModelHelp('  --model <model> Model. Currently supported: (auto, hy3, deepseek-v4.1-flash, glm-5.3-flash)\n');
  assert.deepEqual(models.map(model => model.id), ['auto', 'hy3', 'deepseek-v4.1-flash', 'glm-5.3-flash']);
});

test('WorkBuddy discovery marks the verified concrete route configured and usable', async () => {
  const rows = await discoverModelsForTarget('workbuddy', {
    registry: createRegistry(),
    adapterFactory: () => ({ discoverModels: async () => ({
      status: 'ok', discovery: 'native_cli_help', models: [
        { id: 'auto', route_id: null, provider: 'workbuddy' },
        { id: 'deepseek-v4.1-flash', route_id: null, provider: 'workbuddy' },
        { id: 'glm-5.3-flash', route_id: null, provider: 'workbuddy' },
      ],
    }) }),
  });
  const exact = rows.find(row => row.route_id === 'workbuddy/deepseek-v4.1-flash');
  assert.equal(exact.configured, true);
  assert.equal(exact.discovered, true);
  assert.equal(exact.usable, true);
  const discoveredOnly = rows.find(row => row.model === 'glm-5.3-flash');
  assert.equal(discoveredOnly.configured, false);
  assert.equal(discoveredOnly.admission_allowed, false);
});

test('model listing identifies the configured default and selectable route', async () => {
  const selector = 'workbuddy/glm-5.3-flash';
  const registry = createRegistry({ routes: {
    [selector]: { target: 'workbuddy', model: 'glm-5.3-flash', provider: 'workbuddy', route_id: selector },
  }, defaults: { workbuddy: selector } });
  const rows = await discoverModelsForTarget('workbuddy', {
    registry,
    adapterFactory: () => ({ discoverModels: async () => ({ status: 'ok', discovery: 'native_cli_help', models: [
      { id: 'auto', route_id: null, provider: 'workbuddy' },
      { id: 'glm-5.3-flash', route_id: null, provider: 'workbuddy' },
    ] }) }),
  });
  const selected = rows.find(row => row.selector === selector);
  assert.equal(selected.default, true);
  assert.equal(selected.discovered, true);
  assert.equal(selected.admission_allowed, true);
  assert.equal(rows.find(row => row.selector === 'workbuddy-default').default, false);
});

test('OpenCode model parser keeps only the requested provider catalog', () => {
  const models = parseOpenCodeModelList('commandcode-goat/deepseek/deepseek-v4-flash\nother/model\ncommandcode-goat/z-ai/glm-5.3-flash\n', 'commandcode-goat');
  assert.deepEqual(models.map(model => model.route_id), [
    'commandcode-goat/deepseek/deepseek-v4-flash',
    'commandcode-goat/z-ai/glm-5.3-flash',
  ]);
});

test('dynamic discovery enriches configured routes and exposes discovered-only models without approving them', async () => {
  const rows = await discoverModelsForTarget('opencode', {
    registry: createRegistry(),
    adapterFactory: () => ({ discoverModels: async () => ({
      status: 'ok', discovery: 'native_cli_catalog', models: [
        { id: 'deepseek-v4-flash', route_id: 'commandcode-goat/deepseek/deepseek-v4-flash', provider: 'commandcode-goat/deepseek' },
        { id: 'deepseek-v4-pro', route_id: 'commandcode-goat/deepseek/deepseek-v4-pro', provider: 'commandcode-goat/deepseek' },
      ],
    }) }),
  });
  const configured = rows.find(row => row.route_id === 'commandcode-goat/deepseek/deepseek-v4-flash');
  assert.equal(configured.configured, true);
  assert.equal(configured.admission_allowed, true);
  assert.equal(configured.discovered, true);
  assert.equal(configured.usable, true);
  const missing = rows.find(row => row.route_id === 'commandcode-goat/z-ai/glm-5.3-flash');
  assert.equal(missing.configured, true);
  assert.equal(missing.discovered, false);
  assert.equal(missing.usable, false);
  const discoveredOnly = rows.find(row => row.route_id === 'commandcode-goat/deepseek/deepseek-v4-pro');
  assert.equal(discoveredOnly.configured, false);
  assert.equal(discoveredOnly.admission_allowed, false);
  assert.equal(discoveredOnly.discovered, true);
  assert.equal(discoveredOnly.usable, false);
});

test('discovery failure preserves configured routes without claiming availability', async () => {
  const rows = await discoverModelsForTarget('opencode', {
    registry: createRegistry(),
    adapterFactory: () => ({ discoverModels: async () => { const error = new Error('no cli'); error.code = 'cli_not_found'; throw error; } }),
  });
  assert.equal(rows.length, 2);
  assert.equal(rows.every(row => row.configured === true), true);
  assert.equal(rows.every(row => row.discovered === null && row.usable === null), true);
  assert.equal(rows.every(row => row.discovery.error_code === 'cli_not_found'), true);
});

test('configured-only backend targets do not duplicate their default route', async () => {
  const rows = await discoverModelsForTarget('doubao', {
    registry: createRegistry(),
    adapterFactory: () => ({ discoverModels: async () => ({
      status: 'configured_only', discovery: 'configured', models: [],
    }) }),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].route_id, 'doubao-default');
  assert.equal(rows[0].discovered, null);
  assert.equal(rows[0].usable, null);
  assert.equal(rows[0].discovery.source, 'configured');
});

test('model discovery cache uses TTL, explicit refresh and stale fallback', async () => {
  const cacheStore = new MemoryDiscoveryCache();
  let now = 1_000;
  let calls = 0;
  let failRefresh = false;
  const adapterFactory = () => ({ discoverModels: async () => {
    calls += 1;
    if (failRefresh) {
      const error = new Error('catalog unavailable');
      error.code = 'catalog_unavailable';
      throw error;
    }
    return {
      status: 'ok',
      discovery: 'native_cli_catalog',
      models: [{ id: 'gemini-3.8-flash-medium', route_id: 'agy/gemini-3.8-flash-medium', provider: 'agy' }],
    };
  } });
  const options = {
    registry: createRegistry(),
    adapterFactory,
    cacheStore,
    resolveInstallation: async () => installation('sha-a'),
    clock: () => now,
  };

  const first = await discoverModelsForTarget('agy', options);
  assert.equal(calls, 1);
  assert.equal(first[0].discovery.source, 'native');

  now += 60_000;
  const cached = await discoverModelsForTarget('agy', options);
  assert.equal(calls, 1);
  assert.equal(cached[0].discovery.source, 'cache');
  assert.equal(cached[0].discovery.stale, false);

  now += 1;
  const refreshed = await discoverModelsForTarget('agy', { ...options, refresh: true });
  assert.equal(calls, 2);
  assert.equal(refreshed[0].discovery.source, 'native');

  now += MODEL_DISCOVERY_TTL_MS + 1;
  failRefresh = true;
  const stale = await discoverModelsForTarget('agy', options);
  assert.equal(calls, 3);
  assert.equal(stale[0].discovery.status, 'stale');
  assert.equal(stale[0].discovery.refresh_error.code, 'catalog_unavailable');
  assert.equal(stale[0].usable, null);
});

test('model cache never crosses verified executable identity changes', async () => {
  const cacheStore = new MemoryDiscoveryCache();
  let sha = 'sha-a';
  let fail = false;
  const adapterFactory = () => ({ discoverModels: async () => {
    if (fail) {
      const error = new Error('catalog unavailable');
      error.code = 'catalog_unavailable';
      throw error;
    }
    return {
      status: 'ok', discovery: 'native_cli_catalog',
      models: [{ id: 'gemini-3.8-flash-medium', route_id: 'agy/gemini-3.8-flash-medium', provider: 'agy' }],
    };
  } });
  const options = {
    registry: createRegistry(),
    adapterFactory,
    cacheStore,
    resolveInstallation: async () => installation(sha),
    clock: () => 5_000,
  };
  await discoverModelsForTarget('agy', options);
  sha = 'sha-b';
  fail = true;
  const rows = await discoverModelsForTarget('agy', options);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].discovered, null);
  assert.equal(rows[0].discovery.status, 'failed');
  assert.equal(rows[0].discovery.error_code, 'catalog_unavailable');
});

test('cached native evidence recomputes admission against the current registry', async () => {
  const cacheStore = new MemoryDiscoveryCache();
  const adapterFactory = () => ({ discoverModels: async () => ({
    status: 'ok', discovery: 'native_cli_catalog',
    models: [{ id: 'gemini-3.8-flash-medium', route_id: 'agy/gemini-3.8-flash-medium', provider: 'agy' }],
  }) });
  const common = {
    adapterFactory,
    cacheStore,
    resolveInstallation: async () => installation('sha-a'),
    clock: () => 10_000,
  };
  await discoverModelsForTarget('agy', { ...common, registry: createRegistry() });
  const tightened = createRegistry({ models: { 'gemini-3.8-flash-medium': { enabled: false } } });
  const rows = await discoverModelsForTarget('agy', { ...common, registry: tightened });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].configured, false);
  assert.equal(rows[0].admission_allowed, false);
  assert.equal(rows[0].discovery.source, 'cache');
});
