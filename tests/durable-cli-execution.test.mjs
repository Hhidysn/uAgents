import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { persistCheckpoint } from '../plugins/uagents/src/runtime/checkpoints.mjs';
import { getNativeProcess } from '../plugins/uagents/src/runtime/native-processes.mjs';
import { taskDirectory } from '../plugins/uagents/src/store/task-files.mjs';
import {
  DURABLE_STDOUT_LIMIT_BYTES,
  DURABLE_STDERR_LIMIT_BYTES,
  IncrementalUtf8LineReader,
  launchAndAccept,
  observeDurableExecution,
  prepareDurableExecution,
  replayDurableExecution,
} from '../plugins/uagents/src/transports/durable-cli-execution.mjs';
import { createDurableFixtureDriver } from './fixtures/durable-fixture-driver.mjs';

const base = path.resolve('.local', 'test-runs', randomUUID(), 'durable cli execution');
const workerRunner = fileURLToPath(new URL('./fixtures/durable-worker-runner.mjs', import.meta.url));
fs.mkdirSync(base, { recursive: true });

test('incremental UTF-8 reader waits for newline and preserves a split multibyte sequence', async () => {
  const file = path.join(base, `utf8-${randomUUID()}.log`);
  fs.writeFileSync(file, '');
  const reader = new IncrementalUtf8LineReader(file, { chunkBytes: 1, maxBytes: 1024 });
  const bytes = Buffer.from('中文', 'utf8');
  fs.appendFileSync(file, bytes.subarray(0, 2));
  const lines = [];
  await reader.readAvailable(async line => lines.push(line));
  assert.deepEqual(lines, []);
  assert.equal(reader.committedOffset, 0);

  fs.appendFileSync(file, Buffer.concat([bytes.subarray(2), Buffer.from('\n')]));
  await reader.readAvailable(async line => lines.push(line));
  assert.deepEqual(lines, ['中文']);
  assert.equal(reader.committedOffset, bytes.length + 1);
});

test('durable reader reports a structured stdout limit instead of truncating', async () => {
  const file = path.join(base, `limit-${randomUUID()}.log`);
  fs.writeFileSync(file, Buffer.alloc(9));
  const reader = new IncrementalUtf8LineReader(file, { maxBytes: 8 });
  await assert.rejects(() => reader.readAvailable(async () => {}), error => {
    assert.equal(error.code, 'output_limit');
    assert.deepEqual(error.details, { stream: 'stdout', limit_bytes: 8, observed_bytes: 9, truncated: true });
    return true;
  });
});

test('incremental reader retries an uncommitted complete line instead of skipping it', async () => {
  const file = path.join(base, `retry-${randomUUID()}.log`);
  fs.writeFileSync(file, 'one\ntwo\n');
  const reader = new IncrementalUtf8LineReader(file, { maxBytes: 1024 });
  const seen = [];
  await assert.rejects(() => reader.readAvailable(async line => {
    seen.push(line);
    if (line === 'two') throw new Error('fixture parser fault');
  }), /fixture parser fault/);
  assert.equal(reader.committedOffset, Buffer.byteLength('one\n'));
  await reader.readAvailable(async line => seen.push(line));
  assert.deepEqual(seen, ['one', 'two', 'two']);
  assert.equal(reader.committedOffset, Buffer.byteLength('one\ntwo\n'));
});

