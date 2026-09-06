import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createProcessInspector,
  classifyPersistedProcess,
  inspectProcessTreeWithRunner,
  inspectProcessWithRunner,
} from '../plugins/uagents/src/host/process-inspector.mjs';

test('process inspector distinguishes alive, absent and inspection failure', async () => {
  const alive = await inspectProcessWithRunner(async () => ({
    ok: true, exists: true, pid: 42, started_at_ms: 1234, executable_path: 'C:\\Apps\\opencode.exe',
  }), { pid: 42 });
  assert.deepEqual(alive, { kind: 'alive', pid: 42, started_at_ms: 1234, executable_path: 'C:\\Apps\\opencode.exe' });

  const absent = await inspectProcessWithRunner(async () => ({ ok: true, exists: false, pid: 42 }), { pid: 42 });
  assert.deepEqual(absent, { kind: 'absent', pid: 42 });

  const failed = await inspectProcessWithRunner(async () => ({
    ok: false, error: { code: 'process_inspection_failed', message: 'fixture' },
  }), { pid: 42 });
  assert.deepEqual(failed, { kind: 'inspection_failed', code: 'process_inspection_failed' });
});

test('persisted identity classification handles PID reuse and executable mismatch conservatively', () => {
  const record = { pid: 42, process_started_at_ms: 1234, executable_path: 'C:\\Apps\\OpenCode.exe' };
  assert.deepEqual(classifyPersistedProcess(record, {
    kind: 'alive', pid: 42, started_at_ms: 1234, executable_path: 'c:\\apps\\opencode.exe',
  }), { kind: 'alive_same_identity' });
  assert.deepEqual(classifyPersistedProcess(record, { kind: 'absent', pid: 42 }), { kind: 'dead' });
  assert.deepEqual(classifyPersistedProcess(record, {
    kind: 'alive', pid: 42, started_at_ms: 2234, executable_path: 'C:\\Apps\\OpenCode.exe',
  }), { kind: 'alive_same_identity' });
  assert.deepEqual(classifyPersistedProcess(record, {
    kind: 'alive', pid: 42, started_at_ms: 2235, executable_path: 'C:\\Apps\\OpenCode.exe',
  }), { kind: 'old_identity_dead_pid_reused' });
  assert.deepEqual(classifyPersistedProcess(record, {
    kind: 'alive', pid: 42, started_at_ms: 5678, executable_path: 'C:\\Apps\\OpenCode.exe',
  }), { kind: 'old_identity_dead_pid_reused' });
  assert.deepEqual(classifyPersistedProcess(record, {
    kind: 'alive', pid: 42, started_at_ms: 1234, executable_path: 'C:\\Other\\OpenCode.exe',
  }), { kind: 'identity_mismatch_unknown' });
  assert.deepEqual(classifyPersistedProcess(record, {
    kind: 'inspection_failed', code: 'process_inspection_failed',
  }), { kind: 'inspection_unknown', code: 'process_inspection_failed' });
});

test('process-tree inspector distinguishes quiescence, surviving descendants and failures', async () => {
  const quiescent = await inspectProcessTreeWithRunner(async () => ({ ok: true, descendants: [] }), {
    rootPid: 42, rootStartedAtMs: 1234,
  });
  assert.deepEqual(quiescent, { kind: 'quiescent', descendants: [] });

  const active = await inspectProcessTreeWithRunner(async () => ({
    ok: true, descendants: [{ pid: 43, parent_pid: 42, started_at_ms: 1250 }, { pid: 44, parent_pid: 43, started_at_ms: 1260 }],
  }), { rootPid: 42, rootStartedAtMs: 1234 });
  assert.equal(active.kind, 'active_descendants');
  assert.deepEqual(active.descendants.map(row => row.pid), [43, 44]);

  const failed = await inspectProcessTreeWithRunner(async () => ({
    ok: false, error: { code: 'process_tree_inspection_failed' },
  }), { rootPid: 42, rootStartedAtMs: 1234 });
  assert.deepEqual(failed, { kind: 'inspection_failed', code: 'process_tree_inspection_failed' });
});

test('windows host process query uses terminating CIM errors so failure cannot become absence', () => {
  const script = fs.readFileSync(new URL('../plugins/uagents/scripts/windows-host.ps1', import.meta.url), 'utf8');
  const start = script.indexOf('function Invoke-ProcessInspection');
  const end = script.indexOf('function Invoke-ProcessTreeInspection');
  const block = script.slice(start, end);
  assert.match(block, /Get-CimInstance[^\r\n]+-ErrorAction Stop/);
  assert.match(block, /process_inspection_failed/);
});

test('default Windows inspector can inspect the live Node process and its process tree', {
  skip: process.platform !== 'win32',
}, async () => {
  const inspector = createProcessInspector();
  const current = await inspector.inspectProcess({ pid: process.pid });
  assert.equal(current.kind, 'alive');
  assert.equal(current.pid, process.pid);
  assert.match(current.executable_path.toLowerCase(), /node(?:\.exe)?$/);

  const tree = await inspector.inspectProcessTree({ rootPid: process.pid, rootStartedAtMs: current.started_at_ms });
  assert.notEqual(tree.kind, 'inspection_failed');
});
