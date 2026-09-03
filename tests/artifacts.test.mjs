import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { captureArtifacts } from '../plugins/uagents/src/artifacts/capture.mjs';
import { verifyCapturedArtifacts } from '../plugins/uagents/src/artifacts/verify.mjs';
import { FakeAdapter } from '../plugins/uagents/src/adapters/fake/adapter.mjs';
import { ControlDatabase } from '../plugins/uagents/src/store/database.mjs';
import { TaskService } from '../plugins/uagents/src/runtime/task-service.mjs';
import { runTask } from '../plugins/uagents/src/runtime/worker.mjs';

const root = path.resolve('.local', 'test-runs', randomUUID(), 'artifact capture');
const workspace = path.join(root, 'workspace');
const task = path.join(root, 'task');
fs.mkdirSync(path.join(workspace, 'dist'), { recursive: true });
fs.mkdirSync(task, { recursive: true });

test('artifact is captured as an immutable hashed copy', () => {
  fs.writeFileSync(path.join(workspace, 'dist', 'answer.txt'), 'verified answer');
  const manifest = captureArtifacts({ workspace, taskDirectory: task, expectedOutputs: [{ path: 'dist/answer.txt', type: 'file', required: true, max_bytes: 1024 }] });
  assert.equal(manifest.verified, true);
  assert.match(manifest.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(path.join(task, ...manifest.artifacts[0].captured_path.split('/')), 'utf8'), 'verified answer');
  fs.writeFileSync(path.join(workspace, 'dist', 'answer.txt'), 'changed later');
  assert.equal(verifyCapturedArtifacts(task, manifest).verified, true);
  fs.writeFileSync(path.join(task, ...manifest.artifacts[0].captured_path.split('/')), 'tampered');
  assert.equal(verifyCapturedArtifacts(task, manifest).verified, false);
});

test('optional missing output does not fail the manifest', () => {
  const manifest = captureArtifacts({ workspace, taskDirectory: path.join(root, 'optional'), expectedOutputs: [{ path: 'optional.txt', type: 'file', required: false, max_bytes: 1024 }] });
  assert.equal(manifest.verified, true);
  assert.equal(manifest.artifacts[0].error, 'missing');
});

test('junction output escaping the workspace is rejected', { skip: process.platform !== 'win32' }, () => {
  const outside = path.join(root, 'outside');
  const linkedWorkspace = path.join(root, 'linked-workspace');
  fs.mkdirSync(outside, { recursive: true }); fs.mkdirSync(linkedWorkspace, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(linkedWorkspace, 'linked'), 'junction');
  const manifest = captureArtifacts({ workspace: linkedWorkspace, taskDirectory: path.join(root, 'junction-task'), expectedOutputs: [{ path: 'linked/secret.txt', type: 'file', required: true, max_bytes: 1024 }] });
  assert.equal(manifest.verified, false);
  assert.equal(manifest.artifacts[0].error, 'outside_workspace');
});

test('runtime separates native outcome from failed objective verification', async () => {
  const runtimeRoot = path.join(root, 'runtime');
  const runtimeWorkspace = path.join(root, 'runtime-workspace');
  fs.mkdirSync(runtimeWorkspace, { recursive: true });
  const control = new ControlDatabase(runtimeRoot);
  try {
    const service = new TaskService(control);
    const input = {
      schema_version: '1.0', request_id: randomUUID(), target: 'agy', model: 'gemini-fixture-low', mode: 'implementation', prompt: 'create missing.txt', workspace: runtimeWorkspace,
      expected_outputs: [{ path: 'missing.txt', type: 'file', required: true, max_bytes: 1024 }],
      execution: { observation_timeout_ms: 10_000, effort: 'medium', permission: 'native' }, policy: { fallback: 'none', max_cost_usd: null },
    };
    const registered = service.submit(input, { adapterVersion: 'fake-1' });
    const result = await runTask({ service, taskId: registered.task_id, adapter: new FakeAdapter() });
    assert.equal(result.status, 'failed');
    assert.equal(result.native_outcome, 'succeeded');
    assert.equal(result.objective_verdict, 'failed');
    assert.equal(service.events(result.task_id).at(-1).payload.error, 'output_verification_failed');
  } finally { control.close(); }
});
