import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as z from 'zod/v4';
import { execute } from '../../../src/cli/main.mjs';
import { requestJsonSchema } from '../../../src/protocol/request-json-schema.mjs';
import { UnifiedRuntime } from '../../../src/runtime/api.mjs';
import { createToolHandlers, requestSchema } from '../src/server.mjs';

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
      'uagents_cancel', 'uagents_ensure', 'uagents_get_capabilities', 'uagents_list_models', 'uagents_list_targets', 'uagents_list_tasks',
      'uagents_probe', 'uagents_reconcile', 'uagents_result', 'uagents_resume', 'uagents_status', 'uagents_stop', 'uagents_submit',
    ]);
    const submitTool = listed.result.tools.find(tool => tool.name === 'uagents_submit');
    const submitSchema = JSON.stringify(submitTool.inputSchema);
    assert.match(submitSchema, /"source"/);
    assert.match(submitSchema, /"image"/);
    assert.match(submitSchema, /"continue_from_task_id"/);
    assert.match(submitSchema, /"fork_from_task_id"/);
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

test('MCP attachment schema requires exactly one of path or source', () => {
  const baseInput = {
    schema_version: '1.0', request_id: randomUUID(), target: 'opencode', model: 'commandcode-goat/deepseek/deepseek-v4-flash',
    mode: 'analysis', prompt: 'bounded', workspace: path.resolve('.'),
  };
  assert.equal(requestSchema.safeParse({ ...baseInput, inputs: [{ type: 'image', path: 'screen.png' }] }).success, true);
  assert.equal(requestSchema.safeParse({ ...baseInput, inputs: [{ type: 'file', source: path.resolve('brief.txt') }] }).success, true);
  assert.equal(requestSchema.safeParse({ ...baseInput, inputs: [{ type: 'file' }] }).success, false);
  assert.equal(requestSchema.safeParse({ ...baseInput, inputs: [{ type: 'file', path: 'brief.txt', source: path.resolve('brief.txt') }] }).success, false);
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
  assert.deepEqual(Object.keys(mcp.properties), Object.keys(core.properties));
  assert.deepEqual(mcp.properties.mode.enum, core.properties.mode.enum);
  assert.deepEqual(mcp.properties.execution.properties.effort.enum, core.properties.execution.properties.effort.enum);
  assert.deepEqual(mcp.properties.execution.properties.permission.enum, core.properties.execution.properties.permission.enum);
  assert.deepEqual(mcp.properties.inputs.items.properties.type.enum, core.properties.inputs.items.properties.type.enum);
  assert.deepEqual(Object.keys(mcp.properties.session.properties), ['continue_from_task_id', 'fork_from_task_id']);
});