test('durable launch checkpoints once, accepts before terminal, and replay reconstructs terminal state', async () => {
  await fixture('launch-replay', async context => {
    const { control, service, taskId, attemptId, workspace, markerDirectory } = context;
    const driver = createDurableFixtureDriver(markerDirectory);
    const checkpoint = checkpointFor(control, taskId, attemptId);
    let inspectionCalls = 0;
    const inspector = {
      inspectProcess: async ({ pid }) => {
        inspectionCalls += 1;
        if (inspectionCalls < 3) return { kind: 'inspection_failed', code: 'fixture_metadata_lag' };
        return { kind: 'alive', pid, started_at_ms: Date.now(), executable_path: process.execPath };
      },
      inspectProcessTree: async () => ({ kind: 'quiescent', descendants: [] }),
    };
    const prepared = preparedFor(context, driver);
    const execution = await launchAndAccept({
      prepared, control, checkpoint, inspector, identityBudgetMs: 1_000, identityRetryMs: 5, acceptTimeoutMs: 5_000,
    });

    assert.equal(execution.handle.session_id, 'fixture-session');
    assert.equal(Object.prototype.hasOwnProperty.call(execution, 'child'), false);
    assert.equal(service.status(taskId).attempt.submission, 'sent');
    assert.equal(service.status(taskId).native.session_id, 'fixture-session');
    assert.equal(fs.existsSync(path.join(markerDirectory, 'terminal-emitted.txt')), false);
    assert.equal(fs.readFileSync(path.join(markerDirectory, 'prompt-count.txt'), 'utf8'), '1');
    assert.ok(inspectionCalls >= 3);
    assert.match(execution.process.stdout_relpath, new RegExp(`^native/${attemptId}/stdout\\.log$`));
    assert.equal(path.isAbsolute(execution.process.stdout_relpath), false);

    // Replay while the last progress line is incomplete: it must rediscover
    // the same session idempotently and never feed the partial JSON to parser.
    const earlyReplay = await replayDurableExecution({
      control, taskDirectory: taskDirectory(control.root, taskId), attemptId, driver, checkpoint,
    });
    assert.equal(earlyReplay.handle.session_id, 'fixture-session');
    assert.equal(earlyReplay.outcome, null);
    assert.equal(service.events(taskId).filter(event => event.type === 'dispatch.accepted').length, 1);

    fs.writeFileSync(path.join(markerDirectory, 'release.txt'), '1');
    await execution.closePromise;
    const afterClose = getNativeProcess(control, attemptId);
    assert.equal(afterClose.process_state, 'exited');
    assert.equal(afterClose.workspace_guard_state, 'released');

    const replay = await replayDurableExecution({
      control, taskDirectory: taskDirectory(control.root, taskId), attemptId, driver, checkpoint,
    });
    assert.equal(replay.handle.session_id, 'fixture-session');
    assert.equal(replay.outcome.status, 'succeeded');
    assert.equal(replay.outcome.result.response, 'fixture complete');
    assert.deepEqual(replay.outcome.progress, ['partial 中文']);
    assert.equal(service.events(taskId).filter(event => event.type === 'dispatch.accepted').length, 1);
    assert.equal(fs.readFileSync(path.join(markerDirectory, 'prompt-count.txt'), 'utf8'), '1');
  });
});

test('file-backed native transcript survives termination of the observer process', { timeout: 15_000 }, async () => {
  await fixture('worker-death', async context => {
    const { control, taskId, attemptId, workspace, markerDirectory } = context;
    // The runner opens its own database connection and launches the native
    // fixture through the real durable controller. Its stdout/stderr are not
    // pipes owned by the runner.
    const worker = spawn(process.execPath, [workerRunner, control.root, taskId, attemptId, workspace, markerDirectory], {
      cwd: path.resolve('.'), windowsHide: true, stdio: 'ignore',
    });
    await waitForFile(path.join(markerDirectory, 'worker-accepted.json'));
    const accepted = JSON.parse(fs.readFileSync(path.join(markerDirectory, 'worker-accepted.json'), 'utf8'));
    assert.equal(accepted.session_id, 'fixture-session');
    assert.equal(fs.readFileSync(path.join(markerDirectory, 'prompt-count.txt'), 'utf8'), '1');

    worker.kill();
    await waitForExit(worker);
    fs.writeFileSync(path.join(markerDirectory, 'release.txt'), '1');
    await waitForFile(path.join(markerDirectory, 'terminal-emitted.txt'));

    const processRecord = getNativeProcess(control, attemptId);
    const stdout = path.join(taskDirectory(control.root, taskId), ...processRecord.stdout_relpath.split('/'));
    await waitUntil(() => fs.readFileSync(stdout, 'utf8').includes('fixture complete'));
    assert.match(fs.readFileSync(stdout, 'utf8'), /fixture complete/);
    assert.equal(fs.readFileSync(path.join(markerDirectory, 'prompt-count.txt'), 'utf8'), '1');

    // Recovery is transcript-only here: the killed observer cannot have
    // persisted the close event, but replay still recovers the same identity
    // without any prompt write or duplicate accepted event.
    const replay = await replayDurableExecution({
      control,
      taskDirectory: taskDirectory(control.root, taskId),
      attemptId,
      driver: createDurableFixtureDriver(markerDirectory),
      checkpoint: checkpointFor(control, taskId, attemptId),
    });
    assert.equal(replay.handle.session_id, 'fixture-session');
    assert.equal(fs.readFileSync(path.join(markerDirectory, 'prompt-count.txt'), 'utf8'), '1');
    assert.equal(context.service.events(taskId).filter(event => event.type === 'dispatch.accepted').length, 1);
  });
});

