import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseCouncilRequest, councilJsonSchema, councilMemberTaskId } from '../plugins/uagents/src/protocol/council-schema.mjs';
import { UnifiedRuntime } from '../plugins/uagents/src/runtime/api.mjs';
import { CouncilService } from '../plugins/uagents/src/runtime/council-service.mjs';
import { createRegistry } from '../plugins/uagents/src/registry/registry.mjs';
import { acquireExecutionLeases, releaseLeases } from '../plugins/uagents/src/runtime/leases.mjs';
import { canonicalHash } from '../plugins/uagents/src/protocol/canonical-json.mjs';

const route = 'commandcode-goat/deepseek/deepseek-v4-flash';

const council = patch => ({
  schema_version: '1.0',
  council_id: randomUUID(),
  strategy: 'fanout',
  prompt: 'Review the bounded change.',
  members: [
    { member_id: 'architecture', target: 'workbuddy', model: 'default', instruction: 'Focus on architecture.' },
    { member_id: 'implementation', target: 'opencode', model: route, instruction: 'Focus on implementation feasibility.' },
  ],
  ...patch,
});

test('council schema keeps shared analysis default and gates implementation on git-worktree', () => {
  const id = randomUUID();
  const parsed = parseCouncilRequest(council({ council_id: id }));
  assert.equal(parsed.strategy, 'fanout');
  assert.equal(parsed.mode, 'analysis');
  assert.equal(parsed.workspace_strategy, 'shared');
  assert.equal(parsed.execution.permission, 'advisory-read-only');
  assert.equal(parsed.members.length, 2);
  assert.equal(parsed.members[0].task_id, councilMemberTaskId(id, 'architecture'));
  assert.equal(parsed.members[0].task_id, councilMemberTaskId(id, 'architecture'));
  assert.notEqual(parsed.members[0].task_id, parsed.members[1].task_id);
  assert.throws(() => parseCouncilRequest(council({ members: [council().members[0]] })), { code: 'invalid_request' });
  assert.throws(() => parseCouncilRequest(council({ members: [
    { member_id: 'same', target: 'workbuddy', model: 'default' },
    { member_id: 'same', target: 'opencode', model: route },
  ] })), { code: 'invalid_request' });
  assert.throws(() => parseCouncilRequest(council({ strategy: 'parallel' })), { code: 'invalid_request' });
  assert.throws(() => parseCouncilRequest(council({ mode: 'implementation' })), { code: 'invalid_request' });
  assert.equal(councilJsonSchema().properties.mode.enum.includes('implementation'), true);
  assert.equal(councilJsonSchema().properties.workspace_strategy.enum.includes('git-worktree'), true);
  assert.equal(councilJsonSchema().properties.members.minItems, 2);
});

