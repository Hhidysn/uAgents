import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AgyAdapter } from '../plugins/uagents/src/adapters/agy/adapter.mjs';
import { OpenCodeAdapter } from '../plugins/uagents/src/adapters/opencode/adapter.mjs';
import { WorkBuddyAdapter } from '../plugins/uagents/src/adapters/workbuddy/adapter.mjs';
import { nativeDriver } from '../plugins/uagents/src/transports/cli-process.mjs';
import { validateAdapter } from '../plugins/uagents/src/adapters/contract.mjs';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { runTask } from '../plugins/uagents/src/runtime/worker.mjs';

const root = path.resolve('.local', 'test-runs', randomUUID(), 'unified adapters');
fs.mkdirSync(root, { recursive: true });
const fakeCli = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
const fakeAgy = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));
const baseRequest = patch => ({
  schema_version: '1.0', request_id: randomUUID(), target: 'opencode', model: 'commandcode-goat/deepseek/deepseek-v4-flash',
  mode: 'analysis', prompt: 'bounded', execution: { observation_timeout_ms: 5000, effort: 'medium', permission: 'native' },
  policy: { fallback: 'none', max_cost_usd: null }, ...patch,
});

for (const target of ['agy', 'workbuddy', 'opencode']) test(`${target} adapter completes through shared runtime`, async () => {
  const control = new ControlDatabase(path.join(root, `${target}-${randomUUID()}`));
  try {
    const service = new TaskService(control);
    const input = target === 'agy'
      ? baseRequest({ target, model: 'gemini-fixture-success' })
      : target === 'workbuddy'
        ? baseRequest({ target, model: 'default', mode: 'implementation', expected_outputs: [{ path: 'artifact.txt', type: 'file', required: true, max_bytes: 1024 }] })
        : baseRequest({ target });
    const driver = target === 'agy'
      ? { command: process.execPath, args: [fakeAgy, 'success'] }
      : { command: process.execPath, args: [fakeCli, target, input.request_id, 'success'] };
    const adapter = target === 'agy' ? new AgyAdapter({ testDriver: driver })
      : target === 'workbuddy' ? new WorkBuddyAdapter({ testDriver: driver }) : new OpenCodeAdapter({ testDriver: driver });
    validateAdapter(adapter);
    const registered = service.submit(input, { adapterVersion: 'unified-fixture-1' });
    const result = await runTask({ service, taskId: registered.task_id, adapter });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.attempt.submission, 'sent');
    assert.equal(service.result(result.task_id).response.text.includes('中文'), true);
    if (target === 'agy') {
      assert.equal(result.model_reported, 'gemini-fixture-success');
      assert.equal(result.model_verified, true);
    } else if (target === 'opencode') {
      assert.equal(result.model_reported, null);
      assert.equal(result.model_verified, false);
    } else {
      assert.equal(service.result(result.task_id).artifacts[0].verified, true);
    }
  } finally { control.close(); }
});

test('OpenCode implementation succeeds without expected outputs and ignores legacy permission admission', async () => {
  const control = new ControlDatabase(path.join(root, `rejected-${randomUUID()}`));
  try {
    const service = new TaskService(control);
    const input = baseRequest({
      mode: 'implementation',
      execution: { observation_timeout_ms: 5_000, effort: 'medium', permission: 'full-access' },
    });
    const driver = { command: process.execPath, args: [fakeCli, 'opencode', input.request_id, 'success'] };
    const adapter = new OpenCodeAdapter({ testDriver: driver });
    const registered = service.submit(input, { adapterVersion: 'unified-fixture-1' });
    const result = await runTask({ service, taskId: registered.task_id, adapter });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.attempt.submission, 'sent');
    assert.deepEqual(service.result(result.task_id).artifacts, []);
  } finally { control.close(); }
});

