import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as z from 'zod/v4';
import { execute } from '../../../src/cli/main.mjs';
import { requestJsonSchema } from '../../../src/protocol/request-json-schema.mjs';
import { councilJsonSchema } from '../../../src/protocol/council-schema.mjs';
import { councilValidationJsonSchema } from '../../../src/protocol/council-validation-schema.mjs';
import { hostAttachmentsToInputs } from '../../../src/host/attachment-inputs.mjs';
import { UnifiedRuntime } from '../../../src/runtime/api.mjs';
import { councilRequestSchema, councilValidateSchema, councilValidationSchema, createToolHandlers, requestSchema } from '../src/server.mjs';

const base = path.resolve('../../../../.local/test-runs');

test('bundled stdio server initializes and lists the unified tool surface', async () => {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'unified-mcp-'));
  const child = spawn(process.execPath, ['dist/server.mjs'], {
    cwd: path.resolve('.'), env: { ...process.env, UAGENTS_STATE_DIR: root }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let buffer = ''; const messages = []; let wake;
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.trim()) { messages.push(JSON.parse(line)); wake?.(); wake = undefined; }
    }
  });
  const wait = id => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`timeout waiting for ${id}`)), 5_000);
    const check = () => { const found = messages.find(item => item.id === id); if (found) { clearTimeout(deadline); resolve(found); } else wake = check; };
    check();
  });
  const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'uagents-test', version: '1' } } });
    assert.equal((await wait(1)).result.serverInfo.name, 'uagents-unified');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listed = await wait(2);
    assert.deepEqual(listed.result.tools.map(tool => tool.name).sort(), [
      'uagents_cancel', 'uagents_council_adopt', 'uagents_council_cleanup', 'uagents_council_diff', 'uagents_council_result', 'uagents_council_status', 'uagents_council_submit', 'uagents_council_validate', 'uagents_ensure', 'uagents_get_capabilities', 'uagents_list_models', 'uagents_list_targets', 'uagents_list_tasks',
      'uagents_probe', 'uagents_reconcile', 'uagents_result', 'uagents_resume', 'uagents_status', 'uagents_stop', 'uagents_submit',
    ]);
    const submitTool = listed.result.tools.find(tool => tool.name === 'uagents_submit');
    const submitSchema = JSON.stringify(submitTool.inputSchema);
    assert.match(submitSchema, /"source"/);
    assert.match(submitSchema, /"attachments"/);
    assert.match(submitSchema, /"local_path"/);
    assert.match(submitSchema, /"image"/);
    assert.match(submitSchema, /"continue_from_task_id"/);
    assert.match(submitSchema, /"fork_from_task_id"/);
    const councilTool = listed.result.tools.find(tool => tool.name === 'uagents_council_submit');
    assert.match(JSON.stringify(councilTool.inputSchema), /"member_id"/);
    assert.match(JSON.stringify(councilTool.inputSchema), /"fanout"/);
  } finally {
    child.stdin.end();
    await new Promise(resolve => { child.once('close', resolve); setTimeout(() => { child.kill(); resolve(); }, 2_000).unref(); });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MCP and CLI share UUID idempotency and the same persisted model fields', async () => {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'unified-parity-'));
  const request = {
    schema_version: '1.0', request_id: randomUUID(), target: 'opencode', model: 'commandcode-goat/deepseek/deepseek-v4-flash',
    mode: 'analysis', prompt: 'do not execute fixture', execution: { observation_timeout_ms: 5_000, effort: 'medium', permission: 'native' },
    policy: { fallback: 'none', max_cost_usd: null },
  };
  const requestFile = path.join(root, 'request-input.json');
  fs.writeFileSync(requestFile, JSON.stringify(request));
  const runtime = new UnifiedRuntime({ stateRoot: root, spawnWorker: () => {} });
  try {
    const handlers = createToolHandlers(runtime);
    const fromMcp = await handlers.uagents_submit(request);
    const fromCli = await execute(['submit', '--request', requestFile, '--state-dir', root], { spawnWorker: () => {} });
    assert.equal(fromCli.ok, true);
    assert.equal(fromCli.data.duplicate, true);
    assert.equal(fromCli.data.task_id, fromMcp.task_id);
    assert.equal(fromCli.data.attempt.attempt_id, fromMcp.attempt.attempt_id);
    for (const field of ['model_requested', 'model_resolved', 'model_reported', 'model_verified']) assert.equal(fromCli.data[field], fromMcp[field]);
    assert.equal((await handlers.uagents_status({ task_id: request.request_id })).status, 'registered');
  } finally { runtime.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('MCP model listing merges configured routes with native discovery evidence', async () => {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'unified-model-discovery-'));
  const runtime = new UnifiedRuntime({
    stateRoot: root,
    spawnWorker: () => {},
    adapterFactory: () => ({ discoverModels: async () => ({
      status: 'ok', discovery: 'native_cli_catalog', models: [
        { id: 'deepseek-v4-flash', route_id: 'commandcode-goat/deepseek/deepseek-v4-flash', provider: 'commandcode-goat/deepseek' },
        { id: 'deepseek-v4-pro', route_id: 'commandcode-goat/deepseek/deepseek-v4-pro', provider: 'commandcode-goat/deepseek' },
      ],
    }) }),
  });
  try {
    const models = await createToolHandlers(runtime).uagents_list_models({ target: 'opencode' });
    assert.equal(models.find(model => model.route_id === 'commandcode-goat/deepseek/deepseek-v4-flash').usable, true);
    assert.equal(models.find(model => model.route_id === 'commandcode-goat/deepseek/deepseek-v4-pro').configured, false);
    assert.equal(models.find(model => model.route_id === 'commandcode-goat/z-ai/glm-5.3-flash').discovered, false);
  } finally { runtime.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('MCP model listing forwards explicit refresh to the shared runtime', async () => {
  let observed = null;
  const handlers = createToolHandlers({
    async listModels(target, options) {
      observed = { target, options };
      return [];
    },
  });
  assert.deepEqual(await handlers.uagents_list_models({ target: 'agy', refresh: true }), []);
  assert.deepEqual(observed, { target: 'agy', options: { refresh: true } });
});

test('MCP submit accepts host-materialized file and image sources and normalizes them before storage', async () => {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'unified-attachments-'));
  const workspace = path.join(root, 'workspace');
  const hostFiles = path.join(root, 'host-files');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(hostFiles, { recursive: true });
  const fileSource = path.join(hostFiles, 'brief.txt');
  const imageSource = path.join(hostFiles, 'screen.png');
  fs.writeFileSync(fileSource, 'host materialized attachment');
  const png = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png, 0);
  png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'ascii'); png.writeUInt32BE(2, 16); png.writeUInt32BE(3, 20);
  fs.writeFileSync(imageSource, png);

  const request = requestSchema.parse({
    schema_version: '1.0', request_id: randomUUID(), target: 'opencode', model: 'commandcode-goat/deepseek/deepseek-v4-flash',
    mode: 'analysis', prompt: 'inspect the attached host files', workspace,
    inputs: [{ type: 'file', source: fileSource }, { type: 'image', source: imageSource }],
    execution: { observation_timeout_ms: 5_000, effort: 'medium', permission: 'native' },
    policy: { fallback: 'none', max_cost_usd: null },
  });
  const runtime = new UnifiedRuntime({ stateRoot: root, spawnWorker: () => {} });
  try {
    const submitted = await createToolHandlers(runtime).uagents_submit(request);
    const stored = runtime.service.payload(submitted.task_id);
    assert.deepEqual(stored.request.inputs.map(input => input.type), ['file', 'image']);
    assert.equal(stored.request.inputs.every(input => input.path.startsWith('.uagents/inputs/')), true);
    assert.equal(stored.request.inputs.some(input => Object.hasOwn(input, 'source')), false);
    assert.equal(stored.payload.input_snapshots[1].media_type, 'image/png');
    assert.equal(stored.payload.input_snapshots[1].width_px, 2);
    assert.equal(stored.payload.input_snapshots[1].height_px, 3);
  } finally { runtime.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('MCP host attachments preserve display names and keep temporary paths out of task identity', async () => {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'unified-host-attachments-'));
  const workspace = path.join(root, 'workspace');
  const hostFiles = path.join(root, 'host-files');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(hostFiles, { recursive: true });
  const firstPath = path.join(hostFiles, 'upload-a.tmp');
  const secondPath = path.join(hostFiles, 'upload-b.tmp');
  const bytes = Buffer.from('%PDF-1.7\nhost attachment');
  fs.writeFileSync(firstPath, bytes);
  fs.writeFileSync(secondPath, bytes);
  const requestId = randomUUID();
  const input = localPath => requestSchema.parse({
    schema_version: '1.0', request_id: requestId, target: 'opencode', model: 'commandcode-goat/deepseek/deepseek-v4-flash',
    mode: 'analysis', prompt: 'inspect the uploaded requirements', workspace,
    attachments: [{ type: 'file', local_path: localPath, name: 'requirements.pdf' }],
    execution: { observation_timeout_ms: 5_000, effort: 'medium', permission: 'native' },
    policy: { fallback: 'none', max_cost_usd: null },
  });
  const runtime = new UnifiedRuntime({ stateRoot: root, spawnWorker: () => {} });
  try {
    const handlers = createToolHandlers(runtime);
    const first = await handlers.uagents_submit(input(firstPath));
    const second = await handlers.uagents_submit(input(secondPath));
    assert.equal(second.duplicate, true);
    assert.equal(second.task_id, first.task_id);
    const stored = runtime.service.payload(first.task_id);
    assert.match(stored.request.inputs[0].path, /-requirements\.pdf$/);
    assert.equal(stored.payload.input_snapshots[0].media_type, 'application/pdf');
    const serialized = JSON.stringify(stored);
    assert.equal(serialized.includes(firstPath), false);
    assert.equal(serialized.includes(secondPath), false);
    assert.equal(serialized.includes(bytes.toString('base64')), false);
  } finally { runtime.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('host attachment adapter rejects non-local paths and invalid display names before Core submit', () => {
  assert.throws(() => hostAttachmentsToInputs([{ type: 'file', local_path: 'relative.tmp' }]), { code: 'invalid_input' });
  assert.throws(() => hostAttachmentsToInputs([{ type: 'file', local_path: path.resolve('missing.tmp') }]), { code: 'invalid_input' });
  const root = fs.mkdtempSync(path.join(base, 'host-attachment-validation-'));
  const localPath = path.join(root, 'upload.tmp');
  fs.writeFileSync(localPath, 'x');
  try {
    assert.throws(() => hostAttachmentsToInputs([{ type: 'file', local_path: localPath, name: '../brief.txt' }]), { code: 'invalid_input' });
    const [input] = hostAttachmentsToInputs([{ type: 'file', local_path: localPath, name: 'brief.txt' }]);
    assert.equal(input.blob.name, 'brief.txt');
    assert.equal(Buffer.from(input.blob.data_base64, 'base64').toString('utf8'), 'x');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('MCP Council host attachments are converted before the Core Council contract', async () => {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'unified-host-council-'));
  const localPath = path.join(root, 'opaque-upload.bin');
  const bytes = Buffer.from('shared council attachment');
  fs.writeFileSync(localPath, bytes);
  let captured = null;
  const handlers = createToolHandlers({
    submitCouncil(input) { captured = input; return { council_id: input.council_id }; },
  });
  const input = councilRequestSchema.parse({
    schema_version: '1.0', council_id: randomUUID(), prompt: 'compare this attachment', workspace: path.resolve(root),
    attachments: [{ type: 'file', local_path: localPath, name: 'brief.txt' }],
    members: [
      { member_id: 'wb', target: 'workbuddy', model: 'default' },
      { member_id: 'oc', target: 'opencode', model: 'commandcode-goat/deepseek/deepseek-v4-flash' },
    ],
  });
  try {
    await handlers.uagents_council_submit(input);
    assert.equal(captured.attachments, undefined);
    assert.equal(captured.inputs.length, 1);
    assert.equal(captured.inputs[0].blob.name, 'brief.txt');
    assert.deepEqual(Buffer.from(captured.inputs[0].blob.data_base64, 'base64'), bytes);
    assert.equal(JSON.stringify(captured).includes(localPath), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('MCP submit accepts connector-materialized blob bytes without a local source path', async () => {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'unified-blob-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const bytes = Buffer.from('%PDF-1.7\nconnector payload');
  const request = requestSchema.parse({
    schema_version: '1.0', request_id: randomUUID(), target: 'opencode', model: 'commandcode-goat/deepseek/deepseek-v4-flash',
    mode: 'analysis', prompt: 'inspect the connector attachment', workspace,
    inputs: [{ type: 'file', blob: { name: 'connector.pdf', data_base64: bytes.toString('base64') } }],
    execution: { observation_timeout_ms: 5_000, effort: 'medium', permission: 'native' },
    policy: { fallback: 'none', max_cost_usd: null },
  });
  const runtime = new UnifiedRuntime({ stateRoot: root, spawnWorker: () => {} });
  try {
    const submitted = await createToolHandlers(runtime).uagents_submit(request);
    const stored = runtime.service.payload(submitted.task_id);
    assert.equal(stored.request.inputs[0].blob, undefined);
    assert.equal(stored.request.inputs[0].source, undefined);
    assert.equal(stored.request.inputs[0].path.startsWith('.uagents/inputs/'), true);
    assert.deepEqual(fs.readFileSync(path.join(workspace, ...stored.request.inputs[0].path.split('/'))), bytes);
    assert.equal(stored.payload.input_snapshots[0].media_type, 'application/pdf');
    assert.equal(JSON.stringify(stored).includes(bytes.toString('base64')), false);
  } finally { runtime.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('MCP attachment schema accepts path, source, or inline blob exclusively', () => {
  const baseInput = {
    schema_version: '1.0', request_id: randomUUID(), target: 'opencode', model: 'commandcode-goat/deepseek/deepseek-v4-flash',
    mode: 'analysis', prompt: 'bounded', workspace: path.resolve('.'),
  };
  assert.equal(requestSchema.safeParse({ ...baseInput, inputs: [{ type: 'image', path: 'screen.png' }] }).success, true);
  assert.equal(requestSchema.safeParse({ ...baseInput, inputs: [{ type: 'file', source: path.resolve('brief.txt') }] }).success, true);
  assert.equal(requestSchema.safeParse({ ...baseInput, inputs: [{ type: 'file', blob: { name: 'brief.txt', data_base64: Buffer.from('brief').toString('base64') } }] }).success, true);
  assert.equal(requestSchema.safeParse({ ...baseInput, inputs: [{ type: 'file' }] }).success, false);
  assert.equal(requestSchema.safeParse({ ...baseInput, inputs: [{ type: 'file', path: 'brief.txt', source: path.resolve('brief.txt') }] }).success, false);
  assert.equal(requestSchema.safeParse({ ...baseInput, inputs: [{ type: 'file', path: 'brief.txt', blob: { name: 'brief.txt', data_base64: '' } }] }).success, false);
  assert.equal(requestSchema.safeParse({ ...baseInput, attachments: [{ type: 'file', local_path: path.resolve('upload.tmp'), name: 'brief.txt' }] }).success, true);
  assert.equal(requestSchema.safeParse({ ...baseInput, attachments: [{ type: 'file', local_path: 'relative.tmp' }] }).success, false);
  assert.equal(requestSchema.safeParse({ ...baseInput, inputs: [{ type: 'file', path: 'brief.txt' }], attachments: [{ type: 'file', local_path: path.resolve('upload.tmp') }] }).success, false);
});

test('MCP request schema exposes explicit task-based session continuation and fork', () => {
  const input = {
    schema_version: '1.0', request_id: randomUUID(), target: 'workbuddy', model: 'default',
    mode: 'analysis', prompt: 'follow up', workspace: path.resolve('.'),
    session: { continue_from_task_id: randomUUID() },
  };
  assert.equal(requestSchema.safeParse(input).success, true);
  assert.equal(requestSchema.safeParse({ ...input, session: { fork_from_task_id: randomUUID() } }).success, true);
  assert.equal(requestSchema.safeParse({ ...input, session: { continue_from_task_id: 'latest' } }).success, false);
  assert.equal(requestSchema.safeParse({ ...input, session: {} }).success, false);
  assert.equal(requestSchema.safeParse({ ...input, session: { continue_from_task_id: randomUUID(), fork_from_task_id: randomUUID() } }).success, false);
});

test('CLI request schema discovery stays structurally aligned with MCP submit schema', () => {
  const core = requestJsonSchema();
  const mcp = z.toJSONSchema(requestSchema);
  assert.deepEqual(mcp.required, core.required);
  assert.deepEqual(Object.keys(mcp.properties).filter(key => key !== 'attachments'), Object.keys(core.properties));
  assert.deepEqual(Object.keys(mcp.properties.attachments.items.properties), ['type', 'local_path', 'name']);
  assert.deepEqual(mcp.properties.mode.enum, core.properties.mode.enum);
  assert.deepEqual(mcp.properties.execution.properties.effort.enum, core.properties.execution.properties.effort.enum);
  assert.deepEqual(mcp.properties.execution.properties.permission.enum, core.properties.execution.properties.permission.enum);
  assert.deepEqual(mcp.properties.inputs.items.properties.type.enum, core.properties.inputs.items.properties.type.enum);
  assert.deepEqual(Object.keys(mcp.properties.inputs.items.properties.blob.properties), ['name', 'data_base64']);
  assert.deepEqual(Object.keys(mcp.properties.session.properties), ['continue_from_task_id', 'fork_from_task_id']);
});

test('MCP Council validation schema stays aligned with Core validation discovery', () => {
  const core = councilValidationJsonSchema();
  const mcp = z.toJSONSchema(councilValidationSchema);
  assert.deepEqual(mcp.required, core.required);
  assert.equal(mcp.properties.command.minItems, core.properties.command.minItems);
  assert.equal(mcp.properties.command.maxItems, core.properties.command.maxItems);
  assert.equal(mcp.properties.checks.minItems, core.properties.checks.minItems);
  assert.equal(mcp.properties.checks.maxItems, core.properties.checks.maxItems);
  assert.deepEqual(mcp.properties.on_failure.enum, core.properties.on_failure.enum);
  assert.equal(mcp.properties.timeout_ms.minimum, core.properties.timeout_ms.minimum);
  assert.equal(mcp.properties.timeout_ms.maximum, core.properties.timeout_ms.maximum);
  assert.equal(councilValidationSchema.safeParse({
    schema_version: '1.0', on_failure: 'continue', checks: [
      { name: 'lint', command: [process.execPath, '-e', 'process.exit(0)'] },
      { name: 'test', command: [process.execPath, '-e', 'process.exit(1)'], timeout_ms: 5_000 },
    ],
  }).success, true);
  assert.equal(councilValidationSchema.safeParse({
    schema_version: '1.0', command: [process.execPath], checks: [{ name: 'x', command: [process.execPath] }],
  }).success, false);
  assert.equal(councilValidationSchema.safeParse({
    schema_version: '1.0', checks: [{ name: 'same', command: [process.execPath] }, { name: 'SAME', command: [process.execPath] }],
  }).success, false);
  assert.equal(councilValidateSchema.safeParse({ council_id: randomUUID(), member_id: 'a', profile: 'pre-adopt' }).success, true);
  assert.equal(councilValidateSchema.safeParse({ council_id: randomUUID(), all: true, profile: 'bad name' }).success, false);
  assert.equal(councilValidateSchema.safeParse({
    council_id: randomUUID(), all: true, profile: 'fast', validation: { schema_version: '1.0', command: [process.execPath] },
  }).success, false);
});

test('MCP Council schema and handlers expose first-class fanout aggregation', async () => {
  const core = councilJsonSchema();
  const mcp = z.toJSONSchema(councilRequestSchema);
  assert.deepEqual(mcp.required, core.required);
  assert.deepEqual(Object.keys(mcp.properties).filter(key => key !== 'attachments'), Object.keys(core.properties));
  assert.equal(mcp.properties.members.minItems, 2);
  assert.equal(mcp.properties.members.maxItems, 16);
  assert.deepEqual(mcp.properties.mode.enum, core.properties.mode.enum);
  assert.deepEqual(mcp.properties.workspace_strategy.enum, core.properties.workspace_strategy.enum);
  assert.equal(councilRequestSchema.safeParse({
    schema_version: '1.0', council_id: randomUUID(), mode: 'implementation', prompt: 'x',
    members: [
      { member_id: 'a', target: 'workbuddy', model: 'default' },
      { member_id: 'b', target: 'opencode', model: 'commandcode-goat/deepseek/deepseek-v4-flash' },
    ],
  }).success, false);

  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'unified-council-'));
  const runtime = new UnifiedRuntime({ stateRoot: root, spawnWorker: () => {} });
  try {
    const handlers = createToolHandlers(runtime);
    const input = {
      schema_version: '1.0', council_id: randomUUID(), strategy: 'fanout', prompt: 'Review the bounded change.',
      members: [
        { member_id: 'wb', target: 'workbuddy', model: 'default' },
        { member_id: 'oc', target: 'opencode', model: 'commandcode-goat/deepseek/deepseek-v4-flash' },
      ],
    };
    const submitted = await handlers.uagents_council_submit(input);
    assert.equal(submitted.status, 'running');
    assert.equal(submitted.members.length, 2);
    assert.equal((await handlers.uagents_council_status({ council_id: input.council_id })).members.length, 2);
    assert.equal((await handlers.uagents_council_result({ council_id: input.council_id })).members.length, 2);
    await assert.rejects(() => handlers.uagents_council_diff({ council_id: input.council_id }), { code: 'unsupported_capability' });
    await assert.rejects(() => handlers.uagents_council_adopt({
      council_id: input.council_id, member_id: 'wb', workspace: root,
    }), { code: 'unsupported_capability' });
    await assert.rejects(() => handlers.uagents_council_validate({
      council_id: input.council_id, member_id: 'wb', validation: { schema_version: '1.0', command: [process.execPath, '-e', 'process.exit(0)'] },
    }), { code: 'unsupported_capability' });
    await assert.rejects(() => handlers.uagents_council_cleanup({
      council_id: input.council_id, member_id: 'wb',
    }), { code: 'unsupported_capability' });
  } finally { runtime.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
