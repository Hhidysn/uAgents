import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenCodeModelList, parseWorkBuddyModelHelp } from '../plugins/uagents/src/transports/model-discovery.mjs';
import { discoverModelsForTarget } from '../plugins/uagents/src/runtime/model-discovery.mjs';
import { createRegistry } from '../plugins/uagents/src/registry/registry.mjs';

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
