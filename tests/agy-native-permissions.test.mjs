import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildAgyArgs, invokeAgy } from '../plugins/uagents/src/transports/agy-process.mjs';

test('agy uses native auto-approval without forcing sandbox initialization in either task mode', () => {
  const workspace = path.resolve('.local', 'review workspace');
  for (const mode of ['analysis', 'implementation']) {
    const args = buildAgyArgs(workspace, { mode, model: 'gemini-3.8-flash-medium', timeout_ms: 30_000 });
    assert.equal(args.filter(arg => arg === '--dangerously-skip-permissions').length, 1);
    assert.equal(args.includes('--sandbox'), false);
    assert.equal(args[args.indexOf('--add-dir') + 1], workspace);
    assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.8-flash-medium');
    assert.equal(args.includes('accept-edits'), mode === 'implementation');
  }
});

test('a native permission denial still records needs_user and cannot become a success or safe retry', async () => {
  const directory = path.resolve('.local', 'test-runs', randomUUID(), 'agy-denial');
  fs.mkdirSync(directory, { recursive: true });
  const result = await invokeAgy(directory, directory, {
    mode: 'analysis', model: 'gemini-fixture-tool-denied', timeout_ms: 5_000,
    prompt: 'Review without editing.', expected_outputs: [], permission_policy: 'advisory-read-only',
  }, () => {}, { command: process.execPath, args: [path.resolve('tests/fixtures/fake-agy.mjs'), 'tool-denied'] });
  assert.equal(result.status, 'needs_user');
  assert.equal(result.error, 'native_approval_required');
  assert.equal(result.retry_safe, false);
  assert.equal(fs.readFileSync(path.join(directory, 'received.txt'), 'utf8'), 'submitted\n');
});
