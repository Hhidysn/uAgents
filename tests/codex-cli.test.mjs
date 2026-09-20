import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../plugins/uagents/src/adapters/codex/adapter.mjs';
import { validateAdapter } from '../plugins/uagents/src/adapters/contract.mjs';
import { buildCodexPrompt, codexExecArgs, createCodexParser, invokeCodexExec, probeCodexVersion } from '../plugins/uagents/src/transports/codex-process.mjs';

const workspace = path.resolve('.local', 'test-runs', randomUUID(), 'codex-cli');
const entry = path.join(workspace, 'codex.js');
const request = patch => ({
  request_id: randomUUID(), target: 'codex', model_requested: 'gpt-6-astra',
  model_resolved: 'gpt-6-astra', provider: 'codex', route_id: 'codex/gpt-6-astra',
  mode: 'analysis', prompt: 'Write the fixture answer.', workspace,
  execution: { observation_timeout_ms: 2_000, permission: 'native', native_args: [] },
  expected_outputs: [], ...patch,
});

function fakeCli({ fail = false, noTerminal = false, changedThread = false, noThread = false,
  noResponse = false, hang = false } = {}) {
  let child;
  let sent = '';
  let closed = false;
  let argv = null;
  const close = code => {
    if (closed) return;
    closed = true;
    child.stdout.end(); child.stderr.end();
    setImmediate(() => child.emit('close', code));
  };
  const write = value => { if (!closed) child.stdout.write(`${JSON.stringify(value)}\n`); };
  return {
    spawn(_command, args) {
      argv = args;
      child = new EventEmitter();
      Object.assign(child, {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        kill() { close(null); },
      });
      child.stdin.setEncoding('utf8');
      child.stdin.on('data', chunk => { sent += chunk; });
      child.stdin.on('finish', () => {
        if (hang) return;
        if (!noThread) {
          write({ type: 'thread.started', thread_id: 'codex-fixture-thread' });
          if (changedThread) {
            write({ type: 'thread.started', thread_id: 'other-thread' });
            return;
          }
        }
        write({ type: 'turn.started' });
        if (!noResponse) write({ type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: 'Codex 中文 fixture' } });
        if (fail) write({ type: 'turn.failed', error: { message: 'native fixture failure' } });
        else if (!noTerminal) write({ type: 'turn.completed', usage: { input_tokens: 17, cached_input_tokens: 3, output_tokens: 4 } });
        close(fail ? 1 : 0);
      });
      setImmediate(() => child.emit('spawn'));
      return child;
    },
    get sent() { return sent; },
    get args() { return argv; },
  };
}

test('Codex adapter exposes text/workspace and explicit route only', () => {
  const descriptor = validateAdapter(new CodexAdapter());
  assert.equal(descriptor.transport, 'cli-jsonl');
  assert.equal(descriptor.model_selection, 'explicit');
  assert.deepEqual(descriptor.inputs, { text: true, files: false, images: false, workspace_readable: true });
  assert.equal(descriptor.resume, false);
  assert.equal(descriptor.fork, false);
});

test('Codex exec carries Luna model selection only in dispatcher-owned argv', () => {
  const current = request({ model_requested: 'gpt-5.6-luna', model_resolved: 'gpt-5.6-luna', route_id: 'codex/gpt-5.6-luna' });
  const args = codexExecArgs(current, workspace, entry);
  assert.deepEqual(args, [entry, 'exec', '--json', '--model', 'gpt-5.6-luna', '--cd', workspace, '-']);
  assert.equal(args.includes(current.prompt), false);
});

