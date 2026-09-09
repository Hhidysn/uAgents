import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathIsWithin } from '../path-containment.mjs';
import { atomicWriteJson } from '../store/task-files.mjs';
import { canonicalWorkspace } from '../runtime/workspace-key.mjs';

export function captureArtifacts({ workspace, expectedOutputs, taskDirectory }) {
  const captureRoot = path.join(taskDirectory, 'artifacts', 'captured');
  fs.mkdirSync(captureRoot, { recursive: true });
  const workspaceIdentity = canonicalWorkspace(workspace);
  const artifacts = expectedOutputs.map(expected => captureOne({ workspace, workspaceIdentity, captureRoot, taskDirectory, expected }));
  const verified = artifacts.every((artifact, index) => expectedOutputs[index].required === false || artifact.verified === true);
  const manifest = { schema_version: '1.0', verified, observed_at: new Date().toISOString(), artifacts };
  atomicWriteJson(path.join(taskDirectory, 'artifacts.json'), manifest);
  return manifest;
}

function captureOne({ workspace, workspaceIdentity, captureRoot, taskDirectory, expected }) {
  const source = path.resolve(workspace, expected.path);
  let real;
  try { real = fs.realpathSync.native(source); }
  catch (error) { return { path: expected.path, required: expected.required, verified: false, error: error.code === 'ENOENT' ? 'missing' : 'unreadable' }; }
  const normalized = process.platform === 'win32' ? real.normalize('NFC').toLocaleLowerCase('en-US') : real.normalize('NFC');
  if (!pathIsWithin(workspaceIdentity, normalized)) return { path: expected.path, required: expected.required, verified: false, error: 'outside_workspace' };

  let sourceHandle;
  const destination = path.join(captureRoot, ...expected.path.split('/'));
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    sourceHandle = fs.openSync(real, 'r');
    const before = fs.fstatSync(sourceHandle);
    if (!before.isFile() || before.size === 0 || before.size > expected.max_bytes) return { path: expected.path, required: expected.required, verified: false, error: 'invalid_artifact' };
    const destinationHandle = fs.openSync(temporary, 'wx', 0o600);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    try {
      while (offset < before.size) {
        const read = fs.readSync(sourceHandle, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
        if (read === 0) break;
        fs.writeSync(destinationHandle, buffer, 0, read);
        hash.update(buffer.subarray(0, read));
        offset += read;
      }
    } finally { fs.closeSync(destinationHandle); }
    const after = fs.fstatSync(sourceHandle);
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev) {
      fs.unlinkSync(temporary);
      return { path: expected.path, required: expected.required, verified: false, error: 'changed_during_capture' };
    }
    fs.renameSync(temporary, destination);
    return {
      path: expected.path,
      required: expected.required,
      captured_path: path.relative(taskDirectory, destination).split(path.sep).join('/'),
      source_realpath: real,
      file_identity: `${before.dev}:${before.ino}`,
      observed_at: new Date().toISOString(),
      size_bytes: before.size,
      sha256: hash.digest('hex'),
      verified: true,
    };
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    return { path: expected.path, required: expected.required, verified: false, error: error.code ?? 'capture_failed' };
  } finally {
    if (sourceHandle !== undefined) fs.closeSync(sourceHandle);
  }
}
