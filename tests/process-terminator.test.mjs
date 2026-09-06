import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createProcessInspector } from '../plugins/uagents/src/host/process-inspector.mjs';
import { terminateOwnedProcessTree } from '../plugins/uagents/src/host/process-terminator.mjs';

const record = {
  pid: 42,
  process_started_at_ms: 1000,
  executable_path: 'C:\\Apps\\opencode.exe',
};

test('owned process-tree termination refuses identity mismatch before taskkill', async () => {
  let spawned = false;
  const result = await terminateOwnedProcessTree(record, {
    inspector: {
      inspectProcess: async () => ({ kind: 'alive', pid: 42, started_at_ms: 1000, executable_path: 'C:\\Other\\opencode.exe' }),
      inspectProcessTree: async () => ({ kind: 'quiescent', descendants: [] }),
    },
    spawnImpl() { spawned = true; throw new Error('must not spawn'); },
    env: { SystemRoot: 'C:\\Windows' },
  });
  assert.equal(result.kind, 'unconfirmed');
  assert.equal(result.reason, 'native_process_identity_mismatch');
  assert.equal(result.taskkill_started, false);
  assert.equal(spawned, false);
});

test('owned process-tree termination verifies root death and descendant quiescence after taskkill', async () => {
  const calls = [];
  let inspected = 0;
  const result = await terminateOwnedProcessTree(record, {
    inspector: {
      inspectProcess: async () => inspected++ === 0
        ? { kind: 'alive', pid: 42, started_at_ms: 1000, executable_path: 'C:\\Apps\\opencode.exe' }
        : { kind: 'absent', pid: 42 },
      inspectProcessTree: async () => ({ kind: 'quiescent', descendants: [] }),
    },
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    },
    env: realTaskkillEnvOrFixture(),
    budgetMs: 100,
    pollMs: 1,
  });
  assert.equal(result.kind, process.platform === 'win32' ? 'terminated' : 'unconfirmed');
  if (process.platform === 'win32') {
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['/PID', '42', '/T', '/F']);
    assert.equal(calls[0].options.shell, false);
  }
});

test('already-dead root is not taskkilled and still requires tree quiescence', async () => {
  let spawned = false;
  const quiescent = await terminateOwnedProcessTree(record, {
    inspector: {
      inspectProcess: async () => ({ kind: 'absent', pid: 42 }),
      inspectProcessTree: async () => ({ kind: 'quiescent', descendants: [] }),
    },
    spawnImpl() { spawned = true; throw new Error('must not spawn'); },
  });
  assert.equal(quiescent.kind, 'already_exited');
  assert.equal(spawned, false);

  const descendants = await terminateOwnedProcessTree(record, {
    inspector: {
      inspectProcess: async () => ({ kind: 'absent', pid: 42 }),
      inspectProcessTree: async () => ({ kind: 'active_descendants', descendants: [{ pid: 43, parent_pid: 42, started_at_ms: 1100 }] }),
    },
  });
  assert.equal(descendants.kind, 'unconfirmed');
  assert.equal(descendants.reason, 'process_tree_still_active');
});

test('default Windows terminator kills only the explicitly owned harmless fixture tree', {
  skip: process.platform !== 'win32',
}, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  const inspector = createProcessInspector();
  try {
    let identity = null;
    for (let i = 0; i < 40; i++) {
      const current = await inspector.inspectProcess({ pid: child.pid });
      if (current.kind === 'alive') { identity = current; break; }
      await delay(25);
    }
    assert.ok(identity);
    const result = await terminateOwnedProcessTree({
      pid: child.pid,
      process_started_at_ms: identity.started_at_ms,
      executable_path: identity.executable_path,
    }, { inspector, budgetMs: 5_000, pollMs: 25 });
    assert.equal(result.kind, 'terminated');
    const after = await inspector.inspectProcess({ pid: child.pid });
    assert.equal(after.kind, 'absent');
    const tree = await inspector.inspectProcessTree({ rootPid: child.pid, rootStartedAtMs: identity.started_at_ms });
    assert.equal(tree.kind, 'quiescent');
  } finally {
    if (child.exitCode === null && !child.killed) try { child.kill(); } catch {}
  }
});

function realTaskkillEnvOrFixture() {
  if (process.platform === 'win32') return process.env;
  return { SystemRoot: path.win32.parse('C:\\Windows').root };
}
