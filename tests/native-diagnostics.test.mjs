import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { diagnosticMessage, readOpenCodeDiagnostics } from '../plugins/uagents/src/transports/native-diagnostics.mjs';

const root = path.resolve('.local/test-runs', randomUUID(), 'diagnostics');
fs.mkdirSync(root, { recursive: true });
const file = path.join(root, 'stdout.log');
const tool = { type: 'tool_use', sessionID: 'ours', part: { id: 'tool', sessionID: 'ours', tool: 'read', state: { error: 'Permission denied; Bearer fixture-secret', input: { private: 'fixture-secret' } } } };

test('diagnostics omit indented and inline payloads and camelCase credentials', () => {
  for (const message of ['Invalid arguments\n  Arguments provided:\n{"content":"fixture-private-message"}',
    'Native failure; Response body: {"content":"fixture-private-message"}']) {
    assert.doesNotMatch(diagnosticMessage(message), /fixture-private-message/);
  }
  for (const key of ['accessToken', 'refreshToken', 'access-token']) {
    assert.doesNotMatch(diagnosticMessage(JSON.stringify({ [key]: 'fixture-secret' })), /fixture-secret/);
  }
});

test('missing, malformed and foreign-only transcripts do not verify session identity', () => {
  for (const contents of ['not-json', JSON.stringify({ type: 'error', sessionID: 'foreign', error: { message: 'unrelated' } }),
    JSON.stringify({ ...tool, part: { ...tool.part, sessionID: 'foreign' } })]) {
    fs.writeFileSync(file, contents);
    assert.equal(readOpenCodeDiagnostics(file, { sessionId: 'ours' }).transcript.identity_verified, false);
  }
  assert.equal(readOpenCodeDiagnostics(path.join(root, 'missing'), { sessionId: 'ours' }).transcript.identity_verified, false);
});

test('partial native transcript retains sanitized failure reasons without completion claims', () => {
  fs.writeFileSync(file, [tool, tool, { type: 'error', sessionID: 'ours', error: { type: 'provider.internal', status: 200, message: 'Streaming failed; token=fixture-secret', body: 'fixture-secret' } }].map(JSON.stringify).join('\n'));
  const result = readOpenCodeDiagnostics(file, { sessionId: 'ours' });
  assert.equal(result.tool_errors.length, 1);
  assert.equal(result.native_errors[0].type, 'provider.internal');
  assert.equal(result.native_errors[0].status, 200);
  assert.equal(result.transcript.identity_verified, true);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|response|model_verified/);
});

test('foreign inner identity and unknown session cannot become attributed task errors', () => {
  fs.writeFileSync(file, JSON.stringify({ ...tool, part: { ...tool.part, sessionID: 'foreign' } }));
  assert.deepEqual(readOpenCodeDiagnostics(file, { sessionId: 'ours' }).tool_errors, []);
  fs.writeFileSync(file, JSON.stringify(tool));
  assert.deepEqual(readOpenCodeDiagnostics(file).tool_errors, []);
  assert.equal(readOpenCodeDiagnostics(file).transcript.identity_verified, false);
});

test('bounded reads identify truncation and tolerate incomplete native output', () => {
  fs.writeFileSync(file, JSON.stringify(tool));
  const result = readOpenCodeDiagnostics(file, { sessionId: 'ours', limitBytes: 32 });
  assert.equal(result.transcript.bytes_read, 32);
  assert.equal(result.transcript.truncated, true);
  assert.equal(result.transcript.malformed_lines, 1);
  assert.deepEqual(result.tool_errors, []);
});
