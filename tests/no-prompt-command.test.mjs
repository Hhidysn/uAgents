import test from 'node:test';
import assert from 'node:assert/strict';
import { runNoPromptCommand } from '../plugins/uagents/src/transports/no-prompt-command.mjs';

const node = process.execPath;
const script = `process.stdout.write('out'); process.stderr.write('err')`;

test('no-prompt command captures both streams and uses the bounded no-shell launch options', async () => {
  const result = await runNoPromptCommand(node, ['-e', script]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
});

test('no-prompt command returns nonzero status for the caller to classify', async () => {
  const result = await runNoPromptCommand(node, ['-e', 'process.exit(7)']);
  assert.equal(result.status, 7);
});

test('no-prompt command propagates spawn errors', async () => {
  await assert.rejects(runNoPromptCommand('uagents-command-that-does-not-exist', []), error => error.code === 'ENOENT');
});

test('no-prompt command terminates and reports timeout', async () => {
  await assert.rejects(runNoPromptCommand(node, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 50 }), error => error.code === 'ETIMEDOUT');
});

test('no-prompt command caps captured output', async () => {
  await assert.rejects(runNoPromptCommand(node, ['-e', "process.stdout.write('x'.repeat(1000000))"], { maxBuffer: 1024 }), error => error.code === 'output_limit_exceeded');
});