test('OpenCode implementation reuses verified file inputs and captures declared outputs', async () => {
  const control = new ControlDatabase(path.join(root, `opencode-files-${randomUUID()}`));
  const workspace = path.join(root, `workspace-${randomUUID()}`);
  fs.mkdirSync(path.join(workspace, 'requirements'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'requirements', 'brief.md'), 'verified input');
  try {
    const service = new TaskService(control);
    const input = baseRequest({
      workspace,
      mode: 'implementation',
      inputs: [{ type: 'file', path: 'requirements/brief.md' }],
      expected_outputs: [{ path: 'artifact.txt', type: 'file', required: true, max_bytes: 1024 }],
    });
    const driver = { command: process.execPath, args: [fakeCli, 'opencode', input.request_id, 'success'] };
    const adapter = new OpenCodeAdapter({ testDriver: driver });
    const registered = service.submit(input, { adapterVersion: 'unified-fixture-1' });
    const stored = service.payload(registered.task_id);
    assert.equal(stored.payload.input_snapshots[0].path, 'requirements/brief.md');
    const result = await runTask({ service, taskId: registered.task_id, adapter });
    assert.equal(result.status, 'succeeded');
    assert.equal(service.result(result.task_id).artifacts[0].verified, true);
  } finally { control.close(); }
});

test('external file and image sources are ingested into workspace before registration', () => {
  const control = new ControlDatabase(path.join(root, `source-inputs-${randomUUID()}`));
  const workspace = path.join(root, `source-workspace-${randomUUID()}`);
  const incoming = path.join(root, `incoming-${randomUUID()}`);
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(incoming, { recursive: true });
  const fileSource = path.join(incoming, 'brief.pdf');
  const imageSource = path.join(incoming, 'screen.png');
  fs.writeFileSync(fileSource, '%PDF-1.7\nexternal attachment');
  fs.writeFileSync(imageSource, pngFixture(3, 2));
  try {
    const service = new TaskService(control);
    const input = baseRequest({
      workspace,
      inputs: [{ type: 'file', source: fileSource }, { type: 'image', source: imageSource }],
    });
    const registered = service.submit(input, { adapterVersion: 'unified-fixture-1' });
    const stored = service.payload(registered.task_id);
    assert.equal(stored.request.inputs.length, 2);
    assert.equal(stored.request.inputs.every(item => item.source === undefined), true);
    assert.equal(stored.request.inputs.every(item => item.path.startsWith('.uagents/inputs/')), true);
    assert.equal(fs.readFileSync(path.join(workspace, ...stored.request.inputs[0].path.split('/')), 'utf8'), '%PDF-1.7\nexternal attachment');
    assert.deepEqual(fs.readFileSync(path.join(workspace, ...stored.request.inputs[1].path.split('/'))), pngFixture(3, 2));
    assert.equal(stored.payload.input_snapshots[0].media_type, 'application/pdf');
    assert.equal(stored.payload.input_snapshots[1].media_type, 'image/png');
    assert.equal(stored.payload.input_snapshots[1].width_px, 3);
    assert.equal(stored.payload.input_snapshots[1].height_px, 2);
  } finally { control.close(); }
});

