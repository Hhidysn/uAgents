import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildDshPrompt, invokeDshSdk } from '../plugins/uagents/src/transports/dsh-sdk-process.mjs';
import { DshAdapter } from '../plugins/uagents/src/adapters/dsh/adapter.mjs';
import { validateAdapter } from '../plugins/uagents/src/adapters/contract.mjs';

const root = path.resolve('.local', 'test-runs', randomUUID(), 'dsh-sdk');

const request = patch => ({
  schema_version: '1.0',
  request_id: randomUUID(),
  target: 'dsh',
  model: 'deepseek-official/deepseek-flash',
  model_requested: 'deepseek-official/deepseek-flash',
  model_resolved: 'deepseek-flash',
  provider: 'deepseek-official',
  route_id: 'deepseek-official/deepseek-flash',
  mode: 'analysis',
  prompt: 'Reply with fixture.',
  workspace: root,
  execution: { observation_timeout_ms: 2_000, execution_timeout_ms: null, effort: 'low', permission: 'native', native_args: [] },
  expected_outputs: [], inputs: [], policy: { fallback: 'none', max_cost_usd: null }, session: null,
  ...patch,
});

function fakeRuntime({ badIdentity = false, promptError = false, noPromptAck = false, noRootIdle = false } = {}) {
  let child;
  let input = '';
  let closed = false;
  const seen = [];
  const write = value => child.stdout.write(`${JSON.stringify(value)}\n`);
  const spawn = () => {
    child = new EventEmitter();
    Object.assign(child, {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { if (!closed) { closed = true; child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', null)); } },
    });
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', chunk => {
      input += chunk;
      let end;
      while ((end = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, end); input = input.slice(end + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line); seen.push(frame);
        if (frame.method === 'initialize') {
          write({ jsonrpc: '2.0', id: frame.id, result: { serverInfo: { name: badIdentity ? 'wrong-runtime' : 'deepseek-harness-sdk-runtime', version: '0.1.5-rc.1' } } });
        } else if (frame.method === 'session/prompt') {
          if (noPromptAck) continue;
          if (promptError) {
            write({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: 'fixture prompt failure' } });
            continue;
          }
          write({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: frame.params.sessionId, status: 'running' } });
          write({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: 'unrelated', status: 'idle' } });
          write({ jsonrpc: '2.0', id: frame.id, result: { messageId: 'msg-fixture' } });
          write({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: frame.params.sessionId, event: {
            type: 'assistant/message', seq: 3, time: Date.now(), data: {
              message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' }, content: [{ type: 'text', text: 'fixture answer' }] },
              usage: { input_tokens: 7, output_tokens: 2 },
            },
          } } });
          if (!noRootIdle) write({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: frame.params.sessionId, status: 'idle' } });
        } else if (frame.method === 'shutdown') {
          write({ jsonrpc: '2.0', id: frame.id, result: {} });
          if (!closed) { closed = true; child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', 0)); }
        }
      }
    });
    setImmediate(() => child.emit('spawn'));
    return child;
  };
  return { spawn, seen };
}

test('DSH SDK adapter exposes the static contract', () => {
  const descriptor = validateAdapter(new DshAdapter());
  assert.equal(descriptor.target, 'dsh');
  assert.equal(descriptor.transport, 'sdk-jsonrpc-stdio');
  assert.deepEqual(descriptor.inputs, { text: true, files: false, images: false, workspace_readable: true });
});

test('DSH adapter checkpoints possibly-sent before accepted and verifies reported model', async () => {
  const runtime = fakeRuntime();
  const adapter = new DshAdapter({ testDriver: { spawn: runtime.spawn } });
  const current = request();
  const prepared = await adapter.prepare(current, { verifiedEntry: { canonical_path: path.join(root, 'bin.js') }, taskDirectory: root });
  const checkpoints = [];
  const submission = await adapter.dispatch(prepared, {
    checkpoint(kind, payload = {}) { checkpoints.push({ kind, payload }); },
    isCancelRequested: () => false,
  });
  assert.deepEqual(checkpoints.map(item => item.kind), ['possibly_sent', 'accepted']);
  assert.equal(submission.handle.session_id, current.request_id);
  const events = [];
  for await (const event of adapter.observe(submission.handle)) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'succeeded');
  assert.equal(events[0].response, 'fixture answer');
  assert.equal(events[0].model_reported, 'deepseek-flash');
  assert.equal(events[0].model_verified, true);
});

