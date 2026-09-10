import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { execute, main } from '../plugins/uagents/src/cli/main.mjs';
import { CLI_PARSE_OPTIONS } from '../plugins/uagents/src/cli/discovery.mjs';
import { UnifiedRuntime } from '../plugins/uagents/src/runtime/api.mjs';

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
  assert.deepEqual(capabilities.data.modes, ['analysis', 'implementation']);
  assert.equal('available' in capabilities.data, false);
  const models = await execute(['models', 'opencode']);
  assert.deepEqual(models.data.map(model => model.route_id).sort(), [
    'commandcode-goat/deepseek/deepseek-v4-flash', 'commandcode-goat/z-ai/glm-5.3-flash',
  ]);
});

test('CLI discovery exposes commands and submit arguments without opening runtime state', async () => {
  const described = await execute(['describe'], { env: {} });
  assert.equal(described.ok, true);
  assert.equal(described.data.interface, 'uagents-cli');
  assert.equal(described.data.default_format, 'json');
  assert.equal(described.data.commands.some(command => command.name === 'submit'), true);
  assert.equal(described.data.commands.some(command => command.name === 'schema'), true);
  assert.equal(described.data.commands.some(command => command.name === 'council-submit'), true);

  const submit = await execute(['describe', 'submit'], { env: {} });
  assert.equal(submit.data.name, 'submit');
  assert.deepEqual(submit.data.constraints, [{ type: 'exactly_one', options: ['--request', '--request-stdin'] }]);
  assert.equal(submit.data.options.find(option => option.name === '--request').type, 'file');
  assert.equal(submit.data.options.find(option => option.name === '--request-stdin').type, 'boolean');
  assert.equal(submit.data.request_schema.command, 'schema request');
  for (const option of submit.data.options) assert.equal(Object.hasOwn(CLI_PARSE_OPTIONS, option.name.slice(2)), true);
  const councilSubmit = await execute(['describe', 'council-submit'], { env: {} });
  assert.equal(councilSubmit.data.request_schema.command, 'schema council');
  await assert.rejects(() => execute(['describe', 'unknown'], { env: {} }), { code: 'usage' });
});

test('request schema discovery mirrors the Core request contract', async () => {
  const discovered = await execute(['schema', 'request'], { env: {} });
  const schema = discovered.data;
  assert.equal(schema.$id, 'uagents://schema/request/1.0');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['schema_version', 'request_id', 'target', 'model', 'mode', 'prompt']);
  assert.deepEqual(schema.properties.mode.enum, ['analysis', 'implementation']);
  assert.deepEqual(schema.properties.execution.properties.effort.enum, ['low', 'medium', 'high', 'max']);
  assert.deepEqual(schema.properties.inputs.items.properties.type.enum, ['file', 'image']);
  assert.deepEqual(schema.properties.inputs.items.oneOf, [{ required: ['path'] }, { required: ['source'] }]);
  assert.equal(schema.properties.session.anyOf[0].properties.continue_from_task_id.type, 'string');
  assert.equal(schema.properties.session.anyOf[0].properties.fork_from_task_id.type, 'string');
  assert.deepEqual(schema.properties.session.anyOf[0].oneOf, [
    { required: ['continue_from_task_id'] }, { required: ['fork_from_task_id'] },
  ]);
  assert.equal(schema['x-uagents-authoritative-validator'], 'src/protocol/schema.mjs');
  await assert.rejects(() => execute(['schema', 'other'], { env: {} }), { code: 'usage' });
  await assert.rejects(() => execute(['schema', 'request', '--format', 'table'], { env: {} }), { code: 'usage' });
});

test('council schema discovery and CLI fanout expose deterministic member tasks', async () => {
  const schema = (await execute(['schema', 'council'], { env: {} })).data;
  assert.equal(schema.$id, 'uagents://schema/council/1.0');
  assert.match(schema['x-uagents-mode'], /implementation/);
  assert.deepEqual(schema.properties.mode.enum, ['analysis', 'implementation']);
  assert.deepEqual(schema.properties.workspace_strategy.enum, ['shared', 'git-worktree']);
  assert.equal(schema.properties.members.minItems, 2);
  const input = {
    schema_version: '1.0', council_id: randomUUID(), prompt: 'Review this change.',
    members: [
      { member_id: 'wb', target: 'workbuddy', model: 'default' },
      { member_id: 'oc', target: 'opencode', model: 'commandcode-goat/deepseek/deepseek-v4-flash' },
    ],
  };
  const requestFile = path.join(root, `${input.council_id}.council.json`);
  fs.writeFileSync(requestFile, JSON.stringify(input));
  const spawns = [];
  const submitted = await execute(['council-submit', '--request', requestFile, '--state-dir', root], { spawnWorker: (...args) => spawns.push(args) });
  assert.equal(submitted.data.status, 'running');
  assert.equal(submitted.data.members.length, 2);
  assert.equal(spawns.length, 2);
  const status = await execute(['council-status', input.council_id, '--state-dir', root]);
  assert.deepEqual(status.data.members.map(member => member.task_id), submitted.data.members.map(member => member.task_id));
  const result = await execute(['council-result', input.council_id, '--state-dir', root]);
  assert.equal(result.data.members.length, 2);
});

