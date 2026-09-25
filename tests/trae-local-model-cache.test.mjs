import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTraeLocalModelCache } from '../plugins/uagents/src/adapters/trae/local-model-cache.mjs';
import { TraeAdapter } from '../plugins/uagents/src/adapters/trae/adapter.mjs';

test('TRAE profile cache returns only selectable Solo model identities and labels', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'uagents-trae-model-cache-'));
  const databasePath = path.join(root, 'state.vscdb');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    const catalog = {
      solo_agent: [
        { name: 'glm-5.3', display_name: 'GLM-5.3', status: true, selectable: true,
          ak: 'secret-ak', sk: 'secret-sk', base_url: 'https://private.invalid' },
        { name: 'disabled', display_name: 'Disabled', status: true, selectable: false },
        { name: 'unavailable', display_name: 'Unavailable', status: false, selectable: true },
        { name: 'duplicate', display_name: 'GLM-5.3', status: true, selectable: true },
      ],
      chat_v3: [{ name: 'chat-only', display_name: 'Chat Only', status: true, selectable: true }],
    };
    database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run('account_AI.agent.model.model_list_map', JSON.stringify(catalog));
    const result = readTraeLocalModelCache({ databasePath });
    assert.deepEqual(result.models, [{ id: 'glm-5.3', selector: 'GLM-5.3',
      route_id: 'trae/GLM-5.3', provider: 'trae', kind: 'native_profile_cache' }]);
    assert.equal(typeof result.snapshot_file_mtime_ms, 'number');
    assert.doesNotMatch(JSON.stringify(result), /secret-ak|secret-sk|private\.invalid/);

    database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run('another_AI.agent.model.model_list_map', JSON.stringify(catalog));
    assert.equal(readTraeLocalModelCache({ databasePath }), null, 'ambiguous account cache fails closed');
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('TRAE catalog falls back to a profile hint but Task preparation still requires managed identity', async () => {
  const client = {
    status: async () => ({ traeRunning: true, surface: { kind: 'setup', url: 'vscode://trae/workbench' } }),
    models: async () => { throw new Error('gateway picker must not be read on setup'); },
  };
  const adapter = new TraeAdapter({ client, readLocalModels: () => ({
    models: [{ id: 'glm-5.3', selector: 'GLM-5.3', route_id: 'trae/GLM-5.3', provider: 'trae' }],
    snapshot_file_mtime_ms: 1234,
  }) });
  const catalog = await adapter.discoverModels();
  assert.equal(catalog.status, 'cache_only');
  assert.equal(catalog.error_code, 'trae_identity_unconfirmed');
  await assert.rejects(adapter.prepare({}), { code: 'trae_identity_unconfirmed' });
});
