import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { UnifiedRuntime } from '../plugins/uagents/src/runtime/api.mjs';
import { CouncilService } from '../plugins/uagents/src/runtime/council-service.mjs';
import { acquireLeaseRow, releaseLeases } from '../plugins/uagents/src/runtime/leases.mjs';
import { executeCouncilWorktreeCleanup, prepareCouncilWorktreeCleanup } from '../plugins/uagents/src/runtime/council-worktrees.mjs';
import { adoptCouncilWorktree } from '../plugins/uagents/src/runtime/council-candidates.mjs';
import { runCouncilValidation } from '../plugins/uagents/src/runtime/council-validation.mjs';

// Keep fixture paths short enough for Git for Windows' default path limit.
const base = path.resolve('.local', 'test-runs', `cc-${randomUUID().slice(0, 8)}`);
const runtimeUrl = pathToFileURL(path.resolve('plugins/uagents/src/runtime/api.mjs')).href;
const leasesUrl = pathToFileURL(path.resolve('plugins/uagents/src/runtime/leases.mjs')).href;
const route = 'commandcode-goat/deepseek/deepseek-v4-flash';
const council = patch => ({
  schema_version: '1.0', council_id: randomUUID(), strategy: 'fanout', prompt: 'bounded Council',
  members: [{ member_id: 'one', target: 'opencode', model: route },
    { member_id: 'two', target: 'opencode', model: route }], ...patch,
});
const validation = script => ({ schema_version: '1.0', command: [process.execPath, '-e', script], timeout_ms: 4000 });
const resourceKey = id => `council:${id.toLowerCase()}`;

test('UnifiedRuntime injects control and separate connections serialize submit without locking unrelated work', async () => {
  await fixture('submit-processes', { worktrees: false }, async ({ runtime, root }) => {
    const input = council();
    assert.equal(runtime.councils.control, runtime.control);
    const marker = path.join(root, 'submit-started.json');
    const release = path.join(root, 'submit-release');
    const first = startProcess(runtime.stateRoot, 'submit', input, { marker, release, hold_ms: 10_000 });
    try {
      await waitForFile(marker);
      const second = startProcess(runtime.stateRoot, 'submit', input);
      const blocked = await second.result;
      assert.equal(blocked.code, 'lease_conflict');
      const otherCouncil = council();
      assert.equal(runtime.submitCouncil(otherCouncil).duplicate, false);
      assert.equal(runtime.control.raw.prepare('SELECT count(*) AS count FROM tasks').get().count >= 3, true);
      fs.writeFileSync(release, 'ready');
      const completed = await first.result;
      assert.equal(completed.ok, true);
      assert.equal(runtime.submitCouncil(input).duplicate, true);
      assert.equal(runtime.councilStatus(input.council_id).members.length, 2);
      assert.equal(runtime.control.raw.prepare('SELECT count(*) AS count FROM tasks WHERE request_id IN (?, ?)')
        .get(...runtime.councilStatus(input.council_id).members.map(member => member.task_id)).count, 2);
      assert.equal(runtime.control.raw.prepare('SELECT 1 FROM leases WHERE resource_key = ?').get(resourceKey(input.council_id)), undefined);
    } finally { fs.writeFileSync(release, 'ready'); await first.stop(); }
  });
});

test('a blocking validation excludes validate/adopt/cleanup across processes and preserves both member results', async () => {
  await fixture('validation-processes', {}, async ({ runtime, input, root, submitted, repository }) => {
    const marker = path.join(root, 'validation-started');
    const release = path.join(root, 'validation-release');
    const firstValidation = { ...validation(`
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(marker)}, 'ready');
      const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer); }, 10);
    `), timeout_ms: 10_000 };
    const first = startProcess(runtime.stateRoot, 'validate', input, { memberId: 'one', validation: firstValidation });
    const other = new UnifiedRuntime({ stateRoot: runtime.stateRoot, spawnWorker: () => {} });
    try {
      await waitForFile(marker);
      const second = startProcess(runtime.stateRoot, 'validate', input, { memberId: 'two', validation: validation('process.exit(0)') });
      assert.equal((await second.result).code, 'lease_conflict');
      assert.throws(() => other.councilCleanup(input.council_id, { all: true, force: true }), { code: 'lease_conflict' });
      assert.throws(() => other.councilAdopt(input.council_id, { memberId: 'one', workspace: repository }), { code: 'lease_conflict' });
      assert.equal(other.councilStatus(input.council_id).status, 'complete');
      assert.equal(submitted.members.every(member => fs.existsSync(member.worktree.worktree_root)), true);
      const unrelated = runtime.submit({ schema_version: '1.0', request_id: randomUUID(), target: 'opencode',
        model: route, mode: 'analysis', prompt: 'independent task',
        execution: { observation_timeout_ms: 1000, permission: 'native', effort: 'medium' },
        policy: { fallback: 'none', max_cost_usd: null } });
      assert.equal(unrelated.status, 'registered');
      fs.writeFileSync(release, 'ready');
      assert.equal((await first.result).ok, true);
      const next = other.councilValidate(input.council_id, { memberId: 'two', validation: validation('process.exit(0)') });
      assert.equal(next.members[0].validation.outcome, 'passed');
      assert.deepEqual(other.councilStatus(input.council_id).members.map(member => member.validation.outcome), ['passed', 'passed']);
      other.councilCleanup(input.council_id, { all: true });
      assert.equal(other.councilStatus(input.council_id).members.every(member => member.cleanup.removed), true);
    } finally { fs.writeFileSync(release, 'ready'); other.close(); await first.stop(); }
  });
});

