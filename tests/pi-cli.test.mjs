import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { locateCli, nativeDriver, invokeCli } from '../plugins/uagents/src/transports/cli-process.mjs';
import { buildPiArgs, createPiParser, parsePiVersion, PI_SESSION_GUARD_PATH } from '../plugins/uagents/src/transports/pi-driver.mjs';
import { discoverCliModelCatalog, modelDiscoveryScope, parsePiModelList } from '../plugins/uagents/src/transports/model-discovery.mjs';
import { PiAdapter } from '../plugins/uagents/src/adapters/pi/adapter.mjs';
import { adapterFor } from '../plugins/uagents/src/adapters/index.mjs';
import { validateAdapter } from '../plugins/uagents/src/adapters/contract.mjs';
import { createRegistry } from '../plugins/uagents/src/registry/registry.mjs';
import { resolveModel } from '../plugins/uagents/src/policy/models.mjs';

const root = path.resolve('.local', 'test-runs', randomUUID(), 'pi transport');
fs.mkdirSync(root, { recursive: true });

const request = (patch = {}) => ({
  request_id: randomUUID(), target: 'pi', provider: 'antigravity', model: 'gemini-3-8-flash',
  model_resolved: 'gemini-3-8-flash', effort: 'medium', mode: 'analysis', permission_policy: 'native',
  prompt: 'success', timeout_ms: 5_000, kind: 'run', expected_outputs: [], inputs: [],
  continue_session_id: null, fork_session_id: null, ...patch,
});

// A synthetic pi: reads the prompt from stdin, then emits the documented JSONL
// sequence (session header, messages, agent_settled).
function writeFakePi({ session = 'session-fixture', stopReason = 'stop', settle = true, text = 'pi answer', header = true, guard = true, provider = 'antigravity' } = {}) {
  const entry = path.join(root, `fake-pi-${randomUUID()}.js`);
  fs.writeFileSync(entry, `let input = '';\n` +
    `process.stdin.setEncoding('utf8');\n` +
    `process.stdin.on('data', chunk => input += chunk);\n` +
    `process.stdin.on('end', () => {\n` +
    `  const send = value => process.stdout.write(JSON.stringify(value) + '\\n');\n` +
    (header ? `  send({ type: 'session', version: 3, id: ${JSON.stringify(session)}, cwd: process.cwd() });\n` : '') +
    (guard ? `  send({ type: 'uagents_pi_identity', id: ${JSON.stringify(session)}, cwd: process.cwd() });\n` : '') +
    `  send({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: input }] } });\n` +
    `  send({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: input }] } });\n` +
    `  send({ type: 'message_end', message: { role: 'assistant', provider: ${JSON.stringify(provider)}, model: 'gemini-3-8-flash', ` +
      `stopReason: ${JSON.stringify(stopReason)}, usage: { input: 3, output: 2, totalTokens: 5 }, ` +
      `content: ${JSON.stringify(stopReason === 'stop' ? [{ type: 'text', text }] : [])} } });\n` +
    (guard ? `  send({ type: 'uagents_pi_identity', phase: 'quit', id: ${JSON.stringify(session)}, cwd: process.cwd() });\n` : '') +
    (settle ? `  send({ type: 'agent_settled' });\n` : '') +
    `});\n`);
  return entry;
}

test('pi version parsing accepts a plain semantic version only', () => {
  assert.equal(parsePiVersion('1.0.4\n'), '1.0.4');
  assert.equal(parsePiVersion('pi 1.0.4'), null);
  assert.equal(parsePiVersion('1.0.4\nextra'), null);
});

