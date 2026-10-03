import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createLocalService } from '../src/service.mjs';
import { connectService } from '../src/bridge.mjs';
import { ToolRunner } from '../../../src/service/tool-runner.mjs';
import { initializeServiceConfig } from '../../../src/service/config.mjs';
import { UnifiedRuntime } from '../../../src/runtime/api.mjs';
import { execute } from '../../../src/cli/main.mjs';

const base = path.resolve('../../../../.local/test-runs');
const token = 'u'.repeat(43);
const runtimeEntry = path.resolve('test/fixtures/service-runtime.mjs');
const slowEntry = path.resolve('test/fixtures/service-slow-tool.mjs');

const cleanups = new WeakMap();
function cleanup(t, callback) { cleanups.get(t).push(callback); }
async function fixture(t) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'service-http-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const tokenFile = path.join(root, 'auth', 'token');
  const config = await initializeServiceConfig(path.join(root, 'auth', 'config.json'), { schema_version: '1.0', port: 0, state_dir: path.join(root, 'state'), token_file: tokenFile, workspace_roots: [workspace], targets: ['opencode'], poll_interval_ms: 100 });
  fs.writeFileSync(tokenFile, token);
  cleanups.set(t, []);
  t.after(async () => {
    for (const close of cleanups.get(t).reverse()) await close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, workspace, config, request: {
    schema_version: '1.0', request_id: randomUUID(), target: 'opencode',
    model: 'commandcode-goat/deepseek/deepseek-v4-flash', mode: 'analysis', workspace, prompt: 'fixture: 中文',
  } };
}
async function start(t, config, options = {}) {
  const service = await createLocalService({ config, childEntry: runtimeEntry, scheduler: false, ...options });
  cleanup(t, () => service.close()); return service;
}
async function connection(t, service, config) {
  const client = await connectService({ endpoint: service.url, tokenFile: config.token_file });
  cleanup(t, () => client.close()); return client;
}
async function until(check, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('fixture condition timed out');
}
async function legacy(service, method, params = {}, options = {}) {
  const response = await fetch(service.url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25', ...options.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: options.signal });
  const text = await response.text();
  const message = response.headers.get('content-type')?.includes('event-stream')
    ? text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(item => item.id === 1)
    : JSON.parse(text);
  return { response, message };
}

test('HTTP authenticates and validates local Origin/Host before protocol handling', async t => {
  const { config } = await fixture(t); const service = await start(t, config);
  const health = service.url.replace('/mcp', '/health');
  assert.equal((await fetch(health)).status, 401);
  assert.equal((await fetch(health, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(health, { headers: { Authorization: `Bearer ${token}`, Origin: 'http://evil.example' } })).status, 403);
  const invalidHost = await new Promise((resolve, reject) => {
    const req = http.get(health, { headers: { Authorization: `Bearer ${token}`, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.once('error', reject);
  });
  assert.equal(invalidHost, 403);
  assert.equal((await fetch(health, { headers: { Authorization: `Bearer ${token}`, Origin: service.url.replace('/mcp', '') } })).status, 200);
  const tooLarge = await fetch(service.url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'x'.repeat(config.max_request_bytes + 1) });
  assert.equal(tooLarge.status, 413);
});

test('legacy initialize/list and modern SDK clients share the existing 20-tool schema', async t => {
  const { config } = await fixture(t); const service = await start(t, config);
  const initialized = await legacy(service, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-fixture', version: '1' } });
  assert.equal(initialized.response.status, 200); assert.equal(initialized.message.result.serverInfo.name, 'uagents-unified');
  const listed = await legacy(service, 'tools/list'); assert.equal(listed.message.result.tools.length, 20);
  assert.equal((await fetch(service.url, { headers: { Authorization: `Bearer ${token}` } })).status, 405);
  const client = await connection(t, service, config);
  assert.equal(client.tools.length, 20);
  assert.deepEqual(await client.handlers.uagents_list_targets({}), ['opencode']);
});

test('two HTTP callers and direct CLI share UUID, Attempt and structured conflict errors', async t => {
  const { config, root, request } = await fixture(t); const service = await start(t, config);
  const one = await connection(t, service, config), two = await connection(t, service, config);
  const first = await one.handlers.uagents_submit(request), second = await two.handlers.uagents_submit(request);
  assert.equal(second.duplicate, true); assert.equal(second.task_id, first.task_id); assert.equal(second.attempt.attempt_id, first.attempt.attempt_id);
  const file = path.join(root, 'request.json'); fs.writeFileSync(file, JSON.stringify(request));
  const cli = await execute(['submit', '--request', file, '--state-dir', config.state_dir], { spawnWorker: () => {} });
  assert.equal(cli.data.attempt.attempt_id, first.attempt.attempt_id);
  await assert.rejects(one.handlers.uagents_submit({ ...request, prompt: 'changed' }), error => error.code === 'request_conflict');
  await assert.rejects(one.handlers.uagents_submit({ ...request, request_id: randomUUID(), workspace: root }), error => error.code === 'service_scope_denied');
});

test('blocking child tools leave health responsive and exclude service credentials from execution', async t => {
  const { config } = await fixture(t);
  const runner = new ToolRunner({ config, entry: slowEntry });
  const service = await start(t, config, { runner });
  const client = await connection(t, service, config);
  const slow = client.handlers.uagents_probe({ target: 'opencode', model: 'commandcode-goat/deepseek/deepseek-v4-flash' });
  await until(() => runner.snapshot().in_flight === 1);
  const began = Date.now();
  const response = await fetch(service.url.replace('/mcp', '/health'), { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200); assert.ok(Date.now() - began < 300);
  const result = await slow;
  assert.equal(result.secret_in_environment, false); assert.equal(result.config_contains_token_file, false); assert.equal(result.unicode, '中文回传成功');
});

test('HTTP disconnect does not cancel an accepted registration', async t => {
  const { config, request } = await fixture(t);
  const runner = new ToolRunner({ config, entry: slowEntry });
  const service = await start(t, config, { runner });
  const controller = new AbortController();
  const submitted = legacy(service, 'tools/call', { name: 'uagents_submit', arguments: request }, { signal: controller.signal });
  const rejected = assert.rejects(submitted, error => error.name === 'AbortError');
  await until(() => runner.snapshot().in_flight === 1); controller.abort(); await rejected;
  const runtime = new UnifiedRuntime({ stateRoot: config.state_dir, spawnWorker: () => {} }); cleanup(t, () => runtime.close());
  const status = await until(() => { try { return runtime.status(request.request_id); } catch { return null; } });
  assert.equal(status.cancel_requested, false); assert.equal(status.attempt.submission, 'not_sent');
  await until(() => runner.snapshot().in_flight === 0);
});

test('bridge reports a lost response as possibly sent and the original registration remains queryable', async t => {
  const { config, request } = await fixture(t);
  const runner = new ToolRunner({ config, entry: slowEntry });
  const service = await start(t, config, { runner });
  const client = await connection(t, service, config);
  const pending = client.handlers.uagents_submit(request);
  const rejected = assert.rejects(pending, { code: 'service_tool_response_unconfirmed', category: 'transport', submission: 'may_have_been_sent' });
  await until(() => runner.snapshot().in_flight === 1);
  await client.close(); await rejected;
  const runtime = new UnifiedRuntime({ stateRoot: config.state_dir, spawnWorker: () => {} }); cleanup(t, () => runtime.close());
  const status = await until(() => { try { return runtime.status(request.request_id); } catch { return null; } });
  assert.equal(status.task_id, request.request_id); assert.equal(status.cancel_requested, false);
  await until(() => runner.snapshot().in_flight === 0);
});

test('service restart recovers queued fixture tasks and shutdown leaves accepted workers running', async t => {
  const { config, request } = await fixture(t);
  const first = await createLocalService({ config, childEntry: runtimeEntry, scheduler: false });
  cleanup(t, () => first.close());
  const caller = await connectService({ endpoint: first.url, tokenFile: config.token_file });
  cleanup(t, () => caller.close());
  const registered = await caller.handlers.uagents_submit(request); await caller.close(); await first.close();
  const second = await createLocalService({ config, childEntry: runtimeEntry });
  cleanup(t, () => second.close());
  const runtime = new UnifiedRuntime({ stateRoot: config.state_dir, spawnWorker: () => {} }); cleanup(t, () => runtime.close());
  await until(() => runtime.status(request.request_id).attempt.submission === 'sent');
  await second.close();
  const done = await until(() => { const status = runtime.status(request.request_id); return status.status === 'succeeded' && status; });
  assert.equal(done.attempt.attempt_id, registered.attempt.attempt_id);
  assert.equal(runtime.service.events(request.request_id).filter(event => event.type === 'dispatch.possibly_sent').length, 1);
});

test('bundled stdio bridge connects to the shared HTTP service and discovers enabled tools', async t => {
  const { config } = await fixture(t); const service = await start(t, config);
  const client = new Client({ name: 'stdio-fixture', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/bridge.mjs', '--endpoint', service.url, '--token-file', config.token_file], env: process.env }));
  cleanup(t, () => client.close());
  const tools = await client.listTools(); assert.equal(tools.tools.length, 20);
  const result = await client.callTool({ name: 'uagents_list_targets', arguments: {} });
  assert.deepEqual(result.structuredContent.data, ['opencode']);
});