test('validation reserves every selected member and check timeout before spawnSync and keeps one fencing identity', async () => {
  await fixture('validation-budget', {}, async ({ runtime, input, root }) => {
    runtime.councils.clock = () => 100;
    const observed = path.join(root, 'leases.jsonl');
    const script = `
      import fs from 'node:fs';
      import { UnifiedRuntime } from ${JSON.stringify(runtimeUrl)};
      const runtime = new UnifiedRuntime({ stateRoot: ${JSON.stringify(runtime.stateRoot)}, spawnWorker: () => {} });
      const lease = runtime.control.raw.prepare('SELECT * FROM leases WHERE resource_key = ?').get(${JSON.stringify(resourceKey(input.council_id))});
      fs.appendFileSync(${JSON.stringify(observed)}, JSON.stringify(lease) + '\\n');
      runtime.close();
    `;
    const checked = runtime.councilValidate(input.council_id, { all: true, validation: {
      schema_version: '1.0', on_failure: 'continue', checks: [
        { name: 'first', command: [process.execPath, '--input-type=module', '-e', script], timeout_ms: 180_000 },
        { name: 'second', command: [process.execPath, '--input-type=module', '-e', script], timeout_ms: 240_000 },
      ],
    } });
    assert.equal(checked.members.every(member => member.validation.outcome === 'passed'), true);
    const leases = fs.readFileSync(observed, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(leases.length, 4);
    const minimumExpiry = 100 + 2 * (180_000 + 240_000) + 4 * 1000 + 30_000;
    assert.equal(leases.every(lease => lease.expires_at_ms >= minimumExpiry), true);
    assert.equal(new Set(leases.map(lease => lease.fencing_token)).size, 1);
    assert.equal(new Set(leases.map(lease => lease.epoch)).size, 1);
  });
});

test('a crashed process leaves its Council lease blocking mutations until an explicit post-expiry retry', async () => {
  await fixture('crash-expiry', {}, async ({ runtime, input }) => {
    const abandoned = startProcess(runtime.stateRoot, 'abandon', input, { now: 100, ttl_ms: 10 });
    assert.equal((await abandoned.result).ok, true);
    const stale = runtime.control.raw.prepare('SELECT * FROM leases WHERE resource_key = ?').get(resourceKey(input.council_id));
    assert.equal(JSON.parse(stale.metadata_json).operation, 'validate');
    runtime.councils.clock = () => 109;
    assert.throws(() => runtime.councilValidate(input.council_id, { memberId: 'one', validation: validation('process.exit(0)') }), { code: 'lease_conflict' });
    assert.throws(() => runtime.councilCleanup(input.council_id, { all: true }), { code: 'lease_conflict' });
    assert.equal(runtime.councilStatus(input.council_id).members[0].validation, undefined);
    runtime.councils.clock = () => 110;
    assert.equal(runtime.councilStatus(input.council_id).members[0].validation, undefined);
    const resumed = runtime.councilValidate(input.council_id, { memberId: 'one', validation: validation('process.exit(0)') });
    assert.equal(resumed.members[0].validation.outcome, 'passed');
    assert.equal(runtime.control.raw.prepare('SELECT 1 FROM leases WHERE resource_key = ?').get(resourceKey(input.council_id)), undefined);
  });
});

test('a validation fenced out during a command cannot overwrite evidence or release the replacement lease', async () => {
  await fixture('validation-fencing', {}, async ({ runtime, input, root }) => {
    const marker = path.join(root, 'replaced');
    const manifestFile = path.join(runtime.stateRoot, 'councils', input.council_id, 'manifest.json');
    runtime.councils.clock = () => fs.existsSync(marker) ? 1_000_000 : 100;
    const script = `
      import fs from 'node:fs';
      import { UnifiedRuntime } from ${JSON.stringify(runtimeUrl)};
      import { acquireLeaseRow } from ${JSON.stringify(leasesUrl)};
      const runtime = new UnifiedRuntime({ stateRoot: ${JSON.stringify(runtime.stateRoot)}, spawnWorker: () => {} });
      runtime.control.transaction(database => acquireLeaseRow(database, ${JSON.stringify(resourceKey(input.council_id))}, 'council', 'replacement', 500000, 1000000, { operation: 'validate' }));
      const file = ${JSON.stringify(manifestFile)};
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      manifest.members[0].validation = { outcome: 'replacement-evidence' };
      fs.writeFileSync(file, JSON.stringify(manifest));
      fs.writeFileSync(${JSON.stringify(marker)}, 'ready');
      runtime.close();
    `;
    assert.throws(() => runtime.councilValidate(input.council_id, { memberId: 'one', validation: {
      schema_version: '1.0', command: [process.execPath, '--input-type=module', '-e', script], timeout_ms: 4000,
    } }), { code: 'lease_conflict' });
    assert.equal(runtime.councilStatus(input.council_id).members[0].validation.outcome, 'replacement-evidence');
    const replacement = runtime.control.raw.prepare('SELECT * FROM leases WHERE resource_key = ?').get(resourceKey(input.council_id));
    assert.equal(replacement.owner_nonce, 'replacement');
  });
});

test('submit fencing is checked after its callback before writing manifest or dispatching another member', async () => {
  await fixture('submit-fencing', { worktrees: false }, async ({ runtime, root }) => {
    const input = council();
    let now = 100;
    let calls = 0;
    let replacement;
    const service = new CouncilService({ stateRoot: runtime.stateRoot, control: runtime.control,
      registry: runtime.registry, clock: () => now, statusTask: id => runtime.status(id), resultTask: id => runtime.result(id),
      submitTask: request => {
        calls++;
        runtime.submit(request);
        now = 1_000_000;
        replacement = runtime.control.transaction(database => acquireLeaseRow(database,
          resourceKey(input.council_id), 'council', 'replacement-submit', 500000, now, {}));
        const file = path.join(runtime.stateRoot, 'councils', input.council_id, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        manifest.sentinel = 'new-owner';
        fs.writeFileSync(file, JSON.stringify(manifest));
      } });
    assert.throws(() => service.submit(input), { code: 'lease_conflict' });
    assert.equal(calls, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtime.stateRoot, 'councils', input.council_id, 'manifest.json'))).sentinel, 'new-owner');
    assert.equal(runtime.control.raw.prepare('SELECT fencing_token FROM leases WHERE resource_key = ?').get(resourceKey(input.council_id)).fencing_token, replacement.fencing_token);
  });
});