test('durable stdout safety limit remains one MiB', () => {
  assert.equal(DURABLE_STDOUT_LIMIT_BYTES, 1024 * 1024);
  assert.equal(DURABLE_STDERR_LIMIT_BYTES, 64 * 1024);
});

test('checkpoint failure before prompt write terminates the owned child without sending', async () => {
  await fixture('checkpoint-failure', async context => {
    const driver = createDurableFixtureDriver(context.markerDirectory);
    const prepared = preparedFor(context, driver);
    const inspector = {
      inspectProcess: async ({ pid }) => ({ kind: 'alive', pid, started_at_ms: Date.now(), executable_path: process.execPath }),
      inspectProcessTree: async () => ({ kind: 'quiescent', descendants: [] }),
    };
    await assert.rejects(() => launchAndAccept({
      prepared,
      control: context.control,
      checkpoint: kind => {
        if (kind === 'possibly_sent') throw Object.assign(new Error('fixture checkpoint failure'), { code: 'lease_conflict' });
      },
      inspector,
    }), /fixture checkpoint failure/);
    assert.equal(fs.existsSync(path.join(context.markerDirectory, 'prompt-count.txt')), false);
    assert.equal(context.service.status(context.taskId).attempt.submission, 'not_sent');
    assert.equal(getNativeProcess(context.control, context.attemptId).workspace_guard_state, 'released');
  });
});

test('synchronous spawn failure consumes the launch slot but releases a proven-empty workspace guard', async () => {
  await fixture('spawn-failure', async context => {
    const driver = createDurableFixtureDriver(context.markerDirectory);
    const prepared = preparedFor(context, driver);
    await assert.rejects(() => launchAndAccept({
      prepared,
      control: context.control,
      checkpoint: checkpointFor(context.control, context.taskId, context.attemptId),
      inspector: {
        inspectProcess: async () => ({ kind: 'absent' }),
        inspectProcessTree: async () => ({ kind: 'quiescent', descendants: [] }),
      },
      spawnImpl: () => { throw new Error('fixture spawn failure'); },
    }), error => {
      assert.equal(error.code, 'launch_failed');
      assert.equal(error.submission, 'not_sent');
      return true;
    });
    const record = getNativeProcess(context.control, context.attemptId);
    assert.equal(record.process_state, 'exited');
    assert.equal(record.workspace_guard_state, 'released');
    const recovery = context.service.recoverUnsent(context.taskId);
    assert.equal(recovery.recoverable, false);
    assert.equal(recovery.reason, 'native_process');
  });
});