test('pi arguments map model, thinking, sessions and attachments', () => {
  assert.deepEqual(buildPiArgs(request({ kind: 'probe' }), root), ['--version']);
  assert.deepEqual(buildPiArgs(request(), root), [
    '--mode', 'json', '--extension', PI_SESSION_GUARD_PATH, '--provider', 'antigravity', '--model', 'gemini-3-8-flash', '--thinking', 'medium',
  ]);
  assert.deepEqual(buildPiArgs(request({ continue_session_id: 'session-parent', inputs: [{ type: 'file', path: 'input.md' }] }), root), [
    '--mode', 'json', '--extension', PI_SESSION_GUARD_PATH, '--provider', 'antigravity', '--model', 'gemini-3-8-flash', '--thinking', 'medium',
    '--session', 'session-parent', `@${path.resolve(root, 'input.md')}`,
  ]);
  assert.deepEqual(buildPiArgs(request({ fork_session_id: 'session-parent' }), root), [
    '--mode', 'json', '--extension', PI_SESSION_GUARD_PATH, '--provider', 'antigravity', '--model', 'gemini-3-8-flash', '--thinking', 'medium',
    '--fork', 'session-parent',
  ]);
});

test('pi discovery runs the installed entry with the Node host and verifies identity', () => {
  const entry = path.join(root, 'candidate-pi.js');
  fs.writeFileSync(entry, '// fixture');
  assert.equal(locateCli('pi', { UAGENTS_PI_BIN: entry }), entry);
  const nonScript = path.join(root, 'pi.exe');
  fs.writeFileSync(nonScript, 'fixture');
  assert.throws(() => locateCli('pi', { UAGENTS_PI_BIN: nonScript }), { code: 'invalid_cli_path' });
  assert.throws(() => locateCli('pi', { UAGENTS_PI_BIN: 'relative.js' }), { code: 'invalid_cli_path' });
});

test('pi keeps a nested model id after the provider segment', () => {
  const route = resolveModel(createRegistry(), 'pi', 'openrouter/google/gemini-2.5-flash-image');
  assert.equal(route.provider, 'openrouter');
  assert.equal(route.model_resolved, 'google/gemini-2.5-flash-image');
  assert.equal(route.route_id, 'openrouter/google/gemini-2.5-flash-image');
  assert.deepEqual(buildPiArgs(request({ provider: 'openrouter', model: 'google/gemini-2.5-flash-image' }), root), [
    '--mode', 'json', '--extension', PI_SESSION_GUARD_PATH, '--provider', 'openrouter', '--model', 'google/gemini-2.5-flash-image', '--thinking', 'medium',
  ]);
});

test('pi Windows discovery finds the npm bundle without a shell', { skip: process.platform !== 'win32' }, () => {
  const appData = path.join(root, 'appdata');
  const bundle = path.join(appData, 'npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.writeFileSync(bundle, 'fixture only');
  assert.equal(locateCli('pi', { APPDATA: appData, PATH: '' }), bundle);
});

test('pi native driver runs the bundle with the current Node runtime', () => {
  const entry = path.join(root, 'driver-pi.js');
  fs.writeFileSync(entry, '// fixture');
  const driver = nativeDriver(request(), root, entry);
  assert.equal(driver.command, process.execPath);
  assert.equal(driver.args[0], entry);
  assert.deepEqual(driver.args.slice(1), ['--mode', 'json', '--extension', PI_SESSION_GUARD_PATH, '--provider', 'antigravity', '--model', 'gemini-3-8-flash', '--thinking', 'medium']);
});

test('pi model catalog parsing drops the header and keeps provider/model identity', () => {
  const catalog = 'provider     model                context  max-out  thinking  images\n' +
    'antigravity  gemini-3-8-flash     1M       65.5K    yes       no\n' +
    'openai       gpt-5.4              272K     128K     yes       yes\n';
  assert.deepEqual(parsePiModelList(catalog), [
    { id: 'gemini-3-8-flash', route_id: 'antigravity/gemini-3-8-flash', provider: 'antigravity', kind: 'native_catalog' },
    { id: 'gpt-5.4', route_id: 'openai/gpt-5.4', provider: 'openai', kind: 'native_catalog' },
  ]);
  assert.deepEqual(modelDiscoveryScope('pi'), { version: 2, method: 'native_cli_catalog', argv: ['--list-models'] });
});

test('pi model catalog parsing refuses output without the native header', () => {
  // Real `pi --list-models` output when no provider is authenticated
  // (dist/core/auth-guidance.js): must not become a `No/models` route.
  const noModels = 'No models available. Use /login to log into a provider via OAuth or API key. See:\n' +
    '  https://pi.example/docs/models\n';
  assert.deepEqual(parsePiModelList(noModels), []);
  assert.deepEqual(parsePiModelList('No models matching "foo"\n'), []);
  // A body row without the header is not a catalog either.
  assert.deepEqual(parsePiModelList('antigravity  gemini-3-8-flash  1M  65.5K  yes  no\n'), []);
});

test('pi discovery invokes --list-models through the Node host', async () => {
  const entry = path.join(root, 'discovery-pi.js');
  fs.writeFileSync(entry, '// fixture');
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: 'provider  model\nantigravity  gemini-3-8-flash  1M  65.5K  yes  no\n' };
  };
  const result = await discoverCliModelCatalog('pi', { entryOverride: entry, runner, env: {} });
  assert.deepEqual(calls, [[process.execPath, [entry, '--list-models']]]);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.models.map(model => model.route_id), ['antigravity/gemini-3-8-flash']);
});