test('Codex exec uses stdin for prompt, explicit model and workspace without injected permission flags', async () => {
  const fixture = fakeCli();
  const current = request({ expected_outputs: [{ path: 'answer.txt', type: 'file', required: true }] });
  const args = codexExecArgs(current, workspace, entry);
  assert.deepEqual(args, [entry, 'exec', '--json', '--model', 'gpt-6-astra', '--cd', workspace, '-']);
  assert.equal(args.join(' ').includes(current.prompt), false);
  const result = await invokeCodexExec({ entry, request: current, workspace, spawnImpl: fixture.spawn });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.native_session_id, 'codex-fixture-thread');
  assert.equal(result.response, 'Codex 中文 fixture');
  assert.deepEqual(result.usage, { input_tokens: 17, cached_input_tokens: 3, output_tokens: 4 });
  assert.equal(fixture.sent, buildCodexPrompt(current, workspace));
  assert.equal(fixture.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(fixture.args.includes('--sandbox'), false);
  assert.equal(fixture.args.includes('--approve-for-me'), false);
});

test('Codex thread acceptance follows possibly-sent checkpoint and reports unverified model', async () => {
  const fixture = fakeCli();
  const adapter = new CodexAdapter({ testDriver: { spawn: fixture.spawn } });
  const prepared = await adapter.prepare(request(), { verifiedEntry: { canonical_path: entry }, taskDirectory: workspace });
  const checkpoints = [];
  const dispatched = await adapter.dispatch(prepared, { checkpoint(kind, details = {}) { checkpoints.push({ kind, details }); } });
  assert.deepEqual(checkpoints.map(event => event.kind), ['possibly_sent', 'accepted']);
  assert.equal(dispatched.handle.session_id, 'codex-fixture-thread');
  const observed = [];
  for await (const event of adapter.observe(dispatched.handle)) observed.push(event);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].type, 'succeeded');
  assert.equal(observed[0].model_reported, null);
  assert.equal(observed[0].model_verified, false);
});

test('Codex parser refuses thread identity changes and completion without start', () => {
  const parser = createCodexParser();
  parser.event({ type: 'thread.started', thread_id: 'thread-a' });
  assert.throws(() => parser.event({ type: 'thread.started', thread_id: 'thread-b' }), { code: 'native_session_mismatch' });
  assert.throws(() => createCodexParser().event({ type: 'turn.completed' }), { code: 'invalid_event_order' });
});

test('Codex parser rejects duplicate turns and assistant messages after completion', () => {
  const parser = createCodexParser();
  parser.event({ type: 'thread.started', thread_id: 'thread-a' });
  assert.throws(() => parser.event({ type: 'item.completed', item: { type: 'agent_message', text: 'early' } }), { code: 'invalid_event_order' });
  parser.event({ type: 'turn.started' });
  assert.throws(() => parser.event({ type: 'turn.started' }), { code: 'invalid_event_order' });
  parser.event({ type: 'item.completed', item: { type: 'agent_message', text: 'complete' } });
  parser.event({ type: 'turn.completed' });
  assert.throws(() => parser.event({ type: 'turn.failed' }), { code: 'invalid_event_order' });
  assert.throws(() => parser.event({ type: 'item.completed', item: { type: 'agent_message', text: 'late' } }), { code: 'invalid_event_order' });
  const preTurnFailure = createCodexParser();
  preTurnFailure.event({ type: 'turn.failed', error: { message: 'native pre-turn failure' } });
  assert.equal(preTurnFailure.finish(1).status, 'failed');
});

test('Codex process transport runs a real local fixture with stdin and JSONL, without a provider', async () => {
  const directory = path.join(workspace, 'actual-process');
  fs.mkdirSync(directory, { recursive: true });
  const fixtureEntry = fileURLToPath(new URL('./fixtures/fake-codex-cli.mjs', import.meta.url));
  const version = await probeCodexVersion(fixtureEntry);
  assert.equal(version.version, '0.0.0-fixture');
  const result = await invokeCodexExec({ entry: fixtureEntry, request: request({ workspace: directory }), workspace: directory });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.native_session_id, 'codex-real-process-fixture');
  assert.equal(result.response, 'Codex subprocess fixture 中文');
  assert.deepEqual(result.usage, { input_tokens: 11, output_tokens: 5 });
  assert.equal(result.launcher_close_confirmed, true);
});