test('git-worktree Council gives each implementation member an isolated branch and reports its diff', () => {
  const root = path.resolve('.local', 'test-runs', `council-worktree-${randomUUID()}`);
  const repository = path.join(root, 'repo');
  const stateRoot = path.join(root, 'state');
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ['init']);
  git(repository, ['config', 'user.name', 'uAgents Test']);
  git(repository, ['config', 'user.email', 'uagents@example.invalid']);
  fs.writeFileSync(path.join(repository, 'base.txt'), 'base\n');
  git(repository, ['add', 'base.txt']);
  git(repository, ['commit', '-m', 'base']);
  fs.writeFileSync(path.join(repository, 'base.txt'), 'source dirty\n');
  fs.writeFileSync(path.join(repository, 'untracked.txt'), 'source only\n');

  const spawns = [];
  const runtime = new UnifiedRuntime({ stateRoot, spawnWorker: (...args) => { spawns.push(args); } });
  const input = council({
    mode: 'implementation',
    workspace_strategy: 'git-worktree',
    workspace: repository,
  });
  try {
    const submitted = runtime.submitCouncil(input);
    assert.equal(submitted.mode, 'implementation');
    assert.equal(submitted.workspace_strategy, 'git-worktree');
    assert.equal(submitted.members.length, 2);
    assert.notEqual(submitted.members[0].worktree.workspace, submitted.members[1].worktree.workspace);
    assert.notEqual(submitted.members[0].worktree.branch, submitted.members[1].worktree.branch);
    assert.equal(spawns.length, 2);

    const firstLeases = acquireExecutionLeases(runtime.control, {
      target: submitted.members[0].target,
      workspace: submitted.members[0].worktree.workspace,
      ownerNonce: 'council-member-a',
    });
    const secondLeases = acquireExecutionLeases(runtime.control, {
      target: submitted.members[1].target,
      workspace: submitted.members[1].worktree.workspace,
      ownerNonce: 'council-member-b',
    });
    releaseLeases(runtime.control, secondLeases);
    releaseLeases(runtime.control, firstLeases);

    for (const member of submitted.members) {
      const stored = runtime.service.payload(member.task_id);
      assert.equal(stored.request.mode, 'implementation');
      assert.equal(stored.request.workspace, member.worktree.workspace);
      assert.equal(stored.request.execution.permission, 'native');
      assert.match(fs.readFileSync(path.join(member.worktree.workspace, 'base.txt'), 'utf8'), /^base\r?\n$/);
      assert.equal(fs.existsSync(path.join(member.worktree.workspace, 'untracked.txt')), false);
    }

    const first = submitted.members[0];
    fs.writeFileSync(path.join(first.worktree.workspace, 'base.txt'), 'changed\n');
    fs.writeFileSync(path.join(first.worktree.workspace, 'new.txt'), 'new\n');
    const result = runtime.councilResult(input.council_id);
    assert.equal(result.members[0].worktree.dirty, true);
    assert.equal(result.members[0].worktree.changes.some(line => line.includes('base.txt')), true);
    assert.equal(result.members[0].worktree.changes.some(line => line.includes('new.txt')), true);
    assert.equal(result.members[1].worktree.dirty, false);

    const duplicate = runtime.submitCouncil(input);
    assert.equal(duplicate.duplicate, true);
    assert.equal(spawns.length, 2);
    assert.match(fs.readFileSync(path.join(first.worktree.workspace, 'base.txt'), 'utf8'), /^changed\r?\n$/);
  } finally {
    runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('git-worktree Council rejects a non-Git workspace before any member Task is launched', () => {
  const root = path.resolve('.local', 'test-runs', `council-nongit-${randomUUID()}`);
  const workspace = path.join(root, 'plain');
  fs.mkdirSync(workspace, { recursive: true });
  const spawns = [];
  const runtime = new UnifiedRuntime({ stateRoot: path.join(root, 'state'), spawnWorker: (...args) => spawns.push(args) });
  try {
    assert.throws(() => runtime.submitCouncil(council({
      mode: 'implementation', workspace_strategy: 'git-worktree', workspace,
    })), { code: 'invalid_workspace' });
    assert.equal(spawns.length, 0);
  } finally {
    runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('council submit fans out ordinary deterministic Tasks and is idempotent', () => {
  const root = path.resolve('.local', 'test-runs', `council-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  const spawns = [];
  const runtime = new UnifiedRuntime({ stateRoot: root, spawnWorker: (...args) => { spawns.push(args); } });
  const input = council();
  try {
    const first = runtime.submitCouncil(input);
    assert.equal(first.status, 'running');
    assert.equal(first.duplicate, false);
    assert.equal(first.members.length, 2);
    assert.equal(spawns.length, 2);
    assert.deepEqual(spawns.map(([, taskId]) => taskId), first.members.map(member => member.task_id));
    assert.equal(first.members.every(member => member.task.status === 'registered'), true);

    const architecture = runtime.service.payload(first.members[0].task_id);
    const implementation = runtime.service.payload(first.members[1].task_id);
    assert.match(architecture.payload.prompt, /Review the bounded change/);
    assert.match(architecture.payload.prompt, /Focus on architecture/);
    assert.match(implementation.payload.prompt, /Focus on implementation feasibility/);
    assert.equal(architecture.request.mode, 'analysis');
    assert.equal(architecture.request.execution.permission, 'advisory-read-only');

    const second = runtime.submitCouncil(input);
    assert.equal(second.duplicate, true);
    assert.equal(spawns.length, 2);
    assert.deepEqual(second.members.map(member => member.task_id), first.members.map(member => member.task_id));
    assert.throws(() => runtime.submitCouncil({ ...input, prompt: 'changed brief' }), { code: 'request_conflict' });

    const aggregate = runtime.councilResult(input.council_id);
    assert.equal(aggregate.members.length, 2);
    assert.equal(aggregate.members.every(member => member.result.response.text === ''), true);
  } finally {
    runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pre-worktree Council manifests keep exact-resubmission compatibility', () => {
  const root = path.resolve('.local', 'test-runs', `council-legacy-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  const runtime = new UnifiedRuntime({ stateRoot: root, spawnWorker: () => {} });
  const input = council();
  try {
    runtime.submitCouncil(input);
    const directory = path.join(root, 'councils', input.council_id);
    const manifestFile = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const normalized = parseCouncilRequest(input);
    delete normalized.mode;
    delete normalized.workspace_strategy;
    delete manifest.mode;
    delete manifest.workspace_strategy;
    delete manifest.base_head;
    manifest.request_hash = canonicalHash(normalized);
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    const duplicate = runtime.submitCouncil(input);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.mode, 'analysis');
    assert.equal(duplicate.workspace_strategy, 'shared');
  } finally {
    runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('council status survives runtime reopen and all-member static preflight happens before fanout', () => {
  const root = path.resolve('.local', 'test-runs', `council-reopen-${randomUUID()}`);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'brief.txt'), 'fixture');
  const input = council();
  const spawns = [];
  let runtime = new UnifiedRuntime({ stateRoot: root, spawnWorker: (...args) => { spawns.push(args); } });
  try {
    runtime.submitCouncil(input);
    runtime.close();
    runtime = new UnifiedRuntime({ stateRoot: root, spawnWorker: () => {} });
    const status = runtime.councilStatus(input.council_id);
    assert.equal(status.status, 'running');
    assert.equal(status.members.length, 2);

    const invalid = council({
      council_id: randomUUID(), workspace,
      inputs: [{ type: 'file', path: 'brief.txt' }],
      members: [
        { member_id: 'workbuddy', target: 'workbuddy', model: 'default' },
        { member_id: 'agy', target: 'agy', model: 'gemini-fixture-low' },
      ],
    });
    assert.throws(() => runtime.submitCouncil(invalid), { code: 'unsupported_capability' });
    assert.equal(spawns.length, 2);
  } finally {
    runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('council fan-in reports complete and preserves each member result without synthesis', () => {
  const root = path.resolve('.local', 'test-runs', `council-fanin-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  const tasks = new Map();
  const results = new Map();
  const service = new CouncilService({
    stateRoot: root,
    registry: createRegistry(),
    submitTask: request => {
      tasks.set(request.request_id, { task_id: request.request_id, target: request.target, status: 'succeeded' });
      results.set(request.request_id, {
        task_id: request.request_id,
        target: request.target,
        status: 'succeeded',
        response: { text: `result:${request.target}` },
        usage: { total: 1 },
        artifacts: [],
      });
    },
    statusTask: taskId => tasks.get(taskId),
    resultTask: taskId => results.get(taskId),
  });
  try {
    const input = council();
    const submitted = service.submit(input);
    assert.equal(submitted.status, 'complete');
    const result = service.result(input.council_id);
    assert.deepEqual(result.members.map(member => member.result.response.text), ['result:workbuddy', 'result:opencode']);
    assert.equal(Object.hasOwn(result, 'summary'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