test('cleanup and adopt reject lost fencing before any destructive operation', async () => {
  await fixture('mutation-fencing', {}, async ({ runtime, input, submitted, repository }) => {
    for (const method of ['cleanup', 'adopt']) {
      let now = 100;
      let stolen = false;
      const service = new CouncilService({ stateRoot: runtime.stateRoot, control: runtime.control,
        registry: runtime.registry, clock: () => now, submitTask: value => runtime.submit(value), resultTask: id => runtime.result(id),
        statusTask: id => {
          if (!stolen) {
            stolen = true;
            now = 1_000_000;
            runtime.control.transaction(database => acquireLeaseRow(database,
              resourceKey(input.council_id), 'council', `replacement-${method}`, 500000, now, {}));
          }
          return runtime.status(id);
        } });
      const invoke = method === 'cleanup'
        ? () => service.cleanup(input.council_id, { all: true, force: true })
        : () => service.adopt(input.council_id, { memberId: 'one', workspace: repository });
      assert.throws(invoke, { code: 'lease_conflict' });
      assert.equal(submitted.members.every(member => fs.existsSync(member.worktree.worktree_root)), true);
      const current = runtime.control.raw.prepare('SELECT * FROM leases WHERE resource_key = ?').get(resourceKey(input.council_id));
      assert.equal(current.owner_nonce, `replacement-${method}`);
      releaseLeases(runtime.control, [current]);
    }
  });
});

test('direct CouncilService construction remains compatible and participates in shared locking', async () => {
  await fixture('constructor-compatibility', { worktrees: false }, async ({ runtime, input }) => {
    const direct = new CouncilService({ stateRoot: runtime.stateRoot, registry: runtime.registry,
      submitTask: value => runtime.submit(value), statusTask: id => runtime.status(id), resultTask: id => runtime.result(id) });
    const held = runtime.control.transaction(database => acquireLeaseRow(database,
      resourceKey(input.council_id), 'council', 'external-holder', 5000, Date.now(), {}));
    assert.throws(() => direct.submit(input), { code: 'lease_conflict' });
    assert.equal(direct.status(input.council_id).members.length, 2);
    releaseLeases(runtime.control, [held]);
    assert.equal(direct.submit(input).duplicate, true);
  });
});

