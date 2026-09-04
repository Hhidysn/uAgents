import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execute, main } from '../plugins/uagents/src/cli/main.mjs';

const root = path.resolve('.local', 'test-runs', randomUUID(), 'unified CLI');
fs.mkdirSync(root, { recursive: true });
const request = patch => ({
  schema_version: '1.0', request_id: randomUUID(), target: 'opencode', model: 'commandcode-goat/deepseek/deepseek-v4-flash',
  mode: 'analysis', prompt: 'bounded', execution: { observation_timeout_ms: 5000, effort: 'medium', permission: 'native' },
  policy: { fallback: 'none', max_cost_usd: null }, ...patch,
});

test('discovery commands expose the approved static registry', async () => {
  const targets = await execute(['targets']);
  assert.equal(targets.ok, true);
  assert.deepEqual(targets.data, ['agy', 'workbuddy', 'opencode', 'doubao', 'trae']);
  const capabilities = await execute(['capabilities', 'opencode']);
  assert.deepEqual(capabilities.data.modes, ['analysis']);
  assert.equal('available' in capabilities.data, false);
  const models = await execute(['models', 'opencode']);
  assert.deepEqual(models.data.map(model => model.route_id).sort(), [
    'commandcode-goat/deepseek/deepseek-v4-flash', 'commandcode-goat/z-ai/glm-5.3-flash',
  ]);
});

test('submit is nonblocking, idempotent and creates one detached worker request', async () => {
  const input = request();
  const requestFile = path.join(root, 'request.json');
  fs.writeFileSync(requestFile, JSON.stringify(input));
  const spawns = [];
  const first = await execute(['submit', '--request', requestFile, '--state-dir', root], { spawnWorker: (...args) => spawns.push(args) });
  const second = await execute(['submit', '--request', requestFile, '--state-dir', root], { spawnWorker: (...args) => spawns.push(args) });
  assert.equal(first.data.status, 'registered');
  assert.equal(first.data.model_requested, input.model);
  assert.equal(first.data.model_reported, null);
  assert.equal(first.data.model_verified, false);
  assert.equal(second.data.duplicate, true);
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0], [root, input.request_id]);
  const status = await execute(['status', input.request_id, '--state-dir', root]);
  assert.equal(status.data.attempt.ordinal, 1);
  const listed = await execute(['list', '--limit', '1', '--state-dir', root]);
  assert.equal(listed.data.tasks.length, 1);
});

test('cancel is a separate intent and main returns a structured error envelope', async () => {
  const input = request();
  const requestFile = path.join(root, `${input.request_id}.json`);
  fs.writeFileSync(requestFile, JSON.stringify(input));
  await execute(['submit', '--request', requestFile, '--state-dir', root], { spawnWorker: () => {} });
  const cancelled = await execute(['cancel', input.request_id, '--state-dir', root]);
  assert.equal(cancelled.data.status, 'registered');
  assert.equal(cancelled.data.cancel_requested, true);
  assert.equal(fs.existsSync(path.join(root, 'tasks', input.request_id, 'cancel.json')), true);
  const lines = [];
  const exitCode = await main(['status', 'missing', '--state-dir', root], { log: line => lines.push(JSON.parse(line)) });
  assert.equal(exitCode, 1);
  assert.equal(lines[0].ok, false);
  assert.equal(lines[0].error.code, 'task_not_found');
});

test('table format renders human-readable discovery output', async () => {
  const lines = [];
  const exitCode = await main(['targets', '--format', 'table'], { log: line => lines.push(line) });
  assert.equal(exitCode, 0);
  assert.match(lines[0], /agy/);
  assert.match(lines[0], /trae/);
  assert.equal(lines[0].startsWith('{'), false);
});

test('configuration validation cannot enable unsupported capabilities', async () => {
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ targets: { opencode: { permissions: { workspace_write: true } } } }));
  const validated = await execute(['config', 'validate', '--config', configFile]);
  assert.equal(validated.data.valid, true);
});
