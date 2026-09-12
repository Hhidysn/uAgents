import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseCouncilRequest, councilJsonSchema, councilMemberTaskId } from '../plugins/uagents/src/protocol/council-schema.mjs';
import { parseCouncilValidation, councilValidationJsonSchema } from '../plugins/uagents/src/protocol/council-validation-schema.mjs';
import { councilValidationProfilesJsonSchema, parseCouncilValidationProfiles } from '../plugins/uagents/src/protocol/council-validation-profiles.mjs';
import { UnifiedRuntime } from '../plugins/uagents/src/runtime/api.mjs';
import { CouncilService } from '../plugins/uagents/src/runtime/council-service.mjs';
import { createRegistry } from '../plugins/uagents/src/registry/registry.mjs';
import { acquireExecutionLeases, releaseLeases } from '../plugins/uagents/src/runtime/leases.mjs';
import { canonicalHash } from '../plugins/uagents/src/protocol/canonical-json.mjs';
import { runCouncilValidation } from '../plugins/uagents/src/runtime/council-validation.mjs';

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

test('council validation schema supports legacy argv and ordered named checks', () => {
  const parsed = parseCouncilValidation({ schema_version: '1.0', command: ['node', '--test'] });
  assert.deepEqual(parsed.command, ['node', '--test']);
  assert.equal(parsed.timeout_ms, 120_000);
  const multi = parseCouncilValidation({
    schema_version: '1.0', timeout_ms: 5_000, on_failure: 'stop',
    checks: [
      { name: 'lint', command: ['node', 'lint.mjs'] },
      { name: 'test', command: ['node', '--test'], timeout_ms: 10_000 },
    ],
  });
  assert.equal(multi.on_failure, 'stop');
  assert.deepEqual(multi.checks.map(check => [check.name, check.timeout_ms]), [['lint', 5_000], ['test', 10_000]]);
  assert.equal(councilValidationJsonSchema().properties.command.minItems, 1);
  assert.equal(councilValidationJsonSchema().properties.checks.maxItems, 16);
  assert.deepEqual(councilValidationJsonSchema().properties.on_failure.enum, ['continue', 'stop']);
  assert.throws(() => parseCouncilValidation({ schema_version: '1.0', command: [] }), { code: 'invalid_request' });
  assert.throws(() => parseCouncilValidation({ schema_version: '1.0', command: ['node'], timeout_ms: 1 }), { code: 'invalid_request' });
  assert.throws(() => parseCouncilValidation({ schema_version: '1.0', command: ['node'], checks: [{ name: 'x', command: ['node'] }] }), { code: 'invalid_request' });
  assert.throws(() => parseCouncilValidation({ schema_version: '1.0', checks: [{ name: 'same', command: ['node'] }, { name: 'SAME', command: ['node'] }] }), { code: 'invalid_request' });
  assert.throws(() => parseCouncilValidation({ schema_version: '1.0', command: ['node'], shell: true }), { code: 'unsupported_field' });
});

test('validation profiles reuse the council validation contract without repeating schema_version', () => {
  const parsed = parseCouncilValidationProfiles({
    schema_version: '1.0',
    profiles: {
      fast: { checks: [{ name: 'lint', command: ['node', '--version'] }] },
      'pre-adopt': { command: ['node', '--test'], timeout_ms: 5_000 },
    },
  });
  assert.equal(parsed.profiles.fast.on_failure, 'continue');
  assert.equal(parsed.profiles.fast.checks[0].name, 'lint');
  assert.deepEqual(parsed.profiles['pre-adopt'].command, ['node', '--test']);
  assert.equal(councilValidationProfilesJsonSchema()['x-uagents-location'], '.uagents/validation-profiles.json');
  assert.throws(() => parseCouncilValidationProfiles({ schema_version: '1.0', profiles: { 'bad name': { command: ['node'] } } }), { code: 'invalid_request' });
  assert.throws(() => parseCouncilValidationProfiles({ schema_version: '1.0', profiles: { fast: { schema_version: '1.0', command: ['node'] } } }), { code: 'unsupported_field' });
});