test('inline file and image blobs are ingested into workspace without persisting blob payloads', () => {
  const control = new ControlDatabase(path.join(root, `blob-inputs-${randomUUID()}`));
  const workspace = path.join(root, `blob-workspace-${randomUUID()}`);
  fs.mkdirSync(workspace, { recursive: true });
  const fileBytes = Buffer.from('%PDF-1.7\nconnector blob attachment');
  const imageBytes = pngFixture(4, 5);
  try {
    const service = new TaskService(control);
    const input = baseRequest({
      workspace,
      inputs: [
        { type: 'file', blob: { name: 'brief.pdf', data_base64: fileBytes.toString('base64') } },
        { type: 'image', blob: { name: 'screen.png', data_base64: imageBytes.toString('base64') } },
      ],
    });
    const registered = service.submit(input, { adapterVersion: 'unified-fixture-1' });
    const stored = service.payload(registered.task_id);
    assert.equal(stored.request.inputs.length, 2);
    assert.equal(stored.request.inputs.every(item => item.path.startsWith('.uagents/inputs/')), true);
    assert.equal(stored.request.inputs.some(item => item.source !== undefined || item.blob !== undefined), false);
    assert.deepEqual(fs.readFileSync(path.join(workspace, ...stored.request.inputs[0].path.split('/'))), fileBytes);
    assert.deepEqual(fs.readFileSync(path.join(workspace, ...stored.request.inputs[1].path.split('/'))), imageBytes);
    assert.equal(stored.payload.input_snapshots[0].media_type, 'application/pdf');
    assert.equal(stored.payload.input_snapshots[1].media_type, 'image/png');
    assert.equal(stored.payload.input_snapshots[1].width_px, 4);
    assert.equal(stored.payload.input_snapshots[1].height_px, 5);
    const serialized = JSON.stringify(stored);
    assert.equal(serialized.includes(fileBytes.toString('base64')), false);
    assert.equal(serialized.includes(imageBytes.toString('base64')), false);
  } finally { control.close(); }
});

test('WorkBuddy follow-up task continues the persisted native session', async () => {
  const control = new ControlDatabase(path.join(root, `workbuddy-continuation-${randomUUID()}`));
  const workspace = path.join(root, `workbuddy-continuation-workspace-${randomUUID()}`);
  fs.mkdirSync(workspace, { recursive: true });
  try {
    const service = new TaskService(control);
    const first = baseRequest({ target: 'workbuddy', model: 'default', workspace, prompt: 'first turn' });
    const firstAdapter = new WorkBuddyAdapter({ testDriver: {
      command: process.execPath, args: [fakeCli, 'workbuddy', first.request_id, 'success'],
    } });
    const firstRegistered = service.submit(first, { adapterVersion: 'unified-fixture-1' });
    const firstResult = await runTask({ service, taskId: firstRegistered.task_id, adapter: firstAdapter });
    assert.equal(firstResult.status, 'succeeded');
    assert.equal(firstResult.native.session_id, first.request_id);

    const otherWorkspace = path.join(root, `workbuddy-continuation-other-${randomUUID()}`);
    fs.mkdirSync(otherWorkspace, { recursive: true });
    assert.throws(() => service.submit(baseRequest({
      target: 'workbuddy', model: 'default', workspace: otherWorkspace,
      session: { continue_from_task_id: first.request_id },
    })), { code: 'invalid_workspace' });
    assert.throws(() => service.submit(baseRequest({
      target: 'opencode', workspace,
      session: { continue_from_task_id: first.request_id },
    })), { code: 'unsupported_capability' });
    const pending = baseRequest({ target: 'workbuddy', model: 'default', workspace, prompt: 'still pending' });
    service.submit(pending, { adapterVersion: 'unified-fixture-1' });
    assert.throws(() => service.submit(baseRequest({
      target: 'workbuddy', model: 'default', workspace,
      session: { continue_from_task_id: pending.request_id },
    })), { code: 'invalid_request' });

    const followUp = baseRequest({
      target: 'workbuddy', model: 'default', workspace, prompt: 'second turn',
      session: { continue_from_task_id: first.request_id },
    });
    const followUpRegistered = service.submit(followUp, { adapterVersion: 'unified-fixture-1' });
    const stored = service.payload(followUpRegistered.task_id);
    assert.deepEqual(stored.payload.session, { action: 'continue', from_task_id: first.request_id, native_session_id: first.request_id });
    assert.deepEqual(service.status(followUpRegistered.task_id).session, { continue_from_task_id: first.request_id });

    const followUpAdapter = new WorkBuddyAdapter({ testDriver: {
      command: process.execPath, args: [fakeCli, 'workbuddy', first.request_id, 'success'],
    } });
    const followUpResult = await runTask({ service, taskId: followUpRegistered.task_id, adapter: followUpAdapter });
    assert.equal(followUpResult.status, 'succeeded');
    assert.equal(followUpResult.native.session_id, first.request_id);
  } finally { control.close(); }
});