test('DSH SDK completes one root session from running through committed assistant text to idle', async () => {
  const runtime = fakeRuntime();
  const current = request();
  const publications = [];
  let accepted = null;
  const result = await invokeDshSdk({
    entry: path.join(root, 'bin.js'), request: current, workspace: root,
    publish: patch => publications.push(patch), onAccepted: handle => { accepted = handle; }, spawnImpl: runtime.spawn,
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.response, 'fixture answer');
  assert.equal(result.model_reported, 'deepseek-flash');
  assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 2 });
  assert.deepEqual(accepted, { session_id: current.request_id, task_id: 'msg-fixture', status: 'accepted' });
  assert.equal(publications.some(item => item.submission === 'may_have_been_sent'), true);
  const initialize = runtime.seen.find(frame => frame.method === 'initialize');
  assert.deepEqual(initialize.params, { cwd: root, provider: 'deepseek-official', model: 'deepseek-flash' });
  const prompt = runtime.seen.find(frame => frame.method === 'session/prompt');
  assert.equal(prompt.params.sessionId, current.request_id);
  assert.deepEqual(prompt.params.contentBlocks, [{ type: 'text', text: buildDshPrompt(current, root) }]);
  assert.equal(runtime.seen.at(-1).method, 'shutdown');
});

test('DSH SDK initialize identity failure stays pre-send', async () => {
  const runtime = fakeRuntime({ badIdentity: true });
  let possiblySent = false;
  const result = await invokeDshSdk({
    entry: path.join(root, 'bin.js'), request: request(), workspace: root,
    publish: patch => { if (patch.submission === 'may_have_been_sent') possiblySent = true; }, spawnImpl: runtime.spawn,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'native_protocol_mismatch');
  assert.equal(possiblySent, false);
  assert.equal(runtime.seen.some(frame => frame.method === 'session/prompt'), false);
});

test('DSH SDK prompt RPC failure remains ambiguous after the send checkpoint', async () => {
  const runtime = fakeRuntime({ promptError: true });
  let possiblySent = false;
  const result = await invokeDshSdk({
    entry: path.join(root, 'bin.js'), request: request(), workspace: root,
    publish: patch => { if (patch.submission === 'may_have_been_sent') possiblySent = true; }, spawnImpl: runtime.spawn,
  });
  assert.equal(possiblySent, true);
  assert.equal(result.status, 'unknown');
  assert.equal(result.error, 'native_rpc_error');
});

test('DSH SDK missing prompt acknowledgement consumes the observation budget without replay', async () => {
  const runtime = fakeRuntime({ noPromptAck: true });
  let possiblySent = false;
  const result = await invokeDshSdk({
    entry: path.join(root, 'bin.js'),
    request: request({ execution: { observation_timeout_ms: 25, execution_timeout_ms: null, effort: 'low', permission: 'native', native_args: [] } }),
    workspace: root,
    publish: patch => { if (patch.submission === 'may_have_been_sent') possiblySent = true; },
    spawnImpl: runtime.spawn,
  });
  assert.equal(possiblySent, true);
  assert.equal(result.status, 'unknown');
  assert.equal(result.error, 'native_observation_timeout');
  assert.equal(runtime.seen.filter(frame => frame.method === 'session/prompt').length, 1);
});

test('DSH SDK root session requires idle after running', async () => {
  const runtime = fakeRuntime({ noRootIdle: true });
  const result = await invokeDshSdk({
    entry: path.join(root, 'bin.js'), request: request({ execution: { observation_timeout_ms: 25, execution_timeout_ms: null, effort: 'low', permission: 'native', native_args: [] } }),
    workspace: root, spawnImpl: runtime.spawn,
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.error, 'native_observation_timeout');
});

test('DSH SDK cancellation after acceptance stops local observation without claiming remote cancellation', async () => {
  const runtime = fakeRuntime({ noRootIdle: true });
  let cancelled = false;
  const resultPromise = invokeDshSdk({
    entry: path.join(root, 'bin.js'), request: request(), workspace: root,
    spawnImpl: runtime.spawn, isCancelRequested: () => cancelled,
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  cancelled = true;
  const result = await resultPromise;
  assert.equal(result.status, 'unknown');
  assert.equal(result.error, 'cancel_remote_state_unknown');
});