test('council validation bounds captured output without changing command outcome', () => {
  const root = path.resolve('.local', 'test-runs', `council-validation-output-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  try {
    const evidence = runCouncilValidation({ worktree: { workspace: root } }, {
      schema_version: '1.0', command: [process.execPath, '-e', "process.stdout.write('x'.repeat(70000))"], timeout_ms: 5_000,
    });
    assert.equal(evidence.outcome, 'passed');
    assert.equal(evidence.stdout.captured_bytes, 70_000);
    assert.equal(Buffer.byteLength(evidence.stdout.text), 65_536);
    assert.equal(evidence.stdout.truncated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('multi-step council validation records every check and can stop with skipped evidence', () => {
  const root = path.resolve('.local', 'test-runs', `council-validation-multi-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  try {
    const member = { worktree: { workspace: root } };
    const continued = runCouncilValidation(member, {
      schema_version: '1.0', on_failure: 'continue',
      checks: [
        { name: 'lint', command: [process.execPath, '-e', "console.log('lint ok')"] },
        { name: 'typecheck', command: [process.execPath, '-e', "console.error('type error');process.exit(2)"] },
        { name: 'test', command: [process.execPath, '-e', "console.log('tests still ran')"] },
      ],
    });
    assert.equal(continued.outcome, 'failed');
    assert.deepEqual(continued.checks.map(check => check.outcome), ['passed', 'failed', 'passed']);
    assert.match(continued.checks[2].stdout.text, /tests still ran/);

    const stopped = runCouncilValidation(member, {
      schema_version: '1.0', on_failure: 'stop',
      checks: [
        { name: 'lint', command: [process.execPath, '-e', 'process.exit(3)'] },
        { name: 'build', command: [process.execPath, '-e', "console.log('must not run')"] },
      ],
    });
    assert.equal(stopped.outcome, 'failed');
    assert.deepEqual(stopped.checks.map(check => check.outcome), ['failed', 'skipped']);
    assert.equal(stopped.checks[1].started_at_ms, null);
    assert.equal(stopped.checks[1].stdout.text, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
    const secondMember = submitted.members[1];
    fs.writeFileSync(path.join(first.worktree.workspace, 'base.txt'), 'changed\n');
    fs.writeFileSync(path.join(secondMember.worktree.workspace, 'new.txt'), 'new candidate\n');
    const result = runtime.councilResult(input.council_id);
    assert.equal(result.members[0].worktree.dirty, true);
    assert.equal(result.members[0].worktree.changes.some(line => line.includes('base.txt')), true);
    assert.equal(result.members[1].worktree.changes.some(line => line.includes('new.txt')), true);

    const comparison = runtime.councilDiff(input.council_id);
    assert.equal(comparison.workspace_strategy, 'git-worktree');
    assert.equal(comparison.members[0].worktree.tracked_files.some(file => file.path === 'base.txt' && file.status === 'M'), true);
    assert.match(comparison.members[0].worktree.tracked_patch, /changed/);
    assert.deepEqual(comparison.members[0].worktree.untracked_files, []);
    assert.equal(comparison.members[1].worktree.tracked_patch, '');
    assert.deepEqual(comparison.members[1].worktree.tracked_files, []);
    assert.deepEqual(comparison.members[1].worktree.untracked_files, [{
      path: 'new.txt', status: 'untracked', bytes: Buffer.byteLength('new candidate\n'), binary: false, text: 'new candidate\n',
    }]);

    const duplicate = runtime.submitCouncil(input);
    assert.equal(duplicate.duplicate, true);
    assert.equal(spawns.length, 2);
    assert.match(fs.readFileSync(path.join(first.worktree.workspace, 'base.txt'), 'utf8'), /^changed\r?\n$/);
  } finally {
    runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('git-worktree Council fans one inline blob into every member worktree without persisting blob bytes', () => {
  const root = path.resolve('.local', 'test-runs', `council-blob-${randomUUID()}`);
  const repository = path.join(root, 'repo');
  const stateRoot = path.join(root, 'state');
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ['init']);
  git(repository, ['config', 'user.name', 'uAgents Test']);
  git(repository, ['config', 'user.email', 'uagents@example.invalid']);
  fs.writeFileSync(path.join(repository, 'base.txt'), 'base\n');
  git(repository, ['add', 'base.txt']);
  git(repository, ['commit', '-m', 'base']);
  const bytes = Buffer.from('%PDF-1.7\nshared connector blob');
  const encoded = bytes.toString('base64');
  const input = council({
    mode: 'implementation', workspace_strategy: 'git-worktree', workspace: repository,
    members: [
      { member_id: 'implementation-a', target: 'opencode', model: route, instruction: 'Focus on implementation feasibility.' },
      { member_id: 'implementation-b', target: 'opencode', model: route, instruction: 'Check the same attachment independently.' },
    ],
    inputs: [{ type: 'file', blob: { name: 'requirements.pdf', data_base64: encoded } }],
  });
  const spawns = [];
  const runtime = new UnifiedRuntime({ stateRoot, spawnWorker: (...args) => { spawns.push(args); } });
  try {
    const submitted = runtime.submitCouncil(input);
    assert.equal(submitted.members.length, 2);
    assert.equal(spawns.length, 2);
    const persisted = JSON.parse(fs.readFileSync(path.join(stateRoot, 'councils', input.council_id, 'request.json'), 'utf8'));
    assert.equal(persisted.inputs[0].blob.data_base64, null);
    assert.equal(persisted.inputs[0].blob.size_bytes, bytes.length);
    assert.match(persisted.inputs[0].blob.sha256, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(persisted).includes(encoded), false);
    for (const member of submitted.members) {
      const stored = runtime.service.payload(member.task_id);
      assert.equal(stored.request.inputs.length, 1);
      assert.equal(stored.request.inputs[0].blob, undefined);
      assert.equal(stored.request.inputs[0].source, undefined);
      assert.equal(stored.request.inputs[0].path.startsWith('.uagents/inputs/'), true);
      assert.deepEqual(fs.readFileSync(path.join(member.worktree.workspace, ...stored.request.inputs[0].path.split('/'))), bytes);
    }
    assert.equal(runtime.submitCouncil(input).duplicate, true);
    assert.equal(spawns.length, 2);
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

test('council adopt applies one succeeded candidate to an explicit base workspace without commit or merge', () => {
  const root = path.resolve('.local', 'test-runs', `council-adopt-${randomUUID()}`);
  const repository = path.join(root, 'repo');
  const stateRoot = path.join(root, 'state');
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ['init']);
  git(repository, ['config', 'user.name', 'uAgents Test']);
  git(repository, ['config', 'user.email', 'uagents@example.invalid']);
  fs.writeFileSync(path.join(repository, 'base.txt'), 'base\n');
  fs.writeFileSync(path.join(repository, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
  git(repository, ['add', 'base.txt', 'binary.dat']);
  git(repository, ['commit', '-m', 'base']);
  const baseHead = git(repository, ['rev-parse', 'HEAD']).trim();

  const tasks = new Map();
  const service = new CouncilService({
    stateRoot,
    registry: createRegistry(),
    submitTask: request => tasks.set(request.request_id, {
      task_id: request.request_id, target: request.target, status: 'succeeded', native_outcome: 'succeeded', objective_verdict: 'succeeded',
    }),
    statusTask: taskId => tasks.get(taskId),
    resultTask: () => null,
  });
  const input = council({ mode: 'implementation', workspace_strategy: 'git-worktree', workspace: repository });
  try {
    const submitted = service.submit(input);
    const selected = submitted.members[0];
    fs.writeFileSync(path.join(selected.worktree.workspace, 'base.txt'), 'selected\n');
    fs.writeFileSync(path.join(selected.worktree.workspace, 'binary.dat'), Buffer.from([0, 9, 8, 7]));
    fs.mkdirSync(path.join(selected.worktree.workspace, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(selected.worktree.workspace, 'nested', 'new.txt'), 'new candidate file\n');

    fs.writeFileSync(path.join(repository, 'nested-collision.txt'), 'unrelated destination file\n');
    assert.throws(() => service.adopt(input.council_id, {
      memberId: 'missing-member', workspace: repository,
    }), { code: 'invalid_request' });

    const adopted = service.adopt(input.council_id, { memberId: selected.member_id, workspace: repository });
    assert.equal(adopted.member_id, selected.member_id);
    assert.equal(adopted.source.base_head, baseHead);
    assert.equal(adopted.destination.head, baseHead);
    assert.equal(adopted.applied.tracked_patch_bytes > 0, true);
    assert.deepEqual(adopted.applied.untracked_files.map(file => file.path), ['nested/new.txt']);
    assert.match(fs.readFileSync(path.join(repository, 'base.txt'), 'utf8'), /^selected\r?\n$/);
    assert.deepEqual(fs.readFileSync(path.join(repository, 'binary.dat')), Buffer.from([0, 9, 8, 7]));
    assert.match(fs.readFileSync(path.join(repository, 'nested', 'new.txt'), 'utf8'), /^new candidate file\r?\n$/);
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), baseHead);
    assert.equal(git(repository, ['branch', '--show-current']).trim(), 'master');
    assert.equal(git(repository, ['status', '--porcelain=v1']).trim().length > 0, true);
    assert.equal(fs.readFileSync(path.join(selected.worktree.workspace, 'base.txt'), 'utf8').trim(), 'selected');
    assert.throws(() => service.adopt(input.council_id, { memberId: selected.member_id, workspace: repository }), { code: 'request_conflict' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('council adopt preflights untracked collisions before applying tracked changes', () => {
  const root = path.resolve('.local', 'test-runs', `council-adopt-conflict-${randomUUID()}`);
  const repository = path.join(root, 'repo');
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ['init']);
  git(repository, ['config', 'user.name', 'uAgents Test']);
  git(repository, ['config', 'user.email', 'uagents@example.invalid']);
  fs.writeFileSync(path.join(repository, 'base.txt'), 'base\n');
  git(repository, ['add', 'base.txt']);
  git(repository, ['commit', '-m', 'base']);
  const tasks = new Map();
  const service = new CouncilService({
    stateRoot: path.join(root, 'state'), registry: createRegistry(),
    submitTask: request => tasks.set(request.request_id, { task_id: request.request_id, target: request.target, status: 'succeeded' }),
    statusTask: taskId => tasks.get(taskId), resultTask: () => null,
  });
  const input = council({ mode: 'implementation', workspace_strategy: 'git-worktree', workspace: repository });
  try {
    const selected = service.submit(input).members[0];
    fs.writeFileSync(path.join(selected.worktree.workspace, 'base.txt'), 'candidate\n');
    fs.writeFileSync(path.join(selected.worktree.workspace, 'collision.txt'), 'candidate\n');
    fs.writeFileSync(path.join(repository, 'collision.txt'), 'destination\n');
    assert.throws(() => service.adopt(input.council_id, { memberId: selected.member_id, workspace: repository }), { code: 'request_conflict' });
    assert.match(fs.readFileSync(path.join(repository, 'base.txt'), 'utf8'), /^base\r?\n$/);
    assert.equal(fs.readFileSync(path.join(repository, 'collision.txt'), 'utf8'), 'destination\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('council cleanup removes clean member worktree and branch but preserves manifest history', () => {
  const root = path.resolve('.local', 'test-runs', `council-cleanup-${randomUUID()}`);
  const repository = path.join(root, 'repo');
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ['init']);
  git(repository, ['config', 'user.name', 'uAgents Test']);
  git(repository, ['config', 'user.email', 'uagents@example.invalid']);
  fs.writeFileSync(path.join(repository, 'base.txt'), 'base\n');
  git(repository, ['add', 'base.txt']);
  git(repository, ['commit', '-m', 'base']);
  const tasks = new Map();
  const service = new CouncilService({
    stateRoot: path.join(root, 'state'), registry: createRegistry(),
    submitTask: request => tasks.set(request.request_id, { task_id: request.request_id, target: request.target, status: 'succeeded' }),
    statusTask: taskId => tasks.get(taskId), resultTask: () => null,
  });
  const input = council({ mode: 'implementation', workspace_strategy: 'git-worktree', workspace: repository });
  try {
    const submitted = service.submit(input);
    const selected = submitted.members[0];
    const branch = selected.worktree.branch;
    const worktreeRoot = selected.worktree.worktree_root;
    const cleaned = service.cleanup(input.council_id, { memberId: selected.member_id });
    assert.equal(cleaned.members[0].cleanup.removed, true);
    assert.equal(cleaned.members[0].cleanup.forced, false);
    assert.equal(fs.existsSync(worktreeRoot), false);
    assert.equal(git(repository, ['branch', '--list', branch]).trim(), '');

    const status = service.status(input.council_id);
    const historical = status.members.find(member => member.member_id === selected.member_id);
    assert.equal(historical.cleanup.removed, true);
    assert.equal(historical.task.status, 'succeeded');
    assert.equal(service.result(input.council_id).members[0].worktree.removed, true);
    assert.equal(service.diff(input.council_id).members[0].worktree.removed, true);
    assert.throws(() => service.adopt(input.council_id, { memberId: selected.member_id, workspace: repository }), { code: 'request_conflict' });
    assert.equal(service.cleanup(input.council_id, { memberId: selected.member_id }).members[0].cleanup.already_removed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('council cleanup preflights all candidates and requires force for dirty or diverged worktrees', () => {
  const root = path.resolve('.local', 'test-runs', `council-cleanup-force-${randomUUID()}`);
  const repository = path.join(root, 'repo');
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ['init']);
  git(repository, ['config', 'user.name', 'uAgents Test']);
  git(repository, ['config', 'user.email', 'uagents@example.invalid']);
  fs.writeFileSync(path.join(repository, 'base.txt'), 'base\n');
  git(repository, ['add', 'base.txt']);
  git(repository, ['commit', '-m', 'base']);
  const tasks = new Map();
  const service = new CouncilService({
    stateRoot: path.join(root, 'state'), registry: createRegistry(),
    submitTask: request => tasks.set(request.request_id, { task_id: request.request_id, target: request.target, status: 'succeeded' }),
    statusTask: taskId => tasks.get(taskId), resultTask: () => null,
  });
  const input = council({ mode: 'implementation', workspace_strategy: 'git-worktree', workspace: repository });
  try {
    const submitted = service.submit(input);
    const [dirty, diverged] = submitted.members;
    fs.writeFileSync(path.join(dirty.worktree.workspace, 'candidate.txt'), 'keep unless forced\n');
    fs.writeFileSync(path.join(diverged.worktree.workspace, 'base.txt'), 'committed candidate\n');
    git(diverged.worktree.workspace, ['add', 'base.txt']);
    git(diverged.worktree.workspace, ['commit', '-m', 'candidate commit']);
    assert.throws(() => service.cleanup(input.council_id, { all: true }), { code: 'request_conflict' });
    assert.equal(fs.existsSync(dirty.worktree.worktree_root), true);
    assert.equal(fs.existsSync(diverged.worktree.worktree_root), true);

    const cleaned = service.cleanup(input.council_id, { all: true, force: true });
    assert.equal(cleaned.members.length, 2);
    assert.equal(cleaned.members.every(member => member.cleanup.removed), true);
    assert.equal(fs.existsSync(dirty.worktree.worktree_root), false);
    assert.equal(fs.existsSync(diverged.worktree.worktree_root), false);
    const duplicate = service.submit(input);
    assert.equal(duplicate.duplicate, true);
    assert.equal(fs.existsSync(dirty.worktree.worktree_root), false);
    assert.equal(fs.existsSync(diverged.worktree.worktree_root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('council validation records pass/fail evidence per candidate and exposes it through diff', () => {
  const root = path.resolve('.local', 'test-runs', `council-validation-${randomUUID()}`);
  const repository = path.join(root, 'repo');
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ['init']);
  git(repository, ['config', 'user.name', 'uAgents Test']);
  git(repository, ['config', 'user.email', 'uagents@example.invalid']);
  fs.writeFileSync(path.join(repository, 'base.txt'), 'base\n');
  git(repository, ['add', 'base.txt']);
  git(repository, ['commit', '-m', 'base']);
  const tasks = new Map();
  const service = new CouncilService({
    stateRoot: path.join(root, 'state'), registry: createRegistry(),
    submitTask: request => tasks.set(request.request_id, { task_id: request.request_id, target: request.target, status: 'succeeded' }),
    statusTask: taskId => tasks.get(taskId), resultTask: () => null,
  });
  const input = council({ mode: 'implementation', workspace_strategy: 'git-worktree', workspace: repository });
  try {
    const submitted = service.submit(input);
    fs.writeFileSync(path.join(submitted.members[0].worktree.workspace, 'marker.txt'), 'present\n');
    const validation = {
      schema_version: '1.0',
      command: [process.execPath, '-e', "const fs=require('fs'); if(fs.existsSync('marker.txt')){console.log('marker ok')}else{console.error('missing marker');process.exit(7)}"],
      timeout_ms: 5_000,
    };
    const validated = service.validate(input.council_id, { all: true, validation });
    assert.deepEqual(validated.members.map(member => member.validation.outcome), ['passed', 'failed']);
    assert.deepEqual(validated.members.map(member => member.validation.exit_code), [0, 7]);
    assert.match(validated.members[0].validation.stdout.text, /marker ok/);
    assert.match(validated.members[1].validation.stderr.text, /missing marker/);
    const status = service.status(input.council_id);
    assert.deepEqual(status.members.map(member => member.validation.outcome), ['passed', 'failed']);
    const compared = service.diff(input.council_id);
    assert.deepEqual(compared.members.map(member => member.validation.outcome), ['passed', 'failed']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('council validation persists multi-step evidence per candidate and exposes named checks through diff', () => {
  const root = path.resolve('.local', 'test-runs', `council-validation-multi-service-${randomUUID()}`);
  const repository = path.join(root, 'repo');
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ['init']);
  git(repository, ['config', 'user.name', 'uAgents Test']);
  git(repository, ['config', 'user.email', 'uagents@example.invalid']);
  fs.writeFileSync(path.join(repository, 'base.txt'), 'base\n');
  git(repository, ['add', 'base.txt']);
  git(repository, ['commit', '-m', 'base']);
  const tasks = new Map();
  const service = new CouncilService({
    stateRoot: path.join(root, 'state'), registry: createRegistry(),
    submitTask: request => tasks.set(request.request_id, { task_id: request.request_id, target: request.target, status: 'succeeded' }),
    statusTask: taskId => tasks.get(taskId), resultTask: () => null,
  });
  const input = council({ mode: 'implementation', workspace_strategy: 'git-worktree', workspace: repository });
  try {
    const submitted = service.submit(input);
    fs.writeFileSync(path.join(submitted.members[0].worktree.workspace, 'marker.txt'), 'present\n');
    const validation = {
      schema_version: '1.0', on_failure: 'continue',
      checks: [
        { name: 'marker', command: [process.execPath, '-e', "const fs=require('fs');process.exit(fs.existsSync('marker.txt')?0:4)"] },
        { name: 'always', command: [process.execPath, '-e', "console.log('ran')"] },
      ],
    };
    const validated = service.validate(input.council_id, { all: true, validation });
    assert.deepEqual(validated.members.map(member => member.validation.outcome), ['passed', 'failed']);
    assert.deepEqual(validated.members[0].validation.checks.map(check => check.name), ['marker', 'always']);
    assert.deepEqual(validated.members[1].validation.checks.map(check => check.outcome), ['failed', 'passed']);
    const compared = service.diff(input.council_id);
    assert.equal(compared.members[0].validation.checks[0].name, 'marker');
    assert.equal(compared.members[1].validation.checks[0].exit_code, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('council validation profile is loaded from the source workspace and persisted with expanded evidence', () => {
  const root = path.resolve('.local', 'test-runs', `council-validation-profile-${randomUUID()}`);
  const repository = path.join(root, 'repo');
  fs.mkdirSync(path.join(repository, '.uagents'), { recursive: true });
  git(repository, ['init']);
  git(repository, ['config', 'user.name', 'uAgents Test']);
  git(repository, ['config', 'user.email', 'uagents@example.invalid']);
  fs.writeFileSync(path.join(repository, 'base.txt'), 'base\n');
  fs.writeFileSync(path.join(repository, '.uagents', 'validation-profiles.json'), JSON.stringify({
    schema_version: '1.0',
    profiles: {
      'pre-adopt': {
        checks: [{ name: 'source-standard', command: [process.execPath, '-e', "console.log('source-profile')"] }],
      },
    },
  }, null, 2));
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'base']);
  const tasks = new Map();
  const service = new CouncilService({
    stateRoot: path.join(root, 'state'), registry: createRegistry(),
    submitTask: request => tasks.set(request.request_id, { task_id: request.request_id, target: request.target, status: 'succeeded' }),
    statusTask: taskId => tasks.get(taskId), resultTask: () => null,
  });
  const input = council({ mode: 'implementation', workspace_strategy: 'git-worktree', workspace: repository });
  try {
    const submitted = service.submit(input);
    fs.writeFileSync(path.join(submitted.members[0].worktree.workspace, '.uagents', 'validation-profiles.json'), JSON.stringify({
      schema_version: '1.0', profiles: { 'pre-adopt': { command: [process.execPath, '-e', 'process.exit(9)'] } },
    }));
    const validated = service.validate(input.council_id, { all: true, profile: 'pre-adopt' });
    assert.equal(validated.members.every(member => member.validation.outcome === 'passed'), true);
    assert.equal(validated.members.every(member => member.validation.profile.name === 'pre-adopt'), true);
    assert.equal(validated.members.every(member => member.validation.profile.file === '.uagents/validation-profiles.json'), true);
    assert.equal(validated.members.every(member => member.validation.checks[0].stdout.text === 'source-profile\n'), true);
    assert.equal(service.diff(input.council_id).members[0].validation.profile.name, 'pre-adopt');
    assert.throws(() => service.validate(input.council_id, { all: true, profile: 'missing' }), { code: 'invalid_request' });
    assert.throws(() => service.validate(input.council_id, { all: true, profile: 'pre-adopt', validation: { schema_version: '1.0', command: ['node'] } }), { code: 'invalid_request' });
    fs.rmSync(path.join(repository, '.uagents', 'validation-profiles.json'));
    assert.throws(() => service.validate(input.council_id, { all: true, profile: 'pre-adopt' }), { code: 'invalid_request' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('council validation records timeout and rejects cleaned candidates before running', () => {
  const root = path.resolve('.local', 'test-runs', `council-validation-timeout-${randomUUID()}`);
  const repository = path.join(root, 'repo');
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ['init']);
  git(repository, ['config', 'user.name', 'uAgents Test']);
  git(repository, ['config', 'user.email', 'uagents@example.invalid']);
  fs.writeFileSync(path.join(repository, 'base.txt'), 'base\n');
  git(repository, ['add', 'base.txt']);
  git(repository, ['commit', '-m', 'base']);
  const tasks = new Map();
  const service = new CouncilService({
    stateRoot: path.join(root, 'state'), registry: createRegistry(),
    submitTask: request => tasks.set(request.request_id, { task_id: request.request_id, target: request.target, status: 'succeeded' }),
    statusTask: taskId => tasks.get(taskId), resultTask: () => null,
  });
  const input = council({ mode: 'implementation', workspace_strategy: 'git-worktree', workspace: repository });
  try {
    const submitted = service.submit(input);
    const timed = service.validate(input.council_id, {
      memberId: submitted.members[0].member_id,
      validation: { schema_version: '1.0', command: [process.execPath, '-e', 'setTimeout(()=>{},5000)'], timeout_ms: 150 },
    });
    assert.equal(timed.members[0].validation.outcome, 'timeout');
    assert.equal(timed.members[0].validation.error_code, 'ETIMEDOUT');
    service.cleanup(input.council_id, { memberId: submitted.members[0].member_id, force: true });
    assert.throws(() => service.validate(input.council_id, {
      memberId: submitted.members[0].member_id,
      validation: { schema_version: '1.0', command: [process.execPath, '-e', 'process.exit(0)'] },
    }), { code: 'request_conflict' });
  } finally {
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
    assert.throws(() => runtime.councilDiff(input.council_id), { code: 'unsupported_capability' });
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