for (const target of ['workbuddy', 'opencode']) test(`${target} fork creates a new native branch that can be continued`, async () => {
  const control = new ControlDatabase(path.join(root, `${target}-fork-${randomUUID()}`));
  const workspace = path.join(root, `${target}-fork-workspace-${randomUUID()}`);
  fs.mkdirSync(workspace, { recursive: true });
  try {
    const service = new TaskService(control);
    const source = baseRequest({ target, model: target === 'workbuddy' ? 'default' : 'commandcode-goat/deepseek/deepseek-v4-flash', workspace, prompt: 'source turn' });
    const sourceNativeSession = target === 'workbuddy' ? source.request_id : `ses_source_${randomUUID().replaceAll('-', '')}`;
    const sourceAdapter = target === 'workbuddy'
      ? new WorkBuddyAdapter({ testDriver: { command: process.execPath, args: [fakeCli, target, source.request_id, 'success'] } })
      : new OpenCodeAdapter({ testDriver: { command: process.execPath, args: [fakeCli, target, source.request_id, 'success', sourceNativeSession] } });
    const sourceRegistered = service.submit(source, { adapterVersion: 'unified-fixture-1' });
    const sourceResult = await runTask({ service, taskId: sourceRegistered.task_id, adapter: sourceAdapter });
    assert.equal(sourceResult.status, 'succeeded');
    assert.equal(sourceResult.native.session_id, sourceNativeSession);

    const fork = baseRequest({
      target, model: target === 'workbuddy' ? 'default' : 'commandcode-goat/deepseek/deepseek-v4-flash', workspace, prompt: 'branch turn',
      session: { fork_from_task_id: source.request_id },
    });
    const branchSession = `ses_branch_${randomUUID().replaceAll('-', '')}`;
    const forkRegistered = service.submit(fork, { adapterVersion: 'unified-fixture-1' });
    assert.deepEqual(service.payload(forkRegistered.task_id).payload.session, {
      action: 'fork', from_task_id: source.request_id, native_session_id: sourceNativeSession,
    });
    assert.deepEqual(service.status(forkRegistered.task_id).session, { fork_from_task_id: source.request_id });
    const ForkAdapter = target === 'workbuddy' ? WorkBuddyAdapter : OpenCodeAdapter;
    const forkAdapter = new ForkAdapter({ testDriver: {
      command: process.execPath, args: [fakeCli, target, fork.request_id, 'success', branchSession],
    } });
    const forkResult = await runTask({ service, taskId: forkRegistered.task_id, adapter: forkAdapter });
    assert.equal(forkResult.status, 'succeeded');
    assert.equal(forkResult.native.session_id, branchSession);
    assert.notEqual(forkResult.native.session_id, sourceNativeSession);

    const followUp = baseRequest({
      target, model: target === 'workbuddy' ? 'default' : 'commandcode-goat/deepseek/deepseek-v4-flash', workspace, prompt: 'continue branch',
      session: { continue_from_task_id: fork.request_id },
    });
    const followUpRegistered = service.submit(followUp, { adapterVersion: 'unified-fixture-1' });
    assert.deepEqual(service.payload(followUpRegistered.task_id).payload.session, {
      action: 'continue', from_task_id: fork.request_id, native_session_id: branchSession,
    });
    const followUpAdapter = new ForkAdapter({ testDriver: {
      command: process.execPath, args: [fakeCli, target, followUp.request_id, 'success', branchSession],
    } });
    const followUpResult = await runTask({ service, taskId: followUpRegistered.task_id, adapter: followUpAdapter });
    assert.equal(followUpResult.status, 'succeeded');
    assert.equal(followUpResult.native.session_id, branchSession);
  } finally { control.close(); }
});

