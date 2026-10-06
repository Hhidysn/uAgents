import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { execute, resolveRunWaitTimeoutMs } from '../plugins/uagents/src/cli/main.mjs';
import { installSkill, skillSourceRoot } from '../plugins/uagents/src/cli/skills.mjs';

const root = path.resolve('.local', 'test-runs', randomUUID(), 'cli convenience');
fs.mkdirSync(root, { recursive: true });
// Keeps the detached worker out of the test: registration is observed on disk.
const noWorker = () => ({ unref() {} });
const stateDir = () => path.join(root, randomUUID(), 'state');

function taskFiles(controlsRoot, taskId) {
  return path.join(controlsRoot, 'tasks', taskId.toLowerCase());
}

test('run discovery exposes one prompt source and no request file', async () => {
  const described = await execute(['describe', 'run'], { env: {} });
  assert.equal(described.ok, true);
  assert.deepEqual(described.data.constraints, [{ type: 'exactly_one', options: ['--prompt', '--prompt-file', '--prompt-stdin'] }]);
  assert.deepEqual(described.data.options.map(option => option.name), [
    '--model', '--mode', '--workspace', '--prompt', '--prompt-file', '--prompt-stdin', '--no-wait', '--timeout-ms',
    '--observation-timeout-ms', '--execution-timeout-ms', '--state-dir', '--config',
  ]);
  assert.equal(described.data.effect, 'may_send_prompt');
  const observation = described.data.options.find(option => option.name === '--observation-timeout-ms');
  assert.deepEqual([observation.type, observation.minimum, observation.maximum], ['integer', 1_000, 1_200_000]);
  assert.equal(observation.default, 600_000);
});

test('run forwards the native deadlines into the request', async () => {
  const controlRoot = stateDir();
  const registered = await execute(['run', 'agy', '--model', 'smoke/model', '-p', 'long task', '--no-wait', '--observation-timeout-ms', '600000', '--state-dir', controlRoot], {
    env: {}, spawnWorker: noWorker,
  });
  const request = JSON.parse(fs.readFileSync(path.join(taskFiles(controlRoot, registered.data.task_id), 'request.json'), 'utf8'));
  assert.equal(request.execution.observation_timeout_ms, 600_000);
  assert.equal(request.execution.execution_timeout_ms, null);

  // A target that cannot enforce a native execution budget refuses it instead of
  // silently ignoring the flag.
  await assert.rejects(() => execute(['run', 'agy', '--model', 'smoke/model', '-p', 'x', '--no-wait', '--execution-timeout-ms', '1800000', '--state-dir', controlRoot], {
    env: {}, spawnWorker: noWorker,
  }), { code: 'unsupported_capability' });

  // Omitted flags stay absent, so the request keeps the schema defaults.
  const plain = await execute(['run', 'agy', '--model', 'smoke/model', '-p', 'default', '--no-wait', '--state-dir', controlRoot], { env: {}, spawnWorker: noWorker });
  assert.equal(JSON.parse(fs.readFileSync(path.join(taskFiles(controlRoot, plain.data.task_id), 'request.json'), 'utf8')).execution.observation_timeout_ms, 600_000);
});

test('the run wait follows an explicitly raised native deadline', () => {
  assert.equal(resolveRunWaitTimeoutMs(undefined, undefined), 900_000);
  // The default wait already covers the default 120s deadline.
  assert.equal(resolveRunWaitTimeoutMs(undefined, 120_000), 900_000);
  assert.equal(resolveRunWaitTimeoutMs(undefined, 600_000), 900_000);
  assert.equal(resolveRunWaitTimeoutMs(undefined, 1_200_000), 1_260_000);
  // An explicit --timeout-ms always wins, even when it is shorter.
  assert.equal(resolveRunWaitTimeoutMs('100', 600_000), 100);
});

test('run keeps a multi-byte prompt intact when stdin splits a character', async () => {
  const controlRoot = stateDir();
  const prompt = '检视修改文件';
  const bytes = Buffer.from(prompt, 'utf8');
  const chunks = Array.from(bytes, (_, index) => bytes.subarray(index, index + 1));
  const result = await execute(['run', 'agy', '--model', 'smoke/model', '--prompt-stdin', '--no-wait', '--state-dir', controlRoot], {
    env: {}, spawnWorker: noWorker, stdin: Readable.from(chunks),
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(taskFiles(controlRoot, result.data.task_id), 'payload.json'), 'utf8')).prompt, prompt);
});

