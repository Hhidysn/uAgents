import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalHash, canonicalJson } from '../plugins/uagents/src/protocol/canonical-json.mjs';
import { notOk, ok } from '../plugins/uagents/src/protocol/envelope.mjs';
import { UAgentsError, redactText } from '../plugins/uagents/src/protocol/errors.mjs';
import { modelIdentity, parseRequest } from '../plugins/uagents/src/protocol/schema.mjs';

const request = patch => ({
  schema_version: '1.0',
  request_id: randomUUID(),
  target: 'opencode',
  model: 'commandcode-goat/deepseek/deepseek-v4-flash',
  mode: 'analysis',
  prompt: 'Review this bounded input.',
  execution: { observation_timeout_ms: 30_000, effort: 'high', permission: 'native' },
  policy: { fallback: 'none', max_cost_usd: null },
  ...patch,
});

test('request schema is strict and normalizes optional collections', () => {
  const parsed = parseRequest(request());
  assert.deepEqual(parsed.inputs, []);
  assert.deepEqual(parsed.expected_outputs, []);
  assert.deepEqual(parsed.execution.native_args, []);
  assert.equal(parsed.execution.execution_timeout_ms, null);
  assert.throws(() => parseRequest(request({ surprise: true })), { code: 'unsupported_field' });
  assert.throws(() => parseRequest(request({ schema_version: '2.0' })), { code: 'unsupported_schema_version' });
  assert.throws(() => parseRequest(request({ prompt: '   ' })), { code: 'invalid_request' });
});

test('execution native args preserve caller order and validate bounds', () => {
  const nativeArgs = ['--pure', '--agent', 'build', '--variant=fast'];
  assert.deepEqual(parseRequest(request({ execution: {
    observation_timeout_ms: 30_000, effort: 'high', permission: 'native', native_args: nativeArgs,
  } })).execution.native_args, nativeArgs);
  assert.throws(() => parseRequest(request({ execution: {
    observation_timeout_ms: 30_000, effort: 'high', permission: 'native', native_args: ['']
  } })), { code: 'invalid_request' });
  assert.throws(() => parseRequest(request({ execution: {
    observation_timeout_ms: 30_000, effort: 'high', permission: 'native', native_args: Array(65).fill('--auto'),
  } })), { code: 'invalid_request' });
});

test('workspace and file paths are validated before execution', () => {
  const workspace = path.resolve('.local', '协议 workspace');
  const parsed = parseRequest(request({
    workspace,
    inputs: [{ type: 'file', path: 'requirements/spec.md' }],
    expected_outputs: [{ type: 'file', path: 'src/result.mjs', required: true, max_bytes: 1234 }],
  }));
  assert.equal(parsed.workspace, workspace);
  assert.throws(() => parseRequest(request({ workspace: 'relative' })), { code: 'invalid_workspace' });
  assert.throws(() => parseRequest(request({ workspace, inputs: [{ type: 'file', path: '../secret' }] })), { code: 'invalid_request' });
  assert.throws(() => parseRequest(request({ workspace, inputs: [{ type: 'file', path: 'same' }, { type: 'file', path: 'SAME' }] })), { code: 'invalid_request' });
});

test('canonical JSON is independent of object insertion order', () => {
  const left = { z: 1, nested: { b: 2, a: [3, { y: true, x: null }] } };
  const right = { nested: { a: [3, { x: null, y: true }], b: 2 }, z: 1 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(canonicalHash(left), canonicalHash(right));
  assert.throws(() => canonicalJson({ invalid: undefined }), { code: 'invalid_request' });
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), { code: 'invalid_request' });
});

test('model identity always emits all required fields', () => {
  assert.deepEqual(modelIdentity({ model_requested: 'default' }), {
    model_requested: 'default', model_resolved: null, model_reported: null, model_verified: false,
    provider: null, route_id: null, model_resolution: null,
    model_verification: { status: 'unknown', assurance: 'none', match: null, method: null, evidence_ref: null },
  });
});

test('envelopes are stable and redact common secret forms', () => {
  assert.deepEqual(ok({ value: 1 }), { ok: true, data: { value: 1 }, error: null, warnings: [] });
  const envelope = notOk(new UAgentsError('target_not_ready', 'Authorization: Bearer secret-value', { submission: 'not_sent' }));
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'target_not_ready');
  assert.equal(envelope.error.submission, 'not_sent');
  assert.doesNotMatch(envelope.error.message, /secret-value/);
  assert.equal(redactText('api_key=abc123'), 'api_key=[REDACTED]');
});