test('pi adapter exposes the static contract and is loadable by target id', async () => {
  const descriptor = validateAdapter(new PiAdapter());
  assert.equal(descriptor.target, 'pi');
  assert.equal(descriptor.resume, true);
  assert.equal(descriptor.fork, true);
  assert.deepEqual(descriptor.modes, ['analysis', 'implementation']);
  assert.deepEqual(descriptor.inputs, { text: true, files: true, images: true, workspace_readable: true });
  assert.equal(descriptor.execution_timeout, undefined);
  assert.equal((await adapterFor('pi')).target, 'pi');
});

test('pi transport succeeds only on settled stop with final text', async () => {
  const entry = writeFakePi();
  const result = await invokeCli(root, root, request(), () => {}, nativeDriver(request(), root, entry));
  assert.equal(result.status, 'succeeded');
  assert.equal(result.native_status, 'stop');
  assert.equal(result.result.native_session_id, 'session-fixture');
  assert.equal(result.result.response, 'pi answer');
  assert.deepEqual(result.result.usage, { input: 3, output: 2, totalTokens: 5 });
});

test('pi transport reports a provider error and an unsettled run as not succeeded', async () => {
  const errorEntry = writeFakePi({ stopReason: 'error' });
  const errored = await invokeCli(root, root, request(), () => {}, nativeDriver(request(), root, errorEntry));
  assert.equal(errored.status, 'failed');
  assert.equal(errored.error, 'native_error');

  const unsettledEntry = writeFakePi({ settle: false });
  const unsettled = await invokeCli(root, root, request(), () => {}, nativeDriver(request(), root, unsettledEntry));
  assert.equal(unsettled.status, 'unknown');
  assert.equal(unsettled.error, 'native_completion_unconfirmed');
});

test('pi transport never authenticates a stream whose first record is not the session header', async () => {
  const entry = writeFakePi({ header: false });
  const result = await invokeCli(root, root, request(), () => {}, nativeDriver(request(), root, entry));
  assert.equal(result.status, 'unknown');
  assert.equal(result.error, 'native_session_mismatch');
});

test('pi parser enforces continuation identity and fork separation', () => {
  const publish = () => {};
  const continuing = createPiParser(request({ continue_session_id: 'session-fixture' }), root, publish);
  continuing.event({ type: 'session', version: 3, id: 'session-fixture', cwd: root });
  assert.throws(() => continuing.event({ type: 'session', version: 3, id: 'other', cwd: root }), { code: 'native_session_mismatch' });

  const forking = createPiParser(request({ fork_session_id: 'session-parent' }), root, publish);
  forking.event({ type: 'session', version: 3, id: 'session-child', cwd: root });
  assert.throws(() => forking.event({ type: 'session', version: 3, id: 'session-parent', cwd: root }), { code: 'native_session_mismatch' });

  const mismatched = createPiParser(request(), root, publish);
  assert.throws(() => mismatched.event({ type: 'session', version: 3, id: 'session-fixture', cwd: path.join(root, 'elsewhere') }), {
    code: 'native_session_mismatch',
  });
});