test('submit decodes a multi-byte request from split stdin chunks', async () => {
  const controlRoot = stateDir();
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const body = JSON.stringify({
    schema_version: '1.0', request_id: randomUUID(), target: 'agy', model: 'smoke/model', mode: 'analysis', workspace, prompt: '检视修改文件',
  });
  const bytes = Buffer.from(body, 'utf8');
  const chunks = Array.from(bytes, (_, index) => bytes.subarray(index, index + 1));
  const result = await execute(['submit', '--request-stdin', '--state-dir', controlRoot], { env: {}, spawnWorker: noWorker, stdin: Readable.from(chunks) });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(taskFiles(controlRoot, result.data.task_id), 'payload.json'), 'utf8')).prompt, '检视修改文件');
});

test('the observation and execution deadlines describe different consequences', async () => {
  const described = await execute(['describe', 'run'], { env: {} });
  const text = name => described.data.options.find(option => option.name === name).description;
  // An observation deadline leaves a durable native process running; only the
  // execution deadline terminates the owned process tree.
  assert.match(text('--observation-timeout-ms'), /stopped/);
  assert.match(text('--observation-timeout-ms'), /keeps running/);
  assert.match(text('--execution-timeout-ms'), /terminated/);
});

test('run rejects a native deadline outside the request schema range', async () => {
  const controlRoot = stateDir();
  for (const bad of ['999', '1200001', 'abc', '1.5']) {
    await assert.rejects(() => execute(['run', 'agy', '--model', 'smoke/model', '-p', 'x', '--observation-timeout-ms', bad, '--no-wait', '--state-dir', controlRoot], { env: {}, spawnWorker: noWorker }), { code: 'invalid_request' });
  }
  await assert.rejects(() => execute(['run', 'agy', '--model', 'smoke/model', '-p', 'x', '--execution-timeout-ms', '0', '--no-wait', '--state-dir', controlRoot], { env: {}, spawnWorker: noWorker }), { code: 'invalid_request' });
  assert.equal(fs.existsSync(path.join(controlRoot, 'tasks')), false);
});

test('run registers one task with the default mode, the given workspace and the prompt text', async () => {
  const controlRoot = stateDir();
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const result = await execute(['run', 'agy', '--model', 'smoke/model', '-p', 'hello from run', '--no-wait', '--workspace', workspace, '--state-dir', controlRoot], {
    env: {}, spawnWorker: noWorker,
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.target, 'agy');
  assert.equal(result.data.status, 'registered');
  assert.equal(result.data.model_requested, 'smoke/model');
  const files = taskFiles(controlRoot, result.data.task_id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(files, 'request.json'), 'utf8')).mode, 'analysis');
  assert.equal(JSON.parse(fs.readFileSync(path.join(files, 'request.json'), 'utf8')).workspace, workspace);
  assert.equal(JSON.parse(fs.readFileSync(path.join(files, 'payload.json'), 'utf8')).prompt, 'hello from run');
});

test('run defaults the workspace to the current directory and reads the prompt from stdin', async () => {
  const controlRoot = stateDir();
  const result = await execute(['run', 'agy', '--model', 'smoke/model', '--prompt-stdin', '--no-wait', '--state-dir', controlRoot], {
    env: {}, spawnWorker: noWorker, stdin: Readable.from(['piped prompt']),
  });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(taskFiles(controlRoot, result.data.task_id), 'request.json'), 'utf8')).workspace, process.cwd());
  assert.equal(JSON.parse(fs.readFileSync(path.join(taskFiles(controlRoot, result.data.task_id), 'payload.json'), 'utf8')).prompt, 'piped prompt');
});

test('run rejects a missing, duplicated or empty prompt without registering a task', async () => {
  const controlRoot = stateDir();
  await assert.rejects(() => execute(['run', 'agy', '--model', 'smoke/model', '--no-wait', '--state-dir', controlRoot], { env: {}, spawnWorker: noWorker }), { code: 'usage' });
  await assert.rejects(() => execute(['run', 'agy', '--model', 'smoke/model', '-p', 'a', '--prompt-stdin', '--no-wait', '--state-dir', controlRoot], { env: {}, spawnWorker: noWorker }), { code: 'usage' });
  await assert.rejects(() => execute(['run', 'agy', '--model', 'smoke/model', '-p', '   ', '--no-wait', '--state-dir', controlRoot], { env: {}, spawnWorker: noWorker }), { code: 'invalid_request' });
  await assert.rejects(() => execute(['run', 'agy', '--model', 'smoke/model', '-p', 'a', '--timeout-ms', '0', '--no-wait', '--state-dir', controlRoot], { env: {}, spawnWorker: noWorker }), { code: 'invalid_request' });
  assert.equal(fs.existsSync(path.join(controlRoot, 'tasks')) && fs.readdirSync(path.join(controlRoot, 'tasks')).length > 0, false);
});