test('generic observation timeout never terminates the durable native process', async () => {
  await fixture('observe-window', async context => {
    const driver = createDurableFixtureDriver(context.markerDirectory);
    const prepared = preparedFor(context, driver);
    const checkpoint = checkpointFor(context.control, context.taskId, context.attemptId);
    const inspector = {
      inspectProcess: async ({ pid }) => ({ kind: 'alive', pid, started_at_ms: Date.now(), executable_path: process.execPath }),
      inspectProcessTree: async () => ({ kind: 'quiescent', descendants: [] }),
    };
    const execution = await launchAndAccept({ prepared, control: context.control, checkpoint, inspector, acceptTimeoutMs: 5_000 });
    const observed = await observeDurableExecution({
      control: context.control,
      taskDirectory: taskDirectory(context.control.root, context.taskId),
      attemptId: context.attemptId,
      driver,
      checkpoint,
      observationTimeoutMs: 50,
      pollIntervalMs: 10,
    });
    assert.equal(observed.timed_out, true);
    assert.equal(observed.outcome, null);
    assert.equal(getNativeProcess(context.control, context.attemptId).process_state, 'running');
    assert.equal(fs.existsSync(path.join(context.markerDirectory, 'terminal-emitted.txt')), false);
    assert.equal(fs.readFileSync(path.join(context.markerDirectory, 'prompt-count.txt'), 'utf8'), '1');
    fs.writeFileSync(path.join(context.markerDirectory, 'release.txt'), '1');
    await execution.closePromise;
  });
});

test('native identity mismatch is terminated before the first prompt byte', async () => {
  await fixture('identity-mismatch', async context => {
    const driver = createDurableFixtureDriver(context.markerDirectory);
    const prepared = preparedFor(context, driver);
    const inspector = {
      inspectProcess: async ({ pid }) => ({
        kind: 'alive', pid, started_at_ms: Date.now(), executable_path: path.join(context.workspace, 'foreign.exe'),
      }),
      inspectProcessTree: async () => ({ kind: 'quiescent', descendants: [] }),
    };
    await assert.rejects(() => launchAndAccept({
      prepared,
      control: context.control,
      checkpoint: checkpointFor(context.control, context.taskId, context.attemptId),
      inspector,
      identityBudgetMs: 200,
    }), error => {
      assert.equal(error.code, 'native_process_identity_mismatch');
      assert.equal(error.submission, 'not_sent');
      return true;
    });
    assert.equal(fs.existsSync(path.join(context.markerDirectory, 'prompt-count.txt')), false);
    const record = getNativeProcess(context.control, context.attemptId);
    assert.equal(record.process_state, 'exited');
    assert.equal(record.workspace_guard_state, 'released');
  });
});

test('native PID mismatch is rejected before the first prompt byte', async () => {
  await fixture('pid-mismatch', async context => {
    const driver = createDurableFixtureDriver(context.markerDirectory);
    const prepared = preparedFor(context, driver);
    const inspector = {
      inspectProcess: async ({ pid }) => ({
        kind: 'alive', pid: pid + 1, started_at_ms: Date.now(), executable_path: process.execPath,
      }),
      inspectProcessTree: async () => ({ kind: 'quiescent', descendants: [] }),
    };
    await assert.rejects(() => launchAndAccept({
      prepared,
      control: context.control,
      checkpoint: checkpointFor(context.control, context.taskId, context.attemptId),
      inspector,
      identityBudgetMs: 200,
    }), error => {
      assert.equal(error.code, 'native_process_identity_mismatch');
      assert.equal(error.submission, 'not_sent');
      return true;
    });
    assert.equal(fs.existsSync(path.join(context.markerDirectory, 'prompt-count.txt')), false);
    assert.equal(getNativeProcess(context.control, context.attemptId).workspace_guard_state, 'released');
  });
});

test('child exit before PID bind releases guard only after its process tree is proven quiescent', async () => {
  await fixture('exit-before-bind', async context => {
    const driver = {
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: { ...process.env },
      createParser() { return { line() {}, stderr() {}, finish() { return null; } }; },
    };
    const prepared = preparedFor(context, driver);
    let treeCalls = 0;
    const inspector = {
      inspectProcess: async ({ pid }) => ({ kind: 'inspection_failed', pid, code: 'fixture_metadata_lag' }),
      inspectProcessTree: async () => { treeCalls += 1; return { kind: 'quiescent', descendants: [] }; },
    };
    await assert.rejects(() => launchAndAccept({
      prepared,
      control: context.control,
      checkpoint: checkpointFor(context.control, context.taskId, context.attemptId),
      inspector,
      identityBudgetMs: 1_000,
      identityRetryMs: 10,
    }), error => {
      assert.equal(error.submission, 'not_sent');
      return true;
    });
    const record = getNativeProcess(context.control, context.attemptId);
    assert.ok(treeCalls >= 1);
    assert.equal(record.process_state, 'exited');
    assert.equal(record.workspace_guard_state, 'released');
    assert.equal(context.service.status(context.taskId).attempt.submission, 'not_sent');
  });
});