test('pi parser validates the workspace before publishing a session identity', () => {
  const published = [];
  const parser = createPiParser(request(), root, event => published.push(event));
  assert.throws(() => parser.event({ type: 'session', version: 3, id: 'session-fixture', cwd: path.join(root, 'elsewhere') }), {
    code: 'native_session_mismatch',
  });
  assert.deepEqual(published, []);
});

test('pi parser refuses events that precede the session header', () => {
  const parser = createPiParser(request(), root, () => {});
  assert.throws(() => parser.event({ type: 'agent_settled' }), { code: 'native_session_mismatch' });
  assert.throws(() => parser.event({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'x' }] } }), {
    code: 'native_session_mismatch',
  });
});

test('pi parser requires the latest agent run to be settled', () => {
  const parser = createPiParser(request(), root, () => {});
  const answer = text => ({ type: 'message_end', message: { role: 'assistant', provider: 'antigravity', model: 'gemini-3-8-flash', stopReason: 'stop', content: [{ type: 'text', text }] } });
  parser.event({ type: 'session', version: 3, id: 'session-fixture', cwd: root });
  parser.event({ type: 'uagents_pi_identity', id: 'session-fixture', cwd: root });
  parser.event(answer('first'));
  parser.event({ type: 'uagents_pi_identity', phase: 'quit', id: 'session-fixture', cwd: root });
  parser.event({ type: 'agent_settled' });
  // A new low-level run after settlement invalidates the earlier settlement.
  parser.event({ type: 'agent_start' });
  parser.event(answer('second'));
  const stale = parser.finish(0);
  assert.equal(stale.status, 'unknown');
  assert.equal(stale.error, 'native_completion_unconfirmed');
  parser.event({ type: 'uagents_pi_identity', phase: 'quit', id: 'session-fixture', cwd: root });
  parser.event({ type: 'agent_settled' });
  const settled = parser.finish(0);
  assert.equal(settled.status, 'succeeded');
  assert.equal(settled.result.response, 'second');
});

test('pi guard evidence binds the header even when the raw guard record arrives first', () => {
  const parser = createPiParser(request(), root, () => {});
  parser.event({ type: 'uagents_pi_identity', id: 'owned', cwd: root });
  assert.throws(() => parser.event({ type: 'session', id: 'foreign', cwd: root }), { code: 'native_session_mismatch' });
  const bound = createPiParser(request(), root, () => {});
  bound.event({ type: 'session', id: 'owned', cwd: root });
  assert.throws(() => bound.event({ type: 'uagents_pi_identity', id: 'replacement', cwd: root }), { code: 'native_session_mismatch' });
});

test('pi requires guard evidence and refuses a blocked session replacement', async () => {
  const req = request();
  const result = await invokeCli(root, root, req, () => {}, nativeDriver(req, root, writeFakePi({ guard: false })));
  assert.equal(result.status, 'unknown');assert.equal(result.error, 'native_session_guard_unconfirmed');
  const parser = createPiParser(req, root, () => {});
  parser.event({ type: 'session', id: 'owned', cwd: root });
  parser.event({ type: 'uagents_pi_identity', id: 'owned', cwd: root });
  parser.event({ type: 'uagents_pi_session_change_blocked' });
  assert.equal(parser.finish(0).error, 'native_session_change_blocked');
});

