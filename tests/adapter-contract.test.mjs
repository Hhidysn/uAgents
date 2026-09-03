import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPrepareHasNoSend, validateAdapter } from '../plugins/uagents/src/adapters/contract.mjs';
import { FakeAdapter } from '../plugins/uagents/src/adapters/fake/adapter.mjs';

test('fake adapter exposes the complete static contract', async () => {
  const adapter = new FakeAdapter();
  const descriptor = validateAdapter(adapter);
  assert.equal(descriptor.target, 'fake');
  assert.equal('available' in descriptor, false);
  assert.equal((await adapter.probe()).submission, 'not_sent');
  assert.deepEqual((await adapter.discoverModels()).models, [{ id: 'fake-model' }]);
});

test('prepare cannot perform a native send', async () => {
  const adapter = new FakeAdapter();
  await assertPrepareHasNoSend(adapter, { prompt: 'bounded' });
  assert.equal(adapter.sendCount, 0);
  const violating = new FakeAdapter();
  violating.prepare = async () => { violating.sendCount++; return {}; };
  await assert.rejects(assertPrepareHasNoSend(violating, {}), { code: 'adapter_contract_violation' });
});

test('dispatch cannot send before possibly-sent checkpoint completes', async () => {
  const adapter = new FakeAdapter();
  const order = [];
  const prepared = await adapter.prepare({ prompt: 'bounded' });
  await adapter.dispatch(prepared, {
    attemptId: 'attempt-fixture',
    checkpoint: async kind => {
      order.push(kind);
      if (kind === 'possibly_sent') assert.equal(adapter.sendCount, 0);
      if (kind === 'accepted') assert.equal(adapter.sendCount, 1);
    },
  });
  assert.deepEqual(order, ['possibly_sent', 'accepted']);
});

test('missing adapter methods and dynamic descriptor state are rejected', () => {
  assert.throws(() => validateAdapter({}), { code: 'invalid_adapter' });
  const adapter = new FakeAdapter();
  adapter.descriptor = () => ({ ...new FakeAdapter().descriptor(), available: true });
  assert.throws(() => validateAdapter(adapter), { code: 'invalid_adapter' });
});