test('validation and destructive helper callbacks guard each individual step', async () => {
  await fixture('helper-fencing', {}, async ({ submitted, root, repository }) => {
    const member = submitted.members[0];
    const marker = path.join(root, 'second-check-ran');
    let checks = 0;
    assert.throws(() => runCouncilValidation(member, { schema_version: '1.0', checks: [
      { name: 'first', command: [process.execPath, '-e', 'process.exit(0)'] },
      { name: 'second', command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`] },
    ] }, { beforeCheck: () => { if (++checks === 2) throw Object.assign(new Error('fenced'), { code: 'lease_conflict' }); } }), { code: 'lease_conflict' });
    assert.equal(fs.existsSync(marker), false);

    fs.writeFileSync(path.join(member.worktree.workspace, 'candidate.txt'), 'candidate');
    const plan = prepareCouncilWorktreeCleanup(member, { force: true });
    assert.throws(() => executeCouncilWorktreeCleanup(plan, { beforeMutation: () => {
      throw Object.assign(new Error('fenced'), { code: 'lease_conflict' });
    } }), { code: 'lease_conflict' });
    assert.equal(fs.existsSync(member.worktree.worktree_root), true);
    assert.throws(() => adoptCouncilWorktree(member, repository, { beforeMutation: () => {
      throw Object.assign(new Error('fenced'), { code: 'lease_conflict' });
    } }), { code: 'lease_conflict' });
    assert.equal(fs.existsSync(path.join(repository, 'candidate.txt')), false);
  });
});

async function fixture(name, { worktrees = true }, operation) {
  const root = path.join(base, name);
  fs.mkdirSync(root, { recursive: true });
  const repository = path.join(root, 'repository');
  if (worktrees) {
    fs.mkdirSync(repository, { recursive: true });
    git(repository, ['init']);
    git(repository, ['config', 'user.email', 'council-fixture@example.invalid']);
    git(repository, ['config', 'user.name', 'Council Fixture']);
    fs.writeFileSync(path.join(repository, 'base.txt'), 'base\n');
    git(repository, ['add', 'base.txt']);
    git(repository, ['commit', '-m', 'base']);
  }
  const runtime = new UnifiedRuntime({ stateRoot: path.join(root, 'state'), spawnWorker: () => {} });
  const input = council(worktrees ? { mode: 'implementation', workspace_strategy: 'git-worktree', workspace: repository } : {});
  const submitted = runtime.submitCouncil(input);
  runtime.control.raw.prepare("UPDATE tasks SET status = 'succeeded'").run();
  runtime.control.raw.prepare("UPDATE attempts SET status = 'succeeded'").run();
  try { await operation({ runtime, root, repository, input, submitted }); }
  finally { runtime.close(); }
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function startProcess(stateRoot, method, input, options = {}) {
  const source = `
    import fs from 'node:fs';
    import { UnifiedRuntime } from ${JSON.stringify(runtimeUrl)};
    import { acquireLeaseRow } from ${JSON.stringify(leasesUrl)};
    const [stateRoot, method, rawInput, rawOptions] = process.argv.slice(1);
    const input = JSON.parse(rawInput), options = JSON.parse(rawOptions);
    const runtime = new UnifiedRuntime({ stateRoot, spawnWorker: () => {
      if (options.marker && !fs.existsSync(options.marker)) {
        fs.writeFileSync(options.marker, 'ready');
        const waitArray = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + options.hold_ms;
        while (!fs.existsSync(options.release) && Date.now() < deadline) Atomics.wait(waitArray, 0, 0, 10);
      }
    } });
    try {
      if (method === 'abandon') {
        runtime.control.transaction(database => acquireLeaseRow(database, 'council:' + input.council_id.toLowerCase(),
          'council', 'crashed-validator', options.ttl_ms, options.now, { operation: 'validate' }));
        process.send?.({ ok: true });
        process.exitCode = 42;
      } else {
        const result = method === 'submit' ? runtime.submitCouncil(input) : runtime.councilValidate(input.council_id, options);
        process.send?.({ ok: true, result });
      }
    } catch (error) { process.send?.({ ok: false, code: error?.code ?? 'fixture_failed' }); }
    finally { runtime.close(); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source,
    stateRoot, method, JSON.stringify(input), JSON.stringify(options)], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const result = new Promise((resolve, reject) => {
    let message;
    child.once('message', value => { message = value; });
    child.once('error', () => reject(new Error('Council fixture process could not start.')));
    child.once('close', () => message ? resolve(message) : reject(new Error('Council fixture process exited without a result.')));
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  return { result: withTimeout(result, 15_000), stop: async () => {
    if (child.exitCode === null) child.kill();
    await withTimeout(closed, 5000);
  } };
}

async function waitForFile(file) {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error('Council fixture readiness timed out.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function withTimeout(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Council fixture timed out.')), ms);
  })]); }
  finally { clearTimeout(timer); }
}
