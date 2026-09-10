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
import { snapshotInputs, verifyInputSnapshots } from '../plugins/uagents/src/artifacts/inputs.mjs';
import { ATTACHMENT_LIMITS } from '../plugins/uagents/src/artifacts/attachments.mjs';

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

test('attachment snapshots verify image media type, size and content identity', () => {
  const imagePath = path.join(workspace, 'tiny.png');
  const png = pngFixture(2, 3);
  fs.writeFileSync(imagePath, png);
  const snapshots = snapshotInputs(workspace, [{ type: 'image', path: 'tiny.png' }]);
  assert.deepEqual(snapshots, [{
    type: 'image', path: 'tiny.png', media_type: 'image/png', size_bytes: png.length,
    sha256: snapshots[0].sha256, width_px: 2, height_px: 3,
  }]);
  assert.match(snapshots[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(verifyInputSnapshots(workspace, snapshots), true);
  fs.writeFileSync(path.join(workspace, 'not-image.bin'), 'plain text');
  assert.throws(() => snapshotInputs(workspace, [{ type: 'image', path: 'not-image.bin' }]), { code: 'invalid_input' });
  fs.writeFileSync(path.join(workspace, 'oversized-dim.png'), pngFixture(16_385, 1));
  assert.throws(() => snapshotInputs(workspace, [{ type: 'image', path: 'oversized-dim.png' }]), { code: 'invalid_input' });
});

test('attachment image headers expose dimensions for every supported format', () => {
  const fixtures = [
    ['format.png', pngFixture(2, 3), 'image/png', 2, 3],
    ['format.gif', gifFixture(4, 5), 'image/gif', 4, 5],
    ['format.jpg', jpegFixture(6, 7), 'image/jpeg', 6, 7],
    ['format.webp', webpFixture(8, 9), 'image/webp', 8, 9],
  ];
  for (const [name, bytes, mediaType, width, height] of fixtures) {
    fs.writeFileSync(path.join(workspace, name), bytes);
    const snapshot = snapshotInputs(workspace, [{ type: 'image', path: name }])[0];
    assert.equal(snapshot.media_type, mediaType);
    assert.equal(snapshot.width_px, width);
    assert.equal(snapshot.height_px, height);
  }
});

test('attachment contract enforces byte limits and accepts legacy snapshot subsets', () => {
  const legacyPath = path.join(workspace, 'legacy.txt');
  fs.writeFileSync(legacyPath, 'legacy');
  const current = snapshotInputs(workspace, [{ type: 'file', path: 'legacy.txt' }])[0];
  const legacy = [{ type: current.type, path: current.path, size_bytes: current.size_bytes, sha256: current.sha256 }];
  assert.equal(verifyInputSnapshots(workspace, legacy), true);

  const largeFile = path.join(workspace, 'large.bin');
  fs.writeFileSync(largeFile, Buffer.from([0]));
  fs.truncateSync(largeFile, ATTACHMENT_LIMITS.file_bytes + 1);
  assert.throws(() => snapshotInputs(workspace, [{ type: 'file', path: 'large.bin' }]), { code: 'invalid_input' });

  const largeImage = path.join(workspace, 'large.png');
  fs.writeFileSync(largeImage, pngFixture(1, 1));
  fs.truncateSync(largeImage, ATTACHMENT_LIMITS.image_bytes + 1);
  assert.throws(() => snapshotInputs(workspace, [{ type: 'image', path: 'large.png' }]), { code: 'invalid_input' });

  for (const [name, size] of [['total-a.bin', ATTACHMENT_LIMITS.file_bytes], ['total-b.bin', ATTACHMENT_LIMITS.file_bytes], ['total-c.bin', 1]]) {
    const file = path.join(workspace, name);
    fs.writeFileSync(file, Buffer.from([0]));
    fs.truncateSync(file, size);
  }
  assert.throws(() => snapshotInputs(workspace, [
    { type: 'file', path: 'total-a.bin' }, { type: 'file', path: 'total-b.bin' }, { type: 'file', path: 'total-c.bin' },
  ]), { code: 'invalid_input' });
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

function pngFixture(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function gifFixture(width, height) {
  const bytes = Buffer.alloc(10);
  bytes.write('GIF89a', 0, 'ascii');
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

function jpegFixture(width, height) {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0, 0, 0, 0, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes;
}

function webpFixture(width, height) {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8X', 12, 'ascii');
  bytes.writeUInt32LE(10, 16);
  writeUInt24LE(bytes, 24, width - 1);
  writeUInt24LE(bytes, 27, height - 1);
  return bytes;
}

function writeUInt24LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
}