test('Codex failure, missing terminal, thread or response never produce success', async () => {
  for (const [variant, status, error] of [
    [{ fail: true }, 'failed', 'native_turn_failed'],
    [{ noTerminal: true }, 'unknown', 'native_terminal_missing'],
    [{ noThread: true }, 'unknown', 'invalid_event_order'],
    [{ noResponse: true }, 'unknown', 'native_response_empty'],
    [{ changedThread: true }, 'unknown', 'native_session_mismatch'],
  ]) {
    const result = await invokeCodexExec({ entry, request: request(), workspace, spawnImpl: fakeCli(variant).spawn });
    assert.equal(result.status, status);
    assert.equal(result.error, error);
  }
});

test('Codex cancellation and timeout after stdin send keep remote state unknown', async () => {
  let cancelled = false;
  const promise = invokeCodexExec({ entry, request: request(), workspace, spawnImpl: fakeCli({ hang: true }).spawn, isCancelRequested: () => cancelled });
  await new Promise(resolve => setTimeout(resolve, 15));
  cancelled = true;
  const result = await promise;
  assert.equal(result.status, 'unknown');
  assert.equal(result.error, 'cancel_remote_state_unknown');
  const timed = await invokeCodexExec({ entry, request: request({ execution: { observation_timeout_ms: 25 } }), workspace, spawnImpl: fakeCli({ hang: true }).spawn });
  assert.equal(timed.status, 'unknown');
  assert.equal(timed.error, 'native_observation_timeout');
});

test('Codex does not hang when a killed process never emits close', async () => {
  let killCount = 0;
  function stuckProcess() {
    const child = new EventEmitter();
    Object.assign(child, {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { killCount++; return true; }, unref() {},
    });
    setImmediate(() => child.emit('spawn'));
    return child;
  }
  const timed = await invokeCodexExec({ entry, request: request({ execution: { observation_timeout_ms: 20 } }), workspace,
    spawnImpl: stuckProcess, closeGraceMs: 25 });
  assert.equal(timed.status, 'unknown');
  assert.equal(timed.error, 'native_observation_timeout');
  assert.equal(timed.launcher_close_confirmed, false);
  assert.equal(killCount, 1);
  const controller = new AbortController();
  const pending = invokeCodexExec({ entry, request: request(), workspace, spawnImpl: stuckProcess,
    closeGraceMs: 25, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.status, 'unknown');
  assert.equal(cancelled.error, 'cancel_remote_state_unknown');
  assert.equal(cancelled.launcher_close_confirmed, false);
  assert.equal(killCount, 2);
});

test('Codex process spawn error without close settles as unsent failure', async () => {
  const result = await invokeCodexExec({ entry, request: request(), workspace, closeGraceMs: 20,
    spawnImpl() {
      const child = new EventEmitter();
      Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
      setImmediate(() => child.emit('error', new Error('fixture ENOENT')));
      return child;
    },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.submission, 'not_sent');
  assert.equal(result.error, 'native_process_error');
  assert.equal(result.launcher_close_confirmed, false);
});

test('Codex checkpoint failure prevents the first prompt byte', async () => {
  const fixture = fakeCli();
  const result = await invokeCodexExec({ entry, request: request(), workspace,
    spawnImpl: fixture.spawn, publish() { throw new Error('fixture checkpoint rejected'); },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.submission, 'not_sent');
  assert.equal(result.error, 'checkpoint_failed');
  assert.equal(fixture.sent, '');
});

test('Codex version probe uses no prompt and returns version-only evidence', async () => {
  let args;
  const result = await probeCodexVersion(entry, { spawnImpl(_command, argv) {
    args = argv;
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    setImmediate(() => { child.stdout.write('codex-cli 0.153.4\n'); child.stdout.end(); child.emit('close', 0); });
    return child;
  } });
  assert.deepEqual(args, [entry, '--version']);
  assert.deepEqual(result, { status: 'succeeded', scope: 'version_only', version: '0.153.4', submission: 'not_sent' });
});