test('OpenCode persists a structured native failure and updates the native session status', async () => {
  const control = new ControlDatabase(path.join(root, `opencode-auth-${randomUUID()}`));
  try {
    const service = new TaskService(control);
    const input = baseRequest({ target: 'opencode' });
    const driver = { command: process.execPath, args: [fakeCli, 'opencode', input.request_id, 'auth-error'] };
    const adapter = new OpenCodeAdapter({ testDriver: driver });
    const registered = service.submit(input, { adapterVersion: 'unified-fixture-1' });
    const result = await runTask({ service, taskId: registered.task_id, adapter });
    assert.equal(result.status, 'failed');
    assert.equal(result.native.status, 'failed');
    assert.equal(result.error.code, 'authentication_required');
    assert.equal(result.error.category, 'target');
    assert.equal(result.error.retryable, false);
    assert.equal(result.error.submission, 'sent');
    assert.equal(service.result(result.task_id).error.code, 'authentication_required');
    assert.doesNotMatch(JSON.stringify(service.events(result.task_id)), /fixture-secret/);
  } finally { control.close(); }
});

test('persisted cancel intent interrupts a live CLI process without claiming remote cancellation', async () => {
  const control = new ControlDatabase(path.join(root, `cancel-live-${randomUUID()}`));
  try {
    const service = new TaskService(control);
    const input = baseRequest({ target: 'workbuddy', model: 'default', mode: 'analysis', execution: { observation_timeout_ms: 10_000, effort: 'medium', permission: 'native' } });
    const driver = { command: process.execPath, args: [fakeCli, 'workbuddy', input.request_id, 'hang'] };
    const adapter = new WorkBuddyAdapter({ testDriver: driver });
    const registered = service.submit(input, { adapterVersion: 'unified-fixture-1' });
    const running = runTask({ service, taskId: registered.task_id, adapter });
    const marker = path.join(service.payload(registered.task_id).request.workspace, 'received.txt');
    for (let attempt = 0; attempt < 100 && !fs.existsSync(marker); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fs.existsSync(marker), true);
    service.requestCancel(registered.task_id);
    const result = await running;
    assert.equal(result.status, 'indeterminate');
    assert.equal(result.cancel_requested, true);
    assert.equal(result.attempt.submission, 'sent');
  } finally { control.close(); }
});

test('durable OpenCode cancel stops observation without killing the native process', async () => {
  const control = new ControlDatabase(path.join(root, `cancel-live-opencode-${randomUUID()}`));
  let nativePid = null;
  try {
    const service = new TaskService(control);
    const input = baseRequest({ target: 'opencode', mode: 'analysis', execution: { observation_timeout_ms: 10_000, effort: 'medium', permission: 'native' } });
    const driver = { command: process.execPath, args: [fakeCli, 'opencode', input.request_id, 'hang'] };
    const adapter = new OpenCodeAdapter({ testDriver: driver });
    const registered = service.submit(input, { adapterVersion: 'unified-fixture-1' });
    const running = runTask({ service, taskId: registered.task_id, adapter });
    const marker = path.join(service.payload(registered.task_id).request.workspace, 'received.txt');
    for (let attempt = 0; attempt < 100 && !fs.existsSync(marker); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fs.existsSync(marker), true);
    nativePid = control.raw.prepare('SELECT pid FROM native_processes WHERE attempt_id = ?').get(registered.attempt.attempt_id)?.pid ?? null;
    service.requestCancel(registered.task_id);
    const result = await running;
    assert.equal(result.status, 'indeterminate');
    assert.equal(result.cancel_requested, true);
    assert.equal(result.attempt.submission, 'sent');
    const processRecord = control.raw.prepare('SELECT process_state, workspace_guard_state FROM native_processes WHERE attempt_id = ?').get(registered.attempt.attempt_id);
    assert.equal(processRecord.process_state, 'running');
    assert.equal(['held', 'unknown'].includes(processRecord.workspace_guard_state), true);
  } finally {
    if (nativePid) try { process.kill(nativePid); } catch {}
    control.close();
  }
});

