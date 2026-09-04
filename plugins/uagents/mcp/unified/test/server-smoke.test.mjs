import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { execute } from '../../../src/cli/main.mjs';
import { UnifiedRuntime } from '../../../src/runtime/api.mjs';
import { createToolHandlers } from '../src/server.mjs';

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
      'uagents_cancel', 'uagents_get_capabilities', 'uagents_list_models', 'uagents_list_targets', 'uagents_list_tasks',
      'uagents_probe', 'uagents_reconcile', 'uagents_result', 'uagents_status', 'uagents_submit',
    ]);
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