test('pi never verifies the same model from a different provider at the adapter boundary', async () => {
  const req = { ...request(), ...resolveModel(createRegistry(), 'pi', 'antigravity/gemini-3-8-flash'), workspace: root,
    execution: { permission: 'native', effort: 'medium', observation_timeout_ms: 5000 } };
  const adapter = new PiAdapter({ testDriver: nativeDriver(request(), root, writeFakePi({ provider: 'other-provider' })) });
  const context = { taskDirectory: root, checkpoint() {} };
  const prepared = await adapter.prepare(req, context);
  const submitted = await adapter.dispatch(prepared, context);
  const observed = (await adapter.observe(submitted.handle).next()).value;
  assert.equal(observed.type, 'failed');assert.equal(observed.error, 'native_model_mismatch');
  assert.equal(observed.model_verified, false);assert.equal(observed.model_verification.match, false);
});

test('pi clears old answers and guard evidence across a new run or extension reload', () => {
  const parser = createPiParser(request(), root, () => {});
  parser.event({ type: 'session', id: 'owned', cwd: root });
  parser.event({ type: 'uagents_pi_identity', id: 'owned', cwd: root });
  parser.event({ type: 'message_end', message: { role: 'assistant', provider: 'antigravity', model: 'gemini-3-8-flash', stopReason: 'stop', content: [{ type: 'text', text: 'OLD' }] } });
  parser.event({ type: 'uagents_pi_identity', phase: 'quit', id: 'owned', cwd: root });parser.event({ type: 'agent_settled' });
  assert.equal(parser.finish(0).status, 'succeeded');
  parser.event({ type: 'agent_start' });parser.event({ type: 'uagents_pi_identity', phase: 'quit', id: 'owned', cwd: root });parser.event({ type: 'agent_settled' });
  assert.equal(parser.finish(0).status, 'unknown');assert.equal(parser.finish(0).result.response, '');
  parser.event({ type: 'uagents_pi_guard_invalidated' });
  assert.equal(parser.finish(0).error, 'native_session_guard_unconfirmed');
});

test('pi model discovery preserves native aliases and long model ids', () => {
  const longId = 'model-' + 'x'.repeat(150);
  assert.deepEqual(parsePiModelList(`provider model\nopenrouter ~deepseek/deepseek-flash-latest\ncustom model@preview\ncustom ${longId}\n`).map(row => row.route_id), [
    'openrouter/~deepseek/deepseek-flash-latest', 'custom/model@preview', `custom/${longId}`,
  ]);
});

test('pi session guard still cancels native changes when protocol output is broken', () => {
  const code = `import guard from ${JSON.stringify(pathToFileURL(PI_SESSION_GUARD_PATH).href)};
    import {closeSync} from 'node:fs';
    const handlers=new Map();guard({on:(name,fn)=>handlers.set(name,fn)});
    closeSync(1);
    const cancelled=['session_before_switch','session_before_fork','session_before_tree'].map(name=>handlers.get(name)({}).cancel);
    process.stderr.write(JSON.stringify(cancelled));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0);assert.deepEqual(JSON.parse(child.stderr), [true, true, true]);
});

test('pi final quit identity survives native JSON backpressure and late agent_start', () => {
  const parser = createPiParser(request(), root, () => {});
  parser.event({ type: 'uagents_pi_identity', phase: 'startup', id: 'owned', cwd: root });
  parser.event({ type: 'uagents_pi_identity', phase: 'settled', id: 'owned', cwd: root });
  parser.event({ type: 'uagents_pi_identity', phase: 'quit', id: 'owned', cwd: root });
  parser.event({ type: 'session', id: 'owned', cwd: root });
  parser.event({ type: 'agent_start' });
  parser.event({ type: 'message_end', message: { role: 'assistant', provider: 'antigravity', model: 'gemini-3-8-flash', stopReason: 'stop', content: [{ type: 'text', text: 'ANSWER' }] } });
  parser.event({ type: 'agent_settled' });
  assert.equal(parser.finish(0).status, 'succeeded');assert.equal(parser.finish(0).model_identity_verified, true);
});