test('probe does not hide managed snapshot failures', async () => {
  const stateRoot = path.join(root, `probe-supervisor-${randomUUID()}`);
  const runtime = new UnifiedRuntime({
    stateRoot,
    adapterFactory: () => ({ probe: async () => ({ status: 'available', submission: 'not_sent' }) }),
    supervisor: { inspect: () => { throw new Error('host snapshot failed'); } },
  });
  try {
    await assert.rejects(runtime.probe('doubao'), /host snapshot failed/);
  } finally {
    runtime.close();
  }
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

test('submit accepts versioned request JSON from stdin without putting the prompt in argv', async () => {
  const input = request();
  const spawns = [];
  const submitted = await execute(['submit', '--request-stdin', '--state-dir', root], {
    stdin: Readable.from([JSON.stringify(input)]),
    spawnWorker: (...args) => spawns.push(args),
  });
  assert.equal(submitted.data.status, 'registered');
  assert.equal(submitted.data.request_id, input.request_id);
  assert.deepEqual(spawns, [[root, input.request_id]]);
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

test('capabilities declare the managed lifecycle per target kind', async () => {
  const doubao = await execute(['capabilities', 'doubao']);
  assert.deepEqual(doubao.data.lifecycle, { managed: true, auto_launch: true, profile: 'isolated', ensure: true, resume: true, stop: true });
  const opencode = await execute(['capabilities', 'opencode']);
  assert.deepEqual(opencode.data.lifecycle, { managed: true, auto_launch: false, profile: 'inherit-env', ensure: true, resume: false, stop: false });
});

test('ensure and stop delegate to the host supervisor without a state-dir dependency', async () => {
  const ensured = [];
  const stopped = [];
  const released = [];
  const lease = { resource_key: 'instance:doubao', owner_nonce: 'cli', epoch: 1, fencing_token: 'fence-1' };
  const supervisor = {
    ensure: async (target, context) => {
      ensured.push({ target, refresh: context.refresh === true });
      return {
        mode: 'launched',
        lease,
        lifecycle: { state: 'ready', instance_id: 'managed-doubao-1', installation_id: 'inst-doubao', profile_generation: 1, started_by_uagents: true, reused: false },
        installation: { installation_id: 'inst-doubao', canonical_path: 'C:\\fake\\DoubaoWork.exe' },
        instance: { instance_id: 'managed-doubao-1', port: 19222 },
      };
    },
    stop: async (target) => {
      stopped.push(target);
      return { mode: 'stopped', instance_id: 'managed-doubao-1' };
    },
    releaseInstanceLease: (leased) => { released.push(leased); },
  };
  const ensuredResult = await execute(['ensure', 'doubao', '--state-dir', root], { supervisor });
  assert.equal(ensuredResult.ok, true);
  assert.equal(ensuredResult.data.mode, 'launched');
  assert.equal(ensuredResult.data.lifecycle.state, 'ready');
  assert.deepEqual(ensured, [{ target: 'doubao', refresh: false }]);
  // one-shot ensure must not leave the host lease behind (stop/resume follow)
  assert.deepEqual(released, [lease]);
  const refreshed = await execute(['ensure', 'doubao', '--refresh', '--state-dir', root], { supervisor });
  assert.equal(refreshed.ok, true);
  assert.deepEqual(ensured[1], { target: 'doubao', refresh: true });
  const stoppedResult = await execute(['stop', 'doubao', '--state-dir', root], { supervisor });
  assert.equal(stoppedResult.ok, true);
  assert.equal(stoppedResult.data.mode, 'stopped');
  assert.deepEqual(stopped, ['doubao']);
});

test('ensure does not report success when the one-shot host lease cannot be released', async () => {
  const lease = { resource_key: 'instance:doubao', owner_nonce: 'cli', epoch: 1, fencing_token: 'fence-1' };
  const supervisor = {
    ensure: async () => ({
      mode: 'reuse',
      lease,
      lifecycle: { state: 'ready', instance_id: 'managed-doubao-1', installation_id: 'inst-doubao', profile_generation: 1, started_by_uagents: true, reused: true },
      installation: { installation_id: 'inst-doubao', canonical_path: 'C:\\fake\\DoubaoWork.exe' },
      instance: { instance_id: 'managed-doubao-1', port: 19222 },
    }),
    releaseInstanceLease: () => { throw new TypeError('fixture release failure'); },
  };
  await assert.rejects(() => execute(['ensure', 'doubao', '--state-dir', root], { supervisor }), TypeError);
});

test('ensure without a host supervisor is a structured unsupported error', async () => {
  await assert.rejects(
    () => execute(['ensure', 'doubao', '--state-dir', root], { supervisor: null }),
    (error) => {
      assert.equal(error.code, 'unsupported_capability');
      assert.equal(error.submission, 'not_sent');
      return true;
    }
  );
});

test('resume recovers a registered unsent task without creating another attempt', async () => {
  const input = request();
  const requestFile = path.join(root, `resume-${input.request_id}.json`);
  fs.writeFileSync(requestFile, JSON.stringify(input));
  await execute(['submit', '--request', requestFile, '--state-dir', root], { spawnWorker: () => {} });
  const before = await execute(['status', input.request_id, '--state-dir', root]);
  const spawns = [];
  const resumed = await execute(['resume', input.request_id, '--state-dir', root], {
    spawnWorker: (...args) => spawns.push(args), supervisor: null,
  });
  assert.equal(resumed.data.resumed, true);
  assert.equal(resumed.data.attempt.attempt_id, before.data.attempt.attempt_id);
  assert.equal(resumed.data.attempt.submission, 'not_sent');
  assert.deepEqual(spawns, [[root, input.request_id]]);
});
