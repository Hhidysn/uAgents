import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseCouncilRequest, councilJsonSchema, councilMemberTaskId } from '../plugins/uagents/src/protocol/council-schema.mjs';
import { UnifiedRuntime } from '../plugins/uagents/src/runtime/api.mjs';
import { CouncilService } from '../plugins/uagents/src/runtime/council-service.mjs';
import { createRegistry } from '../plugins/uagents/src/registry/registry.mjs';

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

test('council schema is analysis-only fanout with deterministic member task IDs', () => {
  const id = randomUUID();
  const parsed = parseCouncilRequest(council({ council_id: id }));
  assert.equal(parsed.strategy, 'fanout');
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
  assert.equal(councilJsonSchema()['x-uagents-mode'], 'analysis');
  assert.equal(councilJsonSchema().properties.members.minItems, 2);
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