test('run returns the persisted status with a warning instead of guessing when the wait ends', async () => {
  const controlRoot = stateDir();
  const result = await execute(['run', 'agy', '--model', 'smoke/model', '-p', 'never dispatched', '--timeout-ms', '100', '--state-dir', controlRoot], {
    env: {}, spawnWorker: noWorker,
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.status, 'registered');
  assert.deepEqual(result.warnings, ['run_wait_timeout']);
  assert.equal(result.data.response.text, '');
});

test('skills path reports the bundled skill inside the installation', async () => {
  const result = await execute(['skills', 'path'], { env: {} });
  assert.equal(result.ok, true);
  assert.equal(result.data.skill, 'agent-dispatch');
  assert.equal(result.data.source, skillSourceRoot());
  assert.equal(fs.existsSync(path.join(result.data.source, 'SKILL.md')), true);
});

test('skills install copies the bundled skill and refuses to replace it silently', async () => {
  const skillsDirectory = path.join(root, 'host-skills');
  const preview = installSkill({ targetDir: skillsDirectory, dryRun: true });
  assert.equal(preview.dry_run, true);
  assert.equal(fs.existsSync(skillsDirectory), false);
  assert.equal(preview.files.includes('agent-dispatch/SKILL.md'), true);

  const installed = installSkill({ targetDir: skillsDirectory });
  assert.equal(installed.replaced, false);
  const copied = path.join(skillsDirectory, 'agent-dispatch');
  assert.equal(fs.readFileSync(path.join(copied, 'SKILL.md'), 'utf8'), fs.readFileSync(path.join(skillSourceRoot(), 'SKILL.md'), 'utf8'));
  assert.equal(fs.existsSync(path.join(copied, 'references', 'protocol.md')), true);

  assert.throws(() => installSkill({ targetDir: skillsDirectory }), { code: 'request_conflict' });

  // --force replaces the directory instead of merging into it.
  fs.writeFileSync(path.join(copied, 'stale.md'), 'stale');
  const replaced = installSkill({ targetDir: skillsDirectory, force: true });
  assert.equal(replaced.replaced, true);
  assert.equal(fs.existsSync(path.join(copied, 'stale.md')), false);
  assert.equal(fs.existsSync(path.join(copied, 'SKILL.md')), true);

  assert.throws(() => installSkill({ targetDir: 'relative/skills' }), { code: 'invalid_request' });
});

test('skills install refuses a --dir that overlaps its own source', async () => {
  const skillsDirectory = path.join(root, 'self-skills');
  const source = path.join(skillsDirectory, 'agent-dispatch');
  fs.cpSync(skillSourceRoot(), source, { recursive: true });
  const references = fs.readdirSync(path.join(source, 'references')).length;

  // A refused install must never remove the source it was about to copy.
  assert.throws(() => installSkill({ source, targetDir: skillsDirectory, force: true }), { code: 'invalid_request' });
  assert.throws(() => installSkill({ source, targetDir: skillsDirectory, dryRun: true }), { code: 'invalid_request' });
  assert.throws(() => installSkill({ source, targetDir: path.join(source, 'references') }), { code: 'invalid_request' });
  assert.equal(fs.existsSync(path.join(source, 'SKILL.md')), true);
  assert.equal(fs.readdirSync(path.join(source, 'references')).length, references);

  // The same guard applies to the packaged source through the CLI. Only the
  // dry-run form is exercised here: a regression must not be able to delete the
  // repository's own skill directory while running the suite.
  await assert.rejects(() => execute(['skills', 'install', '--dir', path.dirname(skillSourceRoot()), '--dry-run'], { env: {} }), { code: 'invalid_request' });
  assert.equal(fs.existsSync(path.join(skillSourceRoot(), 'SKILL.md')), true);
});

test('skills reports usage instead of guessing an action', async () => {
  await assert.rejects(() => execute(['skills'], { env: {} }), { code: 'usage' });
  await assert.rejects(() => execute(['skills', 'install'], { env: {} }), { code: 'usage' });
  await assert.rejects(() => execute(['skills', 'remove', '--dir', path.join(root, 'x')], { env: {} }), { code: 'usage' });
  await assert.rejects(() => execute(['skills', 'path', '--force'], { env: {} }), { code: 'usage' });
});