test('oversized durable stderr fails structurally and never becomes success', async () => {
  await fixture('stderr-limit', async context => {
    const driver = createDurableFixtureDriver(context.markerDirectory, { mode: 'stderr-limit' });
    const prepared = preparedFor(context, driver);
    const checkpoint = checkpointFor(context.control, context.taskId, context.attemptId);
    const inspector = {
      inspectProcess: async ({ pid }) => ({ kind: 'alive', pid, started_at_ms: Date.now(), executable_path: process.execPath }),
      inspectProcessTree: async () => ({ kind: 'quiescent', descendants: [] }),
    };
    const execution = await launchAndAccept({
      prepared,
      control: context.control,
      checkpoint,
      inspector,
      acceptTimeoutMs: 5_000,
    });
    assert.equal(execution.handle.session_id, 'fixture-session');
    await assert.rejects(() => observeDurableExecution({
      control: context.control,
      taskDirectory: taskDirectory(context.control.root, context.taskId),
      attemptId: context.attemptId,
      driver,
      checkpoint,
      observationTimeoutMs: 2_000,
      pollIntervalMs: 10,
    }), error => {
      assert.equal(error.code, 'output_limit');
      assert.equal(error.details.stream, 'stderr');
      assert.equal(error.details.truncated, true);
      assert.equal(error.submission, 'sent');
      return true;
    });
    assert.equal(fs.readFileSync(path.join(context.markerDirectory, 'prompt-count.txt'), 'utf8'), '1');
    assert.notEqual(getNativeProcess(context.control, context.attemptId).workspace_guard_state, 'released');
    fs.writeFileSync(path.join(context.markerDirectory, 'release.txt'), '1');
    await execution.closePromise;
  });
});

async function fixture(name, operation) {
  const root = path.join(base, `${name}-${randomUUID()}`);
  const control = new ControlDatabase(path.join(root, 'state'));
  try {
    const service = new TaskService(control);
    const workspace = path.join(root, 'workspace');
    const markerDirectory = path.join(root, 'markers');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(markerDirectory, { recursive: true });
    const registered = service.submit({
      schema_version: '1.0', request_id: randomUUID(), target: 'opencode',
      model: 'commandcode-goat/deepseek/deepseek-v4-flash', mode: 'implementation', prompt: 'fixture prompt', workspace,
      execution: { observation_timeout_ms: 10_000, effort: 'medium', permission: 'native' },
      policy: { fallback: 'none', max_cost_usd: null },
    }, { adapterVersion: 'fixture-adapter' });
    const taskId = registered.task_id;
    const attemptId = registered.attempt.attempt_id;
    service.transition(taskId, 'queued', { attemptId });
    service.transition(taskId, 'starting', { attemptId });
    await operation({ control, service, taskId, attemptId, workspace, markerDirectory });
  } finally {
    control.close();
  }
}

function preparedFor(context, driver) {
  const stored = context.service.payload(context.taskId);
  return prepareDurableExecution({
    driver,
    request: { ...stored.request, prompt: stored.payload.prompt },
    workspace: context.workspace,
    taskDirectory: taskDirectory(context.control.root, context.taskId),
    attemptId: context.attemptId,
    installation: { canonical_path: process.execPath, sha256: null },
    coreVersion: 'fixture-core',
    adapterVersion: 'fixture-adapter',
  });
}

function checkpointFor(control, taskId, attemptId) {
  return (kind, payload = {}) => persistCheckpoint(control, {
    taskId, attemptId, kind, payload: { target: 'opencode', ...payload },
  });
}

async function waitForFile(file, timeoutMs = 5_000) {
  await waitUntil(() => fs.existsSync(file), timeoutMs);
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (predicate()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for fixture condition after ${timeoutMs}ms`);
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', resolve));
}