test('verifiedEntry from the supervisor context is passed to the CLI driver', async () => {
  const control = new ControlDatabase(path.join(root, `entry-${randomUUID()}`));
  try {
    const service = new TaskService(control);
    const input = baseRequest({ target: 'opencode' });
    const driver = { command: process.execPath, args: [fakeCli, 'opencode', input.request_id, 'success'] };
    const resolved = [];
    const adapter = new OpenCodeAdapter({
      testDriver: driver,
      entryResolver: async (target) => {
        resolved.push(target);
        return { canonical_path: 'C:\\verified\\opencode.exe', target };
      },
    });
    validateAdapter(adapter);
    const registered = service.submit(input, { adapterVersion: 'unified-fixture-1' });
    const result = await runTask({ service, taskId: registered.task_id, adapter });
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(resolved, ['opencode']);
  } finally { control.close(); }
});

test('worker consults the supervisor before adapter.prepare and fails closed', async () => {
  const control = new ControlDatabase(path.join(root, `supervisor-${randomUUID()}`));
  try {
    const service = new TaskService(control);
    const input = baseRequest({ target: 'opencode' });
    const driver = { command: process.execPath, args: [fakeCli, 'opencode', input.request_id, 'success'] };
    const adapter = new OpenCodeAdapter({ testDriver: driver });
    const calls = [];
    const supervisor = {
      ensure: async (target, context) => {
        calls.push({ target, workspace: context.workspace });
        throw Object.assign(new Error('launch_failed'), { code: 'launch_failed', submission: 'not_sent' });
      },
      renewInstanceLease: (lease) => lease,
      releaseInstanceLease: () => {},
    };
    const registered = service.submit(input, { adapterVersion: 'unified-fixture-1' });
    // Worker contract: transition to failed, then re-throw the ensure error.
    await assert.rejects(
      () => runTask({ service, taskId: registered.task_id, adapter, supervisor }),
      (error) => error.code === 'launch_failed'
    );
    const result = service.status(registered.task_id);
    assert.equal(result.status, 'failed');
    assert.equal(result.attempt.submission, 'not_sent');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].target, 'opencode');
    // adapter never dispatched: no native session recorded
    assert.equal(result.native, null);
  } finally { control.close(); }
});

test('worker without a supervisor keeps legacy behavior', async () => {
  const control = new ControlDatabase(path.join(root, `nosupervisor-${randomUUID()}`));
  try {
    const service = new TaskService(control);
    const input = baseRequest({ target: 'opencode' });
    const driver = { command: process.execPath, args: [fakeCli, 'opencode', input.request_id, 'success'] };
    const adapter = new OpenCodeAdapter({ testDriver: driver });
    const registered = service.submit(input, { adapterVersion: 'unified-fixture-1' });
    const result = await runTask({ service, taskId: registered.task_id, adapter });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.attempt.submission, 'sent');
  } finally { control.close(); }
});

test('CLI adapters preserve advisory permission and WorkBuddy does not auto-accept edits', async () => {
  const entry = path.join(root, `codebuddy-${randomUUID()}.js`);
  fs.writeFileSync(entry, '// fixture entry');
  const input = baseRequest({
    target: 'workbuddy', model: 'default', mode: 'implementation',
    prompt: 'Review the workspace.',
    expected_outputs: [],
    execution: { observation_timeout_ms: 5_000, effort: 'medium', permission: 'advisory-read-only' },
  });
  const adapter = new WorkBuddyAdapter({ testDriver: { command: process.execPath, args: [] } });
  const prepared = await adapter.prepare(input, {});
  assert.equal(prepared.legacy.permission_policy, 'advisory-read-only');
  const advisory = nativeDriver(prepared.legacy, root, entry);
  assert.equal(advisory.args.includes('--permission-mode'), false);

  const nativeInput = { ...input, request_id: randomUUID(), execution: { ...input.execution, permission: 'native' } };
  const nativePrepared = await adapter.prepare(nativeInput, {});
  const native = nativeDriver(nativePrepared.legacy, root, entry);
  assert.deepEqual(native.args.slice(-2), ['--permission-mode', 'acceptEdits']);
});

function pngFixture(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
