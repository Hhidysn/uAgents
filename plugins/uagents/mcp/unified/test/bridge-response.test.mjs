import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeServiceResult } from '../src/bridge.mjs';
import { fail } from '../../../src/protocol/errors.mjs';
import { notOk, ok } from '../../../src/protocol/envelope.mjs';
import { main } from '../src/service.mjs';

test('bridge decodes both structured and text uAgents envelopes', () => {
  assert.deepEqual(decodeServiceResult({ structuredContent: ok({ text: '中文' }) }), { text: '中文' });
  assert.equal(decodeServiceResult({ content: [{ type: 'text', text: JSON.stringify(ok(42)) }] }), 42);
});

test('bridge retains explicit Core rejection evidence', () => {
  let envelope;
  try { fail('request_conflict', 'fixture'); } catch (error) { envelope = notOk(error); }
  assert.throws(() => decodeServiceResult({ structuredContent: envelope }), { code: 'request_conflict', category: 'conflict', submission: 'not_sent' });
  envelope.error.submission = 'sent';
  assert.throws(() => decodeServiceResult({ structuredContent: envelope }), { code: 'request_conflict', submission: 'sent' });
});

test('partial, corrupt or absent responses never imply not_sent', () => {
  const responses = [{}, { structuredContent: { ok: false } }, { structuredContent: { ok: false, error: { code: 'x', message: 'x' } } },
    { structuredContent: { ok: true } }, { content: [{ type: 'text', text: 'broken-json' }] }];
  for (const result of responses) assert.throws(() => decodeServiceResult(result), { code: 'service_tool_response_unconfirmed', category: 'transport', submission: 'may_have_been_sent' });
});

test('service command/schema discovery requires no configuration or Core state', async () => {
  const output = []; const io = { log: text => output.push(JSON.parse(text)) };
  assert.equal(await main(['describe'], io), 0);
  assert.equal(output[0].data.transport, 'streamable-http');
  assert.equal(await main(['schema', 'config'], io), 0);
  assert.equal(output[1].data.properties.host.const, '127.0.0.1');
});
